import assert from "node:assert/strict";
import test from "node:test";
import * as live from "../../bin/tfx-live.mjs";
import {
  appleScriptString,
  closeGhosttySession,
  openGhosttySession,
  planGhosttyOpen,
} from "../../hub/team/ghostty-terminal.mjs";

test("Ghostty client identity wins over stale iTerm environment", async () => {
  assert.equal(
    await live.detectLocalTerminal({
      platform: "darwin",
      env: { TMUX_PANE: "%1", LC_TERMINAL: "iTerm2" },
      runTmux: async () => ({
        stdout:
          "10\txterm-256color\tiTerm2\n20\txterm-ghostty\tghostty 1.4.0\n",
      }),
    }),
    "ghostty",
  );
});

test("terminal detection uses the newest client and preserves iTerm fallback", async () => {
  for (const [env, stdout, expected] of [
    [{ TERM_PROGRAM: "ghostty" }, "", "ghostty"],
    [
      { TMUX_PANE: "%1", LC_TERMINAL: "iTerm2" },
      "20\txterm-256color\tiTerm2\n10\txterm-ghostty\tghostty 1.4.0\n",
      "iterm",
    ],
    [{ TMUX_PANE: "%1" }, "20\txterm-256color\tghostty 1.4.0\n", "ghostty"],
    [{ TERM_PROGRAM: "iTerm.app" }, "", "iterm"],
    [{}, "", null],
  ]) {
    assert.equal(
      await live.detectLocalTerminal({
        platform: "darwin",
        env,
        runTmux: async () => ({ stdout }),
      }),
      expected,
    );
  }
  for (const [remote, platform] of [
    ["host", "darwin"],
    [null, "linux"],
    [null, "win32"],
  ])
    assert.equal(
      await live.detectLocalTerminal({
        remote,
        platform,
        env: { TERM_PROGRAM: "ghostty" },
        runTmux: async () => {
          throw new Error("must not query tmux");
        },
      }),
      null,
    );
  for (const [env, expected] of [
    [{ TMUX_PANE: "%1", LC_TERMINAL: "iTerm2" }, "iterm"],
    [{ TMUX_PANE: "%1" }, null],
  ])
    assert.equal(
      await live.detectLocalTerminal({
        platform: "darwin",
        env,
        runTmux: async () => {
          throw new Error("tmux unavailable");
        },
      }),
      expected,
    );
});

function layout(columns = []) {
  return {
    windows: [
      {
        id: "w1",
        tabs: [
          {
            id: "leader-tab",
            terminals: [{ id: "leader", tty: "/dev/leader" }],
          },
          ...(columns.length
            ? [
                {
                  id: "group-tab",
                  terminals: columns.map((_, i) => ({
                    id: `p${i + 1}`,
                    tty: `/dev/p${i + 1}`,
                  })),
                },
              ]
            : []),
        ],
      },
    ],
    metadata: columns.map((column, i) => ({
      terminalId: `p${i + 1}`,
      project: "/repo",
      group: "team",
      column,
    })),
    leaderTty: "/dev/leader",
    project: "/repo",
    group: "team",
  };
}

test("Ghostty fills a 2x2 tab before opening the fifth terminal in a new tab", () => {
  assert.deepEqual(planGhosttyOpen(layout()), {
    kind: "tab",
    windowId: "w1",
    column: "L",
  });
  for (const [columns, terminalId, direction, column] of [
    [["L"], "p1", "right", "R"],
    [["L", "R"], "p1", "down", "L"],
    [["L", "R", "L"], "p2", "down", "R"],
  ])
    assert.deepEqual(planGhosttyOpen(layout(columns)), {
      kind: "split",
      windowId: "w1",
      tabId: "group-tab",
      terminalId,
      direction,
      column,
    });
  assert.deepEqual(planGhosttyOpen(layout(["L", "R", "L", "R"])), {
    kind: "tab",
    windowId: "w1",
    column: "L",
  });
});

test("Ghostty fills missing columns after panes close and counts user terminals", () => {
  for (const [columns, terminalId, direction, column] of [
    [["R", "R"], "p2", "right", "L"],
    [["L", "L"], "p2", "right", "R"],
    [["L", "R", "R"], "p1", "down", "L"],
    [["L", "L", "R"], "p3", "down", "R"],
  ])
    assert.deepEqual(planGhosttyOpen(layout(columns)), {
      kind: "split",
      windowId: "w1",
      tabId: "group-tab",
      terminalId,
      direction,
      column,
    });
  const mixed = layout(["L", "R", "L"]);
  mixed.windows[0].tabs[1].terminals.push({ id: "user", tty: "/dev/user" });
  assert.equal(planGhosttyOpen(mixed).kind, "tab");
});

