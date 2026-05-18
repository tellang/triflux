import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cleanupDetachedHubProcesses,
  parseDetachedHubProcessRows,
} from "../../bin/triflux.mjs";

describe("doctor stale hub diagnostics", () => {
  it("reports only PPID=1 hub/server.mjs processes from ps output", () => {
    const rows = parseDetachedHubProcessRows(`
      101     1  12000 01:02:03 node /repo/hub/server.mjs
      102    99  12000 00:00:05 node /repo/hub/server.mjs
      103     1   9000 00:01:00 node /repo/other/server.mjs
      104     1  24000 2-03:04:05 /opt/node /repo/packages/triflux/hub/server.mjs --flag
    `);

    assert.deepEqual(
      rows.map((row) => ({
        pid: row.pid,
        ppid: row.ppid,
        rssKb: row.rssKb,
        uptime: row.uptime,
      })),
      [
        { pid: 101, ppid: 1, rssKb: 12000, uptime: "01:02:03" },
        { pid: 104, ppid: 1, rssKb: 24000, uptime: "2-03:04:05" },
      ],
    );
  });

  it("dry-run cleanup excludes the active healthy hub and skips stale candidates", async () => {
    const result = await cleanupDetachedHubProcesses({
      activeHealthy: { pid: 101, port: 27888 },
      dryRun: true,
      apply: false,
      hubs: [
        { pid: 101, activeHealthy: true },
        { pid: 104, activeHealthy: false },
        { pid: 105, activeHealthy: false },
      ],
      killFn() {
        throw new Error("dry-run must not signal processes");
      },
    });

    assert.equal(result.excluded, 1);
    assert.equal(result.skipped, 2);
    assert.equal(result.retired, 0);
    assert.deepEqual(
      result.results.map((entry) => [entry.pid, entry.action]),
      [
        [101, "excluded-active"],
        [104, "dry-run-skip"],
        [105, "dry-run-skip"],
      ],
    );
  });
});
