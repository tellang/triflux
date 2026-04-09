import { join } from "node:path";
import { orchestrate } from "../../../orchestrator.mjs";
import { buildCliCommand, startCliInPane } from "../../../pane.mjs";
import {
  attachSession,
  configureTeammateKeybindings,
  createSession,
} from "../../../session.mjs";
import { BOLD, DIM, GREEN, RESET } from "../../../shared.mjs";
import { ok, warn } from "../../render.mjs";
import { toAgentId } from "../../services/member-selector.mjs";
import { PKG_ROOT, TEAM_PROFILE } from "../../services/state-store.mjs";
import { buildTasks } from "../../services/task-model.mjs";

export async function startMuxTeam({
  sessionId,
  task,
  lead,
  agents,
  subtasks,
  layout,
  hubUrl,
  teammateMode,
}) {
  const paneCount = agents.length + 1;
  const effectiveLayout =
    paneCount <= 4 ? layout : layout === "Nx1" ? "Nx1" : "1xN";
  console.log(`  레이아웃: ${effectiveLayout} (${paneCount} panes)`);

  const session = createSession(sessionId, {
    layout: effectiveLayout,
    paneCount,
  });
  const leadTarget = session.panes[0];
  startCliInPane(leadTarget, buildCliCommand(lead));

  const members = [
    {
      role: "lead",
      name: "lead",
      cli: lead,
      pane: leadTarget,
      agentId: toAgentId(lead, leadTarget),
    },
  ];
  const assignments = [];
  for (let index = 0; index < agents.length; index += 1) {
    const cli = agents[index];
    const pane = session.panes[index + 1];
    startCliInPane(pane, buildCliCommand(cli));
    const worker = {
      role: "worker",
      name: `${cli}-${index + 1}`,
      cli,
      pane,
      subtask: subtasks[index],
      agentId: toAgentId(cli, pane),
    };
    members.push(worker);
    assignments.push({ target: pane, cli, subtask: subtasks[index] });
  }

  ok("CLI 초기화 대기 (3초)...");
  await new Promise((resolve) => setTimeout(resolve, 3000));
  await orchestrate(sessionId, assignments, {
    hubUrl,
    teammateMode,
    lead: { target: leadTarget, cli: lead, task },
  });
  ok("리드/워커 프롬프트 주입 완료");

  return {
    sessionName: sessionId,
    task,
    lead,
    agents,
    layout: effectiveLayout,
    teammateMode,
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
    postSave() {
      const profilePrefix =
        TEAM_PROFILE === "team" ? "" : `TFX_TEAM_PROFILE=${TEAM_PROFILE} `;
      const taskListCommand = `${profilePrefix}${process.execPath} ${join(PKG_ROOT, "bin", "triflux.mjs")} team tasks`;
      configureTeammateKeybindings(sessionId, {
        inProcess: false,
        taskListCommand,
      });
      console.log(`\n  ${GREEN}${BOLD}팀 세션 준비 완료${RESET}`);
      console.log(`  ${DIM}Shift+Down: 다음 팀메이트 전환${RESET}`);
      console.log(`  ${DIM}Shift+Tab / Shift+Left: 이전 팀메이트 전환${RESET}`);
      console.log(`  ${DIM}Escape: 현재 팀메이트 인터럽트${RESET}`);
      console.log(`  ${DIM}Ctrl+T: 태스크 목록${RESET}`);
      console.log(
        `  ${DIM}참고: Shift+Up은 Claude Code 미지원 (scroll-up 충돌). Shift+Tab 사용${RESET}`,
      );
      console.log(`  ${DIM}Ctrl+B → D: 세션 분리 (백그라운드)${RESET}\n`);
      if (process.stdout.isTTY && process.stdin.isTTY) attachSession(sessionId);
      else {
        warn("TTY 미지원 환경이라 자동 attach를 생략함");
        console.log(`  ${DIM}수동 연결: tfx multi attach${RESET}\n`);
      }
    },
  };
}
