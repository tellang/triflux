// tests/unit/cto-collect-swarm.test.mjs — collectSwarm shard derivation
//
// The real .triflux/swarm-locks.json producer (hub/team/swarm-locks.mjs persist)
// writes a lock OBJECT MAP { "<file>": { workerId, leaseType, sessionMeta } },
// not { shards: [...] }. workerId IS the shard name (swarm-hypervisor calls
// acquire(shard.name, shard.files)). This test reproduces the exact
// createSwarmLocks -> persist -> collectSwarm path so cto status active_shards
// can never silently regress to [] when real locks exist.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { collectSwarm } from "../../cto/collect.mjs";
import { createSwarmLocks } from "../../hub/team/swarm-locks.mjs";

describe("collectSwarm derives active shards from the real lock map", () => {
  let sandboxDir;

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), "triflux-collect-swarm-"));
  });

  afterEach(() => {
    rmSync(sandboxDir, { recursive: true, force: true });
  });

  it("reduces the persisted lock object map (workerId=shard.name) into shard rows", () => {
    const persistPath = join(sandboxDir, ".triflux", "swarm-locks.json");
    const locks = createSwarmLocks({ repoRoot: sandboxDir, persistPath });
    locks.acquire("shard-auth", ["src/a.js", "src/b.js"], {
      sessionMeta: { sessionId: "s1", host: "ryzen", taskSummary: "auth" },
    });
    locks.acquire("shard-ui", ["src/c.js"]);

    const result = collectSwarm(sandboxDir, "2026-06-02T00:00:00.000Z");

    assert.equal(result.available, true);
    const shards = result.detail.shards;
    assert.equal(shards.length, 2);
    const byName = Object.fromEntries(shards.map((s) => [s.shard_name, s]));
    assert.ok(byName["shard-auth"], "shard-auth row missing");
    assert.equal(byName["shard-auth"].phase, "active");
    assert.deepEqual(byName["shard-auth"].members, ["ryzen"]);
    assert.ok(byName["shard-ui"], "shard-ui row missing");
    assert.deepEqual(byName["shard-ui"].members, []);
  });

  it("still honors a future { shards: [...] } array shape (forward-compat)", () => {
    const dir = join(sandboxDir, ".triflux");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "swarm-locks.json"),
      JSON.stringify({ shards: [{ shard_name: "explicit" }] }),
      "utf8",
    );

    const result = collectSwarm(sandboxDir, "2026-06-02T00:00:00.000Z");

    assert.equal(result.detail.shards.length, 1);
    assert.equal(result.detail.shards[0].shard_name, "explicit");
  });

  it("reports an unavailable source when there are no locks or logs", () => {
    const result = collectSwarm(sandboxDir, "2026-06-02T00:00:00.000Z");
    assert.equal(result.available, false);
  });
});
