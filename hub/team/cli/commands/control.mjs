import { injectPrompt, sendKeys } from "../../pane.mjs";
import { DIM, RESET, WHITE, YELLOW } from "../../shared.mjs";
import { publishLeadControl } from "../services/hub-client.mjs";
import { resolveMember } from "../services/member-selector.mjs";
import { nativeRequest } from "../services/native-control.mjs";
import { isNativeMode, isTeamAlive, isWtMode } from "../services/runtime-mode.mjs";
import { loadTeamState } from "../services/state-store.mjs";
import { ok, warn } from "../render.mjs";

export async function teamControl(args = []) {
  const state = loadTeamState();
  if (!state || !isTeamAlive(state)) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }

  const member = resolveMember(state, args[0]);
  const command = String(args[1] || "").toLowerCase();
  const reason = args.slice(2).join(" ");
  if (!member || !new Set(["interrupt", "stop", "pause", "resume"]).has(command)) {
    console.log(`\n  사용법: ${WHITE}tfx multi control <lead|이름|번호> <interrupt|stop|pause|resume> [사유]${RESET}\n`);
    return;
  }
  if (isWtMode(state)) {
    console.log(`\n  ${YELLOW}⚠${RESET} wt 모드는 Hub direct/control 주입 경로가 비활성입니다.\n  ${DIM}수동 제어: 해당 pane에서 직접 명령/인터럽트를 수행하세요.${RESET}\n`);
    return;
  }

  let directOk = false;
  if (isNativeMode(state)) {
    directOk = !!(await nativeRequest(state, "/control", { member: member.name, command, reason }))?.ok;
  } else {
    injectPrompt(member.pane, `[LEAD CONTROL] command=${command}${reason ? ` reason=${reason}` : ""}`);
    if (command === "interrupt") sendKeys(member.pane, "C-c");
    directOk = true;
  }

  const published = await publishLeadControl(state, member, command, reason);
  if (directOk && published) ok(`${member.name} 제어 전송 (${command}, direct + hub)`);
  else if (directOk) ok(`${member.name} 제어 전송 (${command}, direct only)`);
  else warn(`${member.name} 제어 전송 실패 (${command})`);
  console.log("");
}
