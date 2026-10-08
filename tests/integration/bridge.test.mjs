// tests/integration/bridge.test.mjs — bridge.mjs 인자/JSON 헬퍼 테스트

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseArgs, parseJsonSafe } from "../../hub/bridge.mjs";

describe("bridge.mjs parseArgs()", () => {
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

  it("포지셔널 인자를 숫자 키와 배열로 함께 보존해야 한다", () => {
    const args = parseArgs(["lead", "worker", '{"task":"ship"}']);
    assert.equal(args[1], "lead");
    assert.equal(args[2], "worker");
    assert.equal(args[3], '{"task":"ship"}');
    assert.deepEqual(args._, ["lead", "worker", '{"task":"ship"}']);
  });

  it("플래그 없을 때 undefined를 반환해야 한다", () => {
    const args = parseArgs([]);
    assert.equal(args.team, undefined);
    assert.equal(args.status, undefined);
  });

  it("위치 인자를 1-based 키로 함께 노출해야 한다", () => {
    const args = parseArgs(["approval", "승인 요청", "cli"]);
    assert.equal(args[1], "approval");
    assert.equal(args[2], "승인 요청");
    assert.equal(args[3], "cli");
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
