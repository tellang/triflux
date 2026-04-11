// tests/unit/git-preflight.test.mjs — git-preflight 유닛 테스트

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createGitPreflight } from "../../hub/team/git-preflight.mjs";

function fakeRegistry(sessions) {
  return { getActive: () => sessions };
}

function fakeLocks(snapshot) {
  return { snapshot: () => snapshot };
}

describe("git-preflight", () => {
  it("checkRebase blocks on overlapping dirty files from another session", () => {
    const pf = createGitPreflight({
      registry: fakeRegistry([
        {
          sessionId: "other",
          dirtyFiles: ["middleware/auth.mjs"],
          taskSummary: "harden auth",
        },
      ]),
      locks: fakeLocks([]),
    });

    const decision = pf.checkRebase(
      {},
      { sessionId: "self", workerId: "self" },
    );

    assert.equal(decision.allowed, false);
    assert.equal(decision.conflicts.length, 1);
    assert.equal(decision.conflicts[0].file, "middleware/auth.mjs");
    assert.equal(decision.conflicts[0].activeSession, "other");
    assert.ok(decision.recommendation.includes("other"));
  });

  it("checkCherryPick detects target file leases from other workers", () => {
    const pf = createGitPreflight({
      registry: fakeRegistry([]),
      locks: fakeLocks([
        {
          file: "src/payments.mjs",
          workerId: "worker-b",
          leaseType: "exclusive",
          sessionMeta: {
            sessionId: "session-b",
            host: "remote",
            taskSummary: "add refunds",
          },
        },
      ]),
    });

    const decision = pf.checkCherryPick(
      { targetFiles: ["src/payments.mjs", "README.md"] },
      { sessionId: "session-a", workerId: "worker-a" },
    );

    assert.equal(decision.allowed, false);
    assert.equal(decision.conflicts.length, 1);
    assert.equal(decision.conflicts[0].file, "src/payments.mjs");
    assert.equal(decision.conflicts[0].leaseHolder, "worker-b");
  });

  it("fail-open when registry.getActive throws", () => {
    const pf = createGitPreflight({
      registry: {
        getActive: () => {
          throw new Error("hub down");
        },
      },
      locks: fakeLocks([]),
      logger: () => {},
    });

    const decision = pf.checkRebase({}, { sessionId: "self" });
    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, "hub_unavailable_fail_open");
  });

  it("self-session is never blocked by its own lease", () => {
    const pf = createGitPreflight({
      registry: fakeRegistry([
        {
          sessionId: "self",
          dirtyFiles: ["src/a.mjs"],
          taskSummary: "self task",
        },
      ]),
      locks: fakeLocks([
        {
          file: "src/a.mjs",
          workerId: "self",
          leaseType: "exclusive",
          sessionMeta: { sessionId: "self", host: "local", taskSummary: "x" },
        },
      ]),
    });

    const decision = pf.checkRebase(
      {},
      { sessionId: "self", workerId: "self" },
    );
    assert.equal(decision.allowed, true);
  });

  it("checkWorktreeRemove blocks when target worktree has an active session", () => {
    const pf = createGitPreflight({
      registry: fakeRegistry([
        {
          sessionId: "other",
          worktreePath: "/repo/wt-feature",
          dirtyFiles: [],
          taskSummary: "feature work",
        },
      ]),
      locks: fakeLocks([]),
    });

    const decision = pf.checkWorktreeRemove(
      { worktreePath: "/repo/wt-feature" },
      { sessionId: "self", workerId: "self" },
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, "active_worktree");
  });
});
