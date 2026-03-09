// hub/team/cli.mjs — tfx team CLI 진입점
// bin/triflux.mjs에서 import하여 사용
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync, spawn } from "node:child_process";

import { createSession, attachSession, killSession, sessionExists, listSessions, capturePaneOutput } from "./session.mjs";
import { buildCliCommand, startCliInPane, injectPrompt, sendKeys } from "./pane.mjs";
import { orchestrate, decomposeTask } from "./orchestrator.mjs";
import { detectMultiplexer } from "./session.mjs";

// ── 상수 ──
const PKG_ROOT = dirname(dirname(dirname(new URL(import.meta.url).pathname))).replace(/^\/([A-Z]:)/, "$1");
const HUB_PID_DIR = join(homedir(), ".claude", "cache", "tfx-hub");
const HUB_PID_FILE = join(HUB_PID_DIR, "hub.pid");
const TEAM_STATE_FILE = join(HUB_PID_DIR, "team-state.json");

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

function parseTeamArgs() {
  const args = process.argv.slice(3);
  let agents = ["codex", "codex", "gemini"]; // 기본: codex x2 + gemini
  let layout = "2x2";
  let task = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--agents" && args[i + 1]) {
      agents = args[++i].split(",").map((s) => s.trim().toLowerCase());
    } else if (args[i] === "--layout" && args[i + 1]) {
      layout = args[++i];
    } else if (!args[i].startsWith("-")) {
      task = args[i];
    }
  }

  return { agents, layout, task };
}

// ── 서브커맨드 ──

