import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  it("detects psmux when version output is written to stdout only", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "triflux-psmux-stdout-"));
    const psmuxPath = join(binDir, "psmux");
    writeFileSync(psmuxPath, "#!/bin/sh\nprintf 'psmux 1.2.3\\n'\n");
    chmodSync(psmuxPath, 0o755);

    const previousPath = process.env.PATH;
    const previousPsmuxBin = process.env.PSMUX_BIN;
    process.env.PATH = `${binDir}:${previousPath || ""}`;
    delete process.env.PSMUX_BIN;

    try {
      const calls = [];
      const opener = createTerminalOpener({
        platform: "darwin",
        mux: "psmux",
        tmuxExec: (command) => {
          calls.push(command);
          return command.startsWith("display-message") ? "lead:0" : "";
        },
      });

      assert.equal(
        await opener.openSession("demo", { targetPane: "%40" }),
        true,
      );
      assert.match(calls[1], /psmux attach-session -t/);
    } finally {
      process.env.PATH = previousPath;
      if (previousPsmuxBin === undefined) {
        delete process.env.PSMUX_BIN;
      } else {
        process.env.PSMUX_BIN = previousPsmuxBin;
      }
    }
  });

  it("detects psmux when version output is written to stderr only", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "triflux-psmux-stderr-"));
    const psmuxPath = join(binDir, "psmux");
    writeFileSync(psmuxPath, "#!/bin/sh\nprintf 'psmux 1.2.3\\n' >&2\n");
    chmodSync(psmuxPath, 0o755);

    const previousPath = process.env.PATH;
    const previousPsmuxBin = process.env.PSMUX_BIN;
    process.env.PATH = `${binDir}:${previousPath || ""}`;
    delete process.env.PSMUX_BIN;

    try {
      const calls = [];
      const opener = createTerminalOpener({
        platform: "darwin",
        mux: "psmux",
        tmuxExec: (command) => {
          calls.push(command);
          return command.startsWith("display-message") ? "lead:0" : "";
        },
      });

      assert.equal(
        await opener.openSession("demo", { targetPane: "%41" }),
        true,
      );
      assert.match(calls[1], /psmux attach-session -t/);
    } finally {
      process.env.PATH = previousPath;
      if (previousPsmuxBin === undefined) {
        delete process.env.PSMUX_BIN;
      } else {
        process.env.PSMUX_BIN = previousPsmuxBin;
      }
    }
  });

  it("session multiplexer detection removes redundant nested win32 guards only", () => {
    const source = readFileSync("hub/team/session.mjs", "utf8");

    assert.doesNotMatch(
      source,
      /process\.platform === "win32" && hasGitBashTmux\(\)/,
    );
    assert.doesNotMatch(
      source,
      /process\.platform === "win32" && hasWslTmux\(\)/,
    );
    assert.match(
      source,
      /return process\.platform === "win32" && !!process\.env\.WT_SESSION;/,
    );
  });

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

  it("Windows openCommand reports wt-manager failures", async () => {
    const opener = createTerminalOpener({
      platform: "win32",
      createWtManager: () => ({
        createTab: async () => ({ success: false, reason: "wt-not-installed" }),
      }),
    });

    assert.equal(await opener.openCommand({ command: "echo hi" }), false);
  });

  it("Windows openCommand reports thrown wt-manager failures", async () => {
    const opener = createTerminalOpener({
      platform: "win32",
      createWtManager: () => ({
        createTab: async () => {
          throw new Error("WT tab ready timeout: demo");
        },
      }),
    });

    assert.equal(await opener.openCommand({ command: "echo hi" }), false);
  });

  it("Windows openSession quotes psmux session names for PowerShell", async () => {
    const calls = [];
    const opener = createTerminalOpener({
      platform: "win32",
      psmuxBinaryExists: () => true,
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
    assert.notEqual(
      calls[0].command,
      "psmux attach-session -t team one; rm 'x'",
    );
  });

  it("Windows openSession reports wt-manager failures", async () => {
    const opener = createTerminalOpener({
      platform: "win32",
      psmuxBinaryExists: () => true,
      createWtManager: () => ({
        createTab: async () => ({ success: false, reason: "wt-not-installed" }),
      }),
    });

    assert.equal(await opener.openSession("demo"), false);
  });

  it("Windows openSession reports thrown wt-manager failures", async () => {
    const opener = createTerminalOpener({
      platform: "win32",
      psmuxBinaryExists: () => true,
      createWtManager: () => ({
        createTab: async () => {
          throw new Error("WT tab ready timeout: demo");
        },
      }),
    });

    assert.equal(await opener.openSession("demo"), false);
  });

  it("Windows openSession refuses to create a psmux attach tab when psmux is absent", async () => {
    const calls = [];
    const opener = createTerminalOpener({
      platform: "win32",
      psmuxBinaryExists: () => false,
      createWtManager: () => ({
        createTab: async (spec) => {
          calls.push(spec);
        },
      }),
    });

    assert.equal(await opener.openSession("demo"), false);
    assert.deepEqual(calls, []);
  });

  it("macOS tmux openCommand calls tmuxExec new-window and includes command", async () => {
    const calls = [];
    const opener = createTerminalOpener({
      platform: "darwin",
      mux: "tmux",
      tmuxExec: (command) => {
        calls.push(command);
        return command.startsWith("display-message") ? "lead-session:3\n" : "";
      },
    });

    const opened = await opener.openCommand({
      title: "Worker 2",
      cwd: "/tmp/work tree",
      command: "node --test tests/unit/terminal-opener.test.mjs",
      targetPane: "%42",
    });

    assert.equal(opened, true);
    assert.deepEqual(calls.slice(0, 1), [
      "display-message -p -t %42 '#{session_name}:#{window_index}'",
    ]);
    assert.equal(calls.length, 2);
    assert.match(calls[1], /^new-window -a -t 'lead-session:3' -n 'Worker 2' /);
    assert.match(
      calls[1],
      /node --test tests\/unit\/terminal-opener\.test\.mjs/,
    );
    assert.match(calls[1], /cd '\\''\/tmp\/work tree'\\'' && /);
  });

  it("macOS tmux openSession opens tmux attach-session in a new window", async () => {
    const calls = [];
    const socketPath = "/tmp/tmux-501/triflux.sock";
    const opener = createTerminalOpener({
      platform: "darwin",
      mux: "tmux",
      tmuxExec: (command) => {
        calls.push(command);
        if (command.includes("#{socket_path}")) return socketPath;
        return command.startsWith("display-message") ? "requesting:7" : "";
      },
    });

    assert.equal(
      await opener.openSession("demo", {
        title: "Demo Session",
        targetPane: "%43",
      }),
      true,
    );
    assert.equal(calls[0], "display-message -p -t %43 '#{socket_path}'");
    assert.equal(
      calls[1],
      "display-message -p -t %43 '#{session_name}:#{window_index}'",
    );
    assert.match(
      calls[2],
      /^new-window -a -t 'requesting:7' -n 'Demo Session' /,
    );
    assert.match(calls[2], /env -u TMUX tmux -S/);
    assert.match(calls[2], /\/tmp\/tmux-501\/triflux\.sock/);
    assert.doesNotMatch(calls[2], /psmux attach-session -t/);
  });

  it("macOS psmux fallback is treated as tmux-compatible for openCommand", async () => {
    const calls = [];
    const opener = createTerminalOpener({
      platform: "darwin",
      mux: "psmux",
      tmuxExec: (command) => {
        calls.push(command);
        return command.startsWith("display-message") ? "lead:1" : "";
      },
    });

    assert.equal(
      await opener.openCommand({
        title: "Worker 3",
        command: "echo hi",
        targetPane: "%44",
      }),
      true,
    );
    assert.equal(
      calls[0],
      "display-message -p -t %44 '#{session_name}:#{window_index}'",
    );
    assert.match(
      calls[1],
      /^new-window -a -t 'lead:1' -n 'Worker 3' 'echo hi'$/,
    );
  });

  it("macOS psmux fallback opens sessions with psmux attach in a new window", async () => {
    const calls = [];
    const opener = createTerminalOpener({
      platform: "darwin",
      mux: "psmux",
      psmuxBinaryExists: () => true,
      tmuxExec: (command) => {
        calls.push(command);
        return command.startsWith("display-message") ? "lead:4" : "";
      },
    });

    assert.equal(
      await opener.openSession("demo", {
        title: "Demo Session",
        targetPane: "%45",
      }),
      true,
    );
    assert.match(calls[1], /^new-window -a -t 'lead:4' -n 'Demo Session' /);
    assert.match(calls[1], /psmux attach-session -t/);
    assert.doesNotMatch(calls[1], /tmux attach-session -t/);
  });

  it("macOS psmux openSession refuses to emit attach command when psmux binary is absent", async () => {
    const calls = [];
    const opener = createTerminalOpener({
      platform: "darwin",
      mux: "psmux",
      psmuxBinaryExists: () => false,
      tmuxExec: (command) => calls.push(command),
    });

    assert.equal(await opener.openSession("demo"), false);
    assert.deepEqual(calls, []);
  });

  it("tmux-compatible opener는 explicit lead pane 없이는 new-window를 열지 않는다", async () => {
    const calls = [];
    const opener = createTerminalOpener({
      platform: "darwin",
      mux: "tmux",
      tmuxExec: (command) => calls.push(command),
    });

    assert.equal(await opener.openCommand({ command: "echo hi" }), false);
    assert.equal(await opener.openSession("demo"), false);
    assert.deepEqual(calls, []);
  });

  it("lead pane의 window를 해석하지 못하면 new-window를 실행하지 않는다", async () => {
    const calls = [];
    const opener = createTerminalOpener({
      platform: "darwin",
      mux: "tmux",
      tmuxExec: (command) => {
        calls.push(command);
        return "";
      },
    });

    assert.equal(
      await opener.openCommand({
        command: "echo hi",
        targetPane: "%46",
      }),
      false,
    );
    assert.deepEqual(calls, [
      "display-message -p -t %46 '#{session_name}:#{window_index}'",
    ]);
  });

  it("target window의 new-window 실패를 false로 반환한다", async () => {
    const calls = [];
    const opener = createTerminalOpener({
      platform: "darwin",
      mux: "tmux",
      tmuxExec: (command) => {
        calls.push(command);
        if (command.startsWith("display-message")) return "lead:2";
        throw new Error("new-window failed");
      },
    });

    assert.equal(
      await opener.openSession("demo", {
        targetPane: "%47",
      }),
      false,
    );
    assert.equal(calls.length, 3);
    assert.match(calls[2], /^new-window -a -t 'lead:2'/u);
  });

  for (const [caseName, socketResult] of [
    ["빈 값", ""],
    ["예외", new Error("socket lookup failed")],
  ]) {
    it(`lead pane socket_path가 ${caseName}이면 new-window를 열지 않는다`, async () => {
      const calls = [];
      const opener = createTerminalOpener({
        platform: "darwin",
        mux: "tmux",
        tmuxExec: (command) => {
          calls.push(command);
          if (command.includes("#{socket_path}")) {
            if (socketResult instanceof Error) throw socketResult;
            return socketResult;
          }
          return "lead:3";
        },
      });

      assert.equal(
        await opener.openSession("demo", { targetPane: "%48" }),
        false,
      );
      assert.deepEqual(calls, ["display-message -p -t %48 '#{socket_path}'"]);
    });
  }

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

  it("Linux without mux returns false from openCommand", async () => {
    const opener = createTerminalOpener({
      platform: "linux",
      mux: null,
    });
    assert.equal(await opener.openCommand({ command: "echo hi" }), false);
  });

  it("Linux without mux returns false from openSession", async () => {
    const opener = createTerminalOpener({
      platform: "linux",
      mux: null,
    });
    assert.equal(await opener.openSession("demo"), false);
  });

  it("Windows wt-manager undefined return is treated as success", async () => {
    const opener = createTerminalOpener({
      platform: "win32",
      createWtManager: () => ({
        createTab: async () => undefined,
      }),
    });
    assert.equal(await opener.openCommand({ command: "echo hi" }), true);
  });

  it("Windows wt-manager null return is treated as success", async () => {
    const opener = createTerminalOpener({
      platform: "win32",
      psmuxBinaryExists: () => true,
      createWtManager: () => ({
        createTab: async () => null,
      }),
    });
    assert.equal(await opener.openSession("demo"), true);
  });

  it("Windows wt-manager empty object return is treated as success (no explicit success:false)", async () => {
    const opener = createTerminalOpener({
      platform: "win32",
      createWtManager: () => ({
        createTab: async () => ({}),
      }),
    });
    assert.equal(await opener.openCommand({ command: "echo hi" }), true);
  });
});
