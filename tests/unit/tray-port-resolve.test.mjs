// tests/unit/tray-port-resolve.test.mjs — tray hub port resolution regressions

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveTrayHubPort } from "../../hub/tray.mjs";

describe("tray hub port resolution", () => {
  it("clamps leaked env ports in worktree contexts to the canonical default", () => {
    assert.equal(
      resolveTrayHubPort({
        cwd: "/x/.claude/worktrees/y",
        env: { TFX_HUB_PORT: "28255" },
      }),
      "27888",
    );
  });

  it("honors env ports outside worktree contexts", () => {
    assert.equal(
      resolveTrayHubPort({
        cwd: "/x/proj",
        env: { TFX_HUB_PORT: "29000" },
      }),
      "29000",
    );
  });

  it("uses the canonical default when no env port is present", () => {
    assert.equal(resolveTrayHubPort({ cwd: "/x/proj", env: {} }), "27888");
  });

  it("honors explicit ephemeral port opt-in inside worktree contexts", () => {
    assert.equal(
      resolveTrayHubPort({
        cwd: "/x/.claude/worktrees/y",
        env: {
          TFX_HUB_ALLOW_EPHEMERAL_PORT: "1",
          TFX_HUB_PORT: "28255",
        },
      }),
      "28255",
    );
  });
});
