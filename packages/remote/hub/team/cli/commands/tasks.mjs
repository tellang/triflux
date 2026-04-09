import { DIM, RESET } from "../../shared.mjs";
import { renderTasks } from "../render.mjs";
import { isTeamAlive } from "../services/runtime-mode.mjs";
import { loadTeamState } from "../services/state-store.mjs";

export function teamTasks() {
  const state = loadTeamState();
  if (!state || !isTeamAlive(state)) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }
  renderTasks(state.tasks || []);
}