test("Ghostty reuses the project window and requires a local leader window", () => {
  const input = layout(["L"]);
  input.metadata[0].project = "/other";
  assert.deepEqual(planGhosttyOpen(input), { kind: "window", column: "L" });
  input.windows.push({
    id: "w2",
    tabs: [
      {
        id: "project-tab",
        terminals: [{ id: "project-pane", tty: "/dev/project" }],
      },
    ],
  });
  input.metadata.push({
    terminalId: "project-pane",
    project: "/repo",
    group: "team",
    column: "L",
  });
  assert.deepEqual(planGhosttyOpen(input), {
    kind: "split",
    windowId: "w2",
    tabId: "project-tab",
    terminalId: "project-pane",
    direction: "right",
    column: "R",
  });
  input.leaderTty = "/dev/absent";
  assert.equal(planGhosttyOpen(input), null);
});

test("Ghostty ignores removed terminals and selects the first eligible group tab", () => {
  const input = layout();
  input.metadata.push({
    terminalId: "removed",
    project: "/other",
    group: "team",
    column: "R",
  });
  assert.deepEqual(planGhosttyOpen(input), {
    kind: "tab",
    windowId: "w1",
    column: "L",
  });
  const groups = layout(["L"]);
  groups.windows[0].tabs.push({
    id: "later",
    terminals: [{ id: "later-pane" }],
  });
  groups.metadata.push({
    terminalId: "later-pane",
    project: "/repo",
    group: "team",
    column: "L",
  });
  assert.equal(planGhosttyOpen(groups).tabId, "group-tab");
  groups.metadata[0].group = "other-group";
  assert.equal(planGhosttyOpen(groups).tabId, "later");
});

test("Ghostty opening uses exec input with a quoted session, fixes titles and records ownership", async () => {
  const scripts = [];
  const settings = [];
  const result = await openGhosttySession(
    "room'quoted",
    "리뷰 팀",
    { key: "/repo", name: "repo" },
    {
      env: { TMUX_PANE: "%1" },
      name: '11.2 "제목" \\ path',
      tabTitle: '리뷰 "팀"',
      cwd: "/tmp",
      execFile: async (command, args) => {
        if (command === "which") return { stdout: process.execPath };
        assert.equal(command, "/usr/bin/osascript");
        scripts.push(args[1]);
        return {
          stdout:
            scripts.length === 1
              ? "w1\tt1\t1\tleader\t/dev/leader\n"
              : "new-pane\n",
        };
      },
      runTmux: async (_remote, args) => {
        if (args[0] === "list-clients")
          return { stdout: "10\t/dev/old\n20\t/dev/leader\n" };
        if (args[0] === "list-sessions") return { stdout: "" };
        settings.push(args);
        return { stdout: "" };
      },
    },
  );
  assert.deepEqual(result, {
    ghostty: { terminalId: "new-pane", group: "리뷰 팀", split: false },
  });
  assert.equal(scripts.length, 2);
  assert.match(scripts[0], /^set fieldSeparator to character id 9\n/);
  assert.doesNotMatch(scripts.join("\n"), /& tab &/);
  assert.doesNotMatch(scripts[1], /set (?:command|wait after command) of cfg/);
  assert.match(scripts[1], /set initial working directory of cfg to "\/tmp"/);
  assert.match(scripts[1], /new tab in targetWindow with configuration cfg/);
  assert.ok(
    scripts[1].includes(
      `set initial input of cfg to "exec '${process.execPath}' 'attach-session' '-t' '=room'\\"'\\"'quoted'" & linefeed`,
    ),
  );
  assert.ok(
    scripts[1].includes(
      'set name override of newTerminal to "11.2 \\"제목\\" \\\\ path"',
    ),
  );
  assert.ok(
    scripts[1].includes('set name override of targetTab to "리뷰 \\"팀\\""'),
  );
  assert.deepEqual(settings, [
    ["set-option", "-t", "=room'quoted:", "@tfx_ghostty_terminal", "new-pane"],
    ["set-option", "-t", "=room'quoted:", "@tfx_project", "/repo"],
    ["set-option", "-t", "=room'quoted:", "@tfx_group", "리뷰 팀"],
    ["set-option", "-t", "=room'quoted:", "@tfx_column", "L"],
  ]);
});

