import { decomposeTask } from "../../../orchestrator.mjs";
import { hasWindowsTerminal, hasWindowsTerminalSession } from "../../../session.mjs";
import { AMBER, BOLD, DIM, GREEN, RED, RESET, WHITE } from "../../../shared.mjs";
import { getDefaultHubUrl, getHubInfo, startHubDaemon } from "../../services/hub-client.mjs";
import { ensureTmuxOrExit } from "../../services/runtime-mode.mjs";
import { saveTeamState } from "../../services/state-store.mjs";
import { fail, ok, warn } from "../../render.mjs";
import { parseTeamArgs } from "./parse-args.mjs";
import { startInProcessTeam } from "./start-in-process.mjs";
import { startMuxTeam } from "./start-mux.mjs";
import { startHeadlessTeam } from "./start-headless.mjs";
import { startWtTeam } from "./start-wt.mjs";

function printStartUsage() {
  console.log(`\n  ${AMBER}${BOLD}⬡ tfx multi${RESET}\n`);
  console.log(`  사용법: ${WHITE}tfx multi "작업 설명"${RESET}`);
  console.log(`          ${WHITE}tfx multi --agents codex,gemini --lead claude "작업"${RESET}`);
  console.log(`          ${WHITE}tfx multi --teammate-mode headless "작업"${RESET} ${DIM}(psmux 헤드리스, 기본)${RESET}`);
  console.log(`          ${WHITE}tfx multi --dashboard-layout auto "작업"${RESET} ${DIM}(dashboard viewer 레이아웃 자동)${RESET}`);
  console.log(`          ${WHITE}tfx multi --dashboard-anchor window "작업"${RESET} ${DIM}(dashboard anchor: window|tab, 기본 window)${RESET}`);
  console.log(`          ${WHITE}tfx multi --teammate-mode wt "작업"${RESET} ${DIM}(Windows Terminal split-pane)${RESET}`);
  console.log(`          ${WHITE}tfx multi --teammate-mode in-process "작업"${RESET} ${DIM}(mux 불필요)${RESET}\n`);
}

function printWorkerPreview(agents, subtasks) {
  for (let index = 0; index < subtasks.length; index += 1) {
    const preview = subtasks[index].length > 44 ? `${subtasks[index].slice(0, 44)}…` : subtasks[index];
    console.log(`    ${DIM}[${agents[index]}-${index + 1}] ${preview}${RESET}`);
  }
  console.log("");
}

function renderTmuxInstallHelp() {
  console.log(`\n  ${RED}${BOLD}tmux 미발견${RESET}\n`);
  console.log("  현재 선택한 모드는 tmux 기반 팀세션이 필요합니다.\n");
  console.log(`  설치:\n    WSL2:   ${WHITE}wsl sudo apt install tmux${RESET}\n    macOS:  ${WHITE}brew install tmux${RESET}\n    Linux:  ${WHITE}apt install tmux${RESET}\n`);
  console.log(`  Windows에서는 WSL2를 권장합니다:\n    1. ${WHITE}wsl --install${RESET}\n    2. ${WHITE}wsl sudo apt install tmux${RESET}\n    3. ${WHITE}tfx multi "작업"${RESET}\n`);
}

export { parseTeamArgs };

export async function teamStart(args = []) {
  const { agents, lead, layout, teammateMode, task: rawTask, assigns, autoAttach, progressive, timeoutSec, verbose, dashboard, dashboardLayout, dashboardSize, dashboardAnchor, mcpProfile, model } = parseTeamArgs(args);
  // --assign 사용 시 task를 자동 생성
  const task = rawTask || (assigns.length > 0 ? assigns.map(a => a.prompt).join(" + ") : "");
  if (!task) return printStartUsage();

  console.log(`\n  ${AMBER}${BOLD}⬡ tfx multi${RESET}\n`);

  // P1b: 워커 수 계산 — 단일 워커 headless에는 Hub 불필요
  const workerCount = assigns.length > 0 ? assigns.length : agents.length;
  const needsHub = workerCount >= 2 || teammateMode !== "headless";

  let hub = null;
  if (needsHub) {
    hub = await getHubInfo();
    if (!hub) {
      process.stdout.write("  Hub 시작 중...");
      try { hub = await startHubDaemon(); } catch (error) { if (error?.code === "HUB_SERVER_MISSING") fail("hub/server.mjs 없음 — hub 모듈이 설치되지 않음"); }
      console.log(` ${hub ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`}`);
      if (!hub) warn("Hub 시작 실패 — 수동으로 실행: tfx hub start");
    } else ok(`Hub: ${DIM}${hub.url}${RESET}`);
  } else {
    ok(`Hub: ${DIM}건너뜀 (단일 워커 headless)${RESET}`);
  }

  const sessionId = `tfx-multi-${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 6)}`;
  const subtasks = decomposeTask(task, agents.length);
  const hubUrl = hub?.url || getDefaultHubUrl();
  let effectiveMode = teammateMode;
  if (effectiveMode === "wt" && !hasWindowsTerminal()) { warn("wt.exe 미발견 — in-process 모드로 자동 fallback"); effectiveMode = "in-process"; }
  if (effectiveMode === "wt" && !hasWindowsTerminalSession()) { warn("WT_SESSION 미감지(Windows Terminal 외부) — in-process 모드로 자동 fallback"); effectiveMode = "in-process"; }

  console.log(`  세션:  ${WHITE}${sessionId}${RESET}`);
  console.log(`  모드:  ${effectiveMode}`);
  console.log(`  리드:  ${AMBER}${lead}${RESET}`);
  console.log(`  워커:  ${agents.map((agent) => `${AMBER}${agent}${RESET}`).join(", ")}`);
  printWorkerPreview(agents, subtasks);

  if (effectiveMode === "tmux") {
    try { ensureTmuxOrExit(); } catch { return renderTmuxInstallHelp(); }
  }

  const state = effectiveMode === "in-process"
    ? await startInProcessTeam({ sessionId, task, lead, agents, subtasks, hubUrl })
    : effectiveMode === "headless"
      ? await startHeadlessTeam({ sessionId, task, lead, agents, subtasks, layout, assigns, autoAttach, progressive, timeoutSec, verbose, dashboard, dashboardLayout, dashboardSize, dashboardAnchor, mcpProfile, model })
      : effectiveMode === "wt"
        ? await startWtTeam({ sessionId, task, lead, agents, subtasks, layout, hubUrl })
        : await startMuxTeam({ sessionId, task, lead, agents, subtasks, layout, hubUrl, teammateMode: effectiveMode });

  if (!state) return fail("in-process supervisor 시작 실패");
  state.sessionId = sessionId;
  saveTeamState(state, sessionId);
  if (typeof state.postSave === "function") state.postSave();
  if (effectiveMode === "in-process") {
    ok("네이티브 in-process 팀 시작 완료");
    console.log(`  ${DIM}tmux 없이 실행됨 (직접 CLI 프로세스)${RESET}`);
    console.log(`  ${DIM}제어: tfx multi send/control/tasks/status${RESET}\n`);
  } else if (effectiveMode === "wt") {
    ok("Windows Terminal wt 팀 시작 완료");
    console.log(`  ${DIM}현재 pane 기준으로 ${state.layout} 분할 생성됨${RESET}`);
    console.log(`  ${DIM}wt 모드는 자동 프롬프트 주입/Hub direct 제어(send/control)가 제한됩니다.${RESET}\n`);
  }
}
