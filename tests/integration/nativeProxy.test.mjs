// tests/integration/nativeProxy.test.mjs — nativeProxy.mjs 통합 테스트
// 임시 파일시스템 픽스처를 사용해 외부 의존성 없이 팀 파일 CRUD를 검증

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  resolveTeamPaths,
  teamInfo,
  teamSendMessage,
  teamTaskList,
  teamTaskUpdate,
} from "../../hub/team/nativeProxy.mjs";

// ── 픽스처 헬퍼 ──
// nativeProxy.mjs는 homedir()/.claude/teams|tasks 경로를 하드코딩.
// 환경변수로 오버라이드할 수 없으므로 실제 ~/.claude 아래에 임시 팀 디렉토리를 생성하고
// 테스트 후 정리한다. 팀 이름을 유니크하게 만들어 충돌을 방지.

import { homedir } from "node:os";

const CLAUDE_HOME = join(homedir(), ".claude");
const TEAMS_ROOT = join(CLAUDE_HOME, "teams");
const TASKS_ROOT = join(CLAUDE_HOME, "tasks");

function uniqueTeamName() {
  // nativeProxy의 TEAM_NAME_RE = /^[a-z0-9][a-z0-9-]*$/
  return `tfx-test-${randomUUID().slice(0, 8)}`;
}

function createTeamFixture(teamName, config = {}) {
  const teamDir = join(TEAMS_ROOT, teamName);
  const inboxesDir = join(teamDir, "inboxes");
  const tasksDir = join(TASKS_ROOT, teamName);

  mkdirSync(teamDir, { recursive: true });
  mkdirSync(inboxesDir, { recursive: true });
  mkdirSync(tasksDir, { recursive: true });

  writeFileSync(
    join(teamDir, "config.json"),
    JSON.stringify({ description: "테스트 팀", ...config }, null, 2),
    "utf8",
  );

  return { teamDir, inboxesDir, tasksDir };
}

function writeTaskFile(tasksDir, taskId, data) {
  writeFileSync(
    join(tasksDir, `${taskId}.json`),
    JSON.stringify(data, null, 2),
    "utf8",
  );
}

function cleanupTeamFixture(teamName) {
  try {
    rmSync(join(TEAMS_ROOT, teamName), { recursive: true, force: true });
  } catch {}
  try {
    rmSync(join(TASKS_ROOT, teamName), { recursive: true, force: true });
  } catch {}
}

async function createExitedPid() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => process.exit(0), 0)"],
      {
        stdio: "ignore",
      },
    );
    child.once("error", reject);
    child.once("exit", () => resolve(child.pid));
  });
}

// ── resolveTeamPaths ──

describe("resolveTeamPaths()", () => {
  it("유효하지 않은 팀 이름은 에러를 던져야 한다", async () => {
    await assert.rejects(
      () => resolveTeamPaths("Invalid Team!"),
      /INVALID_TEAM_NAME/,
    );
    await assert.rejects(() => resolveTeamPaths(""), /INVALID_TEAM_NAME/);
    await assert.rejects(() => resolveTeamPaths("-bad"), /INVALID_TEAM_NAME/);
  });

  it("유효한 팀 이름은 경로 객체를 반환해야 한다", async () => {
    const teamName = uniqueTeamName();
    const result = await resolveTeamPaths(teamName);

    assert.ok(result.team_dir.endsWith(teamName));
    assert.ok(result.config_path.endsWith("config.json"));
    assert.ok(result.tasks_dir.includes(teamName));
    assert.ok(
      ["team_name", "lead_session_id", "not_found"].includes(
        result.tasks_dir_resolution,
      ),
    );
  });
});

// ── teamInfo ──

