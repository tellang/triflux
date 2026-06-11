import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, it } from "node:test";

import { createConductor } from "../../hub/team/conductor.mjs";

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeMockSpawn() {
  return function mockSpawn() {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;
    setImmediate(() => child.emit("exit", 0, null));
    return child;
  };
}

function readJsonl(filePath) {
  const text = readFileSync(filePath, "utf8").trim();
  if (!text) return [];
  return text.split("\n").map((line) => JSON.parse(line));
}

describe("conductor CTO pull surface", () => {
  let sandboxDir;
  let conductor;

  afterEach(async () => {
    if (conductor) {
      await conductor.shutdown("afterEach_cleanup");
      conductor = null;
    }
    if (sandboxDir) {
      rmSync(sandboxDir, { recursive: true, force: true });
      sandboxDir = null;
    }
  });

  it("logs CTO context additively when a lake snapshot is available", async () => {
    sandboxDir = makeTempDir("triflux-conductor-cto-");
    const logsDir = join(sandboxDir, "logs");
    const lakeRoot = join(sandboxDir, ".triflux", "lake");
    mkdirSync(lakeRoot, { recursive: true });
    writeFileSync(
      join(lakeRoot, "current.json"),
      JSON.stringify({
        schema_version: "cto-lake.v1",
        repo: { branch: "feat/cto-t6e" },
        sources: { git: { available: true } },
        ledger_tail: [{ event: "collect" }],
        live_sessions: [],
        active_shards: [],
      }),
      "utf8",
    );

    conductor = createConductor({
      logsDir,
      ctoLakeRoot: lakeRoot,
      enableMesh: false,
      probeOpts: {
        intervalMs: 999_999,
        l1ThresholdMs: 999_999,
        l3ThresholdMs: 999_999,
      },
      deps: { spawn: makeMockSpawn() },
    });

    conductor.spawnSession({
      id: "cto-context-session",
      agent: "claude",
      prompt: "echo_test",
    });
    await conductor.shutdown("flush_events");

    const events = readJsonl(conductor.eventLogPath);
    const ctoEvent = events.find((event) => event.event === "cto_context");
    assert.equal(ctoEvent.session, "cto-context-session");
    assert.equal(ctoEvent.snapshot.schema_version, "cto-lake.v1");
    assert.equal(ctoEvent.snapshot.repo.branch, "feat/cto-t6e");
  });
});
