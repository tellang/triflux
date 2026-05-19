import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cleanupDetachedHubProcesses,
  inspectDetachedHubProcesses,
} from "../../bin/triflux.mjs";

function psRows(pids) {
  return pids
    .map(
      (pid) =>
        `${pid} 1 12000 01:00:00 node /repo/packages/triflux/hub/server.mjs`,
    )
    .join("\n");
}

function lsofEstablished(count) {
  return [
    "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME",
    ...Array.from(
      { length: count },
      (_, index) =>
        `node ${9000 + index} user 10u IPv4 0t0 TCP 127.0.0.1:27888->127.0.0.1:${50000 + index} (ESTABLISHED)`,
    ),
  ].join("\n");
}

function mockExecFile({ pids, establishedByPid }) {
  return (file, args = []) => {
    if (file === "ps" && args[0] === "-axo") return psRows(pids);
    if (file === "lsof" && args.includes("-sTCP:ESTABLISHED")) {
      const pid = Number(args[args.indexOf("-p") + 1]);
      return lsofEstablished(establishedByPid[pid] || 0);
    }
    if (file === "lsof" && args.includes("-sTCP:LISTEN")) return "";
    if (
      file === "lsof" &&
      args.some((arg) => String(arg).startsWith("-iTCP:"))
    ) {
      return "";
    }
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  };
}

async function inspect({ pids, establishedByPid }) {
  return inspectDetachedHubProcesses({
    expectedVersion: "test-version",
    exists: () => false,
    platform: "darwin",
    execFile: mockExecFile({ pids, establishedByPid }),
    fetchImpl: async () => ({ ok: false }),
  });
}

describe("doctor cleanup-stale-hubs active hub guard", () => {
  it("marks stale hub only with ESTABLISHED=0 as a cleanup candidate", async () => {
    const report = await inspect({
      pids: [101],
      establishedByPid: { 101: 0 },
    });

    assert.deepEqual(
      report.staleCandidates.map((hub) => hub.pid),
      [101],
    );
    assert.equal(report.hubs[0].activeHealthy, false);
    assert.equal(report.hubs[0].healthStatus, "stale");
  });

  it("excludes active healthy hub with ESTABLISHED>=1 from cleanup candidates", async () => {
    const report = await inspect({
      pids: [84365],
      establishedByPid: { 84365: 2 },
    });

    assert.deepEqual(report.staleCandidates, []);
    assert.equal(report.hubs[0].activeHealthy, true);
    assert.equal(report.hubs[0].healthStatus, "healthy");
    assert.equal(report.hubs[0].activeReason, "established-connection");
  });

  it("cleans up only stale hubs and preserves healthy hubs in mixed reports", async () => {
    const report = await inspect({
      pids: [201, 202, 203],
      establishedByPid: { 201: 0, 202: 1, 203: 0 },
    });

    assert.deepEqual(
      report.staleCandidates.map((hub) => hub.pid),
      [201, 203],
    );

    const signaled = [];
    const alive = new Set([201, 203]);
    const cleanup = await cleanupDetachedHubProcesses({
      hubs: report.hubs,
      dryRun: false,
      apply: true,
      graceMs: 0,
      pollMs: 0,
      killFn(pid, signal) {
        if (signal === 0) {
          if (alive.has(pid)) return;
          const error = new Error("not alive");
          error.code = "ESRCH";
          throw error;
        }
        signaled.push([pid, signal]);
        alive.delete(pid);
      },
    });

    assert.equal(cleanup.excluded, 1);
    assert.equal(cleanup.retired, 2);
    assert.deepEqual(
      cleanup.results.map((entry) => [
        entry.pid,
        entry.classification,
        entry.action,
      ]),
      [
        [201, "stale", "retired"],
        [202, "healthy", "excluded-active"],
        [203, "stale", "retired"],
      ],
    );
    assert.deepEqual(signaled, [
      [201, "SIGTERM"],
      [203, "SIGTERM"],
    ]);
  });
});
