// tests/unit/tui-core.test.mjs — tui-core 공통 유틸리티 테스트

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clamp,
  countStatuses,
  FALLBACK_COLUMNS,
  FALLBACK_ROWS,
  formatTokens,
  normalizeWorkerState,
  runtimeStatus,
  sanitizeFiles,
  sanitizeFindings,
  sanitizeOneLine,
  sanitizeTextBlock,
  statusColor,
  stripCodeBlocks,
  wrapLine,
  wrapText,
} from "../../hub/team/tui-core.mjs";

describe("tui-core: 텍스트 유틸", () => {
  it("clamp: 범위 제한", () => {
    assert.equal(clamp(5, 0, 10), 5);
    assert.equal(clamp(-1, 0, 10), 0);
    assert.equal(clamp(15, 0, 10), 10);
  });

  it("stripCodeBlocks: 펜스드 코드블록 제거", () => {
    const input = "before\n```js\ncode();\n```\nafter";
    const result = stripCodeBlocks(input);
    assert.ok(!result.includes("code()"));
    assert.ok(result.includes("before"));
    assert.ok(result.includes("after"));
  });

  it("stripCodeBlocks: 셸 프롬프트 제거", () => {
    const input = "text\nPS C:\\> Get-Process\n$ echo hi\nmore";
    const result = stripCodeBlocks(input);
    assert.ok(!result.includes("Get-Process"));
    assert.ok(!result.includes("echo hi"));
    assert.ok(result.includes("text"));
    assert.ok(result.includes("more"));
  });

  it("sanitizeTextBlock: HANDOFF 마커 제거", () => {
    const input = "line1\n--- HANDOFF ---\nline2";
    assert.ok(!sanitizeTextBlock(input).includes("HANDOFF"));
  });

  it("sanitizeTextBlock: rawMode 시 코드블록 유지", () => {
    const input = "a\n```js\ncode\n```\nb";
    assert.ok(sanitizeTextBlock(input, true).includes("code"));
  });

  it("sanitizeOneLine: 한 줄로 축약", () => {
    assert.equal(sanitizeOneLine("hello  world"), "hello world");
    assert.equal(sanitizeOneLine("", "fallback"), "fallback");
  });

  it("sanitizeFiles: 배열/문자열 모두 처리", () => {
    assert.deepEqual(sanitizeFiles(["a.js", "b.ts"]), ["a.js", "b.ts"]);
    assert.deepEqual(sanitizeFiles("a.js,b.ts"), ["a.js", "b.ts"]);
    assert.deepEqual(sanitizeFiles(null), []);
  });

  it("sanitizeFindings: 배열/문자열 모두 처리", () => {
    assert.deepEqual(sanitizeFindings(["fix bug"]), ["fix bug"]);
    assert.deepEqual(sanitizeFindings("line1\nline2"), ["line1", "line2"]);
    assert.deepEqual(sanitizeFindings(null), []);
  });

  it("formatTokens: 다양한 입력 포맷", () => {
    assert.equal(formatTokens(1500), "1.5k");
    assert.equal(formatTokens(2_500_000), "2.5m");
    assert.equal(formatTokens(42), "42");
    assert.equal(formatTokens(null), "n/a");
    assert.equal(formatTokens(""), "n/a");
    assert.equal(formatTokens("raw"), "raw");
  });
});

describe("tui-core: 워커 상태", () => {
  it("runtimeStatus: handoff.status 우선", () => {
    assert.equal(runtimeStatus({ handoff: { status: "ok" } }), "ok");
    assert.equal(runtimeStatus({ status: "running" }), "running");
    assert.equal(runtimeStatus(null), "pending");
  });

  it("normalizeWorkerState: 기본 정규화", () => {
    const result = normalizeWorkerState(
      {},
      { cli: "gemini", status: "running", progress: 0.5 },
    );
    assert.equal(result.cli, "gemini");
    assert.equal(result.status, "running");
    assert.equal(result.progress, 0.5);
  });

  it("normalizeWorkerState: 코드블록 제거", () => {
    const result = normalizeWorkerState(
      {},
      { snapshot: "text\n```js\ncode\n```\nmore" },
    );
    assert.ok(!result.snapshot.includes("code"));
  });

  it("normalizeWorkerState: trackChanges 옵션", () => {
    const existing = { status: "pending" };
    const result = normalizeWorkerState(
      existing,
      { status: "running" },
      { trackChanges: true },
    );
    assert.equal(result._prevStatus, "pending");
    assert.ok(result._statusChangedAt > 0);
  });

  it("normalizeWorkerState: trackChanges=false 시 _prevStatus 없음", () => {
    const result = normalizeWorkerState({}, { status: "running" });
    assert.equal(result._prevStatus, undefined);
  });

  it("normalizeWorkerState: handoff 병합", () => {
    const existing = { handoff: { verdict: "partial", confidence: "low" } };
    const result = normalizeWorkerState(existing, {
      handoff: { verdict: "done" },
    });
    assert.equal(result.handoff.verdict, "done");
    assert.equal(result.handoff.confidence, "low");
  });

  it("normalizeWorkerState: progress clamp", () => {
    assert.equal(normalizeWorkerState({}, { progress: 1.5 }).progress, 1);
    assert.equal(normalizeWorkerState({}, { progress: -0.1 }).progress, 0);
  });
});

describe("tui-core: 색상/집계", () => {
  it("statusColor: 상태별 색상 반환", () => {
    assert.ok(statusColor("ok"));
    assert.ok(statusColor("failed"));
    assert.ok(statusColor("running"));
    assert.ok(statusColor("unknown"));
  });

  it("countStatuses: 워커 상태 집계", () => {
    const workers = new Map([
      ["w1", { status: "completed" }],
      ["w2", { status: "running" }],
      ["w3", { status: "failed" }],
      ["w4", { handoff: { status: "ok" } }],
    ]);
    const result = countStatuses(["w1", "w2", "w3", "w4"], workers);
    assert.equal(result.ok, 2); // completed + handoff ok
    assert.equal(result.running, 1);
    assert.equal(result.failed, 1);
  });
});

describe("tui-core: 텍스트 래핑", () => {
  it("wrapLine: 짧은 텍스트 그대로", () => {
    assert.deepEqual(wrapLine("hello", 80), ["hello"]);
  });

  it("wrapLine: 긴 텍스트 줄바꿈", () => {
    const lines = wrapLine("a b c d e f g", 5);
    assert.ok(lines.length > 1);
  });

  it("wrapText: 코드블록 제거 후 래핑", () => {
    const result = wrapText("line1\n```js\ncode\n```\nline2", 80);
    assert.ok(result.some((l) => l.includes("line1")));
    assert.ok(result.some((l) => l.includes("line2")));
    assert.ok(!result.some((l) => l.includes("code")));
  });

  it("wrapText: 빈 입력 시 빈 배열", () => {
    assert.deepEqual(wrapText("", 80), []);
    assert.deepEqual(wrapText(null, 80), []);
  });
});

describe("tui-core: 상수", () => {
  it("FALLBACK_COLUMNS/ROWS 기본값", () => {
    assert.equal(FALLBACK_COLUMNS, 100);
    assert.equal(FALLBACK_ROWS, 30);
  });
});
