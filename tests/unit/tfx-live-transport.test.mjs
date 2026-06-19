import assert from "node:assert/strict";
import test from "node:test";

import {
  ADAPTERS,
  buildRemoteLiveCommand,
  callRemoteLive,
  parseRemoteLiveJson,
  resolveAskTransport,
} from "../../bin/tfx-live.mjs";

async function resolveWith({ tmux, daemonProbe }) {
  return resolveAskTransport(
    ADAPTERS.claude,
    {
      bridgePath: "/repo/hub/bridge.mjs",
      configDir: "/tmp/claude-config",
      session: "live-peer",
      short: "facefeed",
      timeoutMs: 1000,
      transport: "auto",
    },
    {
      hasTmuxSession: async () => tmux,
      probeDaemon: async () => daemonProbe,
    },
  );
}

test("resolveAskTransport prefers UDS when both tmux and daemon target exist", async () => {
  const result = await resolveWith({
    tmux: true,
    daemonProbe: { ok: true, raw: { target: { short: "facefeed" } } },
  });

  assert.equal(result.transport, "auto");
  assert.equal(result.transportSelected, "uds");
  assert.deepEqual(result.transportProbe, { tmux: true, daemon: true });
});

test("resolveAskTransport selects tmux when only the tmux session exists", async () => {
  const result = await resolveWith({
    tmux: true,
    daemonProbe: { ok: true, sessions: [], raw: { sessions: [] } },
  });

  assert.equal(result.transportSelected, "tmux");
  assert.deepEqual(result.transportProbe, {
    tmux: true,
    daemon: false,
    daemonReason: "target-not-found",
  });
});

test("resolveAskTransport selects UDS when only the daemon target exists", async () => {
  const result = await resolveWith({
    tmux: false,
    daemonProbe: { ok: true, raw: { target: { short: "facefeed" } } },
  });

  assert.equal(result.transportSelected, "uds");
  assert.deepEqual(result.transportProbe, { tmux: false, daemon: true });
});

test("resolveAskTransport reports none when neither transport target exists", async () => {
  const result = await resolveWith({
    tmux: false,
    daemonProbe: { ok: false, reason: "no-daemon" },
  });

  assert.equal(result.transportSelected, "none");
  assert.deepEqual(result.transportProbe, {
    tmux: false,
    daemon: false,
    daemonReason: "no-daemon",
  });
});

test("resolveAskTransport surfaces absent daemon directory diagnostics", async () => {
  const result = await resolveWith({
    tmux: false,
    daemonProbe: {
      ok: false,
      reason: "daemon-unavailable",
      raw: {
        reason: "daemon-unavailable",
        candidateResults: [
          {
            ok: false,
            errorCode: "daemon-dir-missing",
            controlSock: "/tmp/cc-daemon-501/abc/control.sock",
          },
        ],
      },
    },
  });

  assert.equal(result.transportSelected, "none");
  assert.equal(result.transportProbe.daemonReason, "daemon-dir-missing");
});

test("resolveAskTransport surfaces stale control socket diagnostics", async () => {
  const result = await resolveWith({
    tmux: false,
    daemonProbe: {
      ok: false,
      reason: "daemon-unavailable",
      raw: {
        reason: "daemon-unavailable",
        candidateResults: [
          {
            ok: false,
            errorCode: "stale-control-socket",
            controlSock: "/tmp/cc-daemon-501/abc/control.sock",
          },
        ],
      },
    },
  });

  assert.equal(result.transportSelected, "none");
  assert.equal(result.transportProbe.daemonReason, "stale-control-socket");
});

