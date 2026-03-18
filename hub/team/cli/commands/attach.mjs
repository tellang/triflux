import { attachSession } from "../../session.mjs";
import { DIM, RESET } from "../../shared.mjs";
import { buildManualAttachCommand, launchAttachInWindowsTerminal, wantsWtAttachFallback } from "../services/attach-fallback.mjs";
import { isNativeMode, isTeamAlive, isWtMode } from "../services/runtime-mode.mjs";
import { loadTeamState } from "../services/state-store.mjs";
import { fail, ok, warn } from "../render.mjs";

export async function teamAttach(args = []) {
  const state = loadTeamState();
  if (!state || !isTeamAlive(state)) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }
  if (isNativeMode(state)) {
    console.log(`\n  ${DIM}in-process 모드는 별도 attach가 없습니다.${RESET}\n  ${DIM}상태 확인: tfx multi status${RESET}\n`);
    return;
  }
  if (isWtMode(state)) {
    console.log(`\n  ${DIM}wt 모드는 attach 개념이 없습니다 (Windows Terminal pane가 독립 실행됨).${RESET}\n  ${DIM}재실행/정리는: tfx multi stop${RESET}\n`);
    return;
  }

  try {
    attachSession(state.sessionName);
  } catch (error) {
    const allowWt = wantsWtAttachFallback(args);
    if (allowWt && await launchAttachInWindowsTerminal(state.sessionName)) {
      warn(`현재 터미널에서 attach 실패: ${error.message}`);
      ok("Windows Terminal split-pane로 attach 재시도 창을 열었습니다.");
      console.log(`  ${DIM}수동 attach 명령: ${buildManualAttachCommand(state.sessionName)}${RESET}\n`);
      return;
    }
    fail(`attach 실패: ${error.message}`);
    warn(allowWt ? "WT 분할창 attach 자동 검증 실패 (session_attached 증가 없음)" : "자동 WT 분할은 기본 비활성입니다. 필요 시 --wt 옵션으로 실행하세요.");
    console.log(`  ${DIM}수동 attach 명령: ${buildManualAttachCommand(state.sessionName)}${RESET}\n`);
  }
}
