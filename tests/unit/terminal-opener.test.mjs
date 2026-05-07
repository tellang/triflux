import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildCommandString,
  createTerminalOpener,
  focusSessionPane,
  sanitizeTerminalTitle,
  shellQuote,
} from "../../hub/team/terminal-opener.mjs";

describe("terminal-opener helpers", () => {
  it("sanitizes terminal titles", () => {
    assert.equal(sanitizeTerminalTitle("  alpha\t\n beta  "), "alpha beta");
    assert.equal(sanitizeTerminalTitle(" \n\t ", "fallback"), "fallback");
  });

  it("shellQuote handles embedded single quotes", () => {
    assert.equal(shellQuote("alpha ' beta"), "'alpha '\\'' beta'");
  });

  it("buildCommandString prefixes cwd with a quoted cd", () => {
    assert.equal(
      buildCommandString({ cwd: "/tmp/alpha beta", command: "npm test" }),
      "cd '/tmp/alpha beta' && npm test",
    );
  });
});

describe("terminal-opener adapter", () => {
  it("Windows openCommand uses wt-manager createTab with original command and cwd", async () => {
    const calls = [];
    const opener = createTerminalOpener({
      platform: "win32",
      createWtManager: () => ({
        createTab: async (spec) => {
          calls.push(spec);
        },
      }),
    });

    const opened = await opener.openCommand({
      title: "Worker 1",
      command: "echo $HOME && pwd",
      cwd: "C:\\Users\\SSAFY\\Project",
    });

    assert.equal(opened, true);
    assert.deepEqual(calls, [
      {
        title: "Worker 1",
        command: "echo $HOME && pwd",
        cwd: "C:\\Users\\SSAFY\\Project",
        profile: "triflux",
      },
    ]);
  });

  it("Windows openSession quotes psmux session names for PowerShell", async () => {
    const calls = [];
    const opener = createTerminalOpener({
      platform: "win32",
      createWtManager: () => ({
        createTab: async (spec) => {
          calls.push(spec);
        },
      }),
    });

    const opened = await opener.openSession("team one; rm 'x'", {
      cwd: "C:\\Users\\SSAFY\\Project",
    });

    assert.equal(opened, true);
    assert.deepEqual(calls, [
      {
        title: "team one; rm 'x'",
        command: "psmux attach-session -t 'team one; rm ''x'''",
        cwd: "C:\\Users\\SSAFY\\Project",
        profile: "triflux",
      },
    ]);
    assert.notEqual(calls[0].command, "psmux attach-session -t team one; rm 'x'");
  });

  it("macOS tmux openCommand calls tmuxExec new-window and includes command", async () => {
    const calls = [];
    const opener = createTerminalOpener({
      platform: "darwin",
      mux: "tmux",
      tmuxExec: (command) => calls.push(command),
    });

    const opened = await opener.openCommand({
      title: "Worker 2",
      cwd: "/tmp/work tree",
      command: "node --test tests/unit/terminal-opener.test.mjs",
    });

    assert.equal(opened, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^new-window -n 'Worker 2' /);
    assert.match(
      calls[0],
      /node --test tests\/unit\/terminal-opener\.test\.mjs/,
    );
    assert.match(calls[0], /cd '\\''\/tmp\/work tree'\\'' && /);
  });

  it("macOS without mux falls back to exec open -a Terminal", async () => {
    const calls = [];
    const opener = createTerminalOpener({
      platform: "darwin",
      mux: null,
      exec: (command, options, callback) => {
        calls.push({ command, options });
        callback(null);
      },
    });

    assert.equal(await opener.openCommand({ command: "echo hi" }), true);
    assert.deepEqual(calls, [
      { command: "open -a Terminal", options: { timeout: 5000 } },
    ]);
  });

  it("focusPane uses psmuxExec for psmux", () => {
    const calls = [];
    const opener = createTerminalOpener({
      mux: "psmux",
      psmuxExec: (args) => calls.push(args),
    });

    assert.equal(opener.focusPane("demo", 3), true);
    assert.deepEqual(calls, [["select-pane", "-t", "demo:0.3"]]);
  });

  it("focusPane uses tmuxExec for tmux", () => {
    const calls = [];
    const opener = createTerminalOpener({
      mux: "tmux",
      tmuxExec: (command) => calls.push(command),
    });

    assert.equal(opener.focusPane("demo session", 2), true);
    assert.deepEqual(calls, ["select-pane -t 'demo session:0.2'"]);
  });

  it("focusSessionPane forwards injected dependencies", () => {
    const calls = [];

    assert.equal(
      focusSessionPane("demo", 1, {
        _deps: {
          mux: "psmux",
          psmuxExec: (args) => calls.push(args),
        },
      }),
      true,
    );
    assert.deepEqual(calls, [["select-pane", "-t", "demo:0.1"]]);
  });
});