async function teamStart() {
  // 1. tmux 확인
  const mux = detectMultiplexer();
  if (!mux) {
    console.log(`
  ${RED}${BOLD}tmux 미발견${RESET}

  tfx team은 tmux가 필요합니다:
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

  // 2. 인자 파싱
  const { agents, layout, task } = parseTeamArgs();
  if (!task) {
    console.log(`\n  ${AMBER}${BOLD}⬡ tfx team${RESET}\n`);
    console.log(`  사용법: ${WHITE}tfx team "작업 설명"${RESET}`);
    console.log(`          ${WHITE}tfx team --agents codex,gemini "작업"${RESET}`);
    console.log(`          ${WHITE}tfx team --layout 1x3 "작업"${RESET}\n`);
    return;
  }

  // 3. Hub 확인 + lazy-start
  console.log(`\n  ${AMBER}${BOLD}⬡ tfx team${RESET}\n`);
  let hub = getHubInfo();
  if (!hub) {
    process.stdout.write(`  Hub 시작 중...`);
    hub = startHubDaemon();
    if (hub) {
      console.log(` ${GREEN}✓${RESET}`);
    } else {
      console.log(` ${RED}✗${RESET}`);
      warn("Hub 시작 실패 — 수동으로 실행: tfx hub start");
      // Hub 없이도 계속 진행 (통신만 불가)
    }
  } else {
    ok(`Hub: ${DIM}${hub.url}${RESET}`);
  }

  // 4. 세션 ID 생성
  const sessionId = `tfx-team-${Date.now().toString(36).slice(-4)}`;

  // 5. 작업 분해
  const subtasks = decomposeTask(task, agents.length);

  console.log(`  세션:  ${WHITE}${sessionId}${RESET}`);
  console.log(`  레이아웃: ${layout} (${agents.length + 1} panes)`);
  console.log(`  에이전트: ${agents.map((a) => `${AMBER}${a}${RESET}`).join(", ")}`);
  for (let i = 0; i < subtasks.length; i++) {
    const preview = subtasks[i].length > 40 ? subtasks[i].slice(0, 40) + "…" : subtasks[i];
    console.log(`    ${DIM}[${agents[i]}] ${preview}${RESET}`);
  }
  console.log("");

  // 6. tmux 세션 생성
  const session = createSession(sessionId, {
    layout,
    paneCount: agents.length + 1, // +1 for dashboard
  });

  // 7. Dashboard 시작 (Pane 0)
  const dashCmd = `node ${PKG_ROOT}/hub/team/dashboard.mjs --session ${sessionId} --interval 2`;
  startCliInPane(session.panes[0], dashCmd);

  // 8. CLI 에이전트 시작 (Pane 1~N)
  const assignments = [];
  for (let i = 0; i < agents.length; i++) {
    const cli = agents[i];
    const target = session.panes[i + 1];
    const command = buildCliCommand(cli);
    startCliInPane(target, command);
    assignments.push({ target, cli, subtask: subtasks[i] });
  }

  // 9. CLI 초기화 대기 (3초 — interactive 모드 진입 시간)
  ok("CLI 초기화 대기 (3초)...");
  await new Promise((r) => setTimeout(r, 3000));

  // 10. 프롬프트 주입
  const hubUrl = hub?.url || "http://127.0.0.1:27888/mcp";
  await orchestrate(sessionId, assignments, { hubUrl });
  ok("프롬프트 주입 완료");

  // 11. 팀 상태 저장
  const panes = { [session.panes[0]]: { role: "dashboard" } };
  for (let i = 0; i < agents.length; i++) {
    panes[session.panes[i + 1]] = {
      cli: agents[i],
      agentId: `${agents[i]}-${session.panes[i + 1].split(".").pop()}`,
      subtask: subtasks[i],
    };
  }
  saveTeamState({
    sessionName: sessionId,
    agents,
    task,
    layout,
    startedAt: Date.now(),
    hubUrl,
    panes,
  });

  // 12. tmux attach
  console.log(`\n  ${GREEN}${BOLD}팀 세션 준비 완료${RESET}`);
  console.log(`  ${DIM}Ctrl+B → 방향키로 pane 전환${RESET}`);
  console.log(`  ${DIM}Ctrl+B → D로 세션 분리 (백그라운드)${RESET}\n`);
  attachSession(sessionId);
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
  console.log(`    작업:   ${state.task}`);
  console.log(`    에이전트: ${state.agents.join(", ")}`);
  console.log(`    Uptime: ${uptime}`);
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

  // 상태 파일 정리
  clearTeamState();
  console.log("");
}

function teamKill() {
  // 모든 tfx-team- 세션 강제 종료
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

  const paneIdx = parseInt(process.argv[4], 10);
  const message = process.argv.slice(5).join(" ");
  if (isNaN(paneIdx) || !message) {
    console.log(`\n  사용법: ${WHITE}tfx team send <pane번호> "메시지"${RESET}\n`);
    return;
  }

  const target = `${state.sessionName}:0.${paneIdx}`;
  injectPrompt(target, message);
  ok(`Pane ${paneIdx}에 메시지 주입 완료`);
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
  ${AMBER}${BOLD}⬡ tfx team${RESET} ${DIM}멀티-CLI 팀 모드 (tmux + Hub)${RESET}

  ${BOLD}시작${RESET}
    ${WHITE}tfx team "작업 설명"${RESET}           ${GRAY}기본 (codex x2 + gemini)${RESET}
    ${WHITE}tfx team --agents codex,gemini "작업"${RESET}  ${GRAY}에이전트 지정${RESET}
    ${WHITE}tfx team --layout 1x3 "작업"${RESET}    ${GRAY}레이아웃 지정${RESET}

  ${BOLD}제어${RESET}
    ${WHITE}tfx team status${RESET}    ${GRAY}현재 팀 상태${RESET}
    ${WHITE}tfx team attach${RESET}    ${GRAY}tmux 세션 연결${RESET}
    ${WHITE}tfx team send${RESET} ${DIM}N "msg"${RESET}  ${GRAY}Pane N에 입력${RESET}
    ${WHITE}tfx team stop${RESET}      ${GRAY}graceful 종료${RESET}
    ${WHITE}tfx team kill${RESET}      ${GRAY}모든 팀 세션 강제 종료${RESET}
    ${WHITE}tfx team list${RESET}      ${GRAY}활성 세션 목록${RESET}
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
    case "status":  return teamStatus();
    case "attach":  return teamAttach();
    case "stop":    return teamStop();
    case "kill":    return teamKill();
    case "send":    return teamSend();
    case "list":    return teamList();
    case "help": case "--help": case "-h":
      return teamHelp();
    case undefined:
      return teamHelp();
    default:
      return teamStart();
  }
}
