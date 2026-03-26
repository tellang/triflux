import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  cleanupStaleOmcTeams,
  findNearestOmcStateDir,
  inspectStaleOmcTeams,
} from "../../hub/team/staleState.mjs";

const TEMP_DIRS = [];

function makeTempProject() {
  const baseDir = join(tmpdir(), `triflux-stale-state-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(baseDir, { recursive: true });
  TEMP_DIRS.push(baseDir);
  return baseDir;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

afterEach(() => {
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe("staleState.mjs", () => {
  it("상위 디렉터리로 올라가며 .omc/state를 찾는다", () => {
    const projectDir = makeTempProject();
    const nestedDir = join(projectDir, "packages", "app");
    mkdirSync(join(projectDir, ".omc", "state"), { recursive: true });
    mkdirSync(nestedDir, { recursive: true });

    assert.equal(findNearestOmcStateDir(nestedDir), join(projectDir, ".omc", "state"));
  });

  it("1시간 이상 경과했고 관련 프로세스가 없으면 stale team으로 판정한다", () => {
    const projectDir = makeTempProject();
    const stateRoot = join(projectDir, ".omc", "state");
    const teamsRoot = join(projectDir, ".claude", "teams");
    const sessionId = "stale-session";
    const stateFile = join(stateRoot, "sessions", sessionId, "team-state.json");
    writeJson(stateFile, {
      active: true,
      name: "team",
      session_id: sessionId,
      started_at: new Date(Date.now() - (2 * 60 * 60 * 1000)).toISOString(),
    });

    const report = inspectStaleOmcTeams({
      startDir: projectDir,
      teamsRoot,
      nowMs: Date.now(),
      processEntries: [],
    });

    assert.equal(report.entries.length, 1);
    assert.equal(report.entries[0].sessionId, sessionId);
    assert.equal(report.entries[0].stale, true);
    assert.equal(report.entries[0].active, false);
  });

  it("세션 토큰이 살아 있는 프로세스 커맨드라인에 있으면 stale로 보지 않는다", () => {
    const projectDir = makeTempProject();
    const stateRoot = join(projectDir, ".omc", "state");
    const teamsRoot = join(projectDir, ".claude", "teams");
    const sessionId = "active-session";
    const stateFile = join(stateRoot, "sessions", sessionId, "team-state.json");
    writeJson(stateFile, {
      active: true,
      session_id: sessionId,
      team_name: "tfx-multi-active",
      started_at: new Date(Date.now() - (2 * 60 * 60 * 1000)).toISOString(),
    });

    const report = inspectStaleOmcTeams({
      startDir: projectDir,
      teamsRoot,
      nowMs: Date.now(),
      processEntries: [
        {
          pid: 4242,
          command: `node worker.mjs --session ${sessionId}`,
        },
      ],
    });

    assert.equal(report.entries.length, 0);
  });

  it("~/.claude/teams 디렉터리도 stale 대상으로 탐지한다", () => {
    const projectDir = makeTempProject();
    const teamsRoot = join(projectDir, ".claude", "teams");
    const teamName = "tfx-multi-stale";
    const configPath = join(teamsRoot, teamName, "config.json");

    writeJson(configPath, {
      name: teamName,
      leadSessionId: "lead-session-stale",
      createdAt: Date.now() - (2 * 60 * 60 * 1000),
      members: [
        { name: "lead", agentId: "codex-lead", isActive: true },
      ],
    });

    const report = inspectStaleOmcTeams({
      stateRoot: null,
      teamsRoot,
      nowMs: Date.now(),
      processEntries: [],
    });

    assert.equal(report.entries.length, 1);
    assert.equal(report.entries[0].scope, "claude_team");
    assert.equal(report.entries[0].teamName, teamName);
    assert.equal(report.entries[0].stale, true);
  });

  it("stale team 정리는 세션 디렉터리와 root state 파일을 삭제한다", async () => {
    const projectDir = makeTempProject();
    const stateRoot = join(projectDir, ".omc", "state");
    const teamsRoot = join(projectDir, ".claude", "teams");
    const sessionId = "cleanup-session";
    const sessionStateFile = join(stateRoot, "sessions", sessionId, "team-state.json");
    const rootStateFile = join(stateRoot, "team-state.json");

    writeJson(sessionStateFile, {
      active: true,
      session_id: sessionId,
      started_at: new Date(Date.now() - (2 * 60 * 60 * 1000)).toISOString(),
    });
    writeJson(rootStateFile, {
      active: true,
      session_id: "root-session",
      started_at: new Date(Date.now() - (2 * 60 * 60 * 1000)).toISOString(),
    });

    const report = inspectStaleOmcTeams({
      startDir: projectDir,
      teamsRoot,
      nowMs: Date.now(),
      processEntries: [],
    });

    assert.equal(report.entries.length, 2);

    const result = await cleanupStaleOmcTeams(report.entries);
    assert.equal(result.cleaned, 2);
    assert.equal(result.failed, 0);
    assert.equal(existsSync(sessionStateFile), false);
    assert.equal(existsSync(rootStateFile), false);
    assert.equal(existsSync(join(stateRoot, "sessions", sessionId)), false);
    assert.equal(existsSync(stateRoot), true);
  });
});