test("Ghostty finds the first ancestor with a tty outside tmux", async () => {
  const pids = [];
  const result = await openGhosttySession(
    "room",
    "team",
    { key: "/repo", name: "repo" },
    {
      env: { TERM_PROGRAM: "ghostty" },
      execFile: async (command, args) => {
        if (command === "/bin/ps") {
          pids.push(args[1]);
          return { stdout: pids.length === 1 ? "123 ??\n" : "1 ttys005\n" };
        }
        if (command === "which") return { stdout: process.execPath };
        assert.equal(command, "/usr/bin/osascript");
        return {
          stdout: args[1].includes("set inventory")
            ? "w1\tt1\t1\tleader\t/dev/ttys005\n"
            : "opened\n",
        };
      },
      runTmux: async (_remote, args) => {
        assert.notEqual(args[0], "list-clients");
        return { stdout: "" };
      },
    },
  );
  assert.equal(result.ghostty?.terminalId, "opened");
  assert.deepEqual(pids, [String(process.pid), "123"]);
});

test("Ghostty warns when no ancestor has a tty within eight steps", async () => {
  let queries = 0;
  const result = await openGhosttySession(
    "room",
    "team",
    { key: "/repo", name: "repo" },
    {
      env: { TERM_PROGRAM: "ghostty" },
      execFile: async (command) => {
        if (command === "/bin/ps") return { stdout: `${100 + ++queries} ??\n` };
        assert.equal(command, "/usr/bin/osascript");
        return { stdout: "w1\tt1\t1\tleader\t/dev/leader\n" };
      },
      runTmux: async () => {
        throw new Error("must not mutate tmux");
      },
    },
  );
  assert.equal(queries, 8);
  assert.match(result.ghosttyWarning, /leader tty/i);
  assert.equal(result.ghostty, undefined);
});

test("AppleScript literals reject control characters before interpolation", () => {
  for (const control of [
    "\0",
    "\n",
    "\r",
    "\t",
    "\u001f",
    "\u007f",
    "\u0085",
    "\u009f",
    "\u2028",
    "\u2029",
  ])
    assert.throws(() => appleScriptString(`room${control}close`), {
      message: "AppleScript values must not contain control characters",
    });
});

test("Ghostty Automation errors return a start warning", async () => {
  const result = await openGhosttySession(
    "room",
    "team",
    { key: "/repo", name: "repo" },
    {
      execFile: async () => {
        throw new Error("Automation denied");
      },
      runTmux: async () => {
        throw new Error("must not mutate tmux");
      },
    },
  );
  assert.deepEqual(result, { ghosttyWarning: "Automation denied" });
});

test("Ghostty missing leaders leave all windows untouched", async () => {
  const commands = [];
  const result = await openGhosttySession(
    "room",
    "team",
    { key: "/repo", name: "repo" },
    {
      env: { TMUX_PANE: "%1" },
      execFile: async (command) => {
        assert.equal(command, "/usr/bin/osascript");
        return { stdout: "w1\tt1\t1\tuser\t/dev/user\n" };
      },
      runTmux: async (_remote, args) => {
        commands.push(args[0]);
        return {
          stdout: args[0] === "list-clients" ? "20\t/dev/absent\n" : "",
        };
      },
    },
  );
  assert.match(result.ghosttyWarning, /leader window/i);
  assert.equal(result.ghostty, undefined);
  assert.deepEqual(commands, ["list-clients", "list-sessions"]);
});

test("Ghostty close uses only the stored ID and preserves leader and reused ttys", async () => {
  const scripts = [];
  await closeGhosttySession("owned", {
    execFile: async (command, args) => {
      assert.equal(command, "/usr/bin/osascript");
      scripts.push(args[1]);
      return {
        stdout:
          scripts.length === 1
            ? [
                "w1\tt1\t1\towned\t/dev/owned",
                "w1\tt1\t1\tleader\t/dev/owned",
                "w1\tt1\t1\tuser\t/dev/user",
              ].join("\n")
            : "",
      };
    },
  });
  assert.match(
    scripts[1],
    /^if application "Ghostty" is not running then return/,
  );
  assert.match(scripts[1], /repeat with terminalId in \{"owned"\}/);
  assert.doesNotMatch(scripts[1], /"leader"|"user"|close tab|close window/);
  assert.match(
    scripts[1],
    /try\s+close \(first terminal whose id is \(contents of terminalId\)\)\s+end try/,
  );
  let calls = 0;
  await closeGhosttySession("gone", {
    execFile: async () => {
      calls++;
      return { stdout: "" };
    },
  });
  assert.equal(calls, 1);
});

