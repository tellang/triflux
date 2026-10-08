import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { after, describe, it } from "node:test";

const originalPsmuxBin = process.env.PSMUX_BIN;
process.env.PSMUX_BIN = "/usr/bin/false";

const { headlessResultsIndexPath, runHeadless } = await import(
  "../../hub/team/headless.mjs?results-index-test"
);

after(() => {
  if (originalPsmuxBin === undefined) delete process.env.PSMUX_BIN;
  else process.env.PSMUX_BIN = originalPsmuxBin;
});

const readIndex = (path) => JSON.parse(readFileSync(path, "utf8"));

describe("headless 결과 색인", () => {
  it("워커 완료마다 갱신하고 세션이 끝나면 completed 로 표시한다", async () => {
    const sessionName = `results-index-${process.pid}`;
    const indexPath = headlessResultsIndexPath(sessionName);
    let midRun;

    const result = await runHeadless(
      sessionName,
      [
        { cli: "codex", prompt: "a" },
        { cli: "codex", prompt: "b" },
      ],
      {
        _deps: {
          dispatchProgressive(
            name,
            assignments,
            { safeProgress, sessionOwnership },
          ) {
            sessionOwnership.acquire(name);
            return assignments.map((_, i) => {
              const paneName = `worker-${i + 1}`;
              safeProgress({ type: "dispatched", paneName, cli: "codex" });
              return {
                paneName,
                cli: "codex",
                resultFile: "",
                cwd: process.cwd(),
              };
            });
          },
          awaitAll(_name, dispatches, _timeout, safeProgress) {
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
        },
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
    assert.equal(final.sessionName, sessionName);
    assert.equal(final.completed, true);
    assert.ok(final.finishedAt);
    assert.deepEqual(
      final.workers.map((w) => [w.paneName, w.status, w.exitCode]),
      [
        ["worker-1", "completed", 0],
        ["worker-2", "failed", 2],
      ],
    );
    assert.ok(
      final.workers[0].resultFile.endsWith(`${sessionName}-worker-1.txt`),
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
    assert.equal(existsSync(headlessResultsIndexPath(sessionName)), false);
  });
});
