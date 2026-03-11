// hub/team/cli.mjs — tfx team CLI 진입점
// bin/triflux.mjs에서 import하여 사용
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

import {
  createSession,
  createWtSession,
  attachSession,
  resolveAttachCommand,
  killSession,
  closeWtSession,
  sessionExists,
  getSessionAttachedCount,
  listSessions,
  capturePaneOutput,
  focusPane,
  focusWtPane,
  configureTeammateKeybindings,
  detectMultiplexer,
  hasWindowsTerminal,
  hasWindowsTerminalSession,
} from "./session.mjs";
import { buildCliCommand, startCliInPane, injectPrompt, sendKeys } from "./pane.mjs";
import { orchestrate, decomposeTask, buildLeadPrompt, buildPrompt } from "./orchestrator.mjs";
import { AMBER, GREEN, RED, GRAY, DIM, BOLD, RESET, WHITE, YELLOW } from "./shared.mjs";

// ── 상수 ──
const PKG_ROOT = dirname(dirname(dirname(new URL(import.meta.url).pathname))).replace(/^\/([A-Z]:)/, "$1");
const HUB_PID_DIR = join(homedir(), ".claude", "cache", "tfx-hub");
const HUB_PID_FILE = join(HUB_PID_DIR, "hub.pid");
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const TEAM_PROFILE = (() => {
  const raw = String(process.env.TFX_TEAM_PROFILE || "team").trim().toLowerCase();
  return raw === "codex-team" ? "codex-team" : "team";
})();
const TEAM_STATE_FILE = join(
  HUB_PID_DIR,
  TEAM_PROFILE === "codex-team" ? "team-state-codex-team.json" : "team-state.json",
);

const TEAM_SUBCOMMANDS = new Set([
  "status", "attach", "stop", "kill", "send", "list", "help", "tasks", "task", "focus", "interrupt", "control", "debug",
]);

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
  const nextState = { ...state, profile: TEAM_PROFILE };
  writeFileSync(TEAM_STATE_FILE, JSON.stringify(nextState, null, 2) + "\n");
}

function clearTeamState() {
  try { unlinkSync(TEAM_STATE_FILE); } catch {}
}

// ── Hub 유틸 ──

function formatHostForUrl(host) {
  return host.includes(":") ? `[${host}]` : host;
}

function buildHubBaseUrl(host, port) {
  return `http://${formatHostForUrl(host)}:${port}`;
}

function getDefaultHubPort() {
  const envPortRaw = Number(process.env.TFX_HUB_PORT || "27888");
  return Number.isFinite(envPortRaw) && envPortRaw > 0 ? envPortRaw : 27888;
}

function getDefaultHubUrl() {
  return `${buildHubBaseUrl("127.0.0.1", getDefaultHubPort())}/mcp`;
}

function getDefaultHubBase() {
  return getDefaultHubUrl().replace(/\/mcp$/, "");
}

function normalizeLoopbackHost(host) {
  if (typeof host !== "string") return "127.0.0.1";
  const candidate = host.trim();
  return LOOPBACK_HOSTS.has(candidate) ? candidate : "127.0.0.1";
}

