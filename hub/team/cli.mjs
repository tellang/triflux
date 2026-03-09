// hub/team/cli.mjs — tfx team CLI 진입점
// bin/triflux.mjs에서 import하여 사용
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync, spawn } from "node:child_process";
import { createRequire } from "node:module";

import {
  createSession,
  attachSession,
  killSession,
  sessionExists,
  listSessions,
  focusPane,
  configureTeammateKeybindings,
  detectMultiplexer,
} from "./session.mjs";
import { buildCliCommand, startCliInPane, injectPrompt, sendKeys } from "./pane.mjs";
import { orchestrate, decomposeTask, buildLeadPrompt, buildPrompt } from "./orchestrator.mjs";

// ── 상수 ──
const PKG_ROOT = dirname(dirname(dirname(new URL(import.meta.url).pathname))).replace(/^\/([A-Z]:)/, "$1");
const HUB_PID_DIR = join(homedir(), ".claude", "cache", "tfx-hub");
const HUB_PID_FILE = join(HUB_PID_DIR, "hub.pid");
const TEAM_STATE_FILE = join(HUB_PID_DIR, "team-state.json");
const requireFromPkg = createRequire(join(PKG_ROOT, "package.json"));
const HUB_RUNTIME_DEPS = [
  "@modelcontextprotocol/sdk/server/index.js",
  "@modelcontextprotocol/sdk/server/streamableHttp.js",
  "@modelcontextprotocol/sdk/types.js",
  "better-sqlite3",
];

const TEAM_SUBCOMMANDS = new Set([
  "status", "attach", "stop", "kill", "send", "list", "help", "tasks", "task", "focus", "interrupt", "control",
]);

