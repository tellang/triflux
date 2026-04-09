import { listSessions } from "../../session.mjs";
import { AMBER, BOLD, DIM, GREEN, RESET } from "../../shared.mjs";
import {
  isNativeMode,
  isTeamAlive,
  isWtMode,
} from "../services/runtime-mode.mjs";
import { loadTeamState } from "../services/state-store.mjs";

export function teamList() {
  const state = loadTeamState();
  if (state && isTeamAlive(state) && (isNativeMode(state) || isWtMode(state))) {
    console.log(`\n  ${AMBER}${BOLD}⬡ 팀 세션 목록${RESET}\n`);
    console.log(
      `    ${GREEN}●${RESET} ${state.sessionName} ${DIM}(${isNativeMode(state) ? "in-process" : "wt"})${RESET}`,
    );
    console.log("");
    return;
  }

  const sessions = listSessions();
  if (!sessions.length) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }

  console.log(`\n  ${AMBER}${BOLD}⬡ 팀 세션 목록${RESET}\n`);
  for (const session of sessions)
    console.log(`    ${GREEN}●${RESET} ${session}`);
  console.log("");
}
