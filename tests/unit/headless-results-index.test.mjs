import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { after, describe, it } from "node:test";

const originalPsmuxBin = process.env.PSMUX_BIN;
process.env.PSMUX_BIN = "/usr/bin/false";

const { headlessResultsIndexPath, runHeadless } = await import(
  "../../hub/team/headless.mjs?results-index-test"
);

const written = [];
after(() => {
  for (const path of written) rmSync(path, { force: true });
  if (originalPsmuxBin === undefined) delete process.env.PSMUX_BIN;
  else process.env.PSMUX_BIN = originalPsmuxBin;
});

const readIndex = (path) => JSON.parse(readFileSync(path, "utf8"));
const twoWorkers = [
  { cli: "codex", prompt: "a" },
  { cli: "codex", prompt: "b" },
];

function indexFor(sessionName) {
  const path = headlessResultsIndexPath(sessionName);
  written.push(path);
  return path;
}

function runWith(sessionName, awaitAll) {
  return runHeadless(sessionName, twoWorkers, {
    _deps: {
      dispatchProgressive(name, assignments, opts) {
        opts.sessionOwnership.acquire(name);
        opts.safeProgress({ type: "session_created", sessionName: name });
        return assignments.map((_, i) => {
          const paneName = `worker-${i + 1}`;
          opts.safeProgress({ type: "dispatched", paneName, cli: "codex" });
          return { paneName, cli: "codex", resultFile: "", cwd: process.cwd() };
        });
      },
      awaitAll,
      killPsmuxSession() {},
    },
  });
}

describe("headless 결과 색인", () => {
  it("워커 완료마다 갱신하고 세션이 끝나면 completed 로 표시한다", async () => {
    const sessionName = `results-index-${process.pid}`;
    const indexPath = indexFor(sessionName);
    let midRun;

    const result = await runWith(
      sessionName,
      (_name, dispatches, _timeout, safeProgress) => {
        safeProgress({
          type: "completed",
          paneName: "worker-1",
          matched: true,
          exitCode: 0,
        });
        midRun = readIndex(indexPath);
        safeProgress({
          type: "completed",
          paneName: "worker-2",
          matched: true,
          exitCode: 2,
        });
        return dispatches.map((d) => ({
          d,
          completion: { matched: true, exitCode: 0 },
          output: "",
        }));
      },
    );

    assert.equal(result.resultsIndexPath, indexPath);
    assert.equal(midRun.completed, false);
    assert.equal(midRun.finishedAt, null);
    assert.deepEqual(
      midRun.workers.map((w) => w.status),
      ["completed", "running"],
    );

    const final = readIndex(indexPath);
    assert.equal(final.version, 1);
    assert.equal(final.completed, true);
    assert.ok(final.finishedAt);
    assert.deepEqual(
      final.workers.map((w) => [w.paneName, w.status, w.exitCode]),
      [
        ["worker-1", "completed", 0],
        ["worker-2", "failed", 2],
      ],
    );
  });

  it("예외로 끝나면 completed=false 이고 끝나지 못한 워커는 failed 로 확정한다", async () => {
    const sessionName = `results-index-error-${process.pid}`;
    const indexPath = indexFor(sessionName);

    await assert.rejects(
      runWith(sessionName, (_name, _dispatches, _timeout, safeProgress) => {
        safeProgress({
          type: "completed",
          paneName: "worker-1",
          matched: true,
          exitCode: 0,
        });
        throw new Error("await failed");
      }),
      /await failed/u,
    );

    const final = readIndex(indexPath);
    assert.equal(final.completed, false);
    assert.ok(final.finishedAt);
    assert.deepEqual(
      final.workers.map((w) => w.status),
      ["completed", "failed"],
    );
  });

  it("세션을 소유하지 못하면 같은 이름의 색인을 쓰지 않는다", async () => {
    const sessionName = `results-index-foreign-${process.pid}`;
    await assert.rejects(
      runHeadless(sessionName, [{ cli: "codex", prompt: "a" }], {
        _deps: {
          createPsmuxSession() {
            throw new Error("duplicate session");
          },
        },
      }),
      /duplicate session/u,
    );
    assert.equal(existsSync(indexFor(sessionName)), false);
  });
});
