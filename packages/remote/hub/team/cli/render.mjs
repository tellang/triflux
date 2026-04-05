import { AMBER, BOLD, DIM, GRAY, GREEN, RED, RESET, WHITE, YELLOW } from "../shared.mjs";

export function ok(msg) { console.log(`  ${GREEN}✓${RESET} ${msg}`); }
export function warn(msg) { console.log(`  ${YELLOW}⚠${RESET} ${msg}`); }
export function fail(msg) { console.log(`  ${RED}✗${RESET} ${msg}`); }

export function renderTasks(tasks = []) {
  if (!tasks.length) {
    console.log(`\n  ${DIM}태스크 없음${RESET}\n`);
    return;
  }

  console.log(`\n  ${AMBER}${BOLD}⬡ Team Tasks${RESET}\n`);
  for (const task of tasks) {
    const dep = task.depends_on?.length ? ` ${DIM}(deps: ${task.depends_on.join(",")})${RESET}` : "";
    const owner = task.owner ? ` ${GRAY}[${task.owner}]${RESET}` : "";
    console.log(`    ${WHITE}${task.id}${RESET} ${String(task.status || "").padEnd(11)} ${task.title}${owner}${dep}`);
  }
  console.log("");
}

export function formatCompletionSuffix(member) {
  if (!member?.completionStatus) return "";
  if (member.completionStatus === "abnormal") {
    return ` ${RED}[abnormal:${member.completionReason || "unknown"}]${RESET}`;
  }
  if (member.completionStatus === "normal") return ` ${GREEN}[route-ok]${RESET}`;
  if (member.completionStatus === "unchecked") return ` ${GRAY}[route-unchecked]${RESET}`;
  return "";
}
