import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { runDashboard } from "../../cto/dashboard.mjs";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "tfx-cto-dashboard-"));
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
      root: "/repo/dashboard-fixture",
      branch: "feat/dashboard",
      head: "abc123def4567890",
      dirty: true,
    },
    sources: {
      git: {
        available: true,
        status: "ok",
        detail: {},
        collected_at: "2026-06-02T00:00:00.000Z",
      },
      tfx_swarm: {
        available: true,
        status: "ok",
        detail: {
          shards: [
            {
              id: "S1",
              status: "running",
              task: "dashboard shard",
            },
          ],
        },
        collected_at: "2026-06-02T00:00:00.000Z",
      },
      ultragoal_omx: {
        available: true,
        status: "ok",
        detail: {
          active_goals: [
            {
              id: "G1",
              title: "Render CTO dashboard",
              status: "in_progress",
            },
          ],
        },
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
      repo_state: "branch feat/dashboard at abc123def4567890 is dirty",
      active_goals: [
        {
          id: "G1",
          title: "Render CTO dashboard",
          status: "in_progress",
        },
      ],
      swarm_shards: [
        {
          id: "S1",
          status: "running",
          task: "dashboard shard",
        },
      ],
      available_sources: 3,
      missing_sources: 1,
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

describe("runDashboard", () => {
  it("renders self-contained HTML from current.json key fields", async () => {
    const rootDir = makeTempDir();
    const lakeRoot = join(rootDir, ".test-lake");
    const out = captureStdout();
    try {
      writeJson(join(lakeRoot, "current.json"), fixtureCurrent());

      const result = await runDashboard([], {
        lakeRoot,
        stdout: out.stdout,
      });

      assert.equal(result.path, join(lakeRoot, "dashboard.html"));
      assert.equal(result.available, true);
      assert.equal(existsSync(result.path), true);

      const html = readFileSync(result.path, "utf8");
      assert.match(html, /<style>/u);
      assert.doesNotMatch(html, /https?:\/\//u);
      assert.match(html, /feat\/dashboard/u);
      assert.match(html, /abc123def456/u);
      assert.match(html, /dirty/u);
      assert.match(html, /Sources/u);
      assert.match(html, /3\/4/u);
      assert.match(html, /Render CTO dashboard/u);
      assert.match(html, /S1/u);
      assert.match(html, /collected fixture/u);
      assert.match(html, /2026-06-02T00:00:00.000Z/u);
      assert.match(out.read(), new RegExp(`${result.path}\\n`, "u"));
    } finally {
      cleanup(rootDir);
    }
  });

  it("renders a Hygiene section from current status summary when available", async () => {
    const rootDir = makeTempDir();
    const lakeRoot = join(rootDir, ".test-lake");
    try {
      writeJson(
        join(lakeRoot, "current.json"),
        fixtureCurrent({
          hygiene: {
            active_tasks: 2,
            completed_tasks: 1,
            stale_sessions: 1,
            orphan_worktrees: 1,
            superseded_checkpoints: 3,
            unknown_owner: 2,
            action_count: 2,
            actions: [
              {
                kind: "session",
                id: "stale-session",
                status: "stale",
                action: "review_or_archive_session",
              },
            ],
          },
        }),
      );

      const result = await runDashboard([], {
        lakeRoot,
        stdout: { write() {} },
      });

      const html = readFileSync(result.path, "utf8");
      assert.match(html, /<h2>Hygiene<\/h2>/u);
      assert.match(html, /Active tasks/u);
      assert.match(html, /Stale sessions/u);
      assert.match(html, /stale-session/u);
      assert.match(html, /review_or_archive_session/u);
      assert.doesNotMatch(html, /Apply/u);
    } finally {
      cleanup(rootDir);
    }
  });

  it("renders graceful minimal HTML when current.json is missing", async () => {
    const rootDir = makeTempDir();
    const lakeRoot = join(rootDir, ".test-lake");
    const out = captureStdout();
    try {
      let result = null;
      await assert.doesNotReject(async () => {
        result = await runDashboard([], {
          lakeRoot,
          stdout: out.stdout,
        });
      });

      assert.equal(result.available, false);
      assert.equal(result.path, join(lakeRoot, "dashboard.html"));
      const html = readFileSync(result.path, "utf8");
      assert.match(html, /no snapshot yet/u);
      assert.match(html, /run tfx cto collect/u);
      assert.match(out.read(), new RegExp(`${result.path}\\n`, "u"));
    } finally {
      cleanup(rootDir);
    }
  });

  it("single non-watch render writes and returns without hanging", async () => {
    const rootDir = makeTempDir();
    const lakeRoot = join(rootDir, ".test-lake");
    try {
      writeJson(join(lakeRoot, "current.json"), fixtureCurrent());

      const result = await runDashboard([], {
        lakeRoot,
        stdout: { write() {} },
      });

      assert.equal(result.renders, 1);
      assert.equal(existsSync(join(lakeRoot, "dashboard.html")), true);
    } finally {
      cleanup(rootDir);
    }
  });

  it("watch uses injectable interval and can be bounded for tests", async () => {
    const rootDir = makeTempDir();
    const lakeRoot = join(rootDir, ".test-lake");
    const out = captureStdout();
    try {
      writeJson(
        join(lakeRoot, "current.json"),
        fixtureCurrent({
          generated_at: "2026-06-02T00:01:00.000Z",
        }),
      );

      const result = await runDashboard(["--watch"], {
        lakeRoot,
        stdout: out.stdout,
        intervalMs: 5,
        maxRenders: 2,
        onRender(render) {
          if (render.renders === 1) {
            writeJson(
              join(lakeRoot, "current.json"),
              fixtureCurrent({
                generated_at: "2026-06-02T00:02:00.000Z",
                ledger_tail: [
                  {
                    ts: "2026-06-02T00:02:00.000Z",
                    event: "collect",
                    source: "tfx_cto_collect",
                    summary: "second render",
                    ref: { current_json: "current.json" },
                  },
                ],
              }),
            );
          }
        },
      });

      assert.equal(result.renders, 2);
      assert.equal(result.intervalMs, 5);
      assert.match(readFileSync(result.path, "utf8"), /second render/u);
      assert.equal(out.read().split("\n").filter(Boolean).length, 2);
    } finally {
      cleanup(rootDir);
    }
  });
});
