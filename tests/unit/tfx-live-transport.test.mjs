import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import * as live from "../../bin/tfx-live.mjs";

import {
  ADAPTERS,
  buildRemoteLiveCommand,
  buildTmuxCommand,
  callRemoteLive,
  parseRemoteLiveJson,
  resolveAskTransport,
} from "../../bin/tfx-live.mjs";

const execFileAsync = promisify(execFile);
const CLI = path.resolve("bin/tfx-live.mjs");

test("Codex pane discovery and attach recognize npm shim descendants", async () => {
  for (const command of [
    "node /opt/homebrew/bin/codex --dangerously-bypass-approvals-and-sandbox",
    "node /opt/homebrew/lib/codex.js",
    "/opt/vendor/aarch64-apple-darwin/bin/codex --flag",
  ]) {
    const deps = {
      runTmux: async (_remote, args) => ({
        stdout:
          args[0] === "list-panes"
            ? "shim\t1735689600\t1\t0\t0\t/tmp\tnode\t\t/dev/ttys010\t100\n"
            : args[0] === "display-message"
              ? "node\t\t/dev/ttys010\t100\n"
              : "",
      }),
      psExec: async (program, args) => {
        assert.equal(program, "ps");
        assert.deepEqual(args, ["-ax", "-o", "pid=,ppid=,tty=,args="]);
        return {
          stdout: `100 1 ttys010 -zsh\n101 100 ?? node launcher\n102 101 ?? ${command}\n200 1 ttys099 /other/bin/codex\n`,
        };
      },
    };
    const result = await live.discoverCodexTmuxSessions({}, deps);
    assert.equal(result.sessions[0]?.target, "shim:0.0");
    await live.verifyAttachedPeerSide(
      ADAPTERS.codex,
      { session: "shim:0.0", transport: "tmux" },
      deps,
    );
  }
});

test("Codex pane detection uses tty and excludes code-mode-host and unrelated processes", async () => {
  const pane = {
    currentCommand: "node",
    panePid: "100",
    paneTty: "/dev/ttys010",
  };
  const inspect = (stdout) =>
    live.inspectCodexTmuxPane(pane, { psExec: async () => ({ stdout }) });
  assert.equal(
    (await inspect("102 1 ttys010 node /opt/bin/codex\n")).isCodex,
    true,
  );
  assert.equal(
    (
      await inspect(
        "101 100 ttys010 /vendor/bin/codex-code-mode-host\n200 1 ttys099 /vendor/bin/codex\n",
      )
    ).isCodex,
    false,
  );
  for (const command of [
    "node /vendor/bin/codex-code-mode-host codex",
    "node /app/other.js --label codex",
    "node --eval codex",
    "node --require /vendor/codex /app/other.js",
    "node --conditions codex /app/other.js",
    "node --env-file codex /app/other.js",
  ])
    assert.equal((await inspect(`100 1 ttys010 ${command}\n`)).isCodex, false);
  assert.equal(
    (
      await inspect(
        '101 100 ttys010 node --no-warnings --require /app/register.js "/app dir/codex.js"\n',
      )
    ).isCodex,
    true,
  );
});

test("remote Codex preflight runs ps remotely and warns only when inspection fails", async () => {
  const base = {
    session: "shim:0.0",
    transport: "tmux",
    remote: "remote-host",
  };
  const runTmux = async (remote, args) => {
    assert.equal(remote, base.remote);
    return {
      stdout: args[0] === "display-message" ? "node\t\t/dev/pts/3\t100\n" : "",
    };
  };
  const psExec = async (program, args) => {
    assert.equal(program, "ssh");
    assert.equal(args.at(-2), "remote-host");
    assert.match(args.at(-1), /^ps -ax -o /);
    return { stdout: "101 100 pts/3 node /opt/bin/codex\n" };
  };
  await live.verifyAttachedPeerSide(ADAPTERS.codex, base, { runTmux, psExec });
  const warning = await live.verifyAttachedPeerSide(ADAPTERS.codex, base, {
    runTmux,
    psExec: async () => {
      throw new Error("ps unavailable");
    },
  });
  assert.match(warning.preflightWarning, /ps unavailable/);
  await assert.rejects(
    () =>
      live.verifyAttachedPeerSide(ADAPTERS.codex, base, {
        runTmux,
        psExec: async () => ({
          stdout: "101 100 pts/3 node /bin/codex-code-mode-host\n",
        }),
      }),
    /not a Codex tmux pane/,
  );
});

