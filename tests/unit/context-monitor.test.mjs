import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildContextUsageView,
  classifyContextThreshold,
  createContextMonitor,
  estimateTokens,
  formatContextUsage,
  parseUsageFromPayload,
} from "../../hud/context-monitor.mjs";

function makeTmpPath(prefix) {
  return join(tmpdir(), `${prefix}-${randomUUID()}`);
}

describe("hud/context-monitor.mjs", () => {
  it("chars/4 근사 토큰 추정을 수행한다", () => {
    assert.equal(estimateTokens("abcd"), 1);
    assert.equal(estimateTokens("abcdefgh"), 2);
    assert.equal(estimateTokens(80), 20);
  });

  it("응답 payload에서 usage를 추출한다", () => {
    const usage = parseUsageFromPayload({
      result: {
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 25,
        },
      },
    });
    assert.deepEqual(usage, {
      input: 100,
      output: 50,
      cacheCreation: 0,
      cacheRead: 25,
      total: 175,
    });
  });

  it("임계값 경고 레벨을 분류한다", () => {
    assert.equal(classifyContextThreshold(30).level, "ok");
    assert.equal(classifyContextThreshold(60).level, "info");
    assert.equal(classifyContextThreshold(80).level, "warn");
    assert.equal(classifyContextThreshold(90).level, "critical");
  });

  it("CTX 포맷을 생성한다", () => {
    assert.equal(formatContextUsage(45_000, 200_000, 22), "45K/200K (22%)");
  });

  it("stdin context와 snapshot을 합성해 표시값을 생성한다", () => {
    const view = buildContextUsageView(
      {
        context_window: {
          context_window_size: 200_000,
          current_usage: {
            input_tokens: 30_000,
            cache_read_input_tokens: 15_000,
          },
        },
      },
      { usedTokens: 10_000, limitTokens: 200_000 },
    );
    assert.equal(view.display, "45K/200K (23%)");
    assert.equal(view.warningLevel, "ok");
  });

  it("stdin이 context_window_size를 주지 않으면 model.id로 한도를 추정한다 (Opus 4.7 → 1M)", () => {
    const view = buildContextUsageView(
      { model: { id: "claude-opus-4-7" } },
      null,
    );
    assert.equal(view.limitTokens, 1_000_000);
  });

  it("model.id에 [1m] suffix가 있으면 1M으로 추정한다", () => {
    const view = buildContextUsageView(
      { model: { id: "claude-opus-4-7[1m]" } },
      null,
    );
    assert.equal(view.limitTokens, 1_000_000);
  });

  it("monitor snapshot의 stale 200K 한도는 model hint 1M으로 오버라이드된다 (#88)", () => {
    const view = buildContextUsageView(
      { model: { id: "claude-opus-4-7" } },
      { usedTokens: 44_000, limitTokens: 200_000 },
    );
    assert.equal(view.limitTokens, 1_000_000);
    assert.equal(view.warningLevel, "ok");
  });

  it("알 수 없는 모델 + stdin size 없음 + monitor 없음 = 기본 200K", () => {
    const view = buildContextUsageView({ model: { id: "unknown-model" } }, null);
    assert.equal(view.limitTokens, 200_000);
  });

  it("Opus 4.6도 1M으로 추정한다 (Anthropic 공식 1M 모델)", () => {
    const view = buildContextUsageView(
      { model: { id: "claude-opus-4-6" } },
      null,
    );
    assert.equal(view.limitTokens, 1_000_000);
  });

  it("Sonnet 4.6도 1M으로 추정한다 (Anthropic 공식 1M 모델)", () => {
    const view = buildContextUsageView(
      { model: { id: "claude-sonnet-4-6" } },
      null,
    );
    assert.equal(view.limitTokens, 1_000_000);
  });

  it("Sonnet 4.5는 200K (Anthropic 공식 기본 컨텍스트)", () => {
    const view = buildContextUsageView(
      { model: { id: "claude-sonnet-4-5" } },
      null,
    );
    assert.equal(view.limitTokens, 200_000);
  });

  it("model이 raw string 으로 전달돼도 한도를 올바르게 추정한다", () => {
    const view = buildContextUsageView({ model: "claude-opus-4-7" }, null);
    assert.equal(view.limitTokens, 1_000_000);
  });

  it("요청/응답 기록 후 snapshot과 리포트를 저장한다", () => {
    const cachePath = makeTmpPath("context-monitor-cache");
    const logsDir = makeTmpPath("context-monitor-logs");
    const monitor = createContextMonitor({
      cachePath,
      logsDir,
      limitTokens: 100,
      registerExitHooks: false,
      sessionId: "test-session",
    });

    const summary = monitor.record({
      requestBody: JSON.stringify({
        method: "tools/call",
        params: {
          name: "write_file",
          arguments: { path: "src/index.mjs", skill: "$autopilot" },
        },
      }),
      responseBody: JSON.stringify({
        result: { usage: { input_tokens: 60, output_tokens: 40 } },
      }),
    });

    assert.equal(summary.warningLevel, "critical");
    assert.equal(existsSync(cachePath), true);

    const reportPath = monitor.flush("test");
    assert.ok(
      reportPath?.includes("context-usage-test-session-"),
      "report file name should include session id",
    );
    assert.equal(existsSync(reportPath), true);

    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report.summary.warningLevel, "critical");
    assert.equal(report.breakdown.tools.write_file > 0, true);

    rmSync(cachePath, { force: true });
    rmSync(logsDir, { recursive: true, force: true });
  });

  it("임계값 경계값(소수 포함)을 정확히 분류한다", () => {
    assert.equal(classifyContextThreshold(59.9).level, "ok");
    assert.equal(classifyContextThreshold(60.0).level, "info");
    assert.equal(classifyContextThreshold(79.9).level, "info");
    assert.equal(classifyContextThreshold(80.0).level, "warn");
    assert.equal(classifyContextThreshold(89.9).level, "warn");
    assert.equal(classifyContextThreshold(90.0).level, "critical");
  });

  it("제로/음수/빈 문자열 입력의 토큰 추정치를 0으로 처리한다", () => {
    assert.equal(estimateTokens(0), 0);
    assert.equal(estimateTokens(-1), 0);
    assert.equal(estimateTokens(""), 0);
  });

  it("malformed usage payload는 null을 반환한다", () => {
    assert.equal(parseUsageFromPayload({}), null);
    assert.equal(parseUsageFromPayload(null), null);
    assert.equal(parseUsageFromPayload(undefined), null);
  });

  it("포맷팅 엣지 값도 안정적으로 문자열을 생성한다", () => {
    assert.equal(formatContextUsage(0, 200_000, 0), "0/200K (0%)");
    assert.equal(
      formatContextUsage(999_999_999, 2_000_000_000, 50),
      "1000.0M/2000.0M (50%)",
    );
  });

  it("대형 payload에서 MAX_CAPTURE_BYTES 경계 밖 skill 힌트는 집계하지 않는다", () => {
    const cachePath = makeTmpPath("context-monitor-cache");
    const logsDir = makeTmpPath("context-monitor-logs");
    const monitor = createContextMonitor({
      cachePath,
      logsDir,
      registerExitHooks: false,
      sessionId: "capture-boundary",
    });

    const boundary = "x".repeat(256 * 1024);
    monitor.record({
      requestBody: `$inside ${boundary}`,
      responseBody: "{}",
      toolName: "tools/call",
    });
    monitor.record({
      requestBody: `${boundary}$outside`,
      responseBody: "{}",
      toolName: "tools/call",
    });

    const snapshot = monitor.snapshot();
    assert.equal(snapshot.bySkill.inside > 0, true);
    assert.equal(Object.hasOwn(snapshot.bySkill, "outside"), false);

    monitor.flush("boundary");
    rmSync(cachePath, { force: true });
    rmSync(logsDir, { recursive: true, force: true });
  });

  it("flush는 한 번만 리포트를 기록하고 이후 호출은 null을 반환한다", () => {
    const cachePath = makeTmpPath("context-monitor-cache");
    const logsDir = makeTmpPath("context-monitor-logs");
    const monitor = createContextMonitor({
      cachePath,
      logsDir,
      limitTokens: 50,
      registerExitHooks: false,
      sessionId: "flush-once",
    });

    monitor.record({
      requestBody: '{"method":"tools/call","params":{"name":"read_file"}}',
      responseBody:
        '{"result":{"usage":{"input_tokens":10,"output_tokens":5}}}',
    });

    const first = monitor.flush("first");
    const second = monitor.flush("second");
    assert.equal(typeof first, "string");
    assert.equal(second, null);

    rmSync(cachePath, { force: true });
    rmSync(logsDir, { recursive: true, force: true });
  });
});