describe("teamInfo()", () => {
  let teamName;

  before(() => {
    teamName = uniqueTeamName();
    createTeamFixture(teamName, {
      description: "통합 테스트용 팀",
      leadAgentId: "test-lead",
    });
  });

  after(() => cleanupTeamFixture(teamName));

  it("존재하는 팀의 정보를 반환해야 한다", async () => {
    const result = await teamInfo({ team_name: teamName });
    assert.equal(result.ok, true);
    assert.equal(result.data.team.team_name, teamName);
    assert.equal(result.data.team.description, "통합 테스트용 팀");
    assert.equal(result.data.lead.lead_agent_id, "test-lead");
  });

  it("include_members: true 일 때 members 필드를 포함해야 한다", async () => {
    const result = await teamInfo({
      team_name: teamName,
      include_members: true,
    });
    assert.ok("members" in result.data);
  });

  it("include_paths: true 일 때 paths 필드를 포함해야 한다", async () => {
    const result = await teamInfo({ team_name: teamName, include_paths: true });
    assert.ok("paths" in result.data);
    assert.ok(result.data.paths.config_path);
  });

  it("include_members: false 일 때 members 필드가 없어야 한다", async () => {
    const result = await teamInfo({
      team_name: teamName,
      include_members: false,
    });
    assert.ok(!("members" in result.data));
  });

  it("존재하지 않는 팀은 TEAM_NOT_FOUND 에러를 반환해야 한다", async () => {
    const result = await teamInfo({ team_name: "does-not-exist-xyz" });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "TEAM_NOT_FOUND");
  });

  it("잘못된 팀 이름은 INVALID_TEAM_NAME 에러를 반환해야 한다", async () => {
    const result = await teamInfo({ team_name: "Invalid Name!" });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INVALID_TEAM_NAME");
  });
});

// ── teamTaskList ──

describe("teamTaskList()", () => {
  let teamName;
  let tasksDir;

  before(() => {
    teamName = uniqueTeamName();
    const fixture = createTeamFixture(teamName);
    tasksDir = fixture.tasksDir;

    // 태스크 픽스처 생성
    writeTaskFile(tasksDir, "task-001", {
      id: "task-001",
      status: "pending",
      subject: "첫 번째 작업",
      owner: "",
    });
    writeTaskFile(tasksDir, "task-002", {
      id: "task-002",
      status: "in_progress",
      subject: "두 번째 작업",
      owner: "alice",
    });
    writeTaskFile(tasksDir, "task-003", {
      id: "task-003",
      status: "completed",
      subject: "세 번째 작업",
      owner: "bob",
    });
  });

  after(() => cleanupTeamFixture(teamName));

  it("전체 태스크 목록을 반환해야 한다", async () => {
    const result = await teamTaskList({ team_name: teamName });
    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.data.tasks));
    assert.ok(result.data.count >= 3);
  });

  it("status 필터가 적용되어야 한다", async () => {
    const result = await teamTaskList({
      team_name: teamName,
      statuses: ["pending"],
    });
    assert.equal(result.ok, true);
    assert.ok(result.data.tasks.every((t) => t.status === "pending"));
  });

  it("owner 필터가 적용되어야 한다", async () => {
    const result = await teamTaskList({ team_name: teamName, owner: "alice" });
    assert.equal(result.ok, true);
    assert.ok(result.data.tasks.every((t) => t.owner === "alice"));
  });

  it("limit 이 적용되어야 한다", async () => {
    const result = await teamTaskList({ team_name: teamName, limit: 1 });
    assert.equal(result.ok, true);
    assert.ok(result.data.tasks.length <= 1);
  });

  it("tasks_dir 없을 때 TASKS_DIR_NOT_FOUND 에러를 반환해야 한다", async () => {
    const result = await teamTaskList({ team_name: "no-tasks-team-xyz" });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "TASKS_DIR_NOT_FOUND");
  });

  it("잘못된 팀 이름은 INVALID_TEAM_NAME 에러를 반환해야 한다", async () => {
    const result = await teamTaskList({ team_name: "Bad Name" });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INVALID_TEAM_NAME");
  });
});

// ── teamTaskUpdate ──

