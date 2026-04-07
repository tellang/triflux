// tests/integration/bridge.test.mjs — bridge.mjs 인자/JSON 헬퍼 테스트

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseArgs, parseJsonSafe } from "../../hub/bridge.mjs";

describe("bridge.mjs parseArgs()", () => {
  it("--agent 플래그를 올바르게 파싱해야 한다", () => {
    const args = parseArgs(["--agent", "my-agent-01"]);
    assert.equal(args.agent, "my-agent-01");
  });

  it("--cli 플래그를 올바르게 파싱해야 한다", () => {
    const args = parseArgs(["--cli", "codex"]);
    assert.equal(args.cli, "codex");
  });

  it("--topics 콤마 구분 값을 파싱해야 한다", () => {
    const args = parseArgs(["--topics", "task.result,task.done"]);
    assert.deepEqual(args.topics.split(","), ["task.result", "task.done"]);
  });

  it("--claim boolean 플래그를 파싱해야 한다", () => {
    const args = parseArgs(["--claim"]);
    assert.equal(args.claim, true);
  });

  it("team-task-update 복합 인자를 파싱해야 한다", () => {
    const args = parseArgs([
      "--team",
      "my-team",
      "--task-id",
      "task-001",
      "--claim",
      "--status",
      "in_progress",
      "--owner",
      "codex-worker",
      "--metadata-patch",
      '{"result":"running"}',
    ]);
    assert.equal(args.team, "my-team");
    assert.equal(args["task-id"], "task-001");
    assert.equal(args.claim, true);
    assert.equal(args.status, "in_progress");
    assert.equal(args.owner, "codex-worker");
    assert.equal(args["metadata-patch"], '{"result":"running"}');
  });

  it("control/assign/pipeline 옵션을 파싱해야 한다", () => {
    const args = parseArgs([
      "--to",
      "worker-1",
      "--command",
      "pause",
      "--session-id",
      "sess-01",
      "--reason",
      "check",
      "--supervisor-agent",
      "lead-1",
      "--worker-agent",
      "worker-1",
      "--job-id",
      "job-001",
      "--task",
      "assign this",
      "--payload",
      '{"k":"v"}',
      "--result",
      '{"ok":true}',
      "--error",
      '{"message":"boom"}',
      "--metadata",
      '{"result":"failed"}',
      "--requested-by",
      "tester",
      "--ttl-ms",
      "9000",
      "--timeout-ms",
      "12000",
      "--max-retries",
      "2",
      "--attempt",
      "3",
      "--fix-max",
      "4",
      "--ralph-max",
      "5",
    ]);

    assert.equal(args.to, "worker-1");
    assert.equal(args.command, "pause");
    assert.equal(args["session-id"], "sess-01");
    assert.equal(args.reason, "check");
    assert.equal(args["supervisor-agent"], "lead-1");
    assert.equal(args["worker-agent"], "worker-1");
    assert.equal(args["job-id"], "job-001");
    assert.equal(args.task, "assign this");
    assert.equal(args.payload, '{"k":"v"}');
    assert.equal(args.result, '{"ok":true}');
    assert.equal(args.error, '{"message":"boom"}');
    assert.equal(args.metadata, '{"result":"failed"}');
    assert.equal(args["requested-by"], "tester");
    assert.equal(args["ttl-ms"], "9000");
    assert.equal(args["timeout-ms"], "12000");
    assert.equal(args["max-retries"], "2");
    assert.equal(args.attempt, "3");
    assert.equal(args["fix-max"], "4");
    assert.equal(args["ralph-max"], "5");
  });

  it("포지셔널 인자를 숫자 키와 배열로 함께 보존해야 한다", () => {
    const args = parseArgs(["lead", "worker", '{"task":"ship"}']);
    assert.equal(args[1], "lead");
    assert.equal(args[2], "worker");
    assert.equal(args[3], '{"task":"ship"}');
    assert.deepEqual(args._, ["lead", "worker", '{"task":"ship"}']);
  });

  it("플래그 없을 때 undefined를 반환해야 한다", () => {
    const args = parseArgs([]);
    assert.equal(args.agent, undefined);
    assert.equal(args.command, undefined);
    assert.equal(args["job-id"], undefined);
  });
});

describe("bridge.mjs parseJsonSafe()", () => {
  it("유효한 JSON 문자열을 객체로 반환해야 한다", () => {
    assert.deepEqual(parseJsonSafe('{"key":"value"}'), { key: "value" });
  });

  it("유효하지 않은 JSON은 fallback을 반환해야 한다", () => {
    assert.equal(parseJsonSafe("not-json", null), null);
  });

  it("null/undefined 입력 시 fallback을 반환해야 한다", () => {
    assert.equal(parseJsonSafe(null, "default"), "default");
    assert.equal(parseJsonSafe(undefined, 42), 42);
  });

  it("빈 문자열 입력 시 fallback을 반환해야 한다", () => {
    assert.deepEqual(parseJsonSafe("", { empty: true }), { empty: true });
  });

  it("배열 JSON을 올바르게 파싱해야 한다", () => {
    assert.deepEqual(parseJsonSafe("[1,2,3]", []), [1, 2, 3]);
  });
});