test("peer reports remote ps failure as a preflight warning and preserves attached sessions", async () => {
  const dir = await fs.mkdtemp("/tmp/tfx-live-remote-preflight-");
  const log = path.join(dir, "ssh.jsonl");
  try {
    await fs.writeFile(
      path.join(dir, "ssh"),
      `#!${process.execPath}
const fs = require('node:fs');
const command = process.argv.at(-1);
fs.appendFileSync(process.env.SSH_LOG, JSON.stringify(command) + '\\n');
if (command.startsWith('ps ')) { console.error('ps unavailable'); process.exit(1); }
if (command.startsWith('tmux display-message')) console.log('node\\t\\t/dev/pts/3\\t100');
else if (command.startsWith('tmux capture-pane')) console.log('Working (esc to interrupt)');
else if (!command.startsWith('tmux has-session')) process.exit(92);
`,
      { mode: 0o755 },
    );
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        CLI,
        "peer",
        "--remote",
        "host",
        "--session-a",
        "A",
        "--session-b",
        "B",
        "--attach-a",
        "--attach-b",
        "--if-busy",
        "fail",
        "--rounds",
        "1",
      ],
      {
        env: {
          ...process.env,
          PATH: `${dir}${path.delimiter}${process.env.PATH}`,
          SSH_LOG: log,
          TFX_LIVE_ARTIFACT_DIR: dir,
          TRIFLUX_NOTIFY_BELL: "0",
          TRIFLUX_NOTIFY_TOAST: "0",
        },
        timeout: 5000,
      },
    );
    const output = JSON.parse(stdout);
    assert.match(output.preflightWarning[0].message, /ps unavailable/);
    assert.equal(output.preflightWarning[0].side, "a");
    assert.equal(output.error, "target busy (--if-busy fail)");
    assert.equal(output.stoppedA, false);
    assert.equal(output.stoppedB, false);
    const commands = (await fs.readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.ok(commands.some((command) => command.startsWith("ps ")));
    assert.ok(
      commands.every(
        (command) => !/new-session|kill-session|paste-buffer/.test(command),
      ),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("remote relay budgets busy wait plus the full turn and relay margin", async () => {
  for (const [cli, maxTurnMs, expected] of [
    ["claude", undefined, 39000],
    ["codex", 12000, 51000],
  ]) {
    let budget;
    await callRemoteLive(
      "ask",
      {
        remote: "host",
        cli,
        transport: "uds",
        timeoutMs: 3000,
        busyTimeoutMs: 6000,
        maxTurnMs,
      },
      {
        probeRemoteEnv: async () => ({ os: "linux" }),
        sshExec: async (_command, _args, options) => {
          budget = options.timeout;
          return { stdout: "{}" };
        },
      },
    );
    assert.equal(budget, expected);
  }
});

test("remote Codex relay allows the lifecycle check after a nonaligned hard ceiling", async () => {
  await callRemoteLive(
    "ask",
    {
      remote: "host",
      cli: "codex",
      transport: "uds",
      timeoutMs: 60_000,
      busyTimeoutMs: 5000,
      maxTurnMs: 61_000,
    },
    {
      probeRemoteEnv: async () => ({ os: "linux" }),
      sshExec: async (_command, args, options) => {
        // Activity may defer the 60s check to 120s; 61s + the old 30s margin is insufficient.
        assert.equal(options.timeout, 156_000);
        assert.ok(args.at(-1).includes("max-turn"));
        return { stdout: "{}" };
      },
    },
  );
});

test("peer validates busy policies for each transport before any side starts", async () => {
  const flags = {
    remote: "host",
    "transport-a": "uds",
    "transport-b": "tmux",
    "thread-a": "thread",
    "if-busy-a": "steer",
    "if-busy-b": "interrupt",
  };
  assert.equal(
    live.peerSideBaseOpts(flags, "a", ADAPTERS.codex, "A").ifBusy,
    "steer",
  );
  assert.equal(
    live.peerSideBaseOpts(flags, "b", ADAPTERS.claude, "B").ifBusy,
    "interrupt",
  );
  for (const value of ["wait", "fail"]) {
    const common = { ...flags, "if-busy": value };
    delete common["if-busy-a"];
    delete common["if-busy-b"];
    assert.equal(
      live.peerSideBaseOpts(common, "a", ADAPTERS.codex, "A").ifBusy,
      value,
    );
    assert.equal(
      live.peerSideBaseOpts(common, "b", ADAPTERS.claude, "B").ifBusy,
      value,
    );
  }
  assert.throws(
    () =>
      live.peerSideBaseOpts(
        { ...flags, "if-busy": "interrupt" },
        "a",
        ADAPTERS.codex,
        "A",
      ),
    /--if-busy.*side a/,
  );
  assert.throws(
    () =>
      live.peerSideBaseOpts(
        { ...flags, "if-busy": "steer" },
        "b",
        ADAPTERS.claude,
        "B",
      ),
    /--if-busy.*side b/,
  );
  assert.throws(
    () =>
      live.peerSideBaseOpts(
        { ...flags, "if-busy-a": "interrupt" },
        "a",
        ADAPTERS.codex,
        "A",
      ),
    /--if-busy-a/,
  );
  assert.throws(
    () =>
      live.peerSideBaseOpts(
        { ...flags, "if-busy-b": "steer" },
        "b",
        ADAPTERS.claude,
        "B",
      ),
    /--if-busy-b/,
  );
  // Both sides must be validated before resolving a socket or starting tmux.
  await assert.rejects(
    () =>
      execFileAsync(process.execPath, [
        CLI,
        "peer",
        "--cli-a",
        "codex",
        "--transport-a",
        "uds",
        "--thread-a",
        "thread",
        "--codex-socket-a",
        "/nonexistent.sock",
        "--cli-b",
        "claude",
        "--if-busy-b",
        "steer",
      ]),
    (error) => {
      assert.match(JSON.parse(error.stdout).error, /--if-busy-b/);
      return true;
    },
  );
});

async function withCodexCliFixture(env, fn) {
  const dir = await fs.mkdtemp("/tmp/tfx-live-cli-uds-");
  const socketPath = path.join(dir, "daemon.sock");
  const daemonDir = path.join(dir, "app-server-control");
  await fs.mkdir(daemonDir);
  const defaultSocket = path.join(daemonDir, "app-server-control.sock");
  await fs.symlink(socketPath, defaultSocket);
  // Any accidental process launch must fail before reaching a real CLI.
  for (const name of ["tmux", "codex", "claude"]) {
    await fs.writeFile(path.join(dir, name), "#!/bin/sh\nexit 91\n", {
      mode: 0o755,
    });
  }
  const child = spawn(
    process.execPath,
    [
      path.resolve("tests/fixtures/fake-codex-app-server-ws-uds.mjs"),
      socketPath,
    ],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } },
  );
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await fs.stat(socketPath).catch(() => null))?.isSocket()) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal((await fs.stat(socketPath)).isSocket(), true);
    const run = async (args) => {
      const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], {
        timeout: 5000,
        env: {
          ...process.env,
          CODEX_HOME: dir,
          PATH: `${dir}${path.delimiter}${process.env.PATH}`,
          TFX_LIVE_ARTIFACT_DIR: dir,
          TRIFLUX_NOTIFY_BELL: "0",
          TRIFLUX_NOTIFY_TOAST: "0",
        },
      });
      return JSON.parse(stdout);
    };
    await fn({ run, dir, socketPath, defaultSocket });
    assert.equal(
      child.exitCode,
      null,
      "attached calls must preserve the daemon",
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("Codex UDS CLI discovers and asks through the default symlink socket", async () => {
  await withCodexCliFixture({}, async ({ run, dir, defaultSocket }) => {
    const cwdAlias = path.join(dir, "worktree");
    await fs.symlink(process.cwd(), cwdAlias);
    const threads = await run([
      "list-sessions",
      "--cli",
      "codex",
      "--transport",
      "uds",
      "--cwd",
      cwdAlias,
    ]);
    assert.equal(threads.length, 1);
    assert.equal(threads[0].threadId, "fake-thread-ws");
    assert.deepEqual(threads[0].status, { type: "idle" });
    assert.equal(threads[0].source, "cli");
    const result = await run([
      "ask",
      "--cli",
      "codex",
      "--transport",
      "uds",
      "--thread",
      "auto",
      "--cwd",
      cwdAlias,
      "--prompt",
      "ping",
      "--timeout",
      "60",
    ]);
    assert.equal(result.response, "PONG");
    assert.equal(result.done, true);
    assert.equal(result.matchedCompletion, true);
    assert.equal(result.socketPath, defaultSocket);
    assert.equal(result.ifBusy, "wait");
    assert.equal(result.steered, false);
  });
});

test("Codex UDS CLI forwards busy fail and steer to the existing thread", async () => {
  await withCodexCliFixture(
    { FAKE_ACTIVE_READS: "100" },
    async ({ run, socketPath }) => {
      const args = [
        "ask",
        "--cli",
        "codex",
        "--transport",
        "uds",
        "--thread",
        "fake-thread-ws",
        "--codex-socket",
        socketPath,
        "--prompt",
        "ping",
        "--timeout",
        "2",
      ];
      await assert.rejects(
        () => run([...args, "--if-busy", "fail"]),
        (error) => {
          assert.equal(error.code, 1);
          const result = JSON.parse(error.stdout);
          assert.equal(result.ok, false);
          assert.match(result.error, /target busy/);
          return true;
        },
      );
      const result = await run([...args, "--if-busy", "steer"]);
      assert.equal(result.done, true);
      assert.equal(result.steered, true);
      assert.equal(result.ifBusy, "steer");
      assert.equal(result.turnId, "active-turn-ws-1");
    },
  );
});

test("Codex UDS CLI reports notification errors and exits without pending timers", async () => {
  await withCodexCliFixture(
    { FAKE_MODE: "error-notification" },
    async ({ run }) => {
      await assert.rejects(
        () =>
          run([
            "ask",
            "--cli",
            "codex",
            "--transport",
            "uds",
            "--thread",
            "fake-thread-ws",
            "--prompt",
            "ping",
            "--timeout",
            "60",
          ]),
        (error) => {
          assert.equal(error.code, 1);
          const result = JSON.parse(error.stdout);
          assert.equal(result.ok, false);
          assert.match(result.error, /fake turn error/);
          return true;
        },
      );
    },
  );
});

test("peer participates over existing Codex UDS threads on both sides", async () => {
  await withCodexCliFixture(
    { FAKE_DELTAS: "PONG\n<<<TFX_PEER_HOP_DONE>>>" },
    async ({ run }) => {
      const result = await run([
        "peer",
        "--cli-a",
        "codex",
        "--cli-b",
        "codex",
        "--transport-a",
        "uds",
        "--transport-b",
        "uds",
        "--thread-a",
        "fake-thread-ws",
        "--thread-b",
        "auto",
        "--codex-socket-a",
        "default",
        "--codex-socket-b",
        "default",
        "--rounds",
        "1",
        "--mode",
        "freeform",
        "--seed",
        "review",
        "--timeout",
        "2",
      ]);
      assert.equal(result.attachedA, true);
      assert.equal(result.attachedB, true);
      assert.equal(result.stoppedA, false);
      assert.equal(result.stoppedB, false);
      assert.equal(result.hops.length, 2);
      assert.ok(
        result.hops.every((hop) => hop.transport === "uds" && hop.done),
      );
      assert.equal(result.hops[0].response, "PONG");
      assert.equal(
        result.hops[1].sent.split("<<<TFX_PEER_HOP_DONE>>>").length - 1,
        1,
        "only the current hop's instruction may carry the marker",
      );
    },
  );
});

test("buildTmuxCommand preserves pane targets locally and quotes remote targets", () => {
  const args = ["capture-pane", "-p", "-t", "work:2.3"];
  assert.deepEqual(buildTmuxCommand(null, args), {
    command: "tmux",
    args,
  });
  assert.deepEqual(buildTmuxCommand("remote-host", args), {
    command: "ssh",
    args: [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "remote-host",
      "tmux capture-pane -p -t work:2.3",
    ],
  });
  const quoted = buildTmuxCommand("remote-host", [
    "send-keys",
    "-t",
    "work space's:2.3",
    "Escape",
  ]);
  assert.equal(
    quoted.args.at(-1),
    `tmux send-keys -t 'work space'"'"'s:2.3' Escape`,
  );
});

test("remote ask preserves the pane target and busy policy", () => {
  const plan = buildRemoteLiveCommand(
    "remote-host",
    "ask",
    {
      session: "work:2.3",
      prompt: "review",
      transport: "auto",
      short: "facefeed",
      ifBusy: "fail",
      busyTimeoutMs: 2000,
      timeoutMs: 7000,
    },
    { os: "linux", shell: "bash" },
  );
  const command = plan.args[1].replaceAll(`'\\''`, "'");
  assert.ok(command.includes("'--session' 'work:2.3'"));
  assert.ok(command.includes("'--if-busy' 'fail'"));
  assert.ok(command.includes("'--busy-timeout' '2'"));
});

test("remote Codex UDS ask forwards its thread and socket without Claude refs", () => {
  const plan = buildRemoteLiveCommand(
    "remote-host",
    "ask",
    {
      cli: "codex",
      transport: "uds",
      threadId: "thread-1",
      codexSocket: "/tmp/shared daemon.sock",
      cwd: "/tmp/work tree",
      prompt: "review",
      ifBusy: "steer",
      busyTimeoutMs: 2000,
      timeoutMs: 7000,
    },
    { os: "darwin", shell: "zsh" },
  );
  const command = plan.args[1].replaceAll(`'\\''`, "'");
  assert.ok(command.includes("'--cli' 'codex'"));
  assert.ok(command.includes("'--thread' 'thread-1'"));
  assert.ok(command.includes("'--codex-socket' '/tmp/shared daemon.sock'"));
  assert.ok(command.includes("'--cwd' '/tmp/work tree'"));
  assert.ok(command.includes("'--if-busy' 'steer'"));
  assert.ok(!command.includes("--short"));
  assert.ok(!command.includes("--session-id"));
});

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