// ── 색상 ──
const AMBER = "\x1b[38;5;214m";
const GREEN = "\x1b[38;5;82m";
const RED = "\x1b[38;5;196m";
const GRAY = "\x1b[38;5;245m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const WHITE = "\x1b[97m";
const YELLOW = "\x1b[33m";

function ok(msg) { console.log(`  ${GREEN}✓${RESET} ${msg}`); }
function warn(msg) { console.log(`  ${YELLOW}⚠${RESET} ${msg}`); }
function fail(msg) { console.log(`  ${RED}✗${RESET} ${msg}`); }

function getMissingHubRuntimeDeps() {
  const missing = [];
  for (const dep of HUB_RUNTIME_DEPS) {
    try {
      requireFromPkg.resolve(dep);
    } catch {
      missing.push(dep);
    }
  }
  return missing;
}

function ensureHubRuntimeReady() {
  const missing = getMissingHubRuntimeDeps();
  if (missing.length === 0) return true;

  fail(`Hub 실행 의존성 누락: ${missing.join(", ")}`);
  warn("프로젝트 루트에서 npm install 후 다시 시도하세요.");
  return false;
}

// ── 팀 상태 관리 ──

function loadTeamState() {
  try {
    return JSON.parse(readFileSync(TEAM_STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveTeamState(state) {
  mkdirSync(HUB_PID_DIR, { recursive: true });
  writeFileSync(TEAM_STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

function clearTeamState() {
  try { unlinkSync(TEAM_STATE_FILE); } catch {}
}

// ── Hub 유틸 ──

function getHubInfo() {
  if (!existsSync(HUB_PID_FILE)) return null;
  try {
    const info = JSON.parse(readFileSync(HUB_PID_FILE, "utf8"));
    process.kill(info.pid, 0); // 프로세스 생존 확인
    return info;
  } catch {
    return null;
  }
}

function startHubDaemon() {
  const serverPath = join(PKG_ROOT, "hub", "server.mjs");
  if (!existsSync(serverPath)) {
    fail("hub/server.mjs 없음 — hub 모듈이 설치되지 않음");
    return null;
  }

  if (!ensureHubRuntimeReady()) return null;

  let child;
  try {
    child = spawn(process.execPath, [serverPath], {
      env: { ...process.env },
      stdio: "ignore",
      detached: true,
    });
  } catch (e) {
    fail(`Hub 데몬 시작 실패: ${e.message}`);
    return null;
  }

  child.unref();

  // PID 파일 확인 (최대 3초 대기)
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (existsSync(HUB_PID_FILE)) {
      return JSON.parse(readFileSync(HUB_PID_FILE, "utf8"));
    }
    execSync('node -e "setTimeout(()=>{},100)"', { stdio: "ignore", timeout: 500 });
  }
  return null;
}

// ── 인자 파싱 ──

function normalizeTeammateMode(mode = "auto") {
  const raw = String(mode).toLowerCase();
  if (raw === "inline" || raw === "native") return "in-process";
  if (raw === "in-process" || raw === "tmux") return raw;
  if (raw === "auto") {
    return process.env.TMUX ? "tmux" : "in-process";
  }
  return "in-process";
}

function parseTeamArgs() {
  const args = process.argv.slice(3);
  let agents = ["codex", "gemini"]; // 기본: codex + gemini
  let lead = "claude"; // 기본 리드
  let layout = "2x2";
  let teammateMode = "auto";
  const taskParts = [];

  for (let i = 0; i < args.length; i++) {
    const cur = args[i];
    if (cur === "--agents" && args[i + 1]) {
      agents = args[++i].split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    } else if (cur === "--lead" && args[i + 1]) {
      lead = args[++i].trim().toLowerCase();
    } else if (cur === "--layout" && args[i + 1]) {
      layout = args[++i];
    } else if ((cur === "--teammate-mode" || cur === "--mode") && args[i + 1]) {
      teammateMode = args[++i];
    } else if (!cur.startsWith("-")) {
      taskParts.push(cur);
    }
  }

  return {
    agents,
    lead,
    layout,
    teammateMode: normalizeTeammateMode(teammateMode),
    task: taskParts.join(" ").trim(),
  };
}

function ensureTmuxOrExit() {
  const mux = detectMultiplexer();
  if (mux) return;

  console.log(`
  ${RED}${BOLD}tmux 미발견${RESET}

  현재 선택한 모드는 tmux 기반 팀세션이 필요합니다.

  설치:
    WSL2:   ${WHITE}wsl sudo apt install tmux${RESET}
    macOS:  ${WHITE}brew install tmux${RESET}
    Linux:  ${WHITE}apt install tmux${RESET}

  Windows에서는 WSL2를 권장합니다:
    1. ${WHITE}wsl --install${RESET}
    2. ${WHITE}wsl sudo apt install tmux${RESET}
    3. ${WHITE}tfx team "작업"${RESET}
`);
  process.exit(1);
}

function toAgentId(cli, target) {
  return `${cli}-${target.split(".").pop()}`;
}

function buildNativeCliCommand(cli) {
  switch (cli) {
    case "codex":
      // 비-TTY supervisor 환경에서 확인 프롬프트/alt-screen 의존을 줄임
      return "codex --dangerously-bypass-approvals-and-sandbox --no-alt-screen";
    case "gemini":
      return "gemini";
    case "claude":
      return "claude";
    default:
      return buildCliCommand(cli);
  }
}

function buildTasks(subtasks, workers) {
  return subtasks.map((subtask, i) => ({
    id: `T${i + 1}`,
    title: subtask,
    owner: workers[i]?.name || null,
    status: "pending",
    depends_on: i === 0 ? [] : [`T${i}`],
  }));
}

function renderTasks(tasks = []) {
  if (!tasks.length) {
    console.log(`\n  ${DIM}태스크 없음${RESET}\n`);
    return;
  }

  console.log(`\n  ${AMBER}${BOLD}⬡ Team Tasks${RESET}\n`);
  for (const t of tasks) {
    const dep = t.depends_on?.length ? ` ${DIM}(deps: ${t.depends_on.join(",")})${RESET}` : "";
    const owner = t.owner ? ` ${GRAY}[${t.owner}]${RESET}` : "";
    console.log(`    ${WHITE}${t.id}${RESET} ${t.status.padEnd(11)} ${t.title}${owner}${dep}`);
  }
  console.log("");
}

function resolveMember(state, selector) {
  const members = state?.members || [];
  if (!selector) return null;

  const direct = members.find((m) => m.name === selector || m.role === selector || m.agentId === selector);
  if (direct) return direct;

  // 스킬 친화 별칭: worker-1, worker-2 ...
  const workerAlias = /^worker-(\d+)$/i.exec(selector);
  if (workerAlias) {
    const workerIdx = parseInt(workerAlias[1], 10) - 1;
    const workers = members.filter((m) => m.role === "worker");
    if (workerIdx >= 0 && workerIdx < workers.length) return workers[workerIdx];
  }

  const n = parseInt(selector, 10);
  if (!Number.isNaN(n)) {
    // 하위 호환: pane 번호 우선
    const byPane = members.find((m) => m.pane?.endsWith(`.${n}`));
    if (byPane) return byPane;

    // teammate 스타일: 1-based 인덱스
    if (n >= 1 && n <= members.length) return members[n - 1];
  }

  return null;
}

async function publishLeadControl(state, targetMember, command, reason = "") {
  const hubBase = (state?.hubUrl || "http://127.0.0.1:27888/mcp").replace(/\/mcp$/, "");
  const leadAgent = (state?.members || []).find((m) => m.role === "lead")?.agentId || "lead";

  const payload = {
    from_agent: leadAgent,
    to_agent: targetMember.agentId,
    command,
    reason,
    payload: {
      issued_by: leadAgent,
      issued_at: Date.now(),
    },
  };

  try {
    const res = await fetch(`${hubBase}/bridge/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return !!res.ok;
  } catch {
    return false;
  }
}

function isNativeMode(state) {
  return state?.teammateMode === "in-process" && !!state?.native?.controlUrl;
}

function isTeamAlive(state) {
  if (!state) return false;
  if (isNativeMode(state)) {
    try {
      process.kill(state.native.supervisorPid, 0);
      return true;
    } catch {
      return false;
    }
  }
  return sessionExists(state.sessionName);
}

async function nativeRequest(state, path, body = {}) {
  if (!isNativeMode(state)) return null;
  try {
    const res = await fetch(`${state.native.controlUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch {
    return null;
  }
}

async function nativeGetStatus(state) {
  if (!isNativeMode(state)) return null;
  try {
    const res = await fetch(`${state.native.controlUrl}/status`);
    return await res.json();
  } catch {
    return null;
  }
}

async function startNativeSupervisor({ sessionId, task, lead, agents, subtasks, hubUrl }) {
  const nativeConfigPath = join(HUB_PID_DIR, `team-native-${sessionId}.config.json`);
  const nativeRuntimePath = join(HUB_PID_DIR, `team-native-${sessionId}.runtime.json`);
  const logsDir = join(HUB_PID_DIR, "team-logs", sessionId);
  mkdirSync(logsDir, { recursive: true });

  const leadMember = {
    role: "lead",
    name: "lead",
    cli: lead,
    agentId: `${lead}-lead`,
    command: buildNativeCliCommand(lead),
  };

  const workers = agents.map((cli, i) => ({
    role: "worker",
    name: `${cli}-${i + 1}`,
    cli,
    agentId: `${cli}-w${i + 1}`,
    command: buildNativeCliCommand(cli),
    subtask: subtasks[i],
  }));

  const leadPrompt = buildLeadPrompt(task, {
    agentId: leadMember.agentId,
    hubUrl,
    teammateMode: "in-process",
    workers: workers.map((w) => ({ agentId: w.agentId, cli: w.cli, subtask: w.subtask })),
  });

  const members = [
    { ...leadMember, prompt: leadPrompt },
    ...workers.map((w) => ({
      ...w,
      prompt: buildPrompt(w.subtask, { cli: w.cli, agentId: w.agentId, hubUrl }),
    })),
  ];

  const config = {
    sessionName: sessionId,
    hubUrl,
    startupDelayMs: 3000,
    logsDir,
    runtimeFile: nativeRuntimePath,
    members,
  };
  writeFileSync(nativeConfigPath, JSON.stringify(config, null, 2) + "\n");

  const supervisorPath = join(PKG_ROOT, "hub", "team", "native-supervisor.mjs");
  const child = spawn(process.execPath, [supervisorPath, "--config", nativeConfigPath], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (existsSync(nativeRuntimePath)) {
      try {
        const runtime = JSON.parse(readFileSync(nativeRuntimePath, "utf8"));
        return { runtime, members };
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return { runtime: null, members };
}

// ── 서브커맨드 ──

async function teamStart() {
  const { agents, lead, layout, teammateMode, task } = parseTeamArgs();
  if (!task) {
    console.log(`\n  ${AMBER}${BOLD}⬡ tfx team${RESET}\n`);
    console.log(`  사용법: ${WHITE}tfx team "작업 설명"${RESET}`);
    console.log(`          ${WHITE}tfx team --agents codex,gemini --lead claude "작업"${RESET}`);
    console.log(`          ${WHITE}tfx team --teammate-mode in-process "작업"${RESET} ${DIM}(tmux 불필요)${RESET}\n`);
    return;
  }

  console.log(`\n  ${AMBER}${BOLD}⬡ tfx team${RESET}\n`);

  let hub = getHubInfo();
  if (!hub) {
    process.stdout.write("  Hub 시작 중...");
    hub = startHubDaemon();
    if (hub) {
      console.log(` ${GREEN}✓${RESET}`);
    } else {
      console.log(` ${RED}✗${RESET}`);
      warn("Hub 시작 실패 — 수동으로 실행: tfx hub start");
    }
  } else {
    ok(`Hub: ${DIM}${hub.url}${RESET}`);
  }

  const sessionId = `tfx-team-${Date.now().toString(36).slice(-4)}`;
  const subtasks = decomposeTask(task, agents.length);
  const hubUrl = hub?.url || "http://127.0.0.1:27888/mcp";

  console.log(`  세션:  ${WHITE}${sessionId}${RESET}`);
  console.log(`  모드:  ${teammateMode}`);
  console.log(`  리드:  ${AMBER}${lead}${RESET}`);
  console.log(`  워커:  ${agents.map((a) => `${AMBER}${a}${RESET}`).join(", ")}`);

  // ── in-process(네이티브): tmux 없이 supervisor가 직접 CLI 프로세스 관리 ──
  if (teammateMode === "in-process") {
    for (let i = 0; i < subtasks.length; i++) {
      const preview = subtasks[i].length > 44 ? subtasks[i].slice(0, 44) + "…" : subtasks[i];
      console.log(`    ${DIM}[${agents[i]}-${i + 1}] ${preview}${RESET}`);
    }
    console.log("");

    const { runtime, members } = await startNativeSupervisor({
      sessionId,
      task,
      lead,
      agents,
      subtasks,
      hubUrl,
    });

    if (!runtime?.controlUrl) {
      fail("in-process supervisor 시작 실패");
      return;
    }

    const tasks = buildTasks(subtasks, members.filter((m) => m.role === "worker"));

    saveTeamState({
      sessionName: sessionId,
      task,
      lead,
      agents,
      layout: "native",
      teammateMode,
      startedAt: Date.now(),
      hubUrl,
      members: members.map((m, idx) => ({
        role: m.role,
        name: m.name,
        cli: m.cli,
        agentId: m.agentId,
        pane: `native:${idx}`,
        subtask: m.subtask || null,
      })),
      panes: {},
      tasks,
      native: {
        controlUrl: runtime.controlUrl,
        supervisorPid: runtime.supervisorPid,
      },
    });

    ok("네이티브 in-process 팀 시작 완료");
    console.log(`  ${DIM}tmux 없이 실행됨 (직접 CLI 프로세스)${RESET}`);
    console.log(`  ${DIM}제어: tfx team send/control/tasks/status${RESET}\n`);
    return;
  }

  // ── tmux 모드 ──
  ensureTmuxOrExit();

  const paneCount = agents.length + 1; // lead + workers
  const effectiveLayout = paneCount <= 4 ? layout : "1xN";
  console.log(`  레이아웃: ${effectiveLayout} (${paneCount} panes)`);

  const session = createSession(sessionId, {
    layout: effectiveLayout,
    paneCount,
  });

  // Pane 0: lead
  const leadTarget = session.panes[0];
  startCliInPane(leadTarget, buildCliCommand(lead));

  // Pane 1..N: workers
  const assignments = [];
  const members = [
    {
      role: "lead",
      name: "lead",
      cli: lead,
      pane: leadTarget,
      agentId: toAgentId(lead, leadTarget),
    },
  ];

  for (let i = 0; i < agents.length; i++) {
    const cli = agents[i];
    const target = session.panes[i + 1];
    startCliInPane(target, buildCliCommand(cli));

    const worker = {
      role: "worker",
      name: `${cli}-${i + 1}`,
      cli,
      pane: target,
      subtask: subtasks[i],
      agentId: toAgentId(cli, target),
    };

    members.push(worker);
    assignments.push({ target, cli, subtask: subtasks[i] });
  }

  for (const worker of members.filter((m) => m.role === "worker")) {
    const preview = worker.subtask.length > 44 ? worker.subtask.slice(0, 44) + "…" : worker.subtask;
    console.log(`    ${DIM}[${worker.name}] ${preview}${RESET}`);
  }
  console.log("");

  ok("CLI 초기화 대기 (3초)...");
  await new Promise((r) => setTimeout(r, 3000));

  await orchestrate(sessionId, assignments, {
    hubUrl,
    teammateMode,
    lead: {
      target: leadTarget,
      cli: lead,
      task,
    },
  });
  ok("리드/워커 프롬프트 주입 완료");

  const tasks = buildTasks(subtasks, members.filter((m) => m.role === "worker"));
  const panes = {};
  for (const m of members) {
    panes[m.pane] = {
      role: m.role,
      name: m.name,
      cli: m.cli,
      agentId: m.agentId,
      subtask: m.subtask || null,
    };
  }

  saveTeamState({
    sessionName: sessionId,
    task,
    lead,
    agents,
    layout: effectiveLayout,
    teammateMode,
    startedAt: Date.now(),
    hubUrl,
    members,
    panes,
    tasks,
  });

  const taskListCommand = `${process.execPath} ${join(PKG_ROOT, "bin", "triflux.mjs")} team tasks`;
  configureTeammateKeybindings(sessionId, {
    inProcess: false,
    taskListCommand,
  });

  console.log(`\n  ${GREEN}${BOLD}팀 세션 준비 완료${RESET}`);
  console.log(`  ${DIM}Shift+Down: 다음 팀메이트 전환${RESET}`);
  console.log(`  ${DIM}Escape: 현재 팀메이트 인터럽트${RESET}`);
  console.log(`  ${DIM}Ctrl+T: 태스크 목록${RESET}`);
  console.log(`  ${DIM}Ctrl+B → D: 세션 분리 (백그라운드)${RESET}\n`);

  if (process.stdout.isTTY && process.stdin.isTTY) {
    attachSession(sessionId);
  } else {
    warn("TTY 미지원 환경이라 자동 attach를 생략함");
    console.log(`  ${DIM}수동 연결: tfx team attach${RESET}\n`);
  }
}

async function teamStatus() {
  const state = loadTeamState();
  if (!state) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }

  const alive = isTeamAlive(state);
  const status = alive ? `${GREEN}● active${RESET}` : `${RED}● dead${RESET}`;
  const uptime = alive ? `${Math.round((Date.now() - state.startedAt) / 60000)}분` : "-";

  console.log(`\n  ${AMBER}${BOLD}⬡ tfx team${RESET} ${status}\n`);
  console.log(`    세션:   ${state.sessionName}`);
  console.log(`    모드:   ${state.teammateMode || "tmux"}`);
  console.log(`    리드:   ${state.lead || "claude"}`);
  console.log(`    워커:   ${(state.agents || []).join(", ")}`);
  console.log(`    Uptime: ${uptime}`);
  console.log(`    태스크: ${(state.tasks || []).length}`);

  const members = state.members || [];
  if (members.length) {
    console.log("");
    for (const m of members) {
      const roleTag = m.role === "lead" ? "lead" : "worker";
      console.log(`    - ${m.name} (${m.cli}) ${DIM}${roleTag}${RESET} ${DIM}${m.pane}${RESET}`);
    }
  }

  if (isNativeMode(state) && alive) {
    const native = await nativeGetStatus(state);
    const nativeMembers = native?.data?.members || [];
    if (nativeMembers.length) {
      console.log("");
      for (const m of nativeMembers) {
        console.log(`    • ${m.name}: ${m.status}${m.lastPreview ? ` ${DIM}${m.lastPreview}${RESET}` : ""}`);
      }
    }
  }

  console.log("");
}

function teamTasks() {
  const state = loadTeamState();
  if (!state || !isTeamAlive(state)) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }
  renderTasks(state.tasks || []);
}

function teamTaskUpdate() {
  const state = loadTeamState();
  if (!state || !isTeamAlive(state)) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }

  const action = (process.argv[4] || "").toLowerCase();
  const taskId = (process.argv[5] || "").toUpperCase();

  const nextStatus = action === "done" || action === "complete" || action === "completed"
    ? "completed"
    : action === "progress" || action === "in-progress" || action === "in_progress"
      ? "in_progress"
      : action === "pending"
        ? "pending"
        : null;

  if (!nextStatus || !taskId) {
    console.log(`\n  사용법: ${WHITE}tfx team task <pending|progress|done> <T1>${RESET}\n`);
    return;
  }

  const tasks = state.tasks || [];
  const target = tasks.find((t) => String(t.id).toUpperCase() === taskId);
  if (!target) {
    console.log(`\n  ${DIM}태스크를 찾을 수 없음: ${taskId}${RESET}\n`);
    return;
  }

  target.status = nextStatus;
  saveTeamState(state);
  ok(`${target.id} 상태 갱신: ${nextStatus}`);
  console.log("");
}

function teamAttach() {
  const state = loadTeamState();
  if (!state || !isTeamAlive(state)) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }

  if (isNativeMode(state)) {
    console.log(`\n  ${DIM}in-process 모드는 별도 attach가 없습니다.${RESET}`);
    console.log(`  ${DIM}상태 확인: tfx team status${RESET}\n`);
    return;
  }

  attachSession(state.sessionName);
}

function teamFocus() {
  const state = loadTeamState();
  if (!state || !isTeamAlive(state)) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }

  if (isNativeMode(state)) {
    console.log(`\n  ${DIM}in-process 모드는 focus/attach 개념이 없습니다.${RESET}`);
    console.log(`  ${DIM}직접 지시: tfx team send <대상> \"메시지\"${RESET}\n`);
    return;
  }

  const selector = process.argv[4];
  const member = resolveMember(state, selector);
  if (!member) {
    console.log(`\n  사용법: ${WHITE}tfx team focus <lead|이름|번호>${RESET}\n`);
    return;
  }

  focusPane(member.pane, { zoom: (state.teammateMode === "in-process") });
  attachSession(state.sessionName);
}

async function teamInterrupt() {
  const state = loadTeamState();
  if (!state || !isTeamAlive(state)) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }

  const selector = process.argv[4] || "lead";
  const member = resolveMember(state, selector);
  if (!member) {
    console.log(`\n  사용법: ${WHITE}tfx team interrupt <lead|이름|번호>${RESET}\n`);
    return;
  }

  if (isNativeMode(state)) {
    const result = await nativeRequest(state, "/interrupt", { member: member.name });
    if (result?.ok) {
      ok(`${member.name} 인터럽트 전송`);
    } else {
      warn(`${member.name} 인터럽트 실패`);
    }
    console.log("");
    return;
  }

  sendKeys(member.pane, "C-c");
  ok(`${member.name} 인터럽트 전송`);
  console.log("");
}

async function teamControl() {
  const state = loadTeamState();
  if (!state || !isTeamAlive(state)) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }

  const selector = process.argv[4];
  const command = (process.argv[5] || "").toLowerCase();
  const reason = process.argv.slice(6).join(" ");
  const member = resolveMember(state, selector);
  const allowed = new Set(["interrupt", "stop", "pause", "resume"]);

  if (!member || !allowed.has(command)) {
    console.log(`\n  사용법: ${WHITE}tfx team control <lead|이름|번호> <interrupt|stop|pause|resume> [사유]${RESET}\n`);
    return;
  }

  // 직접 주입: MCP 유무와 무관하게 즉시 전달
  let directOk = false;
  if (isNativeMode(state)) {
    const direct = await nativeRequest(state, "/control", {
      member: member.name,
      command,
      reason,
    });
    directOk = !!direct?.ok;
  } else {
    const controlMsg = `[LEAD CONTROL] command=${command}${reason ? ` reason=${reason}` : ""}`;
    injectPrompt(member.pane, controlMsg);
    if (command === "interrupt") {
      sendKeys(member.pane, "C-c");
    }
    directOk = true;
  }

  // Hub direct mailbox에도 발행
  const published = await publishLeadControl(state, member, command, reason);

  if (directOk && published) {
    ok(`${member.name} 제어 전송 (${command}, direct + hub)`);
  } else if (directOk) {
    ok(`${member.name} 제어 전송 (${command}, direct only)`);
  } else {
    warn(`${member.name} 제어 전송 실패 (${command})`);
  }
  console.log("");
}

async function teamStop() {
  const state = loadTeamState();
  if (!state) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }

  if (isNativeMode(state)) {
    await nativeRequest(state, "/stop", {});
    try { process.kill(state.native.supervisorPid, "SIGTERM"); } catch {}
    ok(`세션 종료: ${state.sessionName}`);
  } else {
    if (sessionExists(state.sessionName)) {
      killSession(state.sessionName);
      ok(`세션 종료: ${state.sessionName}`);
    } else {
      console.log(`  ${DIM}세션 이미 종료됨${RESET}`);
    }
  }

  clearTeamState();
  console.log("");
}

async function teamKill() {
  const state = loadTeamState();
  if (state && isNativeMode(state) && isTeamAlive(state)) {
    await nativeRequest(state, "/stop", {});
    try { process.kill(state.native.supervisorPid, "SIGTERM"); } catch {}
    clearTeamState();
    ok(`종료: ${state.sessionName}`);
    console.log("");
    return;
  }

  const sessions = listSessions();
  if (sessions.length === 0) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }
  for (const s of sessions) {
    killSession(s);
    ok(`종료: ${s}`);
  }
  clearTeamState();
  console.log("");
}

async function teamSend() {
  const state = loadTeamState();
  if (!state || !isTeamAlive(state)) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }

  const selector = process.argv[4];
  const message = process.argv.slice(5).join(" ");
  const member = resolveMember(state, selector);
  if (!member || !message) {
    console.log(`\n  사용법: ${WHITE}tfx team send <lead|이름|번호> "메시지"${RESET}\n`);
    return;
  }

  if (isNativeMode(state)) {
    const result = await nativeRequest(state, "/send", { member: member.name, text: message });
    if (result?.ok) {
      ok(`${member.name}에 메시지 주입 완료`);
    } else {
      warn(`${member.name} 메시지 주입 실패`);
    }
    console.log("");
    return;
  }

  injectPrompt(member.pane, message);
  ok(`${member.name}에 메시지 주입 완료`);
  console.log("");
}

function teamList() {
  const state = loadTeamState();
  if (state && isNativeMode(state) && isTeamAlive(state)) {
    console.log(`\n  ${AMBER}${BOLD}⬡ 팀 세션 목록${RESET}\n`);
    console.log(`    ${GREEN}●${RESET} ${state.sessionName} ${DIM}(in-process)${RESET}`);
    console.log("");
    return;
  }

  const sessions = listSessions();
  if (sessions.length === 0) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }
  console.log(`\n  ${AMBER}${BOLD}⬡ 팀 세션 목록${RESET}\n`);
  for (const s of sessions) {
    console.log(`    ${GREEN}●${RESET} ${s}`);
  }
  console.log("");
}

function teamHelp() {
  console.log(`
  ${AMBER}${BOLD}⬡ tfx team${RESET} ${DIM}멀티-CLI 팀 모드 (Lead + Teammates)${RESET}

  ${BOLD}시작${RESET}
    ${WHITE}tfx team "작업 설명"${RESET}
    ${WHITE}tfx team --agents codex,gemini --lead claude "작업"${RESET}
    ${WHITE}tfx team --teammate-mode tmux "작업"${RESET}
    ${WHITE}tfx team --teammate-mode in-process "작업"${RESET} ${DIM}(tmux 불필요)${RESET}

  ${BOLD}제어${RESET}
    ${WHITE}tfx team status${RESET}                      ${GRAY}현재 팀 상태${RESET}
    ${WHITE}tfx team tasks${RESET}                       ${GRAY}공유 태스크 목록${RESET}
    ${WHITE}tfx team task${RESET} ${DIM}<pending|progress|done> <T1>${RESET} ${GRAY}태스크 상태 갱신${RESET}
    ${WHITE}tfx team attach${RESET}                      ${GRAY}세션 재연결${RESET}
    ${WHITE}tfx team focus${RESET} ${DIM}<lead|이름|번호>${RESET}      ${GRAY}특정 팀메이트 포커스${RESET}
    ${WHITE}tfx team send${RESET} ${DIM}<lead|이름|번호> "msg"${RESET} ${GRAY}팀메이트에 메시지 주입${RESET}
    ${WHITE}tfx team interrupt${RESET} ${DIM}<대상>${RESET}            ${GRAY}팀메이트 인터럽트(C-c)${RESET}
    ${WHITE}tfx team control${RESET} ${DIM}<대상> <cmd>${RESET}        ${GRAY}리드 제어명령(interrupt|stop|pause|resume)${RESET}
    ${WHITE}tfx team stop${RESET}                        ${GRAY}graceful 종료${RESET}
    ${WHITE}tfx team kill${RESET}                        ${GRAY}모든 팀 세션 강제 종료${RESET}
    ${WHITE}tfx team list${RESET}                        ${GRAY}활성 세션 목록${RESET}

  ${BOLD}키 조작(Claude teammate 스타일, tmux 모드)${RESET}
    ${WHITE}Shift+Down${RESET}  ${GRAY}다음 팀메이트${RESET}
    ${WHITE}Shift+Up${RESET}    ${GRAY}이전 팀메이트${RESET}
    ${WHITE}Escape${RESET}      ${GRAY}현재 팀메이트 인터럽트${RESET}
    ${WHITE}Ctrl+T${RESET}      ${GRAY}태스크 목록 토글${RESET}
`);
}

// ── 메인 진입점 ──

/**
 * tfx team 서브커맨드 라우터
 * bin/triflux.mjs에서 호출
 */
export async function cmdTeam() {
  const sub = process.argv[3];

  switch (sub) {
    case "status":    return teamStatus();
    case "tasks":     return teamTasks();
    case "task":      return teamTaskUpdate();
    case "attach":    return teamAttach();
    case "focus":     return teamFocus();
    case "interrupt": return teamInterrupt();
    case "control":   return teamControl();
    case "stop":      return teamStop();
    case "kill":      return teamKill();
    case "send":      return teamSend();
    case "list":      return teamList();
    case "help":
    case "--help":
    case "-h":
      return teamHelp();
    case undefined:
      return teamHelp();
    default:
      // 서브커맨드가 아니면 작업 문자열로 간주
      if (!sub.startsWith("-") && TEAM_SUBCOMMANDS.has(sub)) {
        return teamHelp();
      }
      return teamStart();
  }
}
