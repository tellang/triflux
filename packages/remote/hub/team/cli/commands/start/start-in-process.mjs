import { startNativeSupervisor } from "../../services/native-control.mjs";
import { buildTasks } from "../../services/task-model.mjs";

export async function startInProcessTeam({
  sessionId,
  task,
  lead,
  agents,
  subtasks,
  hubUrl,
}) {
  const { runtime, members } = await startNativeSupervisor({
    sessionId,
    task,
    lead,
    agents,
    subtasks,
    hubUrl,
  });

  if (!runtime?.controlUrl) return null;

  return {
    sessionName: sessionId,
    task,
    lead,
    agents,
    layout: "native",
    teammateMode: "in-process",
    startedAt: Date.now(),
    hubUrl,
    members: members.map((member, index) => ({
      role: member.role,
      name: member.name,
      cli: member.cli,
      agentId: member.agentId,
      pane: `native:${index}`,
      subtask: member.subtask || null,
    })),
    panes: {},
    tasks: buildTasks(
      subtasks,
      members.filter((member) => member.role === "worker"),
    ),
    native: {
      controlUrl: runtime.controlUrl,
      supervisorPid: runtime.supervisorPid,
    },
  };
}
