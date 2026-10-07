import { killSession, listSessions } from "../../session.mjs";
import { DIM, RESET } from "../../shared.mjs";
import { ok } from "../render.mjs";
import { clearTeamState, loadTeamState } from "../services/state-store.mjs";

export async function teamKill() {
  const state = loadTeamState();
  const sessions = listSessions();
  if (!sessions.length) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }
  for (const session of sessions) {
    killSession(session);
    ok(`종료: ${session}`);
  }
  clearTeamState(state?.sessionId);
  console.log("");
}
