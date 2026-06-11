// tests/unit/cto-status.test.mjs — cto status overlay projection
//
// active_shards 와 live_sessions 의 source 가 다르다는 계약을 고정한다:
// live_sessions 는 synapse overlay(실시간 세션), active_shards 는 collect 가
// .triflux/swarm-locks.json 을 snapshot 한 current.json(sources.tfx_swarm.detail.
// shards)에서 온다. 이전에는 active_shards 가 무조건 [] 로 하드코딩돼 있었다.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { runStatus } from "../../cto/status.mjs";

function collectingStdout() {
  let buf = "";
  return {
    write(chunk) {
      buf += chunk;
    },
    text() {
      return buf;
    },
  };
}

function writeCurrent(lakeRoot, current) {
  mkdirSync(lakeRoot, { recursive: true });
  writeFileSync(
    join(lakeRoot, "current.json"),
    JSON.stringify(current),
    "utf8",
  );
}

const emptyOverlay = async () => ({ sessions: [], active_shards: [] });

describe("cto status active_shards / live_sessions projection", () => {
  let sandboxDir;
  let lakeRoot;

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), "triflux-cto-status-"));
    lakeRoot = join(sandboxDir, ".triflux", "lake");
  });

  afterEach(() => {
    rmSync(sandboxDir, { recursive: true, force: true });
  });

  it("fills active_shards from the collected swarm snapshot when overlay is empty", async () => {
    writeCurrent(lakeRoot, {
      schema_version: "cto-lake.v1",
      sources: {
        tfx_swarm: {
          available: true,
          detail: {
            shards: [
              { shard_name: "auth", phase: "active", members: ["codex"] },
              { name: "ui" },
              { nope: "no identifier" },
            ],
          },
        },
      },
    });

    const status = await runStatus(["--json"], {
      rootDir: sandboxDir,
      lakeRoot,
      stdout: collectingStdout(),
      synapseReader: emptyOverlay,
    });

    // shard_name 식별자가 없는 엔트리는 제외된다.
    assert.equal(status.active_shards.length, 2);
    assert.equal(status.active_shards[0].shard_name, "auth");
    assert.equal(status.active_shards[0].phase, "active");
    assert.deepEqual(status.active_shards[0].members, ["codex"]);
    assert.equal(status.active_shards[1].shard_name, "ui");
  });

  it("returns empty active_shards when the snapshot has no swarm shards", async () => {
    writeCurrent(lakeRoot, {
      schema_version: "cto-lake.v1",
      sources: { tfx_swarm: { available: false } },
    });

    const status = await runStatus(["--json"], {
      rootDir: sandboxDir,
      lakeRoot,
      stdout: collectingStdout(),
      synapseReader: emptyOverlay,
    });

    assert.deepEqual(status.active_shards, []);
  });

  it("prefers synapse overlay active_shards over the snapshot when present", async () => {
    writeCurrent(lakeRoot, {
      schema_version: "cto-lake.v1",
      sources: {
        tfx_swarm: { detail: { shards: [{ shard_name: "snapshot-shard" }] } },
      },
    });

    const status = await runStatus(["--json"], {
      rootDir: sandboxDir,
      lakeRoot,
      stdout: collectingStdout(),
      synapseReader: async () => ({
        sessions: [],
        active_shards: [{ shard_name: "live-shard", phase: "active" }],
      }),
    });

    assert.equal(status.active_shards.length, 1);
    assert.equal(status.active_shards[0].shard_name, "live-shard");
  });

  it("still sources live_sessions from the synapse overlay, independent of shards", async () => {
    writeCurrent(lakeRoot, {
      schema_version: "cto-lake.v1",
      sources: { tfx_swarm: { detail: { shards: [{ shard_name: "s1" }] } } },
    });

    const status = await runStatus(["--json"], {
      rootDir: sandboxDir,
      lakeRoot,
      stdout: collectingStdout(),
      synapseReader: async () => ({
        sessions: [{ sessionId: "live-1", phase: "active" }],
        active_shards: [],
      }),
    });

    assert.equal(status.live_sessions.length, 1);
    assert.equal(status.live_sessions[0].sessionId, "live-1");
    // active_shards 는 overlay 와 무관하게 snapshot 에서 채워진다.
    assert.equal(status.active_shards[0].shard_name, "s1");
  });

  it("ignores overlay shards with no identifier and falls back to the snapshot", async () => {
    writeCurrent(lakeRoot, {
      schema_version: "cto-lake.v1",
      sources: { tfx_swarm: { detail: { shards: [{ shard_name: "snap" }] } } },
    });

    const status = await runStatus(["--json"], {
      rootDir: sandboxDir,
      lakeRoot,
      stdout: collectingStdout(),
      // normalizeSynapseOverlay turns this into [{ shard_name: null, ... }];
      // it must NOT suppress the valid snapshot shard.
      synapseReader: async () => ({
        sessions: [],
        active_shards: [{ nope: "bad" }],
      }),
    });

    assert.equal(status.active_shards.length, 1);
    assert.equal(status.active_shards[0].shard_name, "snap");
  });
});
