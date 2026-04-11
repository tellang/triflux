// tests/unit/synapse-registry.test.mjs — Synapse session registry 유닛 테스트

import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";

import { createSynapseRegistry } from "../../hub/team/synapse-registry.mjs";

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
    assert.equal(reg.getSession("session-split")?.branch, "feature/split-register");

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
    reg1.register(baseMeta({ sessionId: "session-x", taskSummary: "persist me" }));
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
