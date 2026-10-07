import { attachSession, focusPane } from "../../session.mjs";
import { DIM, RESET, WHITE } from "../../shared.mjs";
import { fail, ok, warn } from "../render.mjs";
import {
  buildManualAttachCommand,
  launchAttachInWindowsTerminal,
  wantsWtAttachFallback,
} from "../services/attach-fallback.mjs";
import { resolveMember } from "../services/member-selector.mjs";
import { isTeamAlive } from "../services/runtime-mode.mjs";
import { loadTeamState } from "../services/state-store.mjs";

export async function teamFocus(args = []) {
  const state = loadTeamState();
  if (state?.teammateMode === "headless") {
    throw new Error("headless 실행에는 지원하지 않는다");
  }
  if (!state || !isTeamAlive(state)) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }

  const member = resolveMember(state, args[0]);
  if (!member) {
    console.log(
      `\n  사용법: ${WHITE}tfx multi focus <lead|이름|번호>${RESET}\n`,
    );
    return;
  }

  focusPane(member.pane, { zoom: false });
  try {
    attachSession(state.sessionName);
  } catch (error) {
    const allowWt = wantsWtAttachFallback(args);
    if (allowWt && (await launchAttachInWindowsTerminal(state.sessionName))) {
      warn(`현재 터미널에서 attach 실패: ${error.message}`);
      ok("Windows Terminal split-pane로 attach 재시도 창을 열었습니다.");
      console.log(
        `  ${DIM}수동 attach 명령: ${buildManualAttachCommand(state.sessionName)}${RESET}\n`,
      );
      return;
    }
    fail(`attach 실패: ${error.message}`);
    warn(
      allowWt
        ? "WT 분할창 attach 자동 검증 실패 (session_attached 증가 없음)"
        : "자동 WT 분할은 기본 비활성입니다. 필요 시 --wt 옵션으로 실행하세요.",
    );
    console.log(
      `  ${DIM}수동 attach 명령: ${buildManualAttachCommand(state.sessionName)}${RESET}\n`,
    );
  }
}
