import { BOLD, DIM, GREEN, RESET, AMBER } from "../../../shared.mjs";
import { runHeadless } from "../../../headless.mjs";
import { killPsmuxSession } from "../../../psmux.mjs";
import { ok, warn } from "../../render.mjs";
import { buildTasks } from "../../services/task-model.mjs";

export async function startHeadlessTeam({ sessionId, task, lead, agents, subtasks, layout }) {
  console.log(`  ${AMBER}모드: headless (psmux 헤드리스 CLI 실행)${RESET}`);

  const assignments = subtasks.map((subtask, i) => ({
    cli: agents[i],
    prompt: subtask,
    role: `worker-${i + 1}`,
  }));

  ok("헤드리스 실행 시작...");
  const { sessionName, results } = await runHeadless(sessionId, assignments, {
    timeoutSec: 300,
    layout,
    onProgress(event) {
      if (event.type === "dispatched") {
        console.log(`  ${DIM}[${event.paneName}] ${event.cli} dispatch${RESET}`);
      } else if (event.type === "completed") {
        const icon = event.matched && event.exitCode === 0 ? `${GREEN}✓${RESET}` : `${AMBER}✗${RESET}`;
        console.log(`  ${icon} [${event.paneName}] ${event.cli} exit=${event.exitCode}${event.sessionDead ? " (session dead)" : ""}`);
      }
    },
  });

  // 결과 요약
  const succeeded = results.filter((r) => r.matched && r.exitCode === 0);
  const failed = results.filter((r) => !r.matched || r.exitCode !== 0);

  console.log(`\n  ${GREEN}${BOLD}헤드리스 실행 완료${RESET}`);
  console.log(`  ${DIM}성공: ${succeeded.length} / 실패: ${failed.length} / 전체: ${results.length}${RESET}`);

  if (failed.length > 0) {
    warn("실패 워커:");
    for (const r of failed) {
      console.log(`    ${r.paneName} (${r.cli}): exit=${r.exitCode}${r.sessionDead ? " session dead" : ""}`);
    }
  }

  // 결과 출력 (각 워커의 output 요약)
  for (const r of results) {
    if (r.output) {
      const preview = r.output.length > 200 ? `${r.output.slice(0, 200)}…` : r.output;
      console.log(`\n  ${DIM}── ${r.paneName} (${r.cli}) ──${RESET}`);
      console.log(`  ${preview}`);
    }
  }

  // 세션 정리
  try { killPsmuxSession(sessionName); } catch { /* already cleaned */ }

  const members = [
    { role: "lead", name: "lead", cli: lead, pane: `${sessionName}:0.0` },
    ...results.map((r, i) => ({ role: "worker", name: r.paneName, cli: r.cli, pane: `${sessionName}:0.${i + 1}`, subtask: subtasks[i] })),
  ];

  return {
    sessionName,
    task,
    lead,
    agents,
    layout,
    teammateMode: "headless",
    startedAt: Date.now(),
    members,
    headlessResults: results,
    tasks: buildTasks(subtasks, members.filter((m) => m.role === "worker")),
    postSave() {
      console.log(`\n  ${DIM}세션 자동 정리 완료. 결과는 위에 표시됨.${RESET}\n`);
    },
  };
}
