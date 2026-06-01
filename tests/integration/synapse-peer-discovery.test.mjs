// tests/integration/synapse-peer-discovery.test.mjs — interactive peer discovery
//
// Hermetic: drives the Synapse registry object + the pure projectPeer()
// projection directly. No socket, no live hub/server.mjs, no real HTTP.
// Two co-located interactive sessions must discover each other (mutually),
// and the redacted projection must never leak raw cwd/pid.

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";

import {
  createSynapseRegistry,
  projectPeer,
} from "../../hub/team/synapse-registry.mjs";

function makeTmpDir() {
  const dir = join(
    tmpdir(),
    `tfx-synapse-peer-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function interactiveMeta(sessionId, cwd, overrides = {}) {
  return {
    sessionId,
    host: "local",
    cwd,
    pid: 1000 + sessionId.length,
    worktreePath: cwd,
    branch: "main",
    sessionKind: "interactive",
    isRemote: false,
    taskSummary: "",
    dirtyFiles: [],
    ...overrides,
  };
}

describe("synapse peer-discovery (hermetic integration)", () => {
  let persistPath;

  beforeEach(() => {
    persistPath = join(makeTmpDir(), "registry.json");
  });

  it("two co-located sessions discover each other (mutual)", () => {
    const reg = createSynapseRegistry({ persistPath });
    const sharedCwd = "/home/dev/triflux";

    reg.register(interactiveMeta("claude-session", sharedCwd));
    reg.register(interactiveMeta("codex-session", sharedCwd));
    // A non-co-located session must never appear in either result.
    reg.register(interactiveMeta("elsewhere-session", "/home/dev/other"));

    const peersForClaude = reg.querySessions({
      cwd: sharedCwd,
      excludeSessionId: "claude-session",
    });
    assert.equal(peersForClaude.length, 1);
    assert.equal(peersForClaude[0].sessionId, "codex-session");

    const peersForCodex = reg.querySessions({
      cwd: sharedCwd,
      excludeSessionId: "codex-session",
    });
    assert.equal(peersForCodex.length, 1);
    assert.equal(peersForCodex[0].sessionId, "claude-session");

    reg.destroy();
  });

  it("self is always excluded from its own peer query", () => {
    const reg = createSynapseRegistry({ persistPath });
    reg.register(interactiveMeta("solo-session", "/solo"));

    const peers = reg.querySessions({
      cwd: "/solo",
      excludeSessionId: "solo-session",
    });
    assert.equal(peers.length, 0);

    reg.destroy();
  });

  it("redacted projection never leaks raw cwd/pid down the discovery path", () => {
    const reg = createSynapseRegistry({ persistPath });
    const sharedCwd = "/home/dev/secret";
    reg.register(interactiveMeta("a", sharedCwd, { pid: 31337 }));
    reg.register(interactiveMeta("b", sharedCwd));

    const matches = reg.querySessions({
      cwd: sharedCwd,
      excludeSessionId: "a",
    });
    const projected = matches.map((session) =>
      projectPeer(session, { cwd: sharedCwd }),
    );

    assert.equal(projected.length, 1);
    for (const peer of projected) {
      assert.equal(peer.cwd, undefined);
      assert.equal(peer.pid, undefined);
      assert.equal(peer.dirtyFiles, undefined);
      assert.equal(peer.sameCwd, true);
      assert.equal(peer.cwdLabel, "secret");
      assert.ok(peer.cwdHash.length > 0);
    }

    reg.destroy();
  });

  it("co-located sessions sharing a worktree discover each other by worktree", () => {
    const reg = createSynapseRegistry({ persistPath });
    const worktree = "/home/dev/triflux/.wt/shard-1";
    reg.register(
      interactiveMeta("wt-a", "/home/dev/triflux/.wt/shard-1/sub", {
        worktreePath: worktree,
      }),
    );
    reg.register(
      interactiveMeta("wt-b", "/home/dev/triflux/.wt/shard-1", {
        worktreePath: worktree,
      }),
    );

    const peers = reg.querySessions({
      worktree,
      excludeSessionId: "wt-a",
    });
    assert.equal(peers.length, 1);
    assert.equal(peers[0].sessionId, "wt-b");
    const [projected] = peers.map((session) =>
      projectPeer(session, { worktree }),
    );
    assert.equal(projected.sameWorktree, true);
    assert.equal(projected.worktreeLabel, "shard-1");

    reg.destroy();
  });
});
