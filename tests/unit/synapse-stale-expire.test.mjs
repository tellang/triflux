// tests/unit/synapse-stale-expire.test.mjs — Synapse stale expiry policy tests

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { registerInteractiveSession } from "../../hooks/session-start-fast.mjs";
import { createSynapseRegistry } from "../../hub/team/synapse-registry.mjs";

const HOUR_MS = 60 * 60 * 1000;

function makeTmpDir() {
  const dir = join(
    tmpdir(),
    `tfx-synapse-stale-expire-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function persistRows(persistPath, rows) {
  writeFileSync(persistPath, JSON.stringify(rows, null, 2), "utf8");
}

function sessionRow(overrides = {}) {
  const sessionId = overrides.sessionId || "stale-row";
  return {
    sessionId,
    host: "local",
    worktreePath: "/repo/wt",
    branch: "main",
    dirtyFiles: [],
    taskSummary: "stale task",
    lastHeartbeat: Date.now() - 3 * HOUR_MS,
    status: "stale",
    isRemote: false,
    cwd: "/repo/wt",
    pid: null,
    sessionKind: "interactive",
    ...overrides,
  };
}

function payloadJson(obj) {
  return JSON.stringify(obj);
}

describe("synapse stale expiry policy", () => {
  let tmpDir;
  let persistPath;
  let previousCleanExpire;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    persistPath = join(tmpDir, "synapse-registry.json");
    previousCleanExpire = process.env.TFX_SYNAPSE_CLEAN_EXPIRE_MS;
  });

  afterEach(() => {
    if (previousCleanExpire === undefined) {
      delete process.env.TFX_SYNAPSE_CLEAN_EXPIRE_MS;
    } else {
      process.env.TFX_SYNAPSE_CLEAN_EXPIRE_MS = previousCleanExpire;
    }
  });

  it("keeps dirty stale sessions under the 24h dirty-file guard window", () => {
    persistRows(persistPath, {
      dirty: sessionRow({
        sessionId: "dirty",
        dirtyFiles: ["hub/server.mjs"],
      }),
    });
    process.env.TFX_SYNAPSE_CLEAN_EXPIRE_MS = String(HOUR_MS);

    const reg = createSynapseRegistry({
      persistPath,
      expireTimeoutMs: 24 * HOUR_MS,
    });

    const result = reg.pruneExpired();

    assert.deepEqual(result.removed, []);
    assert.equal(reg.getSession("dirty")?.status, "stale");
    assert.deepEqual(reg.getSession("dirty")?.dirtyFiles, ["hub/server.mjs"]);

    reg.destroy();
  });

  it("prunes clean stale sessions using the short clean expiry window", () => {
    persistRows(persistPath, {
      clean: sessionRow({
        sessionId: "clean",
        dirtyFiles: [],
      }),
    });
    process.env.TFX_SYNAPSE_CLEAN_EXPIRE_MS = String(HOUR_MS);

    const reg = createSynapseRegistry({
      persistPath,
      expireTimeoutMs: 24 * HOUR_MS,
    });

    const result = reg.pruneExpired();

    assert.deepEqual(result.removed, ["clean"]);
    assert.equal(result.count, 1);
    assert.equal(reg.getSession("clean"), null);

    reg.destroy();
  });
});

describe("SessionStart headless registration noise", () => {
  it("skips Synapse interactive registration for Claude print-mode ancestors", () => {
    for (const ancestorCommand of [
      "claude --print classify --output-format text",
      "claude -p classify --output-format text",
    ]) {
      const registered = [];
      let gitCalled = false;

      registerInteractiveSession(
        payloadJson({
          hook_event_name: "SessionStart",
          session_id: "print-session",
          cwd: "/repo/wt",
          source: "startup",
          model: "claude-sonnet-4-6",
        }),
        {
          register: (meta) => registered.push(meta),
          heartbeat: () => {},
          gitRunner: () => {
            gitCalled = true;
          },
          ancestorCommands: [
            "node hooks/hook-orchestrator.mjs",
            ancestorCommand,
          ],
        },
      );

      assert.deepEqual(registered, []);
      assert.equal(gitCalled, false);
    }
  });
});
