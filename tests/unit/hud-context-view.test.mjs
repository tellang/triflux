import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildContextUsageView } from "../../hud/context-monitor.mjs";

describe("buildContextUsageView stdin priority", () => {
  it("stdin limitTokens가 modelHint보다 우선한다", () => {
    const view = buildContextUsageView(
      {
        context_window: {
          context_window_size: 1_000,
          current_usage: {
            input_tokens: 450,
            cache_read_input_tokens: 150,
          },
        },
      },
      { usedTokens: 600, limitTokens: 1_000 },
    );
    assert.equal(view.limitTokens, 1_000);
    assert.match(view.display, /600\/1K/);
  });

  it("stdin 없을 때 modelHintLimit fallback 동작", () => {
    const view = buildContextUsageView(
      {},
      { usedTokens: 100, limitTokens: 200_000 },
    );
    assert.ok(view.limitTokens >= 1);
  });
});
