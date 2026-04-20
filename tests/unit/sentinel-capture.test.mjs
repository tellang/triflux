// tests/unit/sentinel-capture.test.mjs — #125 sentinel capture state machine

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  createSentinelCapture,
  SENTINEL_BEGIN,
  SENTINEL_END,
} from "../../hub/team/sentinel-capture.mjs";

test("초기 상태 — capture 비어 있고 inactive", () => {
  const cap = createSentinelCapture();
  assert.equal(cap.snapshot(), "");
  assert.equal(cap.isActive(), false);
  assert.equal(cap.isComplete(), false);
  assert.equal(cap.isOverflow(), false);
});

test("BEGIN 없는 stream — capture 미동작", () => {
  const cap = createSentinelCapture();
  cap.push("just regular log line\n");
  cap.push("more output\n");
  assert.equal(cap.snapshot(), "");
  assert.equal(cap.isActive(), false);
});

test("BEGIN 단일 chunk — capturing 시작", () => {
  const cap = createSentinelCapture();
  cap.push(`prefix\n${SENTINEL_BEGIN}\n`);
  assert.equal(cap.isActive(), true);
  assert.ok(cap.snapshot().startsWith(SENTINEL_BEGIN));
});

test("BEGIN..END 단일 chunk — 완료 마킹", () => {
  const cap = createSentinelCapture();
  const payload = '{"status":"ok"}';
  cap.push(`${SENTINEL_BEGIN}\n${payload}\n${SENTINEL_END}\n`);
  assert.equal(cap.isComplete(), true);
  assert.equal(cap.isActive(), false);
  assert.equal(cap.isOverflow(), false);
  assert.ok(cap.snapshot().includes(payload));
});

test("BEGIN 마커가 chunk 경계에 걸침 — overlap window 로 감지", () => {
  const cap = createSentinelCapture();
  // Split BEGIN exactly in the middle. BEGIN must still appear at the start of
  // its own line — leading newline guarantees a line edge before the marker.
  const half = Math.floor(SENTINEL_BEGIN.length / 2);
  cap.push("noise\n" + SENTINEL_BEGIN.slice(0, half));
  cap.push(SENTINEL_BEGIN.slice(half) + '\n{"status":"ok"}\n' + SENTINEL_END);
  assert.equal(cap.isComplete(), true);
  assert.ok(cap.snapshot().startsWith(SENTINEL_BEGIN));
  assert.ok(cap.snapshot().includes(SENTINEL_END));
});

test("END 이후 추가 stdout — snapshot 변하지 않음", () => {
  const cap = createSentinelCapture();
  cap.push(`${SENTINEL_BEGIN}\n{"x":1}\n${SENTINEL_END}\n`);
  const snapAtEnd = cap.snapshot();
  cap.push("trailing log lines\n");
  cap.push("shell prompt $ ls\n");
  assert.equal(cap.snapshot(), snapAtEnd);
});

test("BEGIN 만 도착 후 stream 종료 — capture 는 BEGIN 만 들어 있어 extract 가 reject 가능", () => {
  const cap = createSentinelCapture();
  cap.push(`${SENTINEL_BEGIN}\n{"status":"ok","commits_made":[`);
  // No END ever arrives.
  assert.equal(cap.isActive(), true);
  assert.equal(cap.isComplete(), false);
  assert.equal(cap.isOverflow(), false);
  assert.ok(cap.snapshot().includes(SENTINEL_BEGIN));
  assert.equal(cap.snapshot().includes(SENTINEL_END), false);
});

test("maxBytes safety cap — head-truncate 적용", () => {
  const cap = createSentinelCapture({ maxBytes: 128 });
  const big = "x".repeat(500);
  cap.push(`${SENTINEL_BEGIN}\n${big}`);
  // Capture must not grow beyond cap.
  assert.ok(cap.snapshot().length <= 128);
});

// Codex R1 MEDIUM: payload past maxBytes loses BEGIN marker → must not silently
// fall through to brace-scan. isOverflow() exposes the truncation explicitly.
test("maxBytes 초과로 BEGIN 잘림 — isOverflow=true, isComplete=false", () => {
  const cap = createSentinelCapture({ maxBytes: 64 });
  cap.push(`${SENTINEL_BEGIN}\n${"y".repeat(200)}\n${SENTINEL_END}\n`);
  assert.equal(cap.isOverflow(), true, "BEGIN was head-truncated");
  assert.equal(
    cap.isComplete(),
    false,
    "isComplete=false even with END visible — overflow takes precedence",
  );
  assert.equal(
    cap.isActive(),
    false,
    "overflowed capture stops accepting more chunks",
  );
});

