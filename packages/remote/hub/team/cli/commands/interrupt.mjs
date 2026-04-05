import { sendKeys } from "../../pane.mjs";
import { DIM, RESET, WHITE, YELLOW } from "../../shared.mjs";
import { resolveMember } from "../services/member-selector.mjs";
import { nativeRequest } from "../services/native-control.mjs";
import { isNativeMode, isTeamAlive, isWtMode } from "../services/runtime-mode.mjs";
import { loadTeamState } from "../services/state-store.mjs";
import { ok, warn } from "../render.mjs";

export async function teamInterrupt(args = []) {
  const state = loadTeamState();
  if (!state || !isTeamAlive(state)) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }

  const member = resolveMember(state, args[0] || "lead");
  if (!member) {
    console.log(`\n  사용법: ${WHITE}tfx multi interrupt <lead|이름|번호>${RESET}\n`);
    return;
  }
  if (isWtMode(state)) {
    console.log(`\n  ${YELLOW}⚠${RESET} wt 모드에서는 pane stdin 주입이 지원되지 않아 interrupt를 자동 전송할 수 없습니다.\n  ${DIM}수동으로 해당 pane에서 Ctrl+C를 입력하세요.${RESET}\n`);
    return;
  }

  if (isNativeMode(state)) {
    const result = await nativeRequest(state, "/interrupt", { member: member.name });
    (result?.ok ? ok : warn)(`${member.name} ${result?.ok ? "인터럽트 전송" : "인터럽트 실패"}`);
    console.log("");
    return;
  }

  sendKeys(member.pane, "C-c");
  ok(`${member.name} 인터럽트 전송`);
  console.log("");
}
