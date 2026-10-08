// headless 세션 결과 색인. 화면의 HEADLESS_COMPLETE 문자열 대신 읽도록 세션당 JSON 하나를 둔다 (ADR-0034).
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const RESULTS_INDEX_VERSION = 1;

export function resultsIndexPath(dir, sessionName) {
  return join(dir, `${sessionName}.results.json`);
}

/**
 * @param {string} path
 * @param {string} sessionName
 * @param {Array<{paneName: string, displayName?: string, cli: string, role?: string, resultFile: string}>} workers
 * @param {{canWrite?: () => boolean, now?: () => string}} [opts]
 */
export function createResultsIndex(
  path,
  sessionName,
  workers,
  { canWrite = () => true, now = () => new Date().toISOString() } = {},
) {
  const index = {
    version: RESULTS_INDEX_VERSION,
    sessionName,
    startedAt: now(),
    finishedAt: null,
    completed: false,
    workers: workers.map((w) => ({
      paneName: w.paneName,
      displayName: w.displayName || w.paneName,
      cli: w.cli,
      role: w.role || "",
      status: "pending",
      matched: null,
      exitCode: null,
      sessionDead: false,
      startedAt: null,
      finishedAt: null,
      resultFile: w.resultFile,
    })),
  };
  const byPane = new Map(index.workers.map((w) => [w.paneName, w]));

  // 임시 파일에 쓰고 rename 해 읽는 쪽이 반쯤 쓴 JSON 을 보지 않게 한다.
  // 색인은 보조 산출물이라 쓰기 실패가 실행을 멈추면 안 된다.
  const flush = () => {
    if (!canWrite()) return;
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`, "utf8");
      renameSync(tmp, path);
    } catch {
      /* best-effort */
    }
  };
  flush();

  return {
    path,
    workerStarted(paneName) {
      const w = byPane.get(paneName);
      if (!w || w.status !== "pending") return;
      w.status = "running";
      w.startedAt = now();
      flush();
    },
    workerFinished(paneName, { matched, exitCode, sessionDead } = {}) {
      const w = byPane.get(paneName);
      if (!w) return;
      w.status = matched && exitCode === 0 ? "completed" : "failed";
      w.matched = Boolean(matched);
      w.exitCode = exitCode ?? null;
      w.sessionDead = Boolean(sessionDead);
      w.finishedAt = now();
      flush();
    },
    finish(completed) {
      index.finishedAt = now();
      index.completed = Boolean(completed);
      flush();
    },
  };
}
