import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";

import { createSynapseRegistry } from "../../hub/team/synapse-registry.mjs";

function makeTmpDir() {
  const dir = join(
    tmpdir(),
    `tfx-synapse-persist-recovery-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

describe("synapse persist recovery", () => {
  let tmpDir;
  let persistPath;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    persistPath = join(tmpDir, "synapse-registry.json");
  });

  it("persist 대기 중인 heartbeat를 destroy 시 flush하고 재시작 후 복구한다", () => {
    const registry1 = createSynapseRegistry({ persistPath });
    registry1.register(baseMeta());
    registry1.heartbeat("session-a", {
      branch: "feature/restart-queued-state",
      dirtyFiles: ["queued-before-restart.mjs"],
      taskSummary: "queued-before-restart",
    });

    registry1.destroy();

    const registry2 = createSynapseRegistry({ persistPath });
    const restored = registry2.getSession("session-a");

    assert.ok(restored);
    assert.equal(restored.branch, "feature/restart-queued-state");
    assert.equal(restored.taskSummary, "queued-before-restart");
    assert.deepEqual(restored.dirtyFiles, ["queued-before-restart.mjs"]);

    registry2.destroy();
  });

  it("부분 persist 실패로 손상된 파일에서도 clean start 후 다시 persist할 수 있다", () => {
    const registry1 = createSynapseRegistry({ persistPath });
    registry1.register(
      baseMeta({
        sessionId: "session-stable",
        taskSummary: "stable-before-partial",
      }),
    );
    registry1.destroy();

    writeFileSync(
      persistPath,
      '{\n  "session-stable": { "sessionId": "session-stable",',
      "utf8",
    );

    const registry2 = createSynapseRegistry({ persistPath });
    assert.deepEqual(registry2.getAll(), []);

    registry2.register(
      baseMeta({
        sessionId: "session-recovered",
        branch: "feature/recovered-after-partial",
        dirtyFiles: ["recovered-after-partial.mjs"],
        taskSummary: "recovered-after-partial",
      }),
    );
    registry2.destroy();

    const registry3 = createSynapseRegistry({ persistPath });
    assert.equal(registry3.getSession("session-stable"), null);
    assert.deepEqual(registry3.getSession("session-recovered")?.dirtyFiles, [
      "recovered-after-partial.mjs",
    ]);
    assert.equal(
      registry3.getSession("session-recovered")?.taskSummary,
      "recovered-after-partial",
    );

    registry3.destroy();
  });
});
