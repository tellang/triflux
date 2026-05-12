import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  loadSwarmLogSessions,
  mergeRegistryAndLogSessions,
} from "../../hub/team/synapse-cli.mjs";

describe("synapse-cli swarm log union", () => {
  let sandboxDir;
  let logsDir;

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), "tfx-synapse-cli-"));
    logsDir = join(sandboxDir, ".triflux", "swarm-logs");
    mkdirSync(logsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(sandboxDir, { recursive: true, force: true });
  });

  function writeRun(runName, events) {
    const runDir = join(logsDir, runName);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "swarm-events.jsonl"),
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
      "utf8",
    );
    return runDir;
  }

  it("loads active sessions from swarm-events.jsonl when registry is absent", () => {
    writeRun("run-1777096295340", [
      {
        ts: "2026-05-12T00:00:00.000Z",
        event: "swarm_state",
        to: "running",
      },
      {
        ts: "2026-05-12T00:00:10.000Z",
        event: "shard_launched",
        shard: "shard-a",
      },
      {
        ts: "2026-05-12T00:00:20.000Z",
        event: "shard_completed",
        shard: "shard-a",
      },
      {
        ts: "2026-05-12T00:00:30.000Z",
        event: "shard_launched",
        shard: "shard-b",
      },
    ]);

    const sessions = loadSwarmLogSessions(logsDir, {
      nowMs: Date.parse("2026-05-12T00:01:00.000Z"),
    });

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].runId, "1777096295340");
    assert.equal(sessions[0].status, "active");
    assert.equal(sessions[0].source, "logs");
    assert.equal(sessions[0].shards, "1/2");
    assert.equal(sessions[0].workers, "1 alive");
  });

  it("marks log-only runs stale after 30 minutes without heartbeat", () => {
    writeRun("run-1777000000000", [
      {
        ts: "2026-05-12T00:00:00.000Z",
        event: "shard_launched",
        shard: "shard-a",
      },
    ]);

    const sessions = loadSwarmLogSessions(logsDir, {
      nowMs: Date.parse("2026-05-12T00:31:01.000Z"),
    });

    assert.equal(sessions[0].status, "stale");
  });

  it("dedupes registry and swarm-log entries by run id", () => {
    writeRun("run-run-a", [
      {
        ts: "2026-05-12T00:00:00.000Z",
        event: "shard_launched",
        shard: "shard-a",
      },
    ]);
    const logSessions = loadSwarmLogSessions(logsDir, {
      nowMs: Date.parse("2026-05-12T00:01:00.000Z"),
    });
    const registrySessions = [
      {
        sessionId: "run-a",
        runId: "run-a",
        status: "active",
        host: "local",
        branch: "main",
        dirtyFiles: [],
      },
    ];

    const merged = mergeRegistryAndLogSessions(registrySessions, logSessions);

    assert.equal(merged.length, 1);
    assert.equal(merged[0].source, "synapse + logs");
    assert.equal(merged[0].host, "local");
    assert.equal(merged[0].shards, "0/1");
  });
});
