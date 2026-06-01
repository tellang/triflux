// tests/unit/synapse-registry.test.mjs — Synapse session registry 유닛 테스트

import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
    `tfx-synapse-registry-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function baseMeta(overrides = {}) {
  return {
    sessionId: "session-a",
    host: "local",
    worktreePath: "/tmp/wt-a",
    branch: "main",
    dirtyFiles: [],
    taskSummary: "test task",
    ...overrides,
  };
}

describe("synapse-registry", () => {
  let tmpDir;
  let persistPath;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    persistPath = join(tmpDir, "synapse-registry.json");
  });

  it("register + getActive returns the session", () => {
    const reg = createSynapseRegistry({ persistPath });
    const res = reg.register(baseMeta());
    assert.equal(res.ok, true);
    assert.equal(res.sessionId, "session-a");

    const active = reg.getActive();
    assert.equal(active.length, 1);
    assert.equal(active[0].sessionId, "session-a");
    assert.equal(active[0].taskSummary, "test task");
    assert.equal(active[0].status, "active");

    reg.destroy();
  });

  it("register supports split sessionId + meta arguments", () => {
    const reg = createSynapseRegistry({ persistPath });
    const meta = baseMeta({
      sessionId: "session-split",
      branch: "feature/split-register",
    });
    const res = reg.register(meta.sessionId, meta);

    assert.equal(res.ok, true);
    assert.equal(res.sessionId, "session-split");
    assert.equal(
      reg.getSession("session-split")?.branch,
      "feature/split-register",
    );

    reg.destroy();
  });

  it("heartbeat updates lastHeartbeat and partial meta", () => {
    const reg = createSynapseRegistry({ persistPath });
    reg.register(baseMeta());
    const before = reg.getSession("session-a").lastHeartbeat;

    // Short sleep so monotonic clock advances
    const until = Date.now() + 5;
    while (Date.now() < until) {
      /* spin */
    }

    reg.heartbeat("session-a", {
      taskSummary: "updated task",
      dirtyFiles: ["src/x.mjs"],
    });

    const after = reg.getSession("session-a");
    assert.ok(after.lastHeartbeat >= before);
    assert.equal(after.taskSummary, "updated task");
    assert.deepEqual(after.dirtyFiles, ["src/x.mjs"]);

    reg.destroy();
  });

  it("marks session stale after timeout", async () => {
    const reg = createSynapseRegistry({
      persistPath,
      localHeartbeatIntervalMs: 5,
      localTimeoutMs: 20,
    });

    let staleCaught = null;
    reg.onStale((session) => {
      staleCaught = session;
    });

    reg.register(baseMeta());
    // Wait longer than timeout + interval
    await new Promise((resolve) => setTimeout(resolve, 80));

    const session = reg.getSession("session-a");
    assert.equal(session.status, "stale");
    assert.ok(staleCaught !== null);
    assert.equal(staleCaught.sessionId, "session-a");

    reg.destroy();
  });

  it("unregister removes the session", () => {
    const reg = createSynapseRegistry({ persistPath });
    reg.register(baseMeta());
    assert.equal(reg.getActive().length, 1);

    const removed = reg.unregister("session-a");
    assert.equal(removed, true);
    assert.equal(reg.getActive().length, 0);
    assert.equal(reg.getSession("session-a"), null);

    reg.destroy();
  });

  it("persists and restores session state", () => {
    const reg1 = createSynapseRegistry({ persistPath });
    reg1.register(
      baseMeta({ sessionId: "session-x", taskSummary: "persist me" }),
    );
    reg1.destroy();

    assert.equal(existsSync(persistPath), true);

    const reg2 = createSynapseRegistry({ persistPath });
    const restored = reg2.getSession("session-x");
    assert.ok(restored);
    assert.equal(restored.taskSummary, "persist me");

    reg2.destroy();
  });

  it("rejects duplicate sessionId", () => {
    const reg = createSynapseRegistry({ persistPath });
    const first = reg.register(baseMeta());
    assert.equal(first.ok, true);

    const dup = reg.register(baseMeta({ taskSummary: "dup attempt" }));
    assert.equal(dup.ok, false);

    // Original taskSummary must remain
    assert.equal(reg.getSession("session-a").taskSummary, "test task");

    reg.destroy();
  });

  it("handles corrupted persist file with a clean start", () => {
    writeFileSync(persistPath, "{ not valid json", "utf8");
    const reg = createSynapseRegistry({ persistPath });
    assert.equal(reg.getActive().length, 0);

    const res = reg.register(baseMeta());
    assert.equal(res.ok, true);
    reg.destroy();
  });

  it("applies different timeouts for remote sessions", async () => {
    const reg = createSynapseRegistry({
      persistPath,
      localHeartbeatIntervalMs: 5,
      localTimeoutMs: 15,
      remoteHeartbeatIntervalMs: 5,
      remoteTimeoutMs: 120,
    });

    reg.register(baseMeta({ sessionId: "local-1", isRemote: false }));
    reg.register(
      baseMeta({
        sessionId: "remote-1",
        isRemote: true,
        host: "ultra4",
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 60));

    const local = reg.getSession("local-1");
    const remote = reg.getSession("remote-1");

    assert.equal(local.status, "stale");
    assert.equal(remote.status, "active");

    reg.destroy();
  });
});

describe("synapse-registry peer-discovery", () => {
  let tmpDir;
  let persistPath;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    persistPath = join(tmpDir, "synapse-registry-peers.json");
  });

  it("sanitizeSession defaults additive fields for legacy rows", () => {
    // Write a persist file in the *old* schema (no cwd/pid/sessionKind).
    const legacy = {
      "legacy-1": {
        sessionId: "legacy-1",
        host: "local",
        worktreePath: "/tmp/wt-legacy",
        branch: "main",
        dirtyFiles: [],
        taskSummary: "old row",
        lastHeartbeat: Date.now(),
        status: "active",
        isRemote: false,
      },
    };
    writeFileSync(persistPath, JSON.stringify(legacy), "utf8");

    const reg = createSynapseRegistry({ persistPath });
    const restored = reg.getSession("legacy-1");
    assert.ok(restored);
    assert.equal(restored.cwd, "");
    assert.equal(restored.pid, null);
    assert.equal(restored.sessionKind, "headless");

    reg.destroy();
  });

  it("register stores cwd/pid/sessionKind and persist round-trips them", () => {
    const reg1 = createSynapseRegistry({ persistPath });
    reg1.register(
      baseMeta({
        sessionId: "interactive-1",
        cwd: "/home/dev/proj",
        pid: 4242,
        sessionKind: "interactive",
      }),
    );
    const stored = reg1.getSession("interactive-1");
    assert.equal(stored.cwd, "/home/dev/proj");
    assert.equal(stored.pid, 4242);
    assert.equal(stored.sessionKind, "interactive");
    reg1.destroy();

    const reg2 = createSynapseRegistry({ persistPath });
    const restored = reg2.getSession("interactive-1");
    assert.equal(restored.cwd, "/home/dev/proj");
    assert.equal(restored.pid, 4242);
    assert.equal(restored.sessionKind, "interactive");
    reg2.destroy();
  });

  it("querySessions filters by cwd and excludes the caller", () => {
    const reg = createSynapseRegistry({ persistPath });
    reg.register(
      baseMeta({ sessionId: "a", cwd: "/shared/cwd", worktreePath: "/wt/x" }),
    );
    reg.register(
      baseMeta({ sessionId: "b", cwd: "/shared/cwd", worktreePath: "/wt/x" }),
    );
    reg.register(
      baseMeta({ sessionId: "c", cwd: "/other/cwd", worktreePath: "/wt/y" }),
    );

    const peersForA = reg.querySessions({
      cwd: "/shared/cwd",
      excludeSessionId: "a",
    });
    assert.equal(peersForA.length, 1);
    assert.equal(peersForA[0].sessionId, "b");

    const byWorktree = reg.querySessions({
      worktree: "/wt/x",
      excludeSessionId: "a",
    });
    assert.equal(byWorktree.length, 1);
    assert.equal(byWorktree[0].sessionId, "b");

    reg.destroy();
  });

  it("querySessions omits stale sessions", async () => {
    const reg = createSynapseRegistry({
      persistPath,
      localHeartbeatIntervalMs: 5,
      localTimeoutMs: 15,
    });
    reg.register(baseMeta({ sessionId: "headless-dead", cwd: "/shared" }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(reg.getSession("headless-dead").status, "stale");

    const peers = reg.querySessions({ cwd: "/shared" });
    assert.equal(peers.length, 0);

    reg.destroy();
  });

  it("interactive session is not stale before its 5-min TTL but goes idle", async () => {
    const reg = createSynapseRegistry({
      persistPath,
      // Headless local would go stale at 15ms; interactive must NOT.
      localHeartbeatIntervalMs: 5,
      localTimeoutMs: 15,
      // Interactive: idle after 10ms (interval), stale only after 5s (TTL).
      interactiveHeartbeatIntervalMs: 10,
      interactiveTimeoutMs: 5_000,
    });

    let idleCaught = null;
    reg.onIdle((session) => {
      idleCaught = session;
    });

    reg.register(
      baseMeta({ sessionId: "ix", sessionKind: "interactive", cwd: "/ix" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 60));

    const session = reg.getSession("ix");
    assert.equal(session.status, "idle");
    assert.ok(idleCaught !== null);
    assert.equal(idleCaught.sessionId, "ix");
    // Idle sessions are still live peers.
    assert.equal(reg.querySessions({ cwd: "/ix" }).length, 1);

    reg.destroy();
  });

  it("getActive()는 idle interactive 세션도 live로 포함한다 (git-preflight 충돌 가드)", async () => {
    const reg = createSynapseRegistry({
      persistPath,
      interactiveHeartbeatIntervalMs: 10,
      interactiveTimeoutMs: 5_000,
    });
    reg.register(
      baseMeta({
        sessionId: "ix-idle",
        sessionKind: "interactive",
        cwd: "/ix-idle",
        worktreePath: "/ix-idle",
        dirtyFiles: ["hub/server.mjs"],
      }),
    );
    // Past the idle interval (10ms) but well under the TTL (5s) → idle, still live.
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(reg.getSession("ix-idle").status, "idle");

    // git-preflight reads getActive() to find other live sessions whose dirty
    // files would conflict. An idle interactive session is still live, so it
    // MUST appear here with its dirty files (regression: getActive() previously
    // returned only "active" and hid idle sessions from that safety check).
    const live = reg.getActive();
    const ixIdle = live.find((s) => s.sessionId === "ix-idle");
    assert.ok(
      ixIdle,
      "idle interactive session must be visible to getActive()",
    );
    assert.equal(ixIdle.status, "idle");
    assert.deepEqual(ixIdle.dirtyFiles, ["hub/server.mjs"]);

    reg.destroy();
  });

  it("interactive session becomes stale only after its TTL", async () => {
    const reg = createSynapseRegistry({
      persistPath,
      interactiveHeartbeatIntervalMs: 5,
      interactiveTimeoutMs: 25,
    });
    reg.register(baseMeta({ sessionId: "ix2", sessionKind: "interactive" }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(reg.getSession("ix2").status, "stale");
    reg.destroy();
  });

  it("projectPeer redacts raw cwd/pid and exposes label/hash + sameCwd", () => {
    const reg = createSynapseRegistry({ persistPath });
    reg.register(
      baseMeta({
        sessionId: "peer-1",
        cwd: "/home/dev/secret-project",
        pid: 9001,
        worktreePath: "/home/dev/secret-project/.wt/shard",
        branch: "feature/x",
        sessionKind: "interactive",
      }),
    );

    const [match] = reg.querySessions({ cwd: "/home/dev/secret-project" });
    const projected = projectPeer(match, { cwd: "/home/dev/secret-project" });

    // Raw path/pid must never leak.
    assert.equal(projected.cwd, undefined);
    assert.equal(projected.pid, undefined);
    assert.equal(projected.dirtyFiles, undefined);
    // Redacted correlates present.
    assert.equal(projected.cwdLabel, "secret-project");
    assert.ok(projected.cwdHash.length > 0);
    assert.equal(projected.sameCwd, true);
    assert.equal(projected.worktreeLabel, "shard");
    assert.equal(projected.branch, "feature/x");
    assert.equal(projected.sessionKind, "interactive");

    // Different caller cwd → sameCwd false.
    const other = projectPeer(match, { cwd: "/elsewhere" });
    assert.equal(other.sameCwd, false);

    reg.destroy();
  });

  it("querySessions with no locator returns [] (never enumerates the registry)", () => {
    const reg = createSynapseRegistry({ persistPath });
    reg.register(baseMeta({ sessionId: "e1", cwd: "/a", worktreePath: "/a" }));
    reg.register(baseMeta({ sessionId: "e2", cwd: "/b", worktreePath: "/b" }));

    // Empty filter, empty strings, whitespace-only excludeId — all must yield [].
    assert.deepEqual(reg.querySessions(), []);
    assert.deepEqual(reg.querySessions({}), []);
    assert.deepEqual(reg.querySessions({ cwd: "", worktree: "" }), []);
    assert.deepEqual(reg.querySessions({ excludeSessionId: "e1" }), []);

    reg.destroy();
  });

  it("querySessions matches cwd OR worktree (same worktree, different subdir)", () => {
    const reg = createSynapseRegistry({ persistPath });
    const worktree = "/repo/.wt/shard-1";
    // Peer lives in a SUBDIR of the shared worktree → different cwd, same worktree.
    reg.register(
      baseMeta({
        sessionId: "sub",
        cwd: "/repo/.wt/shard-1/packages/core",
        worktreePath: worktree,
      }),
    );
    // Unrelated session in a different worktree must not match.
    reg.register(
      baseMeta({ sessionId: "other", cwd: "/repo2", worktreePath: "/repo2" }),
    );

    // Caller is at the worktree root with the worktree locator. A conjunctive
    // (AND cwd) match would wrongly drop the subdir peer; OR keeps it.
    const peers = reg.querySessions({
      cwd: worktree,
      worktree,
      excludeSessionId: "caller",
    });
    assert.equal(peers.length, 1);
    assert.equal(peers[0].sessionId, "sub");

    reg.destroy();
  });

  it("projectPeer redacts Windows-style paths regardless of host platform", () => {
    const reg = createSynapseRegistry({ persistPath });
    // On POSIX, node:path.basename() would NOT split a Windows path, leaking the
    // whole `C:\Users\Alice\secret` as the label. The separator-agnostic pathLabel
    // must return only the last segment.
    reg.register(
      baseMeta({
        sessionId: "win",
        cwd: "C:\\Users\\Alice\\secret",
        worktreePath: "C:\\Users\\Alice\\secret\\.wt\\shard",
        sessionKind: "interactive",
      }),
    );

    const [match] = reg.querySessions({ cwd: "C:\\Users\\Alice\\secret" });
    const projected = projectPeer(match, { cwd: "C:\\Users\\Alice\\secret" });

    assert.equal(projected.cwdLabel, "secret");
    assert.equal(projected.worktreeLabel, "shard");
    // Raw Windows path must never appear anywhere in the serialized projection.
    const serialized = JSON.stringify(projected);
    assert.ok(!serialized.includes("Alice"), "raw Windows path leaked");
    assert.ok(!serialized.includes("C:\\"), "raw Windows drive leaked");

    reg.destroy();
  });

  it("projectPeer never exposes raw worktreePath (only worktreeLabel)", () => {
    const reg = createSynapseRegistry({ persistPath });
    const worktree = "/home/dev/secret-wt/shard-9";
    reg.register(
      baseMeta({
        sessionId: "wtp",
        cwd: worktree,
        worktreePath: worktree,
        sessionKind: "interactive",
      }),
    );

    const [match] = reg.querySessions({ worktree });
    const projected = projectPeer(match, { worktree });

    assert.equal(projected.worktreePath, undefined);
    assert.equal(projected.worktreeLabel, "shard-9");
    const serialized = JSON.stringify(projected);
    assert.ok(
      !serialized.includes("secret-wt"),
      "raw worktree path leaked in projection",
    );

    reg.destroy();
  });
});
