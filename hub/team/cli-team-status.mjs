// hub/team/cli-team-status.mjs — team 상태/조회 로직
import {
  capturePaneOutput,
  detectMultiplexer,
  getSessionAttachedCount,
  hasWindowsTerminal,
  hasWindowsTerminalSession,
  listSessions,
} from "./session.mjs";
import { AMBER, BOLD, DIM, GRAY, GREEN, RED, RESET, WHITE } from "./shared.mjs";
import {
  TEAM_PROFILE,
  getDefaultHubUrl,
  getHubInfo,
  isNativeMode,
  isTeamAlive,
  isWtMode,
  loadTeamState,
  nativeGetStatus,
  ok,
  saveTeamState,
} from "./cli-team-common.mjs";

async function fetchHubTaskList(state) {
  const hubBase = (state?.hubUrl || getDefaultHubUrl()).replace(/\/mcp$/, "");
  const teamName = state?.native?.teamName || state?.sessionName || null;
  if (!teamName) return [];
  try {
    const res = await fetch(`${hubBase}/bridge/team/task-list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ team_name: teamName }),
      signal: AbortSignal.timeout(2000),
    });
    const data = await res.json();
    return data?.ok ? (data.data?.tasks || []) : [];
  } catch {
    return [];
  }
}

function renderTasks(tasks = []) {
  if (!tasks.length) {
    console.log(`\n  ${DIM}태스크 없음${RESET}\n`);
    return;
  }

  console.log(`\n  ${AMBER}${BOLD}⬡ Team Tasks${RESET}\n`);
  for (const t of tasks) {
    const dep = t.depends_on?.length ? ` ${DIM}(deps: ${t.depends_on.join(",")})${RESET}` : "";
    const owner = t.owner ? ` ${GRAY}[${t.owner}]${RESET}` : "";
    console.log(`    ${WHITE}${t.id}${RESET} ${t.status.padEnd(11)} ${t.title}${owner}${dep}`);
  }
  console.log("");
}

function formatCompletionSuffix(member) {
  if (!member?.completionStatus) return "";
  if (member.completionStatus === "abnormal") {
    const reason = member.completionReason || "unknown";
    return ` ${RED}[abnormal:${reason}]${RESET}`;
  }
  if (member.completionStatus === "normal") {
    return ` ${GREEN}[route-ok]${RESET}`;
  }
  if (member.completionStatus === "unchecked") {
    return ` ${GRAY}[route-unchecked]${RESET}`;
  }
  return "";
}

export async function teamStatus() {
  const state = loadTeamState();
  if (!state) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }

  const alive = isTeamAlive(state);
  const status = alive ? `${GREEN}● active${RESET}` : `${RED}● dead${RESET}`;
  const uptime = alive ? `${Math.round((Date.now() - state.startedAt) / 60000)}분` : "-";

  console.log(`\n  ${AMBER}${BOLD}⬡ tfx multi${RESET} ${status}\n`);
  console.log(`    세션:   ${state.sessionName}`);
  console.log(`    모드:   ${state.teammateMode || "tmux"}`);
  console.log(`    리드:   ${state.lead || "claude"}`);
  console.log(`    워커:   ${(state.agents || []).join(", ")}`);
  console.log(`    Uptime: ${uptime}`);
  console.log(`    태스크: ${(state.tasks || []).length}`);
  if (isWtMode(state) && !hasWindowsTerminalSession()) {
    console.log(`    ${DIM}WT_SESSION 미감지: 생존성은 heuristics로 판정됨${RESET}`);
  }

  const members = state.members || [];
  if (members.length) {
    console.log("");
    for (const m of members) {
      const roleTag = m.role === "lead" ? "lead" : "worker";
      console.log(`    - ${m.name} (${m.cli}) ${DIM}${roleTag}${RESET} ${DIM}${m.pane}${RESET}`);
    }
  }

  if (isNativeMode(state) && alive) {
    const native = await nativeGetStatus(state);
    const nativeMembers = native?.data?.members || [];
    if (nativeMembers.length) {
      console.log("");
      for (const m of nativeMembers) {
        console.log(`    • ${m.name}: ${m.status}${formatCompletionSuffix(m)}${m.lastPreview ? ` ${DIM}${m.lastPreview}${RESET}` : ""}`);
      }
    }
  }

  if (alive) {
    const hubTasks = await fetchHubTaskList(state);
    if (hubTasks.length > 0) {
      const completed = hubTasks.filter((t) => t.status === "completed").length;
      const failed = hubTasks.filter((t) => t.status === "failed").length;

      console.log(`\n  ${BOLD}Hub Tasks${RESET} ${DIM}(${completed}/${hubTasks.length} done)${RESET}`);
      for (const t of hubTasks) {
        const icon = t.status === "completed" ? `${GREEN}✓${RESET}`
          : t.status === "in_progress" ? `${AMBER}●${RESET}`
          : t.status === "failed" ? `${RED}✗${RESET}`
          : `${GRAY}○${RESET}`;
        const owner = t.owner ? ` ${GRAY}[${t.owner}]${RESET}` : "";
        const subject = t.subject || t.description?.slice(0, 50) || "";
        console.log(`    ${icon} ${subject}${owner}`);
      }
      if (failed > 0) console.log(`    ${RED}⚠ ${failed}건 실패${RESET}`);
    }
  }

  console.log("");
}

export function teamTasks() {
  const state = loadTeamState();
  if (!state || !isTeamAlive(state)) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }
  renderTasks(state.tasks || []);
}

export function teamTaskUpdate() {
  const state = loadTeamState();
  if (!state || !isTeamAlive(state)) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }

  const action = (process.argv[4] || "").toLowerCase();
  const taskId = (process.argv[5] || "").toUpperCase();
  const nextStatus = action === "done" || action === "complete" || action === "completed"
    ? "completed"
    : action === "progress" || action === "in-progress" || action === "in_progress"
      ? "in_progress"
      : action === "pending"
        ? "pending"
        : null;

  if (!nextStatus || !taskId) {
    console.log(`\n  사용법: ${WHITE}tfx multi task <pending|progress|done> <T1>${RESET}\n`);
    return;
  }

  const tasks = state.tasks || [];
  const target = tasks.find((t) => String(t.id).toUpperCase() === taskId);
  if (!target) {
    console.log(`\n  ${DIM}태스크를 찾을 수 없음: ${taskId}${RESET}\n`);
    return;
  }

  target.status = nextStatus;
  saveTeamState(state);
  ok(`${target.id} 상태 갱신: ${nextStatus}`);
  console.log("");
}

export async function teamDebug() {
  const state = loadTeamState();
  const linesIdx = process.argv.findIndex((a) => a === "--lines" || a === "-n");
  const lines = linesIdx !== -1 ? Math.max(3, parseInt(process.argv[linesIdx + 1] || "20", 10) || 20) : 20;
  const mux = detectMultiplexer() || "none";
  const hub = await getHubInfo();

  console.log(`\n  ${AMBER}${BOLD}⬡ Team Debug${RESET}\n`);
  console.log(`    platform:  ${process.platform}`);
  console.log(`    node:      ${process.version}`);
  console.log(`    tty:       stdout=${!!process.stdout.isTTY}, stdin=${!!process.stdin.isTTY}`);
  console.log(`    mux:       ${mux}`);
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
  const attached = getSessionAttachedCount(state.sessionName);
  console.log(`    attached:  ${attached == null ? "-" : attached}`);

  if (isWtMode(state)) {
    const wtState = state.wt || {};
    console.log(`\n  ${BOLD}wt-session${RESET}`);
    console.log(`    window:    ${wtState.windowId ?? 0}`);
    console.log(`    layout:    ${wtState.layout || state.layout || "-"}`);
    console.log(`    panes:     ${wtState.paneCount ?? (state.members || []).length}`);
    console.log(`    wt.exe:    ${hasWindowsTerminal() ? "yes" : "no"}`);
    console.log(`    WT_SESSION:${hasWindowsTerminalSession() ? "yes" : "no"}`);
    console.log("");
    return;
  }

  if (isNativeMode(state)) {
    const native = await nativeGetStatus(state);
    const members = native?.data?.members || [];
    console.log(`\n  ${BOLD}native-members${RESET}`);
    if (!members.length) {
      console.log(`    ${DIM}(no data)${RESET}`);
    } else {
      for (const m of members) {
        console.log(`    - ${m.name}: ${m.status}${formatCompletionSuffix(m)}${m.lastPreview ? ` ${DIM}${m.lastPreview}${RESET}` : ""}`);
      }
    }
    console.log("");
    return;
  }

  const members = state.members || [];
  console.log(`\n  ${BOLD}pane-tail${RESET} ${DIM}(last ${lines} lines)${RESET}`);
  if (!members.length) {
    console.log(`    ${DIM}(members 없음)${RESET}`);
  } else {
    for (const m of members) {
      const tail = capturePaneOutput(m.pane, lines) || "(empty)";
      console.log(`\n    [${m.name}] ${m.pane}`);
      const tailLines = tail.split("\n").slice(-lines);
      for (const line of tailLines) {
        console.log(`      ${line}`);
      }
    }
  }
  console.log("");
}

export function teamList() {
  const state = loadTeamState();
  if (state && isNativeMode(state) && isTeamAlive(state)) {
    console.log(`\n  ${AMBER}${BOLD}⬡ 팀 세션 목록${RESET}\n`);
    console.log(`    ${GREEN}●${RESET} ${state.sessionName} ${DIM}(in-process)${RESET}`);
    console.log("");
    return;
  }
  if (state && isWtMode(state) && isTeamAlive(state)) {
    console.log(`\n  ${AMBER}${BOLD}⬡ 팀 세션 목록${RESET}\n`);
    console.log(`    ${GREEN}●${RESET} ${state.sessionName} ${DIM}(wt)${RESET}`);
    console.log("");
    return;
  }

  const sessions = listSessions();
  if (sessions.length === 0) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }
  console.log(`\n  ${AMBER}${BOLD}⬡ 팀 세션 목록${RESET}\n`);
  for (const sessionName of sessions) {
    console.log(`    ${GREEN}●${RESET} ${sessionName}`);
  }
  console.log("");
}
