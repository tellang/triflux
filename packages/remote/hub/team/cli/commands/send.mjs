import { injectPrompt } from "../../pane.mjs";
import { DIM, RESET, WHITE } from "../../shared.mjs";
import { ok } from "../render.mjs";
import { resolveMember } from "../services/member-selector.mjs";
import { isTeamAlive } from "../services/runtime-mode.mjs";
import { loadTeamState } from "../services/state-store.mjs";

export async function teamSend(args = []) {
  const state = loadTeamState();
  if (state?.teammateMode === "headless") {
    throw new Error("headless 실행에는 지원하지 않는다");
  }
  if (!state || !isTeamAlive(state)) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }

  const member = resolveMember(state, args[0]);
  const message = args.slice(1).join(" ");
  if (!member || !message) {
    console.log(
      `\n  사용법: ${WHITE}tfx multi send <lead|이름|번호> "메시지"${RESET}\n`,
    );
    return;
  }

  injectPrompt(member.pane, message);
  ok(`${member.name}에 메시지 주입 완료`);
  console.log("");
}
