import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildContextUsageView,
  shouldSuppressInfoOnlyContextStatus,
} from "../../hud/context-monitor.mjs";

function stdinContext(modelId, usedTokens) {
  return {
    model: { id: modelId },
    context_window: {
      context_window_size: 1_000_000,
      current_usage: { total_tokens: usedTokens },
    },
  };
}

describe("1M Opus duplicate status suppression", () => {
  it("claude-opus-4-7 계열에서는 info-only 상태 태그를 숨긴다", () => {
    const view = buildContextUsageView(
      stdinContext("claude-opus-4-7", 700_000),
      null,
    );

    assert.equal(view.warningLevel, "info");
    assert.equal(view.warningMessage, "");
    assert.equal(view.warningTag, "");
  });

  it("claude-opus-5 계열에서도 info-only 상태 태그를 숨긴다", () => {
    const view = buildContextUsageView(
      stdinContext("claude-opus-5", 700_000),
      null,
    );

    assert.equal(shouldSuppressInfoOnlyContextStatus("claude-opus-5"), true);
    assert.equal(view.warningLevel, "info");
    assert.equal(view.warningMessage, "");
    assert.equal(view.warningTag, "");
  });

  it("claude-opus-5[1m] 계열에서도 info-only 상태 태그를 숨긴다", () => {
    const view = buildContextUsageView(
      stdinContext("claude-opus-5[1m]", 700_000),
      null,
    );

    assert.equal(
      shouldSuppressInfoOnlyContextStatus("claude-opus-5[1m]"),
      true,
    );
    assert.equal(view.warningLevel, "info");
    assert.equal(view.warningMessage, "");
    assert.equal(view.warningTag, "");
  });

  it("[1m] suffix 모델도 info-only 상태 태그를 숨긴다", () => {
    const view = buildContextUsageView(
      stdinContext("claude-sonnet-4-5[1m]", 700_000),
      null,
    );

    assert.equal(
      shouldSuppressInfoOnlyContextStatus("claude-sonnet-4-5[1m]"),
      true,
    );
    assert.equal(view.warningLevel, "info");
    assert.equal(view.warningMessage, "");
    assert.equal(view.warningTag, "");
  });

  it("warn/critical 구간은 Opus 4.7에서도 그대로 유지한다", () => {
    const warnView = buildContextUsageView(
      stdinContext("claude-opus-4-7", 850_000),
      null,
    );
    const criticalView = buildContextUsageView(
      stdinContext("claude-opus-4-7[1m]", 950_000),
      null,
    );

    assert.equal(warnView.warningLevel, "warn");
    assert.equal(warnView.warningTag, "⚠ 압축 권장");
    assert.equal(criticalView.warningLevel, "critical");
    assert.equal(criticalView.warningTag, "‼ 분할 권장");
  });

  it("warn/critical 구간은 Opus 5에서도 그대로 유지한다", () => {
    const warnView = buildContextUsageView(
      stdinContext("claude-opus-5", 850_000),
      null,
    );
    const criticalView = buildContextUsageView(
      stdinContext("claude-opus-5[1m]", 950_000),
      null,
    );

    assert.equal(warnView.warningLevel, "warn");
    assert.equal(warnView.warningTag, "⚠ 압축 권장");
    assert.equal(criticalView.warningLevel, "critical");
    assert.equal(criticalView.warningTag, "‼ 분할 권장");
  });
});
