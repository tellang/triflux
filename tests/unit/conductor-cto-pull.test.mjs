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

function writeLakeSnapshot(lakeRoot) {
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
}

async function spawnAndReadEvents(sandboxDir, lakeRoot) {
  const conductor = createConductor({
    logsDir: join(sandboxDir, "logs"),
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
  return { conductor, events: readJsonl(conductor.eventLogPath) };
}

describe("conductor CTO pull surface", () => {
  let sandboxDir;
  let conductor;
  const originalNorthStar = process.env.TFX_CTO_NORTH_STAR;

  afterEach(async () => {
    if (originalNorthStar === undefined) delete process.env.TFX_CTO_NORTH_STAR;
    else process.env.TFX_CTO_NORTH_STAR = originalNorthStar;
    if (conductor) {
      await conductor.shutdown("afterEach_cleanup");
      conductor = null;
    }
    if (sandboxDir) {
      rmSync(sandboxDir, { recursive: true, force: true });
      sandboxDir = null;
    }
  });

  it("does not log CTO context by default (ADR-0018 opt-in)", async () => {
    delete process.env.TFX_CTO_NORTH_STAR;
    sandboxDir = makeTempDir("triflux-conductor-cto-off-");
    const lakeRoot = join(sandboxDir, ".triflux", "lake");
    writeLakeSnapshot(lakeRoot);

    const result = await spawnAndReadEvents(sandboxDir, lakeRoot);
    conductor = result.conductor;

    assert.equal(
      result.events.find((event) => event.event === "cto_context"),
      undefined,
    );
  });

  it("logs CTO context additively when north star is enabled", async () => {
    process.env.TFX_CTO_NORTH_STAR = "1";
    sandboxDir = makeTempDir("triflux-conductor-cto-");
    const lakeRoot = join(sandboxDir, ".triflux", "lake");
    writeLakeSnapshot(lakeRoot);

    const result = await spawnAndReadEvents(sandboxDir, lakeRoot);
    conductor = result.conductor;

    const ctoEvent = result.events.find(
      (event) => event.event === "cto_context",
    );
    assert.equal(ctoEvent.session, "cto-context-session");
    assert.equal(ctoEvent.snapshot.schema_version, "cto-lake.v1");
    assert.equal(ctoEvent.snapshot.repo.branch, "feat/cto-t6e");
  });
});
