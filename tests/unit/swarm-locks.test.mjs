// tests/unit/swarm-locks.test.mjs — swarm-locks 유닛 테스트

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";

import { createSwarmLocks } from "../../hub/team/swarm-locks.mjs";

function makeTmpDir() {
  const dir = join(
    tmpdir(),
    `tfx-swarm-locks-test-${process.pid}-${Date.now()}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("swarm-locks", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  describe("acquire", () => {
    it("acquires locks for new files", () => {
      const locks = createSwarmLocks({ repoRoot: tmpDir });
      const result = locks.acquire("worker-1", ["src/a.mjs", "src/b.mjs"]);

      assert.equal(result.ok, true);
      assert.equal(result.acquired.length, 2);
      assert.equal(result.conflicts.length, 0);
      assert.equal(locks.size, 2);
    });

    it("detects conflicts when different workers lock the same file", () => {
      const locks = createSwarmLocks({ repoRoot: tmpDir });
      locks.acquire("worker-1", ["src/shared.mjs"]);

      const result = locks.acquire("worker-2", ["src/shared.mjs"]);
      assert.equal(result.ok, false);
      assert.equal(result.conflicts.length, 1);
      assert.equal(result.conflicts[0].holder, "worker-1");
    });

    it("allows same worker to re-acquire its own locks", () => {
      const locks = createSwarmLocks({ repoRoot: tmpDir });
      locks.acquire("worker-1", ["src/a.mjs"]);

      const result = locks.acquire("worker-1", ["src/a.mjs"]);
      assert.equal(result.ok, true);
    });

    it("normalizes paths before locking", () => {
      const locks = createSwarmLocks({ repoRoot: tmpDir });
      locks.acquire("worker-1", ["src/a.mjs"]);

      const result = locks.acquire("worker-2", ["./src/a.mjs"]);
      assert.equal(result.ok, false);
      assert.equal(result.conflicts.length, 1);
    });
  });

  describe("release", () => {
    it("releases all locks for a worker", () => {
      const locks = createSwarmLocks({ repoRoot: tmpDir });
      locks.acquire("worker-1", ["src/a.mjs", "src/b.mjs"]);
      assert.equal(locks.size, 2);

      const count = locks.release("worker-1");
      assert.equal(count, 2);
      assert.equal(locks.size, 0);
    });

    it("does not release locks from other workers", () => {
      const locks = createSwarmLocks({ repoRoot: tmpDir });
      locks.acquire("worker-1", ["src/a.mjs"]);
      locks.acquire("worker-2", ["src/b.mjs"]);

      locks.release("worker-1");
      assert.equal(locks.size, 1);

      const result = locks.acquire("worker-1", ["src/b.mjs"]);
      assert.equal(result.ok, false);
    });
  });

  describe("check", () => {
    it("allows worker to write its own locked files", () => {
      const locks = createSwarmLocks({ repoRoot: tmpDir });
      locks.acquire("worker-1", ["src/a.mjs"]);

      const result = locks.check("worker-1", "src/a.mjs");
      assert.equal(result.allowed, true);
    });

    it("denies other workers from writing locked files", () => {
      const locks = createSwarmLocks({ repoRoot: tmpDir });
      locks.acquire("worker-1", ["src/a.mjs"]);

      const result = locks.check("worker-2", "src/a.mjs");
      assert.equal(result.allowed, false);
      assert.equal(result.holder, "worker-1");
    });

    it("allows writes to unlocked files", () => {
      const locks = createSwarmLocks({ repoRoot: tmpDir });
      const result = locks.check("worker-1", "src/unlocked.mjs");
      assert.equal(result.allowed, true);
    });
  });

  describe("validateChanges", () => {
    it("returns empty array when no violations", () => {
      const locks = createSwarmLocks({ repoRoot: tmpDir });
      locks.acquire("worker-1", ["src/a.mjs", "src/b.mjs"]);

      const violations = locks.validateChanges("worker-1", ["src/a.mjs"]);
      assert.equal(violations.length, 0);
    });

    it("detects violations when worker modifies another worker's files", () => {
      const locks = createSwarmLocks({ repoRoot: tmpDir });
      locks.acquire("worker-1", ["src/a.mjs"]);
      locks.acquire("worker-2", ["src/b.mjs"]);

      const violations = locks.validateChanges("worker-1", ["src/b.mjs"]);
      assert.equal(violations.length, 1);
      assert.equal(violations[0].holder, "worker-2");
    });
  });

  describe("TTL expiry", () => {
    it("expired locks are automatically pruned", () => {
      const locks = createSwarmLocks({ repoRoot: tmpDir, ttlMs: 1 });
      locks.acquire("worker-1", ["src/a.mjs"]);

      // Wait for TTL to expire
      const start = Date.now();
      while (Date.now() - start < 5) {
        /* spin */
      }

      const result = locks.acquire("worker-2", ["src/a.mjs"]);
      assert.equal(result.ok, true);
    });
  });

  describe("persistence", () => {
    it("persists and restores locks from JSON file", () => {
      const persistPath = join(tmpDir, ".triflux", "swarm-locks.json");

      const locks1 = createSwarmLocks({ repoRoot: tmpDir, persistPath });
      locks1.acquire("worker-1", ["src/a.mjs"]);

      // Create new instance — should restore from disk
      const locks2 = createSwarmLocks({ repoRoot: tmpDir, persistPath });
      const result = locks2.acquire("worker-2", ["src/a.mjs"]);
      assert.equal(result.ok, false);
    });
  });

  describe("snapshot", () => {
    it("returns all active locks", () => {
      const locks = createSwarmLocks({ repoRoot: tmpDir });
      locks.acquire("worker-1", ["src/a.mjs"]);
      locks.acquire("worker-2", ["src/b.mjs"]);

      const snap = locks.snapshot();
      assert.equal(snap.length, 2);
      assert.ok(snap.some((s) => s.workerId === "worker-1"));
      assert.ok(snap.some((s) => s.workerId === "worker-2"));
    });
  });

  describe("releaseAll", () => {
    it("clears all locks", () => {
      const locks = createSwarmLocks({ repoRoot: tmpDir });
      locks.acquire("worker-1", ["src/a.mjs"]);
      locks.acquire("worker-2", ["src/b.mjs"]);

      locks.releaseAll();
      assert.equal(locks.size, 0);
    });
  });
});
