// tests/unit/synapse-e2e.test.mjs — Synapse v1 e2e 시나리오
// Layer 1 (registry + locks + preflight) end-to-end interaction.

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";

import { createGitPreflight } from "../../hub/team/git-preflight.mjs";
import { createSwarmLocks } from "../../hub/team/swarm-locks.mjs";
import { createSynapseRegistry } from "../../hub/team/synapse-registry.mjs";
import {
  pruneWorktree,
  rebaseShardOntoIntegration,
} from "../../hub/team/worktree-lifecycle.mjs";

function makeTmpDir() {
  const dir = join(
    tmpdir(),
    `tfx-synapse-e2e-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("synapse-v1 e2e", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  it("two sessions contend on same file → second is blocked with report", () => {
    const registryPath = join(tmpDir, "registry.json");
    const locksPath = join(tmpDir, "locks.json");

    const registry = createSynapseRegistry({ persistPath: registryPath });
    const locks = createSwarmLocks({ repoRoot: tmpDir, persistPath: locksPath });
    const preflight = createGitPreflight({ registry, locks });

    // Session A starts hardening auth.mjs, claims exclusive lease
    registry.register({
      sessionId: "session-A",
      host: "local",
      worktreePath: join(tmpDir, "wt-a"),
      branch: "main",
      dirtyFiles: ["middleware/auth.mjs"],
      taskSummary: "harden auth rate limiting",
    });
    const leaseA = locks.acquire("worker-A", ["middleware/auth.mjs"], {
      leaseType: "exclusive",
      sessionMeta: {
        sessionId: "session-A",
        host: "local",
        taskSummary: "harden auth rate limiting",
      },
    });
    assert.equal(leaseA.ok, true);

    // Session B tries to rebase while A is still active — preflight must block
    const decision = preflight.checkRebase(
      {},
      { sessionId: "session-B", workerId: "worker-B" },
    );

    assert.equal(decision.allowed, false);
    assert.equal(decision.conflicts.length >= 1, true);
    const conflictFiles = decision.conflicts.map((c) => c.file);
    assert.ok(conflictFiles.includes("middleware/auth.mjs"));
    assert.ok(decision.recommendation.length > 0);

    // After A releases, B can proceed
    locks.release("worker-A");
    registry.unregister("session-A");

    const clearDecision = preflight.checkRebase(
      {},
      { sessionId: "session-B", workerId: "worker-B" },
    );
    assert.equal(clearDecision.allowed, true);

    registry.destroy();
  });

  it("preflight fails open when hub-side data throws", () => {
    const registry = {
      getActive: () => {
        throw new Error("registry offline");
      },
    };
    const locks = {
      snapshot: () => {
        throw new Error("locks offline");
      },
    };
    const preflight = createGitPreflight({
      registry,
      locks,
      logger: () => {},
    });

    const decision = preflight.checkRebase(
      {},
      { sessionId: "session-C", workerId: "worker-C" },
    );
    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, "hub_unavailable_fail_open");
  });

  it("rebaseShardOntoIntegration short-circuits when preflight blocks", async () => {
    // Fake preflight that always blocks — no git commands should run.
    const blockingPreflight = {
      checkRebase: () => ({
        allowed: false,
        reason: "overlap_with_active_session",
        conflicts: [
          { file: "foo.mjs", activeSession: "other", activeTask: "wip" },
        ],
        recommendation: "wait for other",
      }),
    };

    const result = await rebaseShardOntoIntegration({
      shardBranch: "shard/x",
      integrationBranch: "integration",
      rootDir: tmpDir, // not a git repo — proves git wasn't called
      preflight: blockingPreflight,
      sessionContext: { sessionId: "me", workerId: "me" },
    });

    assert.equal(result.ok, false);
    assert.ok(result.error.includes("git-preflight blocked"));
    assert.equal(result.preflight.allowed, false);
    assert.equal(result.preflight.conflicts.length, 1);
  });

  it("pruneWorktree short-circuits when preflight blocks", async () => {
    const blockingPreflight = {
      checkWorktreeRemove: () => ({
        allowed: false,
        reason: "active_worktree",
        conflicts: [
          { file: "/repo/wt-a", activeSession: "other", activeTask: "wip" },
        ],
        recommendation: "finish other first",
      }),
    };

    const result = await pruneWorktree({
      worktreePath: "/repo/wt-a",
      branchName: "shard/x",
      rootDir: tmpDir,
      preflight: blockingPreflight,
      sessionContext: { sessionId: "me", workerId: "me" },
    });

    assert.equal(result.ok, false);
    assert.ok(result.error.includes("git-preflight blocked"));
    assert.equal(result.preflight.reason, "active_worktree");
  });
});