async function probeHubStatus(host, port, timeoutMs = 1500) {
  try {
    const res = await fetch(`${buildHubBaseUrl(host, port)}/status`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.hub ? data : null;
  } catch {
    return null;
  }
}

async function getHubInfo() {
  const probePort = getDefaultHubPort();

  if (existsSync(HUB_PID_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(HUB_PID_FILE, "utf8"));
      const pid = Number(raw?.pid);
      if (!Number.isFinite(pid) || pid <= 0) throw new Error("invalid pid");
      process.kill(pid, 0); // 프로세스 생존 확인
      const host = normalizeLoopbackHost(raw?.host);
      const port = Number(raw.port) || 27888;
      const status = await probeHubStatus(host, port, 1200);
      if (!status) {
        // transient timeout/응답 지연은 stale로 단정하지 않고 기존 PID 정보를 유지한다.
        return {
          ...raw,
          pid,
          host,
          port,
          url: `${buildHubBaseUrl(host, port)}/mcp`,
          degraded: true,
        };
      }
      return {
        ...raw,
        pid,
        host,
        port,
        url: `${buildHubBaseUrl(host, port)}/mcp`,
      };
    } catch {
      try { unlinkSync(HUB_PID_FILE); } catch {}
    }
  }

  // PID 파일이 없거나 stale인 경우에도 실제 Hub가 떠 있으면 재사용
  const candidates = Array.from(new Set([probePort, 27888]));
  for (const portCandidate of candidates) {
    const data = await probeHubStatus("127.0.0.1", portCandidate, 1200);
    if (!data) continue;
    const port = Number(data.port) || portCandidate;
    const pid = Number(data.pid);
    const recovered = {
      pid: Number.isFinite(pid) ? pid : null,
      host: "127.0.0.1",
      port,
      url: `${buildHubBaseUrl("127.0.0.1", port)}/mcp`,
      discovered: true,
    };
    if (Number.isFinite(recovered.pid) && recovered.pid > 0) {
      try {
        mkdirSync(HUB_PID_DIR, { recursive: true });
        writeFileSync(HUB_PID_FILE, JSON.stringify({
          pid: recovered.pid,
          port: recovered.port,
          host: recovered.host,
          url: recovered.url,
          started: Date.now(),
        }));
      } catch {}
    }
    return recovered;
  }
  return null;
}

