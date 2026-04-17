import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildContextUsageView,
  shouldSuppressInfoOnlyContextStatus,
} from "../../hud/context-monitor.mjs";

describe("Opus 4.7 duplicate status suppression", () => {
  it("claude-opus-4-7 계열에서는 info-only 상태 태그를 숨긴다", () => {
    const view = buildContextUsageView(
      { model: { id: "claude-opus-4-7" } },
      { usedTokens: 700_000, limitTokens: 200_000 },
    );

    assert.equal(view.warningLevel, "info");
    assert.equal(view.warningMessage, "");
    assert.equal(view.warningTag, "");
  });

  it("[1m] suffix 모델도 info-only 상태 태그를 숨긴다", () => {
    const view = buildContextUsageView(
      { model: { id: "claude-sonnet-4-5[1m]" } },
      { usedTokens: 700_000, limitTokens: 200_000 },
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
      { model: { id: "claude-opus-4-7" } },
      { usedTokens: 850_000, limitTokens: 200_000 },
    );
    const criticalView = buildContextUsageView(
      { model: { id: "claude-opus-4-7[1m]" } },
      { usedTokens: 950_000, limitTokens: 200_000 },
    );

    assert.equal(warnView.warningLevel, "warn");
    assert.equal(warnView.warningTag, "⚠ 압축 권장");
    assert.equal(criticalView.warningLevel, "critical");
    assert.equal(criticalView.warningTag, "‼ 분할 권장");
  });
});
