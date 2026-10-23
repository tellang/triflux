import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildLocalClaudeCommand,
  buildPwshExitTail,
  buildRemoteBootstrapCommand,
} from "../../scripts/remote-spawn.mjs";

describe("remote-spawn normal-exit cleanup command builders", () => {
  it("buildPwshExitTail returns LASTEXITCODE-preserving exit sequence", () => {
    const tail = buildPwshExitTail();
    assert.match(tail, /\$LASTEXITCODE/);
    assert.match(tail, /exit\s+\$trifluxExit/);
  });

  it("buildRemoteBootstrapCommand chains ssh and local shell exit", () => {
    const command = buildRemoteBootstrapCommand("devbox-01");
    assert.match(command, /^ssh -t .* devbox-01;/);
    assert.match(command, /exit\s+\$trifluxExit/);
  });

  it("buildLocalClaudeCommand wraps in try/finally for Ctrl+C safety", () => {
    const command = buildLocalClaudeCommand(
      "C:/Users/O'Neil/claude.exe",
      "--dangerously-skip-permissions",
    );
    assert.match(command, /try\s*\{/);
    assert.match(command, /& 'C:\/Users\/O''Neil\/claude\.exe'/);
    assert.match(command, /--dangerously-skip-permissions/);
    assert.match(command, /finally\s*\{\s*exit\s*\}/);
  });
});
