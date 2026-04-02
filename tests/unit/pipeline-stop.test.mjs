import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import Database from "better-sqlite3";

import {
  ensurePipelineStateDbPath,
  ensurePipelineTable,
  initPipelineState,
  updatePipelineState,
} from "../../hub/pipeline/state.mjs";

const HOOK_PATH = fileURLToPath(new URL("../../hooks/pipeline-stop.mjs", import.meta.url));

function createValidPluginRoot(baseDir, name = "plugin-root") {
  const root = join(baseDir, name);
  mkdirSync(join(root, "hooks"), { recursive: true });
  writeFileSync(join(root, "hooks", "hook-orchestrator.mjs"), "// sentinel\n", "utf8");
  return root;
}

function writePipelineState(baseDir, teamName, phase = "exec") {
  const dbPath = ensurePipelineStateDbPath(baseDir);
  const db = new Database(dbPath);
  ensurePipelineTable(db);
  initPipelineState(db, teamName);
  updatePipelineState(db, teamName, { phase });
  db.close();
  return dbPath;
}

function runHook({ cwd, homeDir, pluginRoot }) {
  return spawnSync(process.execPath, [HOOK_PATH], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
    },
  });
}

describe("pipeline-stop hook", () => {
  let sandboxDir;
  let homeDir;
  let pluginRoot;
  let projectRoot;

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), "triflux-pipeline-stop-"));
    homeDir = join(sandboxDir, "home");
    pluginRoot = createValidPluginRoot(sandboxDir);
    projectRoot = join(sandboxDir, "project-root");

    mkdirSync(homeDir, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(sandboxDir, { recursive: true, force: true });
  });

  it("현재 프로젝트에 DB가 없으면 플러그인 루트의 stale pipeline을 무시한다", () => {
    writePipelineState(pluginRoot, "plugin-stale-team", "exec");

    const result = runHook({ cwd: projectRoot, homeDir, pluginRoot });

    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "");
    assert.equal(result.stderr.trim(), "");
  });

  it("현재 프로젝트의 active pipeline만 보고 stop decision을 반환한다", () => {
    writePipelineState(projectRoot, "project-active-team", "exec");

    const result = runHook({ cwd: projectRoot, homeDir, pluginRoot });

    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.decision, "block");
    assert.match(output.reason, /project-active-team/);
  });
});