async function startHubDaemon() {
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

  const expectedPort = getDefaultHubPort();

  // Hub 상태 확인 (최대 3초 대기)
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const info = await getHubInfo();
    if (info && info.port === expectedPort) return info;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

// ── 인자 파싱 ──

function normalizeTeammateMode(mode = "auto") {
  const raw = String(mode).toLowerCase();
  if (raw === "inline" || raw === "native") return "in-process";
  if (raw === "in-process" || raw === "tmux" || raw === "wt") return raw;
  if (raw === "windows-terminal" || raw === "windows_terminal") return "wt";
  if (raw === "auto") {
    return process.env.TMUX ? "tmux" : "in-process";
  }
  return "in-process";
}

function normalizeLayout(layout = "2x2") {
  const raw = String(layout).toLowerCase();
  if (raw === "2x2" || raw === "grid") return "2x2";
  if (raw === "1xn" || raw === "1x3" || raw === "vertical" || raw === "columns") return "1xN";
  if (raw === "nx1" || raw === "horizontal" || raw === "rows") return "Nx1";
  return "2x2";
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
    layout: normalizeLayout(layout),
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

async function launchAttachInWindowsTerminal(sessionName) {
  if (!hasWindowsTerminal()) return false;

  let attachSpec;
  try {
    attachSpec = resolveAttachCommand(sessionName);
  } catch {
    return false;
  }

  const launch = (args) => {
    const child = spawn("wt", args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
  };

  const beforeAttached = getSessionAttachedCount(sessionName);

  try {
    // 분할선이 세로(좌/우)가 되도록 -V 우선
    launch(["-w", "0", "split-pane", "-V", "-d", PKG_ROOT, attachSpec.command, ...attachSpec.args]);
    if (beforeAttached == null) {
      return true;
    }

    const deadline = Date.now() + 3500;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 120));
      const nowAttached = getSessionAttachedCount(sessionName);
      if (typeof nowAttached === "number" && nowAttached > beforeAttached) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function buildManualAttachCommand(sessionName) {
  try {
    const spec = resolveAttachCommand(sessionName);
    const quoted = [spec.command, ...spec.args].map((s) => {
      const v = String(s);
      return /\s/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v;
    });
    return quoted.join(" ");
  } catch {
    return `tmux attach-session -t ${sessionName}`;
  }
}

function wantsWtAttachFallback() {
  return process.argv.includes("--wt")
    || process.argv.includes("--spawn-wt")
    || process.env.TFX_ATTACH_WT_AUTO === "1";
}

function toAgentId(cli, target) {
  const suffix = String(target).split(/[:.]/).pop();
  return `${cli}-${suffix}`;
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
    const byPane = members.find((m) => m.pane?.endsWith(`.${n}`) || m.pane?.endsWith(`:${n}`));
    if (byPane) return byPane;

    // teammate 스타일: 1-based 인덱스
    if (n >= 1 && n <= members.length) return members[n - 1];
  }

  return null;
}

async function publishLeadControl(state, targetMember, command, reason = "") {
  const hubBase = (state?.hubUrl || getDefaultHubUrl()).replace(/\/mcp$/, "");
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

function isWtMode(state) {
  return state?.teammateMode === "wt";
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
  if (isWtMode(state)) {
    // WT pane 상태를 신뢰성 있게 조회할 API가 없어, WT_SESSION은 힌트로만 사용한다.
    if (!hasWindowsTerminal()) return false;
    if (hasWindowsTerminalSession()) return true;
    return Array.isArray(state.members) && state.members.length > 0;
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
    console.log(`          ${WHITE}tfx team --teammate-mode wt "작업"${RESET} ${DIM}(Windows Terminal split-pane)${RESET}`);
    console.log(`          ${WHITE}tfx team --teammate-mode in-process "작업"${RESET} ${DIM}(tmux 불필요)${RESET}\n`);
    return;
  }

  console.log(`\n  ${AMBER}${BOLD}⬡ tfx team${RESET}\n`);

  let hub = await getHubInfo();
  if (!hub) {
    process.stdout.write("  Hub 시작 중...");
    hub = await startHubDaemon();
    if (hub) {
      console.log(` ${GREEN}✓${RESET}`);
    } else {
      console.log(` ${RED}✗${RESET}`);
      warn("Hub 시작 실패 — 수동으로 실행: tfx hub start");
    }
  } else {
    ok(`Hub: ${DIM}${hub.url}${RESET}`);
  }

  const sessionId = `tfx-team-${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 6)}`;
  const subtasks = decomposeTask(task, agents.length);
  const hubUrl = hub?.url || getDefaultHubUrl();
  let effectiveTeammateMode = teammateMode;

  if (teammateMode === "wt") {
    if (!hasWindowsTerminal()) {
      warn("wt.exe 미발견 — in-process 모드로 자동 fallback");
      effectiveTeammateMode = "in-process";
    } else if (!hasWindowsTerminalSession()) {
      warn("WT_SESSION 미감지(Windows Terminal 외부) — in-process 모드로 자동 fallback");
      effectiveTeammateMode = "in-process";
    }
  }

  console.log(`  세션:  ${WHITE}${sessionId}${RESET}`);
  console.log(`  모드:  ${effectiveTeammateMode}`);
  console.log(`  리드:  ${AMBER}${lead}${RESET}`);
  console.log(`  워커:  ${agents.map((a) => `${AMBER}${a}${RESET}`).join(", ")}`);

  // ── in-process(네이티브): tmux 없이 supervisor가 직접 CLI 프로세스 관리 ──
  if (effectiveTeammateMode === "in-process") {
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
      teammateMode: effectiveTeammateMode,
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

  // ── wt 모드(Windows Terminal 독립 split-pane) ──
  if (effectiveTeammateMode === "wt") {
    const paneCount = agents.length + 1; // lead + workers
    const effectiveLayout = layout === "Nx1" ? "Nx1" : "1xN";
    if (layout !== effectiveLayout) {
      warn(`wt 모드에서 ${layout} 레이아웃은 미지원 — ${effectiveLayout}로 대체`);
    }
    console.log(`  레이아웃: ${effectiveLayout} (${paneCount} panes)`);

    const paneCommands = [
      {
        title: `${sessionId}-lead`,
        command: buildCliCommand(lead),
        cwd: PKG_ROOT,
      },
      ...agents.map((cli, i) => ({
        title: `${sessionId}-${cli}-${i + 1}`,
        command: buildCliCommand(cli),
        cwd: PKG_ROOT,
      })),
    ];

    const session = createWtSession(sessionId, {
      layout: effectiveLayout,
      paneCommands,
    });

    const members = [
      {
        role: "lead",
        name: "lead",
        cli: lead,
        pane: session.panes[0] || "wt:0",
        agentId: toAgentId(lead, session.panes[0] || "wt:0"),
      },
    ];

    for (let i = 0; i < agents.length; i++) {
      const cli = agents[i];
      const target = session.panes[i + 1] || `wt:${i + 1}`;
      members.push({
        role: "worker",
        name: `${cli}-${i + 1}`,
        cli,
        pane: target,
        subtask: subtasks[i],
        agentId: toAgentId(cli, target),
      });
    }

    for (const worker of members.filter((m) => m.role === "worker")) {
      const preview = worker.subtask.length > 44 ? worker.subtask.slice(0, 44) + "…" : worker.subtask;
      console.log(`    ${DIM}[${worker.name}] ${preview}${RESET}`);
    }
    console.log("");

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
      teammateMode: effectiveTeammateMode,
      startedAt: Date.now(),
      hubUrl,
      members,
      panes,
      tasks,
      wt: {
        windowId: 0,
        layout: effectiveLayout,
        paneCount: session.paneCount,
      },
    });

    ok("Windows Terminal wt 팀 시작 완료");
    console.log(`  ${DIM}현재 pane 기준으로 ${effectiveLayout} 분할 생성됨${RESET}`);
    console.log(`  ${DIM}wt 모드는 자동 프롬프트 주입/Hub direct 제어(send/control)가 제한됩니다.${RESET}\n`);
    return;
  }

  // ── tmux 모드 ──
  ensureTmuxOrExit();

  const paneCount = agents.length + 1; // lead + workers
  const effectiveLayout = paneCount <= 4 ? layout : (layout === "Nx1" ? "Nx1" : "1xN");
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
    teammateMode: effectiveTeammateMode,
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
    teammateMode: effectiveTeammateMode,
    startedAt: Date.now(),
    hubUrl,
    members,
    panes,
    tasks,
  });

  const profilePrefix = TEAM_PROFILE === "team" ? "" : `TFX_TEAM_PROFILE=${TEAM_PROFILE} `;
  const taskListCommand = `${profilePrefix}${process.execPath} ${join(PKG_ROOT, "bin", "triflux.mjs")} team tasks`;
  configureTeammateKeybindings(sessionId, {
    inProcess: false,
    taskListCommand,
  });

  console.log(`\n  ${GREEN}${BOLD}팀 세션 준비 완료${RESET}`);
  console.log(`  ${DIM}Shift+Down: 다음 팀메이트 전환${RESET}`);
  console.log(`  ${DIM}Shift+Tab / Shift+Left: 이전 팀메이트 전환${RESET}`);
  console.log(`  ${DIM}Escape: 현재 팀메이트 인터럽트${RESET}`);
  console.log(`  ${DIM}Ctrl+T: 태스크 목록${RESET}`);
  console.log(`  ${DIM}참고: Shift+Up은 Claude Code 미지원 (scroll-up 충돌). Shift+Tab 사용${RESET}`);
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
  if (isWtMode(state) && !hasWindowsTerminalSession()) {
    console.log(`    ${DIM}WT_SESSION 미감지: 생존성은 heuristics로 판정됨${RESET}`);
  }

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

  // Hub task-list 데이터 통합 (v2.2)
  if (alive) {
    const hubTasks = await fetchHubTaskList(state);
    if (hubTasks.length > 0) {
      const completed = hubTasks.filter((t) => t.status === "completed").length;
      const inProgress = hubTasks.filter((t) => t.status === "in_progress").length;
      const failed = hubTasks.filter((t) => t.status === "failed").length;
      const pending = hubTasks.filter((t) => !t.status || t.status === "pending").length;

      console.log(`\n  ${BOLD}Hub Tasks${RESET} ${DIM}(${completed}/${hubTasks.length} done)${RESET}`);
      for (const t of hubTasks) {
        const icon = t.status === "completed" ? `${GREEN}✓${RESET}`
          : t.status === "in_progress" ? `${AMBER}●${RESET}`
          : t.status === "failed" ? `${RED}✗${RESET}`
          : `${GRAY}○${RESET}`;
        const owner = t.owner ? ` ${GRAY}[${t.owner}]${RESET}` : "";
        const subject = t.subject || t.description?.slice(0, 50) || "";
        console.log(`    ${icon} ${subject}${owner}`);
      }
      if (failed > 0) console.log(`    ${RED}⚠ ${failed}건 실패${RESET}`);
    }
  }

  console.log("");
}

