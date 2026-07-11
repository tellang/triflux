import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildContextUsageView } from "../../hud/context-monitor.mjs";

describe("lake4 integration", () => {
  it("buildContextUsageView가 포맷/임계값 분류를 일관되게 연결한다", () => {
    const infoView = buildContextUsageView(
      {
        context_window: {
          context_window_size: 1_000,
          current_usage: {
            input_tokens: 450,
            cache_read_input_tokens: 150,
          },
        },
      },
      {
        usedTokens: 10,
        limitTokens: 1_000,
      },
    );

    assert.equal(infoView.display, "600/1K (60%)");
    assert.equal(infoView.warningLevel, "info");
    assert.equal(infoView.source, "stdin.tokens");

    const unavailableView = buildContextUsageView(
      {},
      {
        usedTokens: 900,
        limitTokens: 1_000,
      },
    );

    assert.equal(unavailableView.display, "--");
    assert.equal(unavailableView.warningLevel, "ok");
    assert.equal(unavailableView.source, "none");
  });
});
