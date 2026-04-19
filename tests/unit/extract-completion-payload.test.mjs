// tests/unit/extract-completion-payload.test.mjs
// worker stdout tail → JSON payload 추출 검증

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { extractCompletionPayload } from "../../hub/team/extract-completion-payload.mjs";

test("빈 입력 → null", () => {
  assert.equal(extractCompletionPayload(""), null);
  assert.equal(extractCompletionPayload(null), null);
  assert.equal(extractCompletionPayload(undefined), null);
});

test("JSON 객체 없음 → null", () => {
  assert.equal(extractCompletionPayload("just some plain text\nmore"), null);
});

test("단일 JSON 한 줄 → 파싱", () => {
  const tail = '{"shard":"s1","status":"ok","commits_made":[{"sha":"abc"}]}';
  const result = extractCompletionPayload(tail);
  assert.ok(result);
  assert.equal(result.payload.shard, "s1");
  assert.deepEqual(result.payload.commits_made, [{ sha: "abc" }]);
});

test("JSON 뒤에 trailing garbage — 여전히 파싱", () => {
  const tail =
    '[log] done\n{"status":"ok","commits_made":[{"sha":"deadbeef"}]}\n$ ';
  const result = extractCompletionPayload(tail);
  assert.ok(result);
  assert.equal(result.payload.status, "ok");
});

test("여러 JSON 객체 — 가장 뒤의 객체 반환", () => {
  const tail =
    '{"old":"payload"}\nlog line\n{"status":"final","commits_made":[]}';
  const result = extractCompletionPayload(tail);
  assert.ok(result);
  assert.equal(result.payload.status, "final");
});

test("pretty-printed multi-line JSON → 파싱", () => {
  const tail = [
    "some log output",
    "{",
    '  "status": "ok",',
    '  "commits_made": [',
    '    {"sha": "abc123", "message": "fix"}',
    "  ]",
    "}",
  ].join("\n");
  const result = extractCompletionPayload(tail);
  assert.ok(result);
  assert.equal(result.payload.status, "ok");
  assert.equal(result.payload.commits_made.length, 1);
});

test("유효하지 않은 JSON (dangling `{`) → null", () => {
  const tail = "prefix { not valid json }";
  const result = extractCompletionPayload(tail);
  assert.equal(result, null);
});

test("JSON 배열만 있음 (object 아님) → null", () => {
  // 배열은 object 가 아니므로 reject. 단, 배열 내부 object 가 있으면 그걸 반환.
  const tail = "[1,2,3]";
  assert.equal(extractCompletionPayload(tail), null);
});

test("string 내부의 `{}` 로 인한 오인식 없음", () => {
  const tail =
    '{"note":"this has { and } inside","status":"ok","commits_made":[]}';
  const result = extractCompletionPayload(tail);
  assert.ok(result);
  assert.equal(result.payload.note, "this has { and } inside");
  assert.equal(result.payload.status, "ok");
});

// Codex review finding 1: trailing garbage with `}` must not cause false null.
test("payload 뒤에 `} more` 처럼 dangling `}` 포함된 garbage 가 있어도 파싱", () => {
  const tail =
    'log line\n{"status":"ok","commits_made":[{"sha":"a"}]}\nnoise } more text';
  const result = extractCompletionPayload(tail);
  assert.ok(result);
  assert.equal(result.payload.status, "ok");
});

// Codex review finding 1 (variant): multiple trailing `}` characters.
test("payload 뒤에 dangling `}` 여러 개 있어도 파싱", () => {
  const tail = '{"status":"ok","commits_made":[]}\n} } }';
  const result = extractCompletionPayload(tail);
  assert.ok(result);
  assert.equal(result.payload.status, "ok");
});

// Codex review finding 1 (variant): payload immediately followed by broken brace.
test("payload + `{ broken` 처럼 trailing dangling `{` 도 파싱", () => {
  const tail = '{"status":"ok","commits_made":[]}\n{ broken';
  const result = extractCompletionPayload(tail);
  assert.ok(result);
  assert.equal(result.payload.status, "ok");
});
