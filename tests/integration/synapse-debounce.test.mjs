import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { createSynapseRegistry } from "../../hub/team/synapse-registry.mjs";

function makeTmpDir() {
  const dir = join(
    tmpdir(),
    `tfx-synapse-debounce-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
    taskSummary: "initial task",
    ...overrides,
  };
}

function readPersistedSessions(persistPath) {
  return JSON.parse(readFileSync(persistPath, "utf8"));
}

async function waitFor(assertion, { timeoutMs = 1500, intervalMs = 20 } = {}) {
  const startedAt = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return assertion();
    } catch (error) {
      if (Date.now() - startedAt >= timeoutMs) {
        throw error;
      }
      await delay(intervalMs);
    }
  }
}

describe("synapse debounce persistence", () => {
  let tmpDir;
  let persistPath;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    persistPath = join(tmpDir, "synapse-registry.json");
  });

  it("debounce window 내 burst heartbeat를 마지막 상태로 합쳐 persist한다", async () => {
    const registry = createSynapseRegistry({ persistPath });
    registry.register(baseMeta());

    registry.heartbeat("session-a", {
      taskSummary: "burst-1",
      dirtyFiles: ["hub/team/synapse-registry.mjs"],
    });
    registry.heartbeat("session-a", {
      taskSummary: "burst-2",
      branch: "feature/burst-middle",
      dirtyFiles: [
        "hub/team/synapse-registry.mjs",
        "tests/integration/synapse-debounce.test.mjs",
      ],
    });
    registry.heartbeat("session-a", {
      taskSummary: "burst-final",
      branch: "feature/burst-final",
      dirtyFiles: ["tests/integration/synapse-debounce.test.mjs"],
    });

    const persisted = await waitFor(() => {
      const sessions = readPersistedSessions(persistPath);
      assert.equal(sessions["session-a"]?.taskSummary, "burst-final");
      return sessions["session-a"];
    });

    assert.equal(persisted.branch, "feature/burst-final");
    assert.deepEqual(persisted.dirtyFiles, [
      "tests/integration/synapse-debounce.test.mjs",
    ]);

    registry.destroy();
  });

  it("debounce 경계 직전/직후 heartbeat도 유실 없이 순서대로 flush한다", async () => {
    const registry = createSynapseRegistry({ persistPath });
    registry.register(baseMeta());

    registry.heartbeat("session-a", {
      taskSummary: "late-in-window",
      dirtyFiles: ["pre-boundary.mjs"],
    });

    await delay(170);

    registry.heartbeat("session-a", {
      taskSummary: "boundary-flush",
      dirtyFiles: ["pre-boundary.mjs", "boundary.mjs"],
    });

    await waitFor(() => {
      const sessions = readPersistedSessions(persistPath);
      assert.equal(sessions["session-a"]?.taskSummary, "boundary-flush");
    });

    registry.heartbeat("session-a", {
      taskSummary: "post-boundary",
      branch: "feature/post-boundary",
      dirtyFiles: ["post-boundary.mjs"],
    });

    const persisted = await waitFor(() => {
      const sessions = readPersistedSessions(persistPath);
      assert.equal(sessions["session-a"]?.taskSummary, "post-boundary");
      return sessions["session-a"];
    });

    assert.equal(persisted.branch, "feature/post-boundary");
    assert.deepEqual(persisted.dirtyFiles, ["post-boundary.mjs"]);

    registry.destroy();
  });
});