test("buildRemoteLiveCommand wraps darwin zsh remote tfx-live ask", () => {
  const plan = buildRemoteLiveCommand(
    "m2",
    "ask",
    {
      configDir: "/Users/tellang/.claude/.omc-launch",
      prompt: "say 'ok'",
      short: "facefeed",
      timeoutMs: 7000,
      transport: "uds",
    },
    { os: "darwin", shell: "zsh" },
  );

  assert.equal(plan.command, "ssh");
  assert.equal(plan.args.length, 2);
  assert.equal(plan.args[0], "m2");
  assert.match(plan.args[1], /^zsh -lc '/);
  assert.match(plan.args[1], /'\\''tfx-live'\\'' '\\''ask'\\'' /);
  assert.match(plan.args[1], /'\\''--transport'\\'' '\\''uds'\\''/);
  assert.match(plan.args[1], /'\\''--prompt'\\'' '\\''say /);
  assert.match(plan.args[1], /ok/);
  assert.match(
    plan.args[1],
    /'\\''--config-dir'\\'' '\\''\/Users\/tellang\/\.claude\/\.omc-launch'\\''/,
  );
  assert.match(plan.args[1], /'\\''--timeout'\\'' '\\''7'\\''/);
  assert.doesNotMatch(plan.args[1], /'\\''--json'\\''/);
});

test("buildRemoteLiveCommand wraps linux posix remote tfx-live ask", () => {
  const plan = buildRemoteLiveCommand(
    "linux-box",
    "ask",
    {
      prompt: "hello",
      sessionId: "sess-1",
      timeoutMs: 1000,
      transport: "auto",
    },
    { os: "linux", shell: "bash" },
  );

  assert.equal(plan.args.length, 2);
  assert.equal(plan.args[0], "linux-box");
  assert.match(plan.args[1], /^sh -lc '/);
  assert.match(plan.args[1], /'\\''tfx-live'\\'' '\\''ask'\\'' /);
  assert.match(plan.args[1], /'\\''--transport'\\'' '\\''auto'\\''/);
  assert.match(plan.args[1], /'\\''--session-id'\\'' '\\''sess-1'\\''/);
  assert.doesNotMatch(plan.args[1], /'\\''--json'\\''/);
});

test("buildRemoteLiveCommand wraps windows remote tfx-live interrupt with pwsh", () => {
  const plan = buildRemoteLiveCommand(
    "win-dev",
    "interrupt",
    {
      configDir: "C:\\Users\\me\\.claude",
      short: "facefeed",
      timeoutMs: 5000,
      transport: "uds",
    },
    { os: "win32", shell: "pwsh" },
  );

  assert.equal(plan.args.length, 2);
  assert.equal(plan.args[0], "win-dev");
  assert.match(plan.args[1], /^pwsh -NoProfile -Command /);
  assert.match(plan.args[1], /& '\\''tfx-live'\\'' '\\''interrupt'\\'' /);
  assert.match(plan.args[1], /'\\''--transport'\\'' '\\''uds'\\''/);
  assert.match(
    plan.args[1],
    /'\\''--config-dir'\\'' '\\''C:\\Users\\me\\.claude'\\''/,
  );
  assert.doesNotMatch(plan.args[1], /'\\''--json'\\''/);
});

test("buildRemoteLiveCommand keeps darwin ssh remote command as one host-side argument", () => {
  const plan = buildRemoteLiveCommand(
    "m2",
    "ask",
    {
      prompt: "LIVE_UDS_REMOTE_OK",
      short: "facefeed",
      timeoutMs: 1000,
      transport: "uds",
    },
    { os: "darwin", shell: "zsh" },
  );

  assert.deepEqual(plan.args, ["m2", plan.args[1]]);
  assert.equal(plan.args.length, 2);
  assert.match(plan.args[1], /^zsh -lc '.+'$/);
  assert.doesNotMatch(plan.args[1], /^zsh\s+-lc\s+'tfx-live'/);
  assert.match(plan.args[1], /'\\''--transport'\\'' '\\''uds'\\''/);
});

test("parseRemoteLiveJson extracts the JSON object from noisy stdout", () => {
  const parsed = parseRemoteLiveJson(
    [
      "remote shell banner",
      "debug: daemon attach starting",
      "{",
      '  "ok": true,',
      '  "transport": "uds",',
      '  "response": "REMOTE_OK"',
      "}",
      "",
    ].join("\n"),
  );

  assert.deepEqual(parsed, {
    ok: true,
    transport: "uds",
    response: "REMOTE_OK",
  });
});

test("callRemoteLive uses injected remote env probe and ssh exec", async () => {
  const calls = [];
  const result = await callRemoteLive(
    "ask",
    {
      prompt: "hello",
      remote: "m2",
      short: "facefeed",
      timeoutMs: 1000,
      transport: "uds",
    },
    {
      probeRemoteEnv: async (host) => {
        calls.push({ type: "probe", host });
        return { os: "darwin", shell: "zsh" };
      },
      sshExec: async (command, args, options) => {
        calls.push({ type: "ssh", command, args, timeout: options.timeout });
        return {
          stdout: [
            "remote login banner",
            '{"ok":true,"transport":"uds","response":"REMOTE_OK"}',
          ].join("\n"),
        };
      },
    },
  );

  assert.deepEqual(result, {
    ok: true,
    transport: "uds",
    response: "REMOTE_OK",
  });
  assert.equal(calls[0].type, "probe");
  assert.equal(calls[0].host, "m2");
  assert.equal(calls[1].command, "ssh");
  assert.equal(calls[1].args.length, 2);
  assert.equal(calls[1].args[0], "m2");
  assert.match(calls[1].args[1], /^zsh -lc '/);
  assert.match(calls[1].args[1], /'\\''--transport'\\'' '\\''uds'\\''/);
  assert.doesNotMatch(calls[1].args[1], /'\\''--json'\\''/);
});

test("claude adapter registers an external-imports startup screen after trust", () => {
  const names = ADAPTERS.claude.startupScreens.map((screen) => screen.name);
  assert.ok(
    names.includes("external-imports"),
    "claude startupScreens must include an external-imports entry",
  );
  assert.ok(
    names.indexOf("external-imports") > names.indexOf("trust"),
    "external-imports must be registered after the trust screen",
  );
});

test("external-imports startup screen detects the claude import prompt", () => {
  const screen = ADAPTERS.claude.startupScreens.find(
    (entry) => entry.name === "external-imports",
  );
  assert.ok(screen, "external-imports startup screen must exist");

  assert.equal(
    screen.isPresent(
      "Allow external CLAUDE.md file imports?\n  Yes, allow external imports\n  No",
    ),
    true,
  );
  assert.equal(
    screen.isPresent("allow external imports for this session"),
    true,
  );
  assert.equal(
    screen.isPresent("Quick safety check: trust this folder?"),
    false,
  );
  assert.equal(screen.isPresent("ready for input"), false);
});

test("claude adapter registers a tour startup screen after external-imports", () => {
  const names = ADAPTERS.claude.startupScreens.map((screen) => screen.name);
  assert.ok(
    names.includes("tour"),
    "claude startupScreens must include a tour entry",
  );
  assert.ok(
    names.indexOf("tour") > names.indexOf("external-imports"),
    "tour must be registered after the external-imports screen",
  );
});

test("tour startup screen detects the claude welcome/tour prompt", () => {
  const screen = ADAPTERS.claude.startupScreens.find(
    (entry) => entry.name === "tour",
  );
  assert.ok(screen, "tour startup screen must exist");

  // Real claude welcome screen renders both the confirm and cancel labels.
  assert.equal(
    screen.isPresent(
      "Welcome to Claude Code\n  ❯ Take the tour\n    Skip for now",
    ),
    true,
  );
  // Requires BOTH labels — a stray "Skip for now" alone must not match.
  assert.equal(screen.isPresent("Skip for now"), false);
  assert.equal(screen.isPresent("Take the tour"), false);
  // Must not collide with the other claude startup screens or the ready state.
  assert.equal(
    screen.isPresent("Allow external CLAUDE.md file imports?"),
    false,
  );
  assert.equal(
    screen.isPresent("Quick safety check: trust this folder?"),
    false,
  );
  assert.equal(screen.isPresent("ready for input"), false);
});
