import {
  capturePaneOutput,
  detectMultiplexer,
  getSessionAttachedCount,
  hasWindowsTerminal,
  hasWindowsTerminalSession,
  listSessions,
} from "../../session.mjs";
import { AMBER, BOLD, DIM, RESET } from "../../shared.mjs";
import { formatCompletionSuffix } from "../render.mjs";
import { getHubInfo, nativeGetStatus } from "../services/hub-client.mjs";
import {
  isNativeMode,
  isTeamAlive,
  isWtMode,
} from "../services/runtime-mode.mjs";
import { loadTeamState, TEAM_PROFILE } from "../services/state-store.mjs";

export async function teamDebug(args = []) {
  const state = loadTeamState();
  const flagIndex = args.findIndex((arg) => arg === "--lines" || arg === "-n");
  const lines =
    flagIndex === -1
      ? 20
      : Math.max(3, parseInt(args[flagIndex + 1] || "20", 10) || 20);
  const hub = await getHubInfo();

  console.log(`\n  ${AMBER}${BOLD}⬡ Team Debug${RESET}\n`);
  console.log(`    platform:  ${process.platform}`);
  console.log(`    node:      ${process.version}`);
  console.log(
    `    tty:       stdout=${!!process.stdout.isTTY}, stdin=${!!process.stdin.isTTY}`,
  );
  console.log(`    mux:       ${detectMultiplexer() || "none"}`);
  console.log(`    hub-pid:   ${hub ? `${hub.pid}` : "-"}`);
  console.log(`    hub-url:   ${hub?.url || "-"}`);
  const sessions = listSessions();
  console.log(`    sessions:  ${sessions.length ? sessions.join(", ") : "-"}`);

  if (!state) {
    console.log(`\n  ${DIM}team-state 없음 (활성 세션 없음)${RESET}\n`);
    return;
  }

  console.log(`\n  ${BOLD}state${RESET}`);
  console.log(`    session:   ${state.sessionName}`);
  console.log(`    profile:   ${state.profile || TEAM_PROFILE}`);
  console.log(`    mode:      ${state.teammateMode || "tmux"}`);
  console.log(`    lead:      ${state.lead}`);
  console.log(`    agents:    ${(state.agents || []).join(", ")}`);
  console.log(`    alive:     ${isTeamAlive(state) ? "yes" : "no"}`);
  console.log(
    `    attached:  ${getSessionAttachedCount(state.sessionName) ?? "-"}`,
  );

  if (isWtMode(state)) {
    console.log(`\n  ${BOLD}wt-session${RESET}`);
    console.log(`    window:    ${state?.wt?.windowId ?? 0}`);
    console.log(`    layout:    ${state?.wt?.layout || state?.layout || "-"}`);
    console.log(
      `    panes:     ${state?.wt?.paneCount ?? (state.members || []).length}`,
    );
    console.log(`    wt.exe:    ${hasWindowsTerminal() ? "yes" : "no"}`);
    console.log(`    WT_SESSION:${hasWindowsTerminalSession() ? "yes" : "no"}`);
    console.log("");
    return;
  }

  if (isNativeMode(state)) {
    console.log(`\n  ${BOLD}native-members${RESET}`);
    const members = (await nativeGetStatus(state))?.data?.members || [];
    if (!members.length) console.log(`    ${DIM}(no data)${RESET}`);
    for (const member of members)
      console.log(
        `    - ${member.name}: ${member.status}${formatCompletionSuffix(member)}${member.lastPreview ? ` ${DIM}${member.lastPreview}${RESET}` : ""}`,
      );
    console.log("");
    return;
  }

  console.log(
    `\n  ${BOLD}pane-tail${RESET} ${DIM}(last ${lines} lines)${RESET}`,
  );
  if (!(state.members || []).length)
    console.log(`    ${DIM}(members 없음)${RESET}`);
  for (const member of state.members || []) {
    console.log(`\n    [${member.name}] ${member.pane}`);
    for (const line of (capturePaneOutput(member.pane, lines) || "(empty)")
      .split("\n")
      .slice(-lines)) {
      console.log(`      ${line}`);
    }
  }
  console.log("");
}
