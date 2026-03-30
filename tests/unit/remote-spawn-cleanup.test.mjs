import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSpawnCleanupWatcherArgs,
  buildLocalClaudeCommand,
  buildPosixExitTail,
  buildPwshExitTail,
  buildRemoteBootstrapCommand,
  buildRemoteClaudeCommand,
  resolveCleanupWatcherTimingOptions,
} from "../../scripts/remote-spawn.mjs";

describe("remote-spawn normal-exit cleanup command builders", () => {
  it("buildPwshExitTail returns LASTEXITCODE-preserving exit sequence", () => {
    const tail = buildPwshExitTail();
    assert.match(tail, /\$LASTEXITCODE/);
    assert.match(tail, /exit\s+\$trifluxExit/);
  });

  it("buildPosixExitTail returns shell exit propagation", () => {
    assert.equal(buildPosixExitTail(), "exit $?");
  });

  it("buildRemoteBootstrapCommand chains ssh and local shell exit", () => {
    const command = buildRemoteBootstrapCommand("devbox-01");
    assert.match(command, /^ssh -t devbox-01;/);
    assert.match(command, /exit\s+\$trifluxExit/);
  });

  it("buildLocalClaudeCommand appends pwsh exit tail", () => {
    const command = buildLocalClaudeCommand("C:/Users/O'Neil/claude.exe", "--dangerously-skip-permissions");
    assert.match(command, /& 'C:\/Users\/O''Neil\/claude\.exe'/);
    assert.match(command, /--dangerously-skip-permissions/);
    assert.match(command, /exit\s+\$trifluxExit/);
  });

  it("buildRemoteClaudeCommand for pwsh appends pwsh exit tail", () => {
    const command = buildRemoteClaudeCommand(
      { shell: "pwsh", claudePath: "C:\\Users\\dev\\bin\\claude.exe" },
      "--dangerously-skip-permissions",
    );
    assert.match(command, /^& "C:\\Users\\dev\\bin\\claude\.exe"/);
    assert.match(command, /--dangerously-skip-permissions/);
    assert.match(command, /exit\s+\$trifluxExit/);
  });

  it("buildRemoteClaudeCommand for posix appends posix exit tail", () => {
    const command = buildRemoteClaudeCommand(
      { shell: "bash", claudePath: "/home/dev/.local/bin/claude" },
      "--dangerously-skip-permissions",
    );
    assert.equal(
      command,
      "'/home/dev/.local/bin/claude' --dangerously-skip-permissions; exit $?",
    );
  });

  it("resolveCleanupWatcherTimingOptions merges explicit values and defaults", () => {
    const explicit = resolveCleanupWatcherTimingOptions(
      { graceMs: 2500, pollMs: 400, maxMs: 5000 },
      {},
    );
    assert.deepEqual(explicit, { graceMs: 2500, pollMs: 400, maxMs: 5000 });

    const fallback = resolveCleanupWatcherTimingOptions({}, {});
    assert.equal(typeof fallback.graceMs, "number");
    assert.equal(typeof fallback.pollMs, "number");
    assert.equal(typeof fallback.maxMs, "number");
    assert.ok(fallback.graceMs > 0);
    assert.ok(fallback.pollMs > 0);
    assert.ok(fallback.maxMs > 0);
  });

  it("buildSpawnCleanupWatcherArgs creates deterministic watcher argv", () => {
    const argv = buildSpawnCleanupWatcherArgs("tfx-spawn-abcd1234", "tfx-spawn-abcd1234:0.0", {
      graceMs: 2000,
      pollMs: 300,
      maxMs: 9000,
    });
    assert.ok(argv.length >= 11);
    assert.equal(argv[1], "--watch-cleanup");
    assert.equal(argv[2], "tfx-spawn-abcd1234");
    assert.equal(argv[3], "--pane");
    assert.equal(argv[4], "tfx-spawn-abcd1234:0.0");
    assert.equal(argv[5], "--poll-ms");
    assert.equal(argv[6], "300");
    assert.equal(argv[7], "--grace-ms");
    assert.equal(argv[8], "2000");
    assert.equal(argv[9], "--max-ms");
    assert.equal(argv[10], "9000");
  });
});
