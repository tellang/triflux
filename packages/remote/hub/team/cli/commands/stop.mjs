import { closeWtSession, killSession, sessionExists } from "../../session.mjs";
import { DIM, RESET } from "../../shared.mjs";
import { nativeRequest } from "../services/native-control.mjs";
import { isNativeMode, isWtMode } from "../services/runtime-mode.mjs";
import { clearTeamState, loadTeamState } from "../services/state-store.mjs";
import { ok } from "../render.mjs";

export async function teamStop() {
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
    const closed = closeWtSession({ layout: state?.wt?.layout || state?.layout || "1xN", paneCount: state?.wt?.paneCount ?? (state.members || []).length });
    ok(`세션 종료: ${state.sessionName}${closed ? ` (${closed} panes closed)` : ""}`);
  } else if (sessionExists(state.sessionName)) {
    killSession(state.sessionName);
    ok(`세션 종료: ${state.sessionName}`);
  } else {
    console.log(`  ${DIM}세션 이미 종료됨${RESET}`);
  }

  clearTeamState(state.sessionId);
  console.log("");
}
