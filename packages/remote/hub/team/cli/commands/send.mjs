import { injectPrompt } from "../../pane.mjs";
import { DIM, RESET, WHITE, YELLOW } from "../../shared.mjs";
import { resolveMember } from "../services/member-selector.mjs";
import { nativeRequest } from "../services/native-control.mjs";
import { isNativeMode, isTeamAlive, isWtMode } from "../services/runtime-mode.mjs";
import { loadTeamState } from "../services/state-store.mjs";
import { ok, warn } from "../render.mjs";

export async function teamSend(args = []) {
  const state = loadTeamState();
  if (!state || !isTeamAlive(state)) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }

  const member = resolveMember(state, args[0]);
  const message = args.slice(1).join(" ");
  if (!member || !message) {
    console.log(`\n  사용법: ${WHITE}tfx multi send <lead|이름|번호> "메시지"${RESET}\n`);
    return;
  }
  if (isWtMode(state)) {
    console.log(`\n  ${YELLOW}⚠${RESET} wt 모드는 pane 프롬프트 자동 주입(send)이 지원되지 않습니다.\n  ${DIM}수동 전달: 선택한 pane에 직접 붙여넣으세요.${RESET}\n`);
    return;
  }

  if (isNativeMode(state)) {
    const result = await nativeRequest(state, "/send", { member: member.name, text: message });
    (result?.ok ? ok : warn)(`${member.name}${result?.ok ? "에 메시지 주입 완료" : " 메시지 주입 실패"}`);
    console.log("");
    return;
  }

  injectPrompt(member.pane, message);
  ok(`${member.name}에 메시지 주입 완료`);
  console.log("");
}
