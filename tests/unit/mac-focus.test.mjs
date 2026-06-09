// tests/unit/mac-focus.test.mjs — macOS tray focus script contract

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildFocusScript,
  FOCUS_SCRIPT_TIMEOUT_MS,
  getFocusCandidates,
} from "../../hub/mac-focus.mjs";

describe("mac focus script", () => {
  it("targets real macOS app names and prefers agent-specific apps", () => {
    assert.deepEqual(getFocusCandidates({ agentId: "codex" }).slice(0, 3), [
      "Codex",
      "iTerm2",
      "Terminal",
    ]);
    assert.deepEqual(getFocusCandidates({ agentId: "claude" }).slice(0, 3), [
      "Claude",
      "iTerm2",
      "Terminal",
    ]);
  });

  it("builds an AppleScript that can activate iTerm2 instead of the wrong iTerm name", () => {
    const script = buildFocusScript({ agentId: "claude" });

    assert.match(script, /iTerm2/);
    assert.doesNotMatch(script, /"iTerm"/);
    assert.match(script, /System Events/);
  });

  it("allows enough time for System Events on a busy macOS session", () => {
    assert.ok(FOCUS_SCRIPT_TIMEOUT_MS >= 5_000);
  });
});
