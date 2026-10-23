import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ensureBashScriptExecution,
  resolveBashExecutable,
} from "../../hub/lib/bash-path.mjs";

describe("resolveBashExecutable", () => {
  it("prefers Git Bash on Windows when available", () => {
    const result = resolveBashExecutable({
      platform: "win32",
      exists(path) {
        return path === "C:/Program Files/Git/bin/bash.exe";
      },
    });

    assert.equal(result, "C:/Program Files/Git/bin/bash.exe");
  });

  it("falls back to bare bash when Git Bash is unavailable", () => {
    const result = resolveBashExecutable({
      platform: "win32",
      exists() {
        return false;
      },
    });

    assert.equal(result, "bash");
  });

  it("returns bare bash on non-Windows platforms", () => {
    const result = resolveBashExecutable({
      platform: "linux",
      exists() {
        return true;
      },
    });

    assert.equal(result, "bash");
  });

  it("wraps raw .sh commands with bash -lc", () => {
    const result = ensureBashScriptExecution(
      "~/.claude/scripts/tfx-route.sh exec",
      { bashCommand: "bash" },
    );

    assert.equal(result, "bash -lc '~/.claude/scripts/tfx-route.sh exec'");
  });

  it("does not double-wrap commands that already call bash", () => {
    const result = ensureBashScriptExecution(
      "TFX_TEAM_NAME=test bash ~/.claude/scripts/tfx-route.sh exec",
      { bashCommand: "C:/Program Files/Git/bin/bash.exe" },
    );

    assert.equal(
      result,
      "TFX_TEAM_NAME=test bash ~/.claude/scripts/tfx-route.sh exec",
    );
  });
});
