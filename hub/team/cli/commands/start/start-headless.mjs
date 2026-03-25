import { BOLD, DIM, GREEN, RESET, AMBER } from "../../../shared.mjs";
import { runHeadlessInteractive } from "../../../headless.mjs";
import { ok, warn } from "../../render.mjs";
import { buildTasks } from "../../services/task-model.mjs";

export async function startHeadlessTeam({ sessionId, task, lead, agents, subtasks, layout, assigns, autoAttach, progressive, timeoutSec }) {
  console.log(`  ${AMBER}모드: headless (Lead-Direct v6.0.0)${RESET}`);

  // --assign이 있으면 그것을 사용, 없으면 agents+subtasks 조합
  const assignments = assigns && assigns.length > 0
    ? assigns.map((a, i) => ({ cli: a.cli, prompt: a.prompt, role: a.role || `worker-${i + 1}` }))
    : subtasks.map((subtask, i) => ({ cli: agents[i] || agents[0], prompt: subtask, role: `worker-${i + 1}` }));

  ok(`헤드리스 실행 시작 (${assignments.length}워커, progressive=${progressive !== false})`);

  const handle = await runHeadlessInteractive(sessionId, assignments, {
    timeoutSec: timeoutSec || 300,
    layout,
    autoAttach: autoAttach !== false, // 기본 true
    progressive: progressive !== false, // 기본 true
    progressIntervalSec: 10,
    onProgress(event) {
      if (event.type === "session_created") {
        console.log(`  ${DIM}세션: ${event.sessionName}${RESET}`);
      } else if (event.type === "worker_added") {
        console.log(`  ${DIM}[+] ${event.paneTitle}${RESET}`);
      } else if (event.type === "dispatched") {
        console.log(`  ${DIM}[${event.paneName}] ${event.cli} dispatch${RESET}`);
      } else if (event.type === "progress") {
        const last = (event.snapshot || "").split("\n").filter(l => l.trim()).pop() || "";
        if (last) console.log(`  ${DIM}[${event.paneName}] ${last.slice(0, 60)}${RESET}`);
      } else if (event.type === "completed") {
        const icon = event.matched && event.exitCode === 0 ? `${GREEN}✓${RESET}` : `${AMBER}✗${RESET}`;
        console.log(`  ${icon} [${event.paneName}] ${event.cli} exit=${event.exitCode}${event.sessionDead ? " (dead)" : ""}`);
      }
    },
  });

  // 결과 요약
  const results = handle.results;
  const succeeded = results.filter((r) => r.matched && r.exitCode === 0);
  const failed = results.filter((r) => !r.matched || r.exitCode !== 0);

  console.log(`\n  ${GREEN}${BOLD}헤드리스 실행 완료${RESET}`);
  console.log(`  ${DIM}성공: ${succeeded.length} / 실패: ${failed.length} / 전체: ${results.length}${RESET}`);

  if (failed.length > 0) {
    warn("실패 워커:");
    for (const r of failed) console.log(`    ${r.paneName} (${r.cli}): exit=${r.exitCode}`);
  }

  // 결과 출력 + JSON stdout
  for (const r of results) {
    if (r.output) {
      const preview = r.output.length > 200 ? `${r.output.slice(0, 200)}…` : r.output;
      console.log(`\n  ${DIM}── ${r.paneName} (${r.cli}${r.role ? `, ${r.role}` : ""}) ──${RESET}`);
      console.log(`  ${preview}`);
    }
  }

  // 세션 정리
  handle.kill();

  const members = [
    { role: "lead", name: "lead", cli: lead, pane: `${handle.sessionName}:0.0` },
    ...results.map((r, i) => ({ role: "worker", name: r.paneName, cli: r.cli, pane: r.paneId || "", subtask: assignments[i]?.prompt })),
  ];

  return {
    sessionName: handle.sessionName,
    task,
    lead,
    agents: assignments.map(a => a.cli),
    layout,
    teammateMode: "headless",
    startedAt: Date.now(),
    members,
    headlessResults: results,
    tasks: buildTasks(assignments.map(a => a.prompt), members.filter((m) => m.role === "worker")),
    postSave() {
      console.log(`\n  ${DIM}세션 정리 완료.${RESET}\n`);
    },
  };
}
