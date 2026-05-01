import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CLAUDE_CACHE_PRICING,
  PRICING,
} from "../../scripts/token-snapshot.mjs";

describe("token-snapshot pricing", () => {
  it("uses current Opus 4.7 pricing for base and cache tokens", () => {
    // Issue #208: Anthropic public pricing page lists Opus 4.7 at $5/$25 per MTok.
    assert.equal(PRICING.claude_opus.input, 5);
    assert.equal(PRICING.claude_opus.output, 25);
    assert.equal(CLAUDE_CACHE_PRICING.claude_opus.cache_write, 6.25);
    assert.equal(CLAUDE_CACHE_PRICING.claude_opus.cache_read, 0.5);
  });
});