test("stop reads Ghostty ownership before killing tmux and keeps GUI failure nonfatal", async () => {
  const order = [];
  const result = await live.doStop(
    live.ADAPTERS.claude,
    { session: "room" },
    {
      platform: "darwin",
      env: {},
      runTmux: async (_remote, args) => {
        order.push(args[0]);
        if (args[0] === "show-options")
          return {
            stdout: args.at(-1) === "@tfx_ghostty_terminal" ? "owned\n" : "",
          };
        if (args[0] === "list-clients")
          return {
            stdout: "/dev/ghostty\n/dev/iterm\n",
          };
        assert.deepEqual(args, ["kill-session", "-t", "=room:"]);
        return { stdout: "" };
      },
      closeItermSession: async (id, session, fallback, ttys) => {
        assert.deepEqual(
          [id, session, fallback, ttys],
          ["", "room", false, ["/dev/ghostty", "/dev/iterm"]],
        );
        order.push("iterm-close");
      },
      execFile: async (_command, args) => {
        order.push("ghostty-close");
        assert.match(args[1], /^set fieldSeparator/);
        throw new Error("Automation denied");
      },
    },
  );
  assert.deepEqual(order, [
    "show-options",
    "show-options",
    "list-clients",
    "kill-session",
    "iterm-close",
    "ghostty-close",
  ]);
  assert.deepEqual(result, {
    cli: "claude",
    session: "room",
    remote: null,
    stopped: true,
    ghosttyWarning: "Automation denied",
  });
});

for (const [label, itermId, ghosttyId] of [
  ["iTerm ID only", "abc-123", ""],
  ["neither ID", "", ""],
  ["Ghostty ID only", "", "owned"],
]) {
  test(`stop preserves iTerm cleanup with real tmux output: ${label}`, async () => {
    const closedIterm = [];
    const closedGhostty = [];
    const result = await live.doStop(
      live.ADAPTERS.claude,
      { session: "room" },
      {
        platform: "darwin",
        env: {},
        runTmux: async (_remote, args) => {
          if (args[0] === "show-options") {
            if (args.includes(";"))
              return {
                stdout: `${itermId ? `${itermId}\n` : ""}GHOSTTY\t${ghosttyId}\n`,
              };
            const value =
              args.at(-1) === "@tfx_iterm_session" ? itermId : ghosttyId;
            return { stdout: value ? `${value}\n` : "" };
          }
          if (args[0] === "list-clients") return { stdout: "" };
          assert.deepEqual(args, ["kill-session", "-t", "=room:"]);
          return { stdout: "" };
        },
        closeItermSession: async (...args) => {
          closedIterm.push(args);
        },
        closeGhosttySession: async (id) => {
          closedGhostty.push(id);
        },
      },
    );
    assert.deepEqual(
      closedIterm,
      itermId ? [[itermId, "room", false, []]] : [],
    );
    assert.deepEqual(closedGhostty, ghosttyId ? [ghosttyId] : []);
    assert.equal(result.stopped, true);
    assert.equal(result.itermWarning, undefined);
    assert.equal(result.ghosttyWarning, undefined);
  });
}

test("stop preserves iTerm tty cleanup without closing an unrecorded Ghostty leader", async () => {
  const closed = [];
  await live.doStop(
    live.ADAPTERS.claude,
    { session: "room" },
    {
      platform: "darwin",
      env: {},
      runTmux: async (_remote, args) => {
        if (args[0] === "show-options") return { stdout: "" };
        if (args[0] === "list-clients") {
          assert.equal(args.at(-1), "#{client_tty}");
          return { stdout: "/dev/leader\n" };
        }
        return { stdout: "" };
      },
      closeItermSession: async (...args) => {
        closed.push(args);
      },
      closeGhosttySession: async () => {
        assert.fail("must not close a terminal without a stored ID");
      },
    },
  );
  assert.deepEqual(closed, [["", "room", false, ["/dev/leader"]]]);
});
