import assert from "node:assert/strict";
import { it } from "node:test";
import { buildContextUsageView } from "../../hud/context-monitor.mjs";

it("1M 컨텍스트에서는 info 태그만 숨기고 warn과 critical은 유지한다", () => {
  const view = (tokens) =>
    buildContextUsageView({
      context_window: {
        context_window_size: 1_000_000,
        current_usage: { total_tokens: tokens },
      },
    });
  const info = view(700_000);
  assert.equal(info.warningLevel, "info");
  assert.equal(info.warningMessage, "");
  assert.equal(info.warningTag, "");
  assert.equal(view(850_000).warningTag, "⚠ 압축 권장");
  assert.equal(view(950_000).warningTag, "‼ 분할 권장");
});
