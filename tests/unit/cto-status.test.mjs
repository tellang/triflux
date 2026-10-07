// tests/unit/cto-status.test.mjs — cto status overlay projection
//
// live_sessions는 synapse overlay의 유효한 행에서 온다.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { deriveRepoRootFromCwd, runStatus } from "../../cto/status.mjs";

function collectingStdout() {
  let buf = "";
  return {
    write(chunk) {
      buf += chunk;
    },
    text() {
      return buf;
    },
  };
}

function writeCurrent(lakeRoot, current) {
  mkdirSync(lakeRoot, { recursive: true });
  writeFileSync(
    join(lakeRoot, "current.json"),
    JSON.stringify(current),
    "utf8",
  );
}

describe("cto status live_sessions projection", () => {
  let sandboxDir;
  let lakeRoot;

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), "triflux-cto-status-"));
    lakeRoot = join(sandboxDir, ".triflux", "lake");
  });

  afterEach(() => {
    rmSync(sandboxDir, { recursive: true, force: true });
  });

  it("projects live_sessions while keeping retired active_shards empty", async () => {
    writeCurrent(lakeRoot, {
      schema_version: "cto-lake.v1",
      sources: {},
    });

    const status = await runStatus(["--json"], {
      rootDir: sandboxDir,
      lakeRoot,
      stdout: collectingStdout(),
      synapseReader: async () => ({
        sessions: [{ sessionId: "live-1", phase: "active" }],
        active_shards: [{ shard_name: "retired-shard" }],
      }),
    });

    assert.equal(status.live_sessions.length, 1);
    assert.equal(status.live_sessions[0].sessionId, "live-1");
    assert.deepEqual(status.active_shards, []);
  });

  it("derives repo roots from known nested worktree cwd shapes without filesystem probes", () => {
    assert.equal(
      deriveRepoRootFromCwd("/repo/app/.claude/worktrees/feature"),
      "/repo/app",
    );
    assert.equal(
      deriveRepoRootFromCwd("/repo/app/.claude/worktrees/feature/child"),
      "/repo/app",
    );
    assert.equal(
      deriveRepoRootFromCwd("/repo/app/.claude/worktrees/feature/"),
      "/repo/app",
    );
    assert.equal(
      deriveRepoRootFromCwd(
        "/repo/app/.claude/worktrees/a/.claude/worktrees/b",
      ),
      "/repo/app",
    );
    assert.equal(
      deriveRepoRootFromCwd("/repo/app/.codex-swarm/wt-auth"),
      "/repo/app",
    );
    assert.equal(
      deriveRepoRootFromCwd("/repo/app/.codex-swarm/wt-auth/src"),
      "/repo/app",
    );
    assert.equal(
      deriveRepoRootFromCwd("/repo/app/.worktrees/feature"),
      "/repo/app",
    );
    assert.equal(
      deriveRepoRootFromCwd("/repo/app/.worktrees/feature/src"),
      "/repo/app",
    );
    assert.equal(deriveRepoRootFromCwd("/repo/sibling"), "/repo/sibling");
    assert.equal(
      deriveRepoRootFromCwd("C:\\Users\\dev\\repo\\.claude\\worktrees\\x"),
      "C:\\Users\\dev\\repo\\.claude\\worktrees\\x",
    );
  });

  it("groups nested synapse session cwd values by derived repo root without exposing raw cwd", async () => {
    writeCurrent(lakeRoot, {
      schema_version: "cto-lake.v1",
      sources: {},
    });

    const parentCwd = join(sandboxDir, "parent-repo");
    const claudeWorktreeCwd = join(
      parentCwd,
      ".claude",
      "worktrees",
      "feature-a",
    );
    const codexWorktreeCwd = join(
      parentCwd,
      ".codex-swarm",
      "wt-feature-b",
      "src",
    );
    const gitWorktreeCwd = join(parentCwd, ".worktrees", "feature-c", "src");
    const siblingCwd = join(sandboxDir, "sibling-repo");

    const status = await runStatus(["--json"], {
      rootDir: sandboxDir,
      lakeRoot,
      stdout: collectingStdout(),
      synapseReader: async () => ({
        sessions: [
          { sessionId: "parent", cwd: parentCwd },
          { sessionId: "claude-wt", cwd: claudeWorktreeCwd },
          { sessionId: "codex-wt", cwd: codexWorktreeCwd },
          { sessionId: "git-wt", cwd: gitWorktreeCwd },
          { sessionId: "sibling", cwd: siblingCwd },
        ],
        active_shards: [],
      }),
    });

    const byId = Object.fromEntries(
      status.live_sessions.map((session) => [session.sessionId, session]),
    );
    assert.equal(byId.parent.cwdLabel, "parent-repo");
    assert.equal(byId["claude-wt"].cwdLabel, "feature-a");
    assert.equal(byId["codex-wt"].cwdLabel, "src");
    assert.equal(byId["git-wt"].cwdLabel, "src");
    assert.equal(byId.parent.repoRootLabel, "parent-repo");
    assert.equal(byId["claude-wt"].repoRootHash, byId.parent.repoRootHash);
    assert.equal(byId["codex-wt"].repoRootHash, byId.parent.repoRootHash);
    assert.equal(byId["git-wt"].repoRootHash, byId.parent.repoRootHash);
    assert.notEqual(byId.sibling.repoRootHash, byId.parent.repoRootHash);

    assert.equal(status.live_session_groups.length, 2);
    const groupsByLabel = Object.fromEntries(
      status.live_session_groups.map((group) => [group.repoRootLabel, group]),
    );
    assert.deepEqual(groupsByLabel["parent-repo"].sessions, [
      "parent",
      "claude-wt",
      "codex-wt",
      "git-wt",
    ]);
    assert.deepEqual(groupsByLabel["sibling-repo"].sessions, ["sibling"]);

    const serialized = JSON.stringify(status);
    assert.equal(serialized.includes(parentCwd), false);
    assert.equal(serialized.includes(claudeWorktreeCwd), false);
    assert.equal(serialized.includes(codexWorktreeCwd), false);
    assert.equal(serialized.includes(gitWorktreeCwd), false);
    assert.equal(serialized.includes(siblingCwd), false);
  });
});
