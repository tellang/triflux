import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { runStatus } from "../../cto/status.mjs";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "tfx-cto-status-"));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function writeJson(filePath, payload) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function captureStdout() {
  let output = "";
  return {
    stdout: {
      write(chunk) {
        output += String(chunk);
      },
    },
    read() {
      return output;
    },
  };
}

function fixtureCurrent(overrides = {}) {
  return {
    schema_version: "cto-lake.v1",
    generated_at: "2026-06-02T00:00:00.000Z",
    repo: {
      root: "/repo",
      branch: "main",
      head: "abc123",
      dirty: false,
    },
    sources: {
      git: {
        available: true,
        status: "ok",
        detail: {},
        collected_at: "2026-06-02T00:00:00.000Z",
      },
      tfx_synapse: {
        available: false,
        status: "no_shell_readable_artifact",
        detail: "missing",
        collected_at: "2026-06-02T00:00:00.000Z",
      },
    },
    summary: {
      available_sources: 1,
      total_sources: 2,
    },
    ledger_tail: [
      {
        ts: "2026-06-02T00:00:00.000Z",
        event: "collect",
        source: "tfx_cto_collect",
        summary: "collected fixture",
        ref: { current_json: "current.json" },
      },
    ],
    ...overrides,
  };
}

describe("runStatus", () => {
  it("prints stable status JSON keys with live synapse overlays", async () => {
    const rootDir = makeTempDir();
    const lakeRoot = join(rootDir, ".test-lake");
    const out = captureStdout();
    try {
      writeJson(join(lakeRoot, "current.json"), fixtureCurrent());

      const result = await runStatus(["--json"], {
        lakeRoot,
        stdout: out.stdout,
        synapseReader: async () => ({
          sessions: [
            {
              sessionId: "sess-1",
              host: "local",
              agent_id: "agent-1",
              status: "active",
              started_at: "2026-06-02T00:01:00.000Z",
            },
          ],
          active_shards: [
            {
              shard_name: "t4",
              phase: "running",
              members: ["agent-1"],
            },
          ],
        }),
      });

      const parsed = JSON.parse(out.read());
      const existingKeys = [
        "schema_version",
        "generated_at",
        "repo",
        "sources",
        "summary",
        "ledger_tail",
        "live_sessions",
        "active_shards",
        "hygiene",
      ];
      for (const key of existingKeys)
        assert.ok(key in parsed, `${key} missing`);
      assert.ok("live_session_groups" in parsed);
      assert.deepEqual(parsed, result);
      assert.equal(parsed.schema_version, "cto-lake.v1");
      assert.equal(parsed.repo.branch, "main");
      assert.equal(parsed.sources.git.available, true);
      assert.equal(parsed.ledger_tail.length, 1);
      assert.deepEqual(parsed.live_session_groups, []);
      assert.deepEqual(parsed.live_sessions, [
        {
          sessionId: "sess-1",
          host: "local",
          agent_id: "agent-1",
          phase: "active",
          started_at: "2026-06-02T00:01:00.000Z",
        },
      ]);
      assert.deepEqual(parsed.active_shards, [
        {
          shard_name: "t4",
          phase: "running",
          members: ["agent-1"],
        },
      ]);
      assert.deepEqual(parsed.hygiene, {
        active_tasks: 0,
        completed_tasks: 0,
        stale_sessions: 0,
        orphan_worktrees: 0,
        superseded_checkpoints: 0,
        unknown_owner: 0,
      });
    } finally {
      cleanup(rootDir);
    }
  });

  it("prints minimal graceful JSON when current.json is missing", async () => {
    const rootDir = makeTempDir();
    const lakeRoot = join(rootDir, ".test-lake");
    const out = captureStdout();
    try {
      await assert.doesNotReject(() =>
        runStatus(["--json"], {
          lakeRoot,
          stdout: out.stdout,
          synapseReader: async () => {
            throw new Error("must not be read without current.json");
          },
        }),
      );

      assert.deepEqual(JSON.parse(out.read()), {
        schema_version: "cto-lake.v1",
        available: false,
        hint: "run tfx cto collect",
      });
    } finally {
      cleanup(rootDir);
    }
  });

  it("falls back to ledger_tail when synapse is unavailable", async () => {
    const rootDir = makeTempDir();
    const lakeRoot = join(rootDir, ".test-lake");
    const out = captureStdout();
    const current = fixtureCurrent({
      ledger_tail: [
        {
          ts: "2026-06-02T00:02:00.000Z",
          event: "collect",
          source: "tfx_cto_collect",
          summary: "fallback activity",
          ref: {},
        },
      ],
    });
    try {
      writeJson(join(lakeRoot, "current.json"), current);

      await assert.doesNotReject(() =>
        runStatus(["--json"], {
          lakeRoot,
          stdout: out.stdout,
          synapseReader: async () => {
            throw new Error("synapse down");
          },
        }),
      );

      const parsed = JSON.parse(out.read());
      assert.deepEqual(parsed.live_sessions, []);
      assert.deepEqual(parsed.active_shards, []);
      assert.deepEqual(parsed.ledger_tail, current.ledger_tail);
    } finally {
      cleanup(rootDir);
    }
  });

  it("includes compact hygiene summary derived from current ledger and live overlay", async () => {
    const rootDir = makeTempDir();
    const lakeRoot = join(rootDir, ".test-lake");
    const out = captureStdout();
    try {
      writeJson(
        join(lakeRoot, "current.json"),
        fixtureCurrent({
          ledger_tail: [
            {
              ts: "2026-06-17T00:00:00.000Z",
              event: "task_claimed",
              source: "test",
              summary: "claim task-a",
              ref: { task_id: "task-a" },
            },
            {
              ts: "2026-06-17T00:01:00.000Z",
              event: "session_stale",
              source: "test",
              summary: "session stale",
              ref: { session_id: "session-old" },
            },
          ],
        }),
      );

      await runStatus(["--json"], {
        lakeRoot,
        stdout: out.stdout,
        synapseReader: async () => ({
          sessions: [{ sessionId: "session-live", status: "active" }],
        }),
      });

      const parsed = JSON.parse(out.read());
      assert.deepEqual(parsed.hygiene, {
        active_tasks: 1,
        completed_tasks: 0,
        stale_sessions: 1,
        orphan_worktrees: 0,
        superseded_checkpoints: 0,
        unknown_owner: 2,
      });
    } finally {
      cleanup(rootDir);
    }
  });
});
