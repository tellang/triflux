import { injectPrompt, sendKeys } from "../../pane.mjs";
import { DIM, RESET, WHITE } from "../../shared.mjs";
import { ok } from "../render.mjs";
import { resolveMember } from "../services/member-selector.mjs";
import { isTeamAlive } from "../services/runtime-mode.mjs";
import { loadTeamState } from "../services/state-store.mjs";

export async function teamControl(args = []) {
  const state = loadTeamState();
  if (state?.teammateMode === "headless") {
    throw new Error("headless 실행에는 지원하지 않는다");
  }
  if (!state || !isTeamAlive(state)) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }

  const member = resolveMember(state, args[0]);
  const command = String(args[1] || "").toLowerCase();
  const reason = args.slice(2).join(" ");
  if (
    !member ||
    !new Set(["interrupt", "stop", "pause", "resume"]).has(command)
  ) {
    console.log(
      `\n  사용법: ${WHITE}tfx multi control <lead|이름|번호> <interrupt|stop|pause|resume> [사유]${RESET}\n`,
    );
    return;
  }
  injectPrompt(
    member.pane,
    `[LEAD CONTROL] command=${command}${reason ? ` reason=${reason}` : ""}`,
  );
  if (command === "interrupt") sendKeys(member.pane, "C-c");

  ok(`${member.name} 제어 전송 (${command})`);
  console.log("");
}
