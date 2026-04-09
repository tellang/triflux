import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  detectMultiplexer,
  hasWindowsTerminal,
  listSessions,
  sessionExists,
} from "../../hub/team/session.mjs";

describe("session.mjs", () => {
  it("detectMultiplexer()는 string 또는 null을 반환해야 한다", () => {
    const mux = detectMultiplexer();
    assert.ok(
      mux === null ||
        ["tmux", "git-bash-tmux", "wsl-tmux", "psmux"].includes(mux),
    );
  });

  it("sessionExists(nonexistent)는 false를 반환해야 한다", () => {
    const missingSession = `nonexistent-session-${Date.now()}-${Math.random()}`;
    assert.equal(sessionExists(missingSession), false);
  });

  it("listSessions()는 배열을 반환해야 한다", () => {
    const sessions = listSessions();
    assert.ok(Array.isArray(sessions));
  });

  it("hasWindowsTerminal()은 boolean을 반환해야 한다", () => {
    const hasWt = hasWindowsTerminal();
    assert.equal(typeof hasWt, "boolean");
  });
});
