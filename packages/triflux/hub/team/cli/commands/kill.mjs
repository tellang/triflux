import { closeWtSession, killSession, listSessions } from "../../session.mjs";
import { DIM, RESET } from "../../shared.mjs";
import { nativeRequest } from "../services/native-control.mjs";
import { isNativeMode, isTeamAlive, isWtMode } from "../services/runtime-mode.mjs";
import { clearTeamState, loadTeamState } from "../services/state-store.mjs";
import { ok } from "../render.mjs";

export async function teamKill() {
  const state = loadTeamState();
  if (state && isNativeMode(state) && isTeamAlive(state)) {
    await nativeRequest(state, "/stop", {});
    try { process.kill(state.native.supervisorPid, "SIGTERM"); } catch {}
    clearTeamState(state.sessionId);
    ok(`종료: ${state.sessionName}`);
    console.log("");
    return;
  }
  if (state && isWtMode(state)) {
    const closed = closeWtSession({ layout: state?.wt?.layout || state?.layout || "1xN", paneCount: state?.wt?.paneCount ?? (state.members || []).length });
    clearTeamState(state.sessionId);
    ok(`종료: ${state.sessionName}${closed ? ` (${closed} panes closed)` : ""}`);
    console.log("");
    return;
  }

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
