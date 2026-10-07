import { decomposeTask } from "../../../orchestrator.mjs";
import { AMBER, BOLD, DIM, RESET, WHITE } from "../../../shared.mjs";
import { fail } from "../../render.mjs";
import {
  ensureTmuxOrExit,
  normalizeTeammateMode,
} from "../../services/runtime-mode.mjs";
import { saveTeamState } from "../../services/state-store.mjs";
import { parseTeamArgs } from "./parse-args.mjs";
import { startHeadlessTeam } from "./start-headless.mjs";
import { startMuxTeam } from "./start-mux.mjs";

function printStartUsage() {
  console.log(`\n  ${AMBER}${BOLD}⬡ tfx multi${RESET}\n`);
  console.log(`  사용법: ${WHITE}tfx multi "작업 설명"${RESET}`);
  console.log(
    `          ${WHITE}tfx multi --agents codex,antigravity --lead claude "작업"${RESET}`,
  );
  console.log(
    `          ${WHITE}tfx multi --teammate-mode headless "작업"${RESET} ${DIM}(headless workers)${RESET}`,
  );
  console.log(
    `          ${WHITE}tfx multi --dashboard-layout lite "작업"${RESET} ${DIM}(dashboard-lite 기본 뷰)${RESET}`,
  );
  console.log(
    `          ${WHITE}tfx multi --dashboard-layout auto "작업"${RESET} ${DIM}(dashboard viewer 레이아웃 자동)${RESET}`,
  );
  console.log(
    `          ${WHITE}tfx multi --dashboard-anchor window "작업"${RESET} ${DIM}(dashboard anchor: window|tab, 기본 window)${RESET}`,
  );
}

function printWorkerPreview(agents, subtasks) {
  for (let index = 0; index < subtasks.length; index += 1) {
    const preview =
      subtasks[index].length > 44
        ? `${subtasks[index].slice(0, 44)}…`
        : subtasks[index];
    console.log(`    ${DIM}[${agents[index]}-${index + 1}] ${preview}${RESET}`);
  }
  console.log("");
}

export { parseTeamArgs };

export function resolveTeamWorkers({ agents, task, assigns = [] }) {
  if (assigns.length > 0) {
    return {
      agents: assigns.map((assign) => assign.cli),
      subtasks: assigns.map((assign) => assign.prompt),
    };
  }
  return { agents, subtasks: decomposeTask(task, agents.length) };
}

export async function teamStart(args = []) {
  const {
    agents: requestedAgents,
    lead,
    layout,
    teammateMode,
    task: rawTask,
    assigns,
    autoAttach,
    progressive,
    timeoutSec,
    verbose,
    dashboard,
    dashboardLayout,
    dashboardSize,
    dashboardAnchor,
    mcpProfile,
    model,
    cwd,
    nativeBridge,
    nativeBridgeMode,
    nativeBridgeUiOptOut,
  } = parseTeamArgs(args);
  // --assign 사용 시 task를 자동 생성
  const task =
    rawTask ||
    (assigns.length > 0 ? assigns.map((a) => a.prompt).join(" + ") : "");
  if (!task) return printStartUsage();
  const { agents, subtasks } = resolveTeamWorkers({
    agents: requestedAgents,
    task,
    assigns,
  });

  const effectiveMode = normalizeTeammateMode(teammateMode);
  // headless 워커도 tmux 방에서 돈다. 방이 없으면 claude agents 행도 열 수 없다.
  ensureTmuxOrExit();
  const effectiveNativeBridge =
    effectiveMode === "headless" && !nativeBridgeUiOptOut ? true : nativeBridge;

  console.log(`\n  ${AMBER}${BOLD}⬡ tfx multi${RESET}\n`);

  const sessionId = `tfx-multi-${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 6)}`;

  console.log(`  세션:  ${WHITE}${sessionId}${RESET}`);
  console.log(`  모드:  ${effectiveMode}`);
  console.log(`  리드:  ${AMBER}${lead}${RESET}`);
  console.log(
    `  워커:  ${agents.map((agent) => `${AMBER}${agent}${RESET}`).join(", ")}`,
  );
  printWorkerPreview(agents, subtasks);

  if (effectiveMode === "headless") {
    return startHeadlessTeam({
      sessionId,
      task,
      lead,
      agents,
      subtasks,
      layout,
      assigns,
      autoAttach,
      progressive,
      timeoutSec,
      verbose,
      dashboard,
      dashboardLayout,
      dashboardSize,
      dashboardAnchor,
      mcpProfile,
      model,
      cwd,
      nativeBridge: effectiveNativeBridge,
      nativeBridgeMode,
    });
  }

  const state = await startMuxTeam({
    sessionId,
    task,
    lead,
    agents,
    subtasks,
    layout,
    teammateMode: effectiveMode,
  });

  if (!state) return fail("팀 세션 시작 실패");
  state.sessionId = sessionId;
  saveTeamState(state, sessionId);
  if (typeof state.postSave === "function") state.postSave();
}
