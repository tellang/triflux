// tests/unit/swarm-locks-v2.test.mjs — Synapse v1 locks 확장 테스트
// Covers leaseType (exclusive/shared-read) + sessionMeta on top of swarm-locks.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";

import { createSwarmLocks } from "../../hub/team/swarm-locks.mjs";

function makeTmpDir() {
  const dir = join(
    tmpdir(),
    `tfx-swarm-locks-v2-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("swarm-locks v2 (leaseType + sessionMeta)", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  it("shared-read lets multiple workers coexist", () => {
    const locks = createSwarmLocks({ repoRoot: tmpDir });
    const first = locks.acquire("w1", ["a.mjs"], { leaseType: "shared-read" });
    assert.equal(first.ok, true);

    const second = locks.acquire("w2", ["a.mjs"], { leaseType: "shared-read" });
    assert.equal(second.ok, true);
  });

  it("exclusive blocks existing shared-read", () => {
    const locks = createSwarmLocks({ repoRoot: tmpDir });
    locks.acquire("w1", ["a.mjs"], { leaseType: "shared-read" });

    const excl = locks.acquire("w2", ["a.mjs"], { leaseType: "exclusive" });
    assert.equal(excl.ok, false);
    assert.equal(excl.conflicts.length, 1);
    assert.equal(excl.conflicts[0].file, "a.mjs");
    assert.equal(excl.conflicts[0].holder, "w1");
  });

  it("snapshot exposes leaseType and sessionMeta", () => {
    const locks = createSwarmLocks({ repoRoot: tmpDir });
    locks.acquire("w1", ["a.mjs"], {
      leaseType: "exclusive",
      sessionMeta: {
        sessionId: "session-a",
        host: "local",
        taskSummary: "harden auth",
      },
    });

    const snap = locks.snapshot();
    assert.equal(snap.length, 1);
    assert.equal(snap[0].leaseType, "exclusive");
    assert.equal(snap[0].sessionMeta.sessionId, "session-a");
    assert.equal(snap[0].sessionMeta.taskSummary, "harden auth");
  });

  it("legacy calls without opts default to exclusive lease", () => {
    const locks = createSwarmLocks({ repoRoot: tmpDir });
    const res = locks.acquire("w1", ["a.mjs"]);
    assert.equal(res.ok, true);

    const snap = locks.snapshot();
    assert.equal(snap[0].leaseType, "exclusive");
    assert.equal(snap[0].sessionMeta, null);
  });

  it("restores legacy persist entries without leaseType as exclusive", () => {
    const persistPath = join(tmpDir, "swarm-locks.json");
    // Legacy shape: no leaseType or sessionMeta
    const legacy = {
      "legacy.mjs": {
        workerId: "w-legacy",
        acquiredAt: Date.now(),
      },
    };
    writeFileSync(persistPath, JSON.stringify(legacy), "utf8");

    const locks = createSwarmLocks({ repoRoot: tmpDir, persistPath });
    const snap = locks.snapshot();
    assert.equal(snap.length, 1);
    assert.equal(snap[0].leaseType, "exclusive");
    assert.equal(snap[0].sessionMeta, null);
  });
});
