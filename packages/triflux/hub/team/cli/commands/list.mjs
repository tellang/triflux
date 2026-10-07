import { listSessions } from "../../session.mjs";
import { AMBER, BOLD, DIM, GREEN, RESET } from "../../shared.mjs";

export function teamList() {
  const sessions = listSessions();
  if (!sessions.length) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }

  console.log(`\n  ${AMBER}${BOLD}⬡ 팀 세션 목록${RESET}\n`);
  for (const session of sessions)
    console.log(`    ${GREEN}●${RESET} ${session}`);
  console.log("");
}
