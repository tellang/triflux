// hub/team/cli.mjs — tfx team CLI 진입점
// bin/triflux.mjs에서 import하여 사용
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync, spawn } from "node:child_process";

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
import { orchestrate, decomposeTask } from "./orchestrator.mjs";

// ── 상수 ──
const PKG_ROOT = dirname(dirname(dirname(new URL(import.meta.url).pathname))).replace(/^\/([A-Z]:)/, "$1");
const HUB_PID_DIR = join(homedir(), ".claude", "cache", "tfx-hub");
const HUB_PID_FILE = join(HUB_PID_DIR, "hub.pid");
const TEAM_STATE_FILE = join(HUB_PID_DIR, "team-state.json");

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

  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env },
    stdio: "ignore",
    detached: true,
  });
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

  현재 tfx team의 tmux/in-process 모드는 모두 tmux 기반입니다.

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
    agent_id: leadAgent,
    topic: "lead.control",
    payload: {
      command,
      reason,
      target_agent: targetMember.agentId,
      issued_by: leadAgent,
      issued_at: Date.now(),
    },
  };

  try {
    await fetch(`${hubBase}/bridge/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return true;
  } catch {
    return false;
  }
}

// ── 서브커맨드 ──

async function teamStart() {
  ensureTmuxOrExit();

  const { agents, lead, layout, teammateMode, task } = parseTeamArgs();
  if (!task) {
    console.log(`\n  ${AMBER}${BOLD}⬡ tfx team${RESET}\n`);
    console.log(`  사용법: ${WHITE}tfx team "작업 설명"${RESET}`);
    console.log(`          ${WHITE}tfx team --agents codex,gemini --lead claude "작업"${RESET}`);
    console.log(`          ${WHITE}tfx team --teammate-mode in-process "작업"${RESET}\n`);
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

  const paneCount = agents.length + 1; // lead + workers
  const effectiveLayout = teammateMode === "tmux" && paneCount <= 4 ? layout : "1xN";

  console.log(`  세션:  ${WHITE}${sessionId}${RESET}`);
  console.log(`  모드:  ${teammateMode}`);
  console.log(`  리드:  ${AMBER}${lead}${RESET}`);
  console.log(`  워커:  ${agents.map((a) => `${AMBER}${a}${RESET}`).join(", ")}`);
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

  const hubUrl = hub?.url || "http://127.0.0.1:27888/mcp";
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
    inProcess: teammateMode === "in-process",
    taskListCommand,
  });

  if (teammateMode === "in-process") {
    focusPane(leadTarget, { zoom: true });
  }

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

function teamStatus() {
  const state = loadTeamState();
  if (!state) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }

  const alive = sessionExists(state.sessionName);
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

  console.log("");
}

function teamTasks() {
  const state = loadTeamState();
  if (!state || !sessionExists(state.sessionName)) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }
  renderTasks(state.tasks || []);
}

function teamTaskUpdate() {
  const state = loadTeamState();
  if (!state || !sessionExists(state.sessionName)) {
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
  if (!state || !sessionExists(state.sessionName)) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }
  attachSession(state.sessionName);
}

function teamFocus() {
  const state = loadTeamState();
  if (!state || !sessionExists(state.sessionName)) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
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

function teamInterrupt() {
  const state = loadTeamState();
  if (!state || !sessionExists(state.sessionName)) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }

  const selector = process.argv[4] || "lead";
  const member = resolveMember(state, selector);
  if (!member) {
    console.log(`\n  사용법: ${WHITE}tfx team interrupt <lead|이름|번호>${RESET}\n`);
    return;
  }

  sendKeys(member.pane, "C-c");
  ok(`${member.name} 인터럽트 전송`);
  console.log("");
}

async function teamControl() {
  const state = loadTeamState();
  if (!state || !sessionExists(state.sessionName)) {
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
  const controlMsg = `[LEAD CONTROL] command=${command}${reason ? ` reason=${reason}` : ""}`;
  injectPrompt(member.pane, controlMsg);

  if (command === "interrupt") {
    sendKeys(member.pane, "C-c");
  }

  // Hub에도 발행: 워커 poll_messages 루프가 있으면 메시지 기반으로도 수신
  const published = await publishLeadControl(state, member, command, reason);

  if (published) {
    ok(`${member.name} 제어 전송 (${command}, direct + hub)`);
  } else {
    ok(`${member.name} 제어 전송 (${command}, direct only)`);
  }
  console.log("");
}

function teamStop() {
  const state = loadTeamState();
  if (!state) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }

  if (sessionExists(state.sessionName)) {
    killSession(state.sessionName);
    ok(`세션 종료: ${state.sessionName}`);
  } else {
    console.log(`  ${DIM}세션 이미 종료됨${RESET}`);
  }

  clearTeamState();
  console.log("");
}

function teamKill() {
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

function teamSend() {
  const state = loadTeamState();
  if (!state || !sessionExists(state.sessionName)) {
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

  injectPrompt(member.pane, message);
  ok(`${member.name}에 메시지 주입 완료`);
  console.log("");
}

function teamList() {
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
    ${WHITE}tfx team --teammate-mode in-process "작업"${RESET}

  ${BOLD}제어${RESET}
    ${WHITE}tfx team status${RESET}                      ${GRAY}현재 팀 상태${RESET}
    ${WHITE}tfx team tasks${RESET}                       ${GRAY}공유 태스크 목록${RESET}
    ${WHITE}tfx team task${RESET} ${DIM}<pending|progress|done> <T1>${RESET} ${GRAY}태스크 상태 갱신${RESET}
    ${WHITE}tfx team attach${RESET}                      ${GRAY}세션 재연결${RESET}
    ${WHITE}tfx team focus${RESET} ${DIM}<lead|이름|번호>${RESET}      ${GRAY}특정 팀메이트 포커스${RESET}
    ${WHITE}tfx team send${RESET} ${DIM}<lead|이름|번호> "msg"${RESET} ${GRAY}팀메이트에 메시지 주입${RESET}
    ${WHITE}tfx team interrupt${RESET} ${DIM}<대상>${RESET}            ${GRAY}팀메이트 인터럽트(C-c)${RESET}
    ${WHITE}tfx team control${RESET} ${DIM}<대상> <cmd>${RESET}        ${GRAY}리드 제어명령(interrupt/stop/pause/resume)${RESET}
    ${WHITE}tfx team stop${RESET}                        ${GRAY}graceful 종료${RESET}
    ${WHITE}tfx team kill${RESET}                        ${GRAY}모든 팀 세션 강제 종료${RESET}
    ${WHITE}tfx team list${RESET}                        ${GRAY}활성 세션 목록${RESET}

  ${BOLD}키 조작(Claude teammate 스타일)${RESET}
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
