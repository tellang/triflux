import { DIM, RESET, WHITE } from "../../shared.mjs";
import { isTeamAlive } from "../services/runtime-mode.mjs";
import { loadTeamState, saveTeamState } from "../services/state-store.mjs";
import { normalizeTaskStatus, updateTaskStatus } from "../services/task-model.mjs";
import { ok } from "../render.mjs";

export function teamTaskUpdate(args = []) {
  const state = loadTeamState();
  if (!state || !isTeamAlive(state)) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }

  const nextStatus = normalizeTaskStatus(args[0]);
  const taskId = String(args[1] || "").toUpperCase();
  if (!nextStatus || !taskId) {
    console.log(`\n  사용법: ${WHITE}tfx multi task <pending|progress|done> <T1>${RESET}\n`);
    return;
  }

  const updated = updateTaskStatus(state.tasks || [], taskId, nextStatus);
  if (!updated.target) {
    console.log(`\n  ${DIM}태스크를 찾을 수 없음: ${taskId}${RESET}\n`);
    return;
  }

  saveTeamState({ ...state, tasks: updated.tasks }, state.sessionId);
  ok(`${updated.target.id} 상태 갱신: ${nextStatus}`);
  console.log("");
}