describe("teamTaskUpdate()", () => {
  let teamName;
  let tasksDir;

  before(() => {
    teamName = uniqueTeamName();
    const fixture = createTeamFixture(teamName);
    tasksDir = fixture.tasksDir;
  });

  after(() => cleanupTeamFixture(teamName));

  it("status 업데이트가 파일에 반영되어야 한다", async () => {
    writeTaskFile(tasksDir, "upd-task-1", {
      id: "upd-task-1",
      status: "pending",
      owner: "",
    });

    const result = await teamTaskUpdate({
      team_name: teamName,
      task_id: "upd-task-1",
      status: "completed",
    });

    assert.equal(result.ok, true);
    assert.equal(result.data.updated, true);
    assert.equal(result.data.task_after.status, "completed");
  });

  it("claim=true 이고 pending 상태인 태스크를 claim할 수 있어야 한다", async () => {
    writeTaskFile(tasksDir, "claim-task-1", {
      id: "claim-task-1",
      status: "pending",
      owner: "",
    });

    const result = await teamTaskUpdate({
      team_name: teamName,
      task_id: "claim-task-1",
      claim: true,
      owner: "worker-a",
    });

    assert.equal(result.ok, true);
    assert.equal(result.data.claimed, true);
    assert.equal(result.data.task_after.owner, "worker-a");
    assert.equal(result.data.task_after.status, "in_progress");
  });

  it("이미 in_progress인 태스크에 claim 시 CLAIM_CONFLICT를 반환해야 한다", async () => {
    writeTaskFile(tasksDir, "conflict-task", {
      id: "conflict-task",
      status: "in_progress",
      owner: "other",
    });

    const result = await teamTaskUpdate({
      team_name: teamName,
      task_id: "conflict-task",
      claim: true,
      owner: "worker-b",
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "CLAIM_CONFLICT");
  });

  it('"failed" status는 자동으로 "completed" + metadata.result: "failed"로 변환되어야 한다', async () => {
    writeTaskFile(tasksDir, "fail-task", {
      id: "fail-task",
      status: "in_progress",
      owner: "worker",
    });

    const result = await teamTaskUpdate({
      team_name: teamName,
      task_id: "fail-task",
      status: "failed",
    });

    assert.equal(result.ok, true);
    assert.equal(result.data.task_after.status, "completed");
    assert.equal(result.data.task_after.metadata?.result, "failed");
  });

  it("존재하지 않는 task_id는 TASK_NOT_FOUND를 반환해야 한다", async () => {
    const result = await teamTaskUpdate({
      team_name: teamName,
      task_id: "ghost-task-xyz",
      status: "completed",
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "TASK_NOT_FOUND");
  });

  it("task_id 누락 시 INVALID_TASK_ID를 반환해야 한다", async () => {
    const result = await teamTaskUpdate({ team_name: teamName });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INVALID_TASK_ID");
  });

  it("유효하지 않은 status는 INVALID_STATUS를 반환해야 한다", async () => {
    writeTaskFile(tasksDir, "bad-status-task", {
      id: "bad-status-task",
      status: "pending",
    });

    const result = await teamTaskUpdate({
      team_name: teamName,
      task_id: "bad-status-task",
      status: "unknown_status",
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INVALID_STATUS");
  });

  it("metadata_patch가 기존 metadata에 병합되어야 한다", async () => {
    writeTaskFile(tasksDir, "meta-task", {
      id: "meta-task",
      status: "pending",
      metadata: { existing: "value" },
    });

    const result = await teamTaskUpdate({
      team_name: teamName,
      task_id: "meta-task",
      metadata_patch: { new_key: "new_value" },
    });

    assert.equal(result.ok, true);
    assert.equal(result.data.task_after.metadata.existing, "value");
    assert.equal(result.data.task_after.metadata.new_key, "new_value");
  });

  it("if_match_mtime_ms 불일치 시 MTIME_CONFLICT를 반환해야 한다", async () => {
    writeTaskFile(tasksDir, "mtime-task", {
      id: "mtime-task",
      status: "pending",
    });

    const result = await teamTaskUpdate({
      team_name: teamName,
      task_id: "mtime-task",
      status: "completed",
      if_match_mtime_ms: 1, // 과거 mtime — 불일치
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "MTIME_CONFLICT");
  });

  it("30초를 초과한 stale lock 파일은 자동 해제 후 업데이트해야 한다", async () => {
    const taskId = "stale-age-task";
    const taskFile = join(tasksDir, `${taskId}.json`);
    const lockFile = `${taskFile}.lock`;
    writeTaskFile(tasksDir, taskId, {
      id: taskId,
      status: "pending",
      owner: "",
    });
    writeFileSync(
      lockFile,
      JSON.stringify({
        pid: process.pid,
        token: "stale-age-lock",
        created_at: new Date(Date.now() - 60000).toISOString(),
        created_at_ms: Date.now() - 60000,
      }),
      "utf8",
    );

    const result = await teamTaskUpdate({
      team_name: teamName,
      task_id: taskId,
      status: "completed",
    });

    assert.equal(result.ok, true);
    assert.equal(result.data.task_after.status, "completed");
    assert.equal(existsSync(lockFile), false);
  });

  it("PID가 더 이상 존재하지 않는 lock 파일은 자동 해제 후 업데이트해야 한다", async () => {
    const taskId = "stale-pid-task";
    const taskFile = join(tasksDir, `${taskId}.json`);
    const lockFile = `${taskFile}.lock`;
    const deadPid = await createExitedPid();
    writeTaskFile(tasksDir, taskId, {
      id: taskId,
      status: "pending",
      owner: "",
    });
    writeFileSync(
      lockFile,
      JSON.stringify({
        pid: deadPid,
        token: "dead-pid-lock",
        created_at: new Date().toISOString(),
        created_at_ms: Date.now(),
      }),
      "utf8",
    );

    const result = await teamTaskUpdate({
      team_name: teamName,
      task_id: taskId,
      status: "completed",
    });

    assert.equal(result.ok, true);
    assert.equal(result.data.task_after.status, "completed");
    assert.equal(existsSync(lockFile), false);
  });
});

// ── teamSendMessage ──

describe("teamSendMessage()", () => {
  let teamName;

  before(() => {
    teamName = uniqueTeamName();
    createTeamFixture(teamName);
  });

  after(() => cleanupTeamFixture(teamName));

  it("유효한 메시지를 inbox에 추가해야 한다", async () => {
    const result = await teamSendMessage({
      team_name: teamName,
      from: "worker-1",
      text: "작업이 완료되었습니다",
    });

    assert.equal(result.ok, true);
    assert.ok(result.data.message_id);
    assert.ok(result.data.inbox_file.includes("team-lead"));
    assert.ok(result.data.queued_at);
    assert.ok(result.data.unread_count >= 1);
  });

  it("to 지정 시 해당 수신자의 inbox 파일에 저장해야 한다", async () => {
    const result = await teamSendMessage({
      team_name: teamName,
      from: "lead",
      to: "worker-1",
      text: "작업을 시작하세요",
    });

    assert.equal(result.ok, true);
    assert.ok(result.data.inbox_file.includes("worker-1"));
  });

  it("같은 inbox에 메시지를 추가하면 unread_count가 증가해야 한다", async () => {
    const r1 = await teamSendMessage({
      team_name: teamName,
      from: "a",
      text: "첫 번째 메시지",
    });
    const r2 = await teamSendMessage({
      team_name: teamName,
      from: "a",
      text: "두 번째 메시지",
    });

    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.ok(r2.data.unread_count > r1.data.unread_count);
  });

  it("from 누락 시 INVALID_FROM 에러를 반환해야 한다", async () => {
    const result = await teamSendMessage({
      team_name: teamName,
      text: "발신자 없는 메시지",
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INVALID_FROM");
  });

  it("text 누락 시 INVALID_TEXT 에러를 반환해야 한다", async () => {
    const result = await teamSendMessage({
      team_name: teamName,
      from: "worker",
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INVALID_TEXT");
  });

  it("존재하지 않는 팀은 TEAM_NOT_FOUND 에러를 반환해야 한다", async () => {
    const result = await teamSendMessage({
      team_name: "ghost-team-xyz",
      from: "x",
      text: "hello",
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "TEAM_NOT_FOUND");
  });

  it("잘못된 팀 이름은 INVALID_TEAM_NAME 에러를 반환해야 한다", async () => {
    const result = await teamSendMessage({
      team_name: "Bad Name!",
      from: "x",
      text: "hello",
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INVALID_TEAM_NAME");
  });
});
