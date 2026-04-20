// tests/unit/extract-completion-payload.test.mjs
// worker stdout tail → JSON payload 추출 검증

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { extractCompletionPayload } from "../../hub/team/extract-completion-payload.mjs";
import {
  SENTINEL_BEGIN,
  SENTINEL_END,
} from "../../hub/team/sentinel-capture.mjs";

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

// Codex review finding 3 (truncation): simulate conductor's slice(-16384) on an
// oversized payload. Head-truncation loses the outer `{`, and the extractor
// deterministically returns the last intact inner commit object — which F7 /
// validateWorkerCompletion then rejects as missing `commits_made`. Sentinel
// framing is the proper fix and is tracked as a follow-up issue.
test("앞부분이 잘린 payload — 마지막 intact inner commit object 를 반환 (F7 reject)", () => {
  const shas = Array.from({ length: 500 }, (_, i) =>
    String(i).padStart(40, "0"),
  );
  const inner = shas
    .map((sha) => `{"sha":"${sha}","message":"m${sha.length}"}`)
    .join(",");
  const full = `{"status":"ok","commits_made":[${inner}]}`;
  assert.ok(full.length > 16384, "test fixture must exceed buffer size");
  const truncated = full.slice(-16384);
  const result = extractCompletionPayload(truncated);
  assert.ok(result, "head-truncated tail 에서 inner object 가 deterministic 하게 추출되어야 함");
  // 외부 status/commits_made 는 손실되어 없어야 함.
  assert.equal(result.payload.status, undefined);
  assert.equal(result.payload.commits_made, undefined);
  // 마지막 intact inner commit — 정확히 이 두 필드만 존재.
  assert.equal(typeof result.payload.sha, "string");
  assert.equal(typeof result.payload.message, "string");
  assert.equal(result.payload.sha.length, 40);
});

// Codex review finding 3 (variant): tail-truncated tail (no closing `}`).
test("끝부분이 잘린 payload — 마지막 `}` 없음 → null", () => {
  const truncated = '{"status":"ok","commits_made":[{"sha":"abc"';
  assert.equal(extractCompletionPayload(truncated), null);
});

// ── #125 sentinel-framed extraction ──────────────────────────────

test("sentinel-framed payload → 파싱", () => {
  const payload =
    '{"shard":"s1","status":"ok","commits_made":[{"sha":"deadbeef"}]}';
  const tail = `[log] starting\n${SENTINEL_BEGIN}\n${payload}\n${SENTINEL_END}\n[log] exiting`;
  const result = extractCompletionPayload(tail);
  assert.ok(result);
  assert.equal(result.payload.shard, "s1");
  assert.equal(result.payload.status, "ok");
});

test("sentinel BEGIN 만 있고 END 없음 → null (deterministic truncation reject)", () => {
  // 핵심: BEGIN 이 보이면 fallback brace-scan 으로 떨어지지 않고 명확히 null.
  // 그렇지 않으면 inner partial JSON 으로 silent incorrect extraction 위험.
  const tail = `${SENTINEL_BEGIN}\n{"status":"ok","commits_made":[{"sha":"a"}`;
  assert.equal(extractCompletionPayload(tail), null);
});

test("sentinel-framed + invalid JSON → null (fallback 진입 금지)", () => {
  // worker 가 명시적으로 sentinel protocol 을 시도했으나 본문이 깨진 경우.
  // 외부 brace 스캔으로 다른 무관한 JSON 을 잡지 않도록 즉시 null.
  const tail =
    '{"old":"unrelated"}\n' +
    `${SENTINEL_BEGIN}\n{ broken json,,,\n${SENTINEL_END}\n`;
  assert.equal(extractCompletionPayload(tail), null);
});

test("여러 sentinel 쌍 — 마지막 BEGIN 사용", () => {
  const oldPayload = '{"status":"old","commits_made":[]}';
  const newPayload = '{"status":"new","commits_made":[{"sha":"latest"}]}';
  const tail = [
    SENTINEL_BEGIN,
    oldPayload,
    SENTINEL_END,
    "log line in between",
    SENTINEL_BEGIN,
    newPayload,
    SENTINEL_END,
  ].join("\n");
  const result = extractCompletionPayload(tail);
  assert.ok(result);
  assert.equal(result.payload.status, "new");
});

test("sentinel-framed payload 뒤 trailing log 무시", () => {
  const payload = '{"status":"ok","commits_made":[]}';
  const tail = `${SENTINEL_BEGIN}\n${payload}\n${SENTINEL_END}\nshell prompt $ ls -la\n{"unrelated":"json"}`;
  const result = extractCompletionPayload(tail);
  assert.ok(result);
  assert.equal(result.payload.status, "ok");
  assert.deepEqual(result.payload.commits_made, []);
});

test("sentinel-framed payload — 16 KiB 보다 큰 payload 도 그대로 파싱", () => {
  // 가장 중요한 회귀 방지: 기존 16 KiB tail 만으로는 head-truncation 발생하지만
  // sentinel snapshot 은 무제한 (1 MiB cap) 이므로 온전히 들어와야 함.
  const shas = Array.from({ length: 600 }, (_, i) =>
    String(i).padStart(40, "0"),
  );
  const inner = shas
    .map((sha) => `{"sha":"${sha}","message":"m"}`)
    .join(",");
  const payload = `{"status":"ok","commits_made":[${inner}]}`;
  const tail = `${SENTINEL_BEGIN}\n${payload}\n${SENTINEL_END}\n`;
  assert.ok(payload.length > 16384, "fixture must exceed legacy 16 KiB tail");
  const result = extractCompletionPayload(tail);
  assert.ok(result);
  assert.equal(result.payload.status, "ok");
  assert.equal(result.payload.commits_made.length, 600);
});

test("sentinel array body → null (object 만 허용)", () => {
  const tail = `${SENTINEL_BEGIN}\n[1,2,3]\n${SENTINEL_END}`;
  assert.equal(extractCompletionPayload(tail), null);
});

// ── Codex R1 LOW: standalone-line marker matching ─────────────────────

test("inline marker (앞뒤 newline 없음) — Tier 1 미발동, brace-scan fallback", () => {
  // 워커가 debug log 에 마커를 inline 으로 출력하면 Tier 1 트리거되면 안 됨.
  // Tier 2 (brace-scan) 가 외부의 정상 JSON 을 추출.
  const tail =
    `[debug] saw ${SENTINEL_BEGIN} earlier\n` +
    `{"status":"ok","commits_made":[{"sha":"abc"}]}\n`;
  const result = extractCompletionPayload(tail);
  assert.ok(result, "inline marker 무시하고 brace-scan 으로 정상 JSON 추출");
  assert.equal(result.payload.status, "ok");
});

test("standalone-line BEGIN 만 있고 inline END 는 무시 → null (truncation reject)", () => {
  // BEGIN 정상, END 는 인라인 (자기 줄 단독 아님) → END 인식 X → truncation.
  const tail = `${SENTINEL_BEGIN}\n{"x":1}\nlog ${SENTINEL_END} suffix\n`;
  assert.equal(extractCompletionPayload(tail), null);
});

test("Windows \\r\\n line endings — sentinel 정상 파싱", () => {
  const payload = '{"status":"ok","commits_made":[]}';
  const tail = `prefix\r\n${SENTINEL_BEGIN}\r\n${payload}\r\n${SENTINEL_END}\r\n`;
  const result = extractCompletionPayload(tail);
  assert.ok(result);
  assert.equal(result.payload.status, "ok");
});
