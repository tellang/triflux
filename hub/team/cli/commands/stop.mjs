import { killSession, sessionExists } from "../../session.mjs";
import { DIM, RESET } from "../../shared.mjs";
import { ok } from "../render.mjs";
import { clearTeamState, loadTeamState } from "../services/state-store.mjs";

export async function teamStop(args = []) {
  const state = loadTeamState(args[0]);
  if (!state || (args[0] && state.sessionId !== args[0])) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }

  if (state.teammateMode === "headless") {
    if (!Number.isInteger(state.ownerPid) || state.ownerPid <= 0) {
      throw new Error("headless ownerPid가 없습니다.");
    }
    try {
      process.kill(state.ownerPid, "SIGTERM");
      ok(`headless 종료 요청: ${state.sessionId}`);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      console.log(`  ${DIM}세션 이미 종료됨${RESET}`);
    }
  } else if (sessionExists(state.sessionName)) {
    killSession(state.sessionName);
    ok(`세션 종료: ${state.sessionName}`);
  } else {
    console.log(`  ${DIM}세션 이미 종료됨${RESET}`);
  }

  clearTeamState(state.sessionId);
  console.log("");
}
