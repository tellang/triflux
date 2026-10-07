import { AMBER, BOLD, DIM, GRAY, GREEN, RED, RESET } from "../../shared.mjs";
import { fetchHubTaskList } from "../services/hub-client.mjs";
import { isTeamAlive } from "../services/runtime-mode.mjs";
import { loadTeamState } from "../services/state-store.mjs";

export async function teamStatus(args = []) {
  const json = process.env.TFX_OUTPUT_JSON === "1" || args.includes("--json");
  const state = loadTeamState();
  if (!state) {
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ status: "offline", sessionName: null, alive: false }, null, 2)}\n`,
      );
      return;
    }
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }

  const alive = isTeamAlive(state);
  const payload = {
    status: alive ? "active" : "dead",
    alive,
    sessionName: state.sessionName,
    teammateMode: state.teammateMode || "tmux",
    lead: state.lead || "claude",
    agents: state.agents || [],
    startedAt: state.startedAt || null,
    taskCount: (state.tasks || []).length,
    members: (state.members || []).map((member) => ({
      name: member.name,
      cli: member.cli,
      role: member.role,
      pane: member.pane,
    })),
  };

  if (alive) {
    payload.hubTasks = await fetchHubTaskList(state);
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  console.log(
    `\n  ${AMBER}${BOLD}⬡ tfx multi${RESET} ${alive ? `${GREEN}● active${RESET}` : `${RED}● dead${RESET}`}\n`,
  );
  console.log(`    세션:   ${state.sessionName}`);
  console.log(`    모드:   ${state.teammateMode || "tmux"}`);
  console.log(`    리드:   ${state.lead || "claude"}`);
  console.log(`    워커:   ${(state.agents || []).join(", ")}`);
  console.log(
    `    Uptime: ${alive ? `${Math.round((Date.now() - state.startedAt) / 60000)}분` : "-"}`,
  );
  console.log(`    태스크: ${(state.tasks || []).length}`);

  for (const member of state.members || []) {
    console.log(
      `    - ${member.name} (${member.cli}) ${DIM}${member.role}${RESET} ${DIM}${member.pane}${RESET}`,
    );
  }

  if (alive) {
    const hubTasks = payload.hubTasks || (await fetchHubTaskList(state));
    if (hubTasks.length) {
      const completed = hubTasks.filter(
        (task) => task.status === "completed",
      ).length;
      const failed = hubTasks.filter((task) => task.status === "failed").length;
      console.log(
        `\n  ${BOLD}Hub Tasks${RESET} ${DIM}(${completed}/${hubTasks.length} done)${RESET}`,
      );
      for (const task of hubTasks) {
        const icon =
          task.status === "completed"
            ? `${GREEN}✓${RESET}`
            : task.status === "in_progress"
              ? `${AMBER}●${RESET}`
              : task.status === "failed"
                ? `${RED}✗${RESET}`
                : `${GRAY}○${RESET}`;
        const owner = task.owner ? ` ${GRAY}[${task.owner}]${RESET}` : "";
        console.log(
          `    ${icon} ${task.subject || task.description?.slice(0, 50) || ""}${owner}`,
        );
      }
      if (failed > 0) console.log(`    ${RED}⚠ ${failed}건 실패${RESET}`);
    }
  }
  console.log("");
}