/**
 * Hub bridge에서 팀 task-list 조회 (v2.2)
 * @param {object} state — team-state.json
 * @returns {Promise<Array>}
 */
async function fetchHubTaskList(state) {
  const hubBase = (state?.hubUrl || getDefaultHubUrl()).replace(/\/mcp$/, "");
  // teamName: native 모드는 state에 저장된 팀 이름, SKILL.md 모드는 세션 이름 기반
  const teamName = state?.native?.teamName || state?.sessionName || null;
  if (!teamName) return [];
  try {
    const res = await fetch(`${hubBase}/bridge/team/task-list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ team_name: teamName }),
      signal: AbortSignal.timeout(2000),
    });
    const data = await res.json();
    return data?.ok ? (data.data?.tasks || []) : [];
  } catch {
    return [];
  }
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

async function teamAttach() {
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

  if (isWtMode(state)) {
    console.log(`\n  ${DIM}wt 모드는 attach 개념이 없습니다 (Windows Terminal pane가 독립 실행됨).${RESET}`);
    console.log(`  ${DIM}재실행/정리는: tfx team stop${RESET}\n`);
    return;
  }

  try {
    attachSession(state.sessionName);
  } catch (e) {
    const allowWt = wantsWtAttachFallback();
    if (allowWt && await launchAttachInWindowsTerminal(state.sessionName)) {
      warn(`현재 터미널에서 attach 실패: ${e.message}`);
      ok("Windows Terminal split-pane로 attach 재시도 창을 열었습니다.");
      console.log(`  ${DIM}수동 attach 명령: ${buildManualAttachCommand(state.sessionName)}${RESET}`);
      console.log("");
      return;
    }
    fail(`attach 실패: ${e.message}`);
    if (allowWt) {
      fail("WT 분할창 attach 자동 검증 실패 (session_attached 증가 없음)");
    } else {
      warn("자동 WT 분할은 기본 비활성입니다. 필요 시 --wt 옵션으로 실행하세요.");
    }
    console.log(`  ${DIM}수동 attach 명령: ${buildManualAttachCommand(state.sessionName)}${RESET}`);
    console.log("");
    return;
  }
}

async function teamDebug() {
  const state = loadTeamState();
  const linesIdx = process.argv.findIndex((a) => a === "--lines" || a === "-n");
  const lines = linesIdx !== -1 ? Math.max(3, parseInt(process.argv[linesIdx + 1] || "20", 10) || 20) : 20;
  const mux = detectMultiplexer() || "none";
  const hub = await getHubInfo();

  console.log(`\n  ${AMBER}${BOLD}⬡ Team Debug${RESET}\n`);
  console.log(`    platform:  ${process.platform}`);
  console.log(`    node:      ${process.version}`);
  console.log(`    tty:       stdout=${!!process.stdout.isTTY}, stdin=${!!process.stdin.isTTY}`);
  console.log(`    mux:       ${mux}`);
  console.log(`    hub-pid:   ${hub ? `${hub.pid}` : "-"}`);
  console.log(`    hub-url:   ${hub?.url || "-"}`);

  const sessions = listSessions();
  console.log(`    sessions:  ${sessions.length ? sessions.join(", ") : "-"}`);

  if (!state) {
    console.log(`\n  ${DIM}team-state 없음 (활성 세션 없음)${RESET}\n`);
    return;
  }

  console.log(`\n  ${BOLD}state${RESET}`);
  console.log(`    session:   ${state.sessionName}`);
  console.log(`    profile:   ${state.profile || TEAM_PROFILE}`);
  console.log(`    mode:      ${state.teammateMode || "tmux"}`);
  console.log(`    lead:      ${state.lead}`);
  console.log(`    agents:    ${(state.agents || []).join(", ")}`);
  console.log(`    alive:     ${isTeamAlive(state) ? "yes" : "no"}`);
  const attached = getSessionAttachedCount(state.sessionName);
  console.log(`    attached:  ${attached == null ? "-" : attached}`);

  if (isWtMode(state)) {
    const wtState = state.wt || {};
    console.log(`\n  ${BOLD}wt-session${RESET}`);
    console.log(`    window:    ${wtState.windowId ?? 0}`);
    console.log(`    layout:    ${wtState.layout || state.layout || "-"}`);
    console.log(`    panes:     ${wtState.paneCount ?? (state.members || []).length}`);
    console.log(`    wt.exe:    ${hasWindowsTerminal() ? "yes" : "no"}`);
    console.log(`    WT_SESSION:${hasWindowsTerminalSession() ? "yes" : "no"}`);
    console.log("");
    return;
  }

  if (isNativeMode(state)) {
    const native = await nativeGetStatus(state);
    const members = native?.data?.members || [];
    console.log(`\n  ${BOLD}native-members${RESET}`);
    if (!members.length) {
      console.log(`    ${DIM}(no data)${RESET}`);
    } else {
      for (const m of members) {
        console.log(`    - ${m.name}: ${m.status}${m.lastPreview ? ` ${DIM}${m.lastPreview}${RESET}` : ""}`);
      }
    }
    console.log("");
    return;
  }

  const members = state.members || [];
  console.log(`\n  ${BOLD}pane-tail${RESET} ${DIM}(last ${lines} lines)${RESET}`);
  if (!members.length) {
    console.log(`    ${DIM}(members 없음)${RESET}`);
  } else {
    for (const m of members) {
      const tail = capturePaneOutput(m.pane, lines) || "(empty)";
      console.log(`\n    [${m.name}] ${m.pane}`);
      const tailLines = tail.split("\n").slice(-lines);
      for (const line of tailLines) {
        console.log(`      ${line}`);
      }
    }
  }
  console.log("");
}

async function teamFocus() {
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

  if (isWtMode(state)) {
    const m = /^wt:(\d+)$/.exec(member.pane || "");
    const paneIndex = m ? parseInt(m[1], 10) : NaN;
    if (!Number.isFinite(paneIndex)) {
      warn(`wt pane 인덱스 파싱 실패: ${member.pane}`);
      console.log("");
      return;
    }
    const focused = focusWtPane(paneIndex, {
      layout: state?.wt?.layout || state?.layout || "1xN",
    });
    if (focused) {
      ok(`${member.name} pane 포커스 이동 (wt)`);
    } else {
      warn("wt pane 포커스 이동 실패 (WT_SESSION/wt.exe 상태 확인 필요)");
    }
    console.log("");
    return;
  }

  focusPane(member.pane, { zoom: (state.teammateMode === "in-process") });
  try {
    attachSession(state.sessionName);
  } catch (e) {
    const allowWt = wantsWtAttachFallback();
    if (allowWt && await launchAttachInWindowsTerminal(state.sessionName)) {
      warn(`현재 터미널에서 attach 실패: ${e.message}`);
      ok("Windows Terminal split-pane로 attach 재시도 창을 열었습니다.");
      console.log(`  ${DIM}수동 attach 명령: ${buildManualAttachCommand(state.sessionName)}${RESET}`);
      console.log("");
      return;
    }
    fail(`attach 실패: ${e.message}`);
    if (allowWt) {
      fail("WT 분할창 attach 자동 검증 실패 (session_attached 증가 없음)");
    } else {
      warn("자동 WT 분할은 기본 비활성입니다. 필요 시 --wt 옵션으로 실행하세요.");
    }
    console.log(`  ${DIM}수동 attach 명령: ${buildManualAttachCommand(state.sessionName)}${RESET}`);
    console.log("");
    return;
  }
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

  if (isWtMode(state)) {
    warn("wt 모드에서는 pane stdin 주입이 지원되지 않아 interrupt를 자동 전송할 수 없습니다.");
    console.log(`  ${DIM}수동으로 해당 pane에서 Ctrl+C를 입력하세요.${RESET}`);
    console.log("");
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

  if (isWtMode(state)) {
    warn("wt 모드는 Hub direct/control 주입 경로가 비활성입니다.");
    console.log(`  ${DIM}수동 제어: 해당 pane에서 직접 명령/인터럽트를 수행하세요.${RESET}`);
    console.log("");
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
  } else if (isWtMode(state)) {
    const closed = closeWtSession({
      layout: state?.wt?.layout || state?.layout || "1xN",
      paneCount: state?.wt?.paneCount ?? (state.members || []).length,
    });
    ok(`세션 종료: ${state.sessionName}${closed ? ` (${closed} panes closed)` : ""}`);
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
  if (state && isWtMode(state)) {
    const closed = closeWtSession({
      layout: state?.wt?.layout || state?.layout || "1xN",
      paneCount: state?.wt?.paneCount ?? (state.members || []).length,
    });
    clearTeamState();
    ok(`종료: ${state.sessionName}${closed ? ` (${closed} panes closed)` : ""}`);
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

  if (isWtMode(state)) {
    warn("wt 모드는 pane 프롬프트 자동 주입(send)이 지원되지 않습니다.");
    console.log(`  ${DIM}수동 전달: 선택한 pane에 직접 붙여넣으세요.${RESET}`);
    console.log("");
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
  if (state && isWtMode(state) && isTeamAlive(state)) {
    console.log(`\n  ${AMBER}${BOLD}⬡ 팀 세션 목록${RESET}\n`);
    console.log(`    ${GREEN}●${RESET} ${state.sessionName} ${DIM}(wt)${RESET}`);
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
    ${WHITE}tfx team --teammate-mode wt "작업"${RESET}   ${DIM}(Windows Terminal split-pane)${RESET}
    ${WHITE}tfx team --layout 1xN "작업"${RESET}               ${DIM}(세로 분할 컬럼)${RESET}
    ${WHITE}tfx team --layout Nx1 "작업"${RESET}               ${DIM}(가로 분할 스택)${RESET}
    ${WHITE}tfx team --teammate-mode in-process "작업"${RESET} ${DIM}(tmux 불필요)${RESET}

  ${BOLD}제어${RESET}
    ${WHITE}tfx team status${RESET}                      ${GRAY}현재 팀 상태${RESET}
    ${WHITE}tfx team debug${RESET} ${DIM}[--lines 30]${RESET}          ${GRAY}강화 디버그 출력(환경/세션/pane tail)${RESET}
    ${WHITE}tfx team tasks${RESET}                       ${GRAY}공유 태스크 목록${RESET}
    ${WHITE}tfx team task${RESET} ${DIM}<pending|progress|done> <T1>${RESET} ${GRAY}태스크 상태 갱신${RESET}
    ${WHITE}tfx team attach${RESET} ${DIM}[--wt]${RESET}               ${GRAY}세션 재연결 (WT 분할은 opt-in)${RESET}
    ${WHITE}tfx team focus${RESET} ${DIM}<lead|이름|번호> [--wt]${RESET} ${GRAY}특정 팀메이트 포커스${RESET}
    ${WHITE}tfx team send${RESET} ${DIM}<lead|이름|번호> "msg"${RESET} ${GRAY}팀메이트에 메시지 주입${RESET}
    ${WHITE}tfx team interrupt${RESET} ${DIM}<대상>${RESET}            ${GRAY}팀메이트 인터럽트(C-c)${RESET}
    ${WHITE}tfx team control${RESET} ${DIM}<대상> <cmd>${RESET}        ${GRAY}리드 제어명령(interrupt|stop|pause|resume)${RESET}
    ${WHITE}tfx team stop${RESET}                        ${GRAY}graceful 종료${RESET}
    ${WHITE}tfx team kill${RESET}                        ${GRAY}모든 팀 세션 강제 종료${RESET}
    ${WHITE}tfx team list${RESET}                        ${GRAY}활성 세션 목록${RESET}

  ${BOLD}키 조작(Claude teammate 스타일, tmux 모드)${RESET}
    ${WHITE}Shift+Down${RESET}  ${GRAY}다음 팀메이트${RESET}
    ${WHITE}Shift+Tab${RESET}   ${GRAY}이전 팀메이트 (권장)${RESET}
    ${WHITE}Shift+Left${RESET}  ${GRAY}이전 팀메이트 (대체)${RESET}
    ${WHITE}Shift+Up${RESET}    ${GRAY}미지원 (Claude Code가 캡처 불가, scroll-up 충돌)${RESET}
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
  const rawSub = process.argv[3];
  const sub = typeof rawSub === "string" ? rawSub.toLowerCase() : rawSub;

  switch (sub) {
    case "status":    return teamStatus();
    case "debug":     return teamDebug();
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
      if (typeof sub === "string" && !sub.startsWith("-") && TEAM_SUBCOMMANDS.has(sub)) {
        return teamHelp();
      }
      return teamStart();
  }
}