test("maxBytes 초과 후에도 BEGIN 유지되면 isOverflow=false", () => {
  // BEGIN at the very end of the truncation window — still standalone. END
  // arrives within budget → normal completion.
  const cap = createSentinelCapture({ maxBytes: 200 });
  cap.push(`${SENTINEL_BEGIN}\n{"x":1}\n${SENTINEL_END}\n`);
  assert.equal(cap.isOverflow(), false);
  assert.equal(cap.isComplete(), true);
});

test("non-string / 빈 chunk — 무시", () => {
  const cap = createSentinelCapture();
  cap.push("");
  cap.push(null);
  cap.push(undefined);
  assert.equal(cap.snapshot(), "");
  assert.equal(cap.isActive(), false);
});

test("여러 BEGIN/END 쌍 — 첫 BEGIN 이후 모두 capture (END 후 stop)", () => {
  // 핵심: capture 는 첫 BEGIN 부터 첫 END 까지. 이후 stdout 은 무시.
  // extractCompletionPayload 가 lastIndexOf(BEGIN) 기준으로 가장 최근 쌍을
  // 고르도록 설계되어 있으나, capture 는 BEGIN..END 한 쌍만 본다.
  const cap = createSentinelCapture();
  cap.push(
    [
      SENTINEL_BEGIN,
      '{"status":"first"}',
      SENTINEL_END,
      "after",
      SENTINEL_BEGIN,
      '{"status":"second"}',
      SENTINEL_END,
    ].join("\n"),
  );
  const snap = cap.snapshot();
  assert.ok(snap.includes('"first"'));
  // After the first END, capture stops. Second pair should not be present.
  assert.equal(snap.includes('"second"'), false);
  assert.equal(cap.isComplete(), true);
});

// ── Codex R1 LOW: standalone-line marker matching ─────────────────────

test("inline marker (앞뒤 newline 없음) — capture 미동작", () => {
  // Worker accidentally echoes the literal marker inline (debug log etc.).
  // Must NOT trigger capturing — markers only matter when standalone-on-line.
  const cap = createSentinelCapture();
  cap.push(`some prefix ${SENTINEL_BEGIN} suffix log line\n`);
  cap.push(`more text ${SENTINEL_END} more\n`);
  assert.equal(cap.isActive(), false);
  assert.equal(cap.isComplete(), false);
  assert.equal(cap.snapshot(), "");
});

test("BEGIN 앞에 prefix 텍스트 (newline 없이) — capture 미동작", () => {
  const cap = createSentinelCapture();
  cap.push(`some-debug-output${SENTINEL_BEGIN}\nbody\n${SENTINEL_END}\n`);
  assert.equal(cap.isActive(), false);
  assert.equal(cap.snapshot(), "");
});

test("BEGIN 뒤에 trailing 텍스트 (newline 없이) — capture 미동작", () => {
  const cap = createSentinelCapture();
  cap.push(`prefix\n${SENTINEL_BEGIN}-trailing\nbody\n${SENTINEL_END}\n`);
  assert.equal(cap.isActive(), false);
});

test("BEGIN 은 정상이지만 END 가 inline (자기 줄 단독 아님) — END 인식 안 함, BEGIN 만 남음", () => {
  // Worker emitted BEGIN correctly but then printed END as part of a log line.
  // Must NOT terminate capture; treat as BEGIN-without-END (truncation).
  const cap = createSentinelCapture();
  cap.push(`${SENTINEL_BEGIN}\n{"x":1}\nlog line ${SENTINEL_END} suffix\n`);
  assert.equal(cap.isActive(), true);
  assert.equal(cap.isComplete(), false);
});

test("Windows \\r\\n line endings — 정상 capture", () => {
  const cap = createSentinelCapture();
  cap.push(`prefix\r\n${SENTINEL_BEGIN}\r\n{"x":1}\r\n${SENTINEL_END}\r\n`);
  assert.equal(cap.isComplete(), true);
  assert.ok(cap.snapshot().startsWith(SENTINEL_BEGIN));
  assert.ok(cap.snapshot().endsWith(SENTINEL_END));
});

test("BEGIN 이 stream 첫 byte (string 시작이 line edge) — 정상 capture", () => {
  const cap = createSentinelCapture();
  cap.push(`${SENTINEL_BEGIN}\n{"x":1}\n${SENTINEL_END}`);
  assert.equal(cap.isComplete(), true);
});

test("END 가 stream 마지막 byte (string 끝이 line edge) — 정상 capture", () => {
  const cap = createSentinelCapture();
  cap.push(`${SENTINEL_BEGIN}\n{"x":1}\n${SENTINEL_END}`);
  assert.equal(cap.isComplete(), true);
  assert.ok(cap.snapshot().endsWith(SENTINEL_END));
});
