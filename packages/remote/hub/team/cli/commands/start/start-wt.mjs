import { buildCliCommand } from "../../../pane.mjs";
import { createWtSession } from "../../../session.mjs";
import { warn } from "../../render.mjs";
import { toAgentId } from "../../services/member-selector.mjs";
import { buildTasks } from "../../services/task-model.mjs";

export async function startWtTeam({
  sessionId,
  task,
  lead,
  agents,
  subtasks,
  layout,
  hubUrl,
}) {
  const paneCount = agents.length + 1;
  const effectiveLayout = layout === "Nx1" ? "Nx1" : "1xN";
  if (layout !== effectiveLayout)
    warn(`wt 모드에서 ${layout} 레이아웃은 미지원 — ${effectiveLayout}로 대체`);
  console.log(`  레이아웃: ${effectiveLayout} (${paneCount} panes)`);

  const session = await createWtSession(sessionId, {
    layout: effectiveLayout,
    paneCommands: [
      { title: `${sessionId}-lead`, command: buildCliCommand(lead) },
      ...agents.map((cli, index) => ({
        title: `${sessionId}-${cli}-${index + 1}`,
        command: buildCliCommand(cli),
      })),
    ],
  });

  const members = [
    {
      role: "lead",
      name: "lead",
      cli: lead,
      pane: session.panes[0] || "wt:0",
      agentId: toAgentId(lead, session.panes[0] || "wt:0"),
    },
    ...agents.map((cli, index) => {
      const pane = session.panes[index + 1] || `wt:${index + 1}`;
      return {
        role: "worker",
        name: `${cli}-${index + 1}`,
        cli,
        pane,
        subtask: subtasks[index],
        agentId: toAgentId(cli, pane),
      };
    }),
  ];

  return {
    sessionName: sessionId,
    task,
    lead,
    agents,
    layout: effectiveLayout,
    teammateMode: "wt",
    startedAt: Date.now(),
    hubUrl,
    members,
    panes: Object.fromEntries(
      members.map((member) => [
        member.pane,
        {
          role: member.role,
          name: member.name,
          cli: member.cli,
          agentId: member.agentId,
          subtask: member.subtask || null,
        },
      ]),
    ),
    tasks: buildTasks(
      subtasks,
      members.filter((member) => member.role === "worker"),
    ),
    wt: {
      windowId: 0,
      layout: effectiveLayout,
      paneCount: session.paneCount,
    },
  };
}
