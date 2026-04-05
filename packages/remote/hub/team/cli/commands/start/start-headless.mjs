import { BOLD, DIM, GREEN, RESET, AMBER } from "../../../shared.mjs";
import { runHeadlessInteractive, resolveCliType } from "../../../headless.mjs";
import { ok, warn } from "../../render.mjs";
import { buildTasks } from "../../services/task-model.mjs";
import { clearTeamState } from "../../services/state-store.mjs";

export async function startHeadlessTeam({ sessionId, task, lead, agents, subtasks, layout, assigns, autoAttach, progressive, timeoutSec, verbose, dashboard, dashboardLayout, dashboardSize, dashboardAnchor, mcpProfile, model }) {
  // --assign이 있으면 그것을 사용, 없으면 agents+subtasks 조합
  const assignments = assigns && assigns.length > 0
    ? assigns.map((a, i) => ({ cli: resolveCliType(a.cli), prompt: a.prompt, role: a.role || `worker-${i + 1}`, mcp: mcpProfile, model }))
    : subtasks.map((subtask, i) => ({ cli: resolveCliType(agents[i] || agents[0]), prompt: subtask, role: `worker-${i + 1}`, mcp: mcpProfile, model }));

  const startedAt = Date.now();
  ok(`headless ${assignments.length}워커 시작`);

  const handle = await runHeadlessInteractive(sessionId, assignments, {
    timeoutSec: timeoutSec || 300,
    layout,
    autoAttach: !!autoAttach,
    dashboard: !!dashboard,
    dashboardLayout,
    dashboardSize: dashboardSize ?? 0.50,
    dashboardAnchor,
    progressive: progressive !== false,
    progressIntervalSec: verbose ? 10 : 0,
    onProgress: verbose ? function onProgress(event) {
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
    } : undefined,
  });

  // 최소 결과 요약
  const results = handle.results;
  const succeeded = results.filter((r) => r.matched && r.exitCode === 0);
  const failed = results.filter((r) => !r.matched || r.exitCode !== 0);

  ok(`헤드리스 완료: ${succeeded.length}성공 / ${failed.length}실패 / ${results.length}전체`);

  if (failed.length > 0) {
    for (const r of failed) console.log(`  ${AMBER}✗${RESET} ${r.paneName} (${r.cli}) exit=${r.exitCode}`);
  }

  // handoff 요약 (Lead 토큰 절약 포맷)
  for (const r of results) {
    const icon = r.matched && r.exitCode === 0 ? `${GREEN}✓${RESET}` : `${AMBER}✗${RESET}`;
    if (r.handoffFormatted) {
      const tag = r.handoffFallback ? `${DIM}(fallback)${RESET}` : "";
      console.log(`  ${icon} ${r.paneName} ${tag}`);
      for (const line of r.handoffFormatted.split("\n")) {
        console.log(`    ${DIM}${line}${RESET}`);
      }
    } else {
      if (r.resultFile) console.log(`  ${icon} ${r.paneName}: ${r.resultFile}`);
    }
  }

  // --verbose: 기존 장황한 출력 (200자 preview)
  if (verbose) {
    for (const r of results) {
      if (r.output) {
        const preview = r.output.length > 200 ? `${r.output.slice(0, 200)}…` : r.output;
        console.log(`\n  ${DIM}── ${r.paneName} (${r.cli}${r.role ? `, ${r.role}` : ""}) ──${RESET}`);
        console.log(`  ${preview}`);
      }
    }
  }

  // dashboard 모드: tui-viewer가 최종 상태를 렌더링할 시간 확보
  // WT pane spawn (~1s) + node 기동 (~500ms) + 첫 폴링 (~500ms) + 렌더 여유
  if (dashboard) await new Promise(r => setTimeout(r, 5000));

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
    handoffs: results.map((r) => ({ paneName: r.paneName, cli: r.cli, ...r.handoff })),
    tasks: buildTasks(assignments.map(a => a.prompt), members.filter((m) => m.role === "worker")),
    postSave() {
      // headless는 실행 완료 후 즉시 정리 — HUD에 잔존 방지
      clearTeamState(sessionId);
      console.log(`\n  ${DIM}세션 정리 완료.${RESET}\n`);
    },
  };
}
