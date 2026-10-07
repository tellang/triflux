import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import * as tfxLive from "../../bin/tfx-live.mjs";

const { ADAPTERS, buildLaunchKeys } = tfxLive;

const execFileAsync = promisify(execFile);
const CLI = path.resolve("bin/tfx-live.mjs");
const PEER_HOP_DONE_MARKER = "<<<TFX_PEER_HOP_DONE>>>";

test("tmux target split and buffer name preserve pane targeting safely", () => {
  assert.deepEqual(tfxLive.splitTmuxTarget("team:2.3"), {
    session: "team",
    target: "team:2.3",
  });
  assert.deepEqual(tfxLive.splitTmuxTarget("team"), {
    session: "team",
    target: "team",
  });
  assert.throws(() => tfxLive.splitTmuxTarget(":2.3"), /session name/);
  assert.match(
    tfxLive.tmuxBufferName("team:2.3"),
    /^tfx-live-prompt-team_2_3-\d+$/,
  );
});

test("Codex loading screen blocks readiness and timestamp lines leave responses", () => {
  assert.equal(tfxLive.isCodexLoadingCapture("model: loading\n›"), true);
  assert.equal(
    tfxLive.isCodexLoadingCapture("\u001b[32m│ model: loading │\u001b[0m\n›"),
    true,
  );
  assert.equal(
    ADAPTERS.codex.isReady("\u001b[32m│ model: loading │\u001b[0m\n›"),
    false,
  );
  assert.equal(
    tfxLive.isCodexLoadingCapture(
      "model: loading\nold scrollback\nmodel: gpt-6.1-sol\n›",
    ),
    false,
  );
  assert.equal(
    tfxLive.isCodexLoadingCapture(
      "model: gpt-6.1-sol\nold scrollback\nmodel: loading\n›",
    ),
    true,
  );
  assert.equal(
    tfxLive.extractAssistantResponse(
      ADAPTERS.codex,
      "• TMUX-OK\n\n  10:36 PM\n›",
    ),
    "TMUX-OK",
  );
  assert.equal(
    tfxLive.extractAssistantResponse(ADAPTERS.codex, "• 확인\n오후 10:36\n›"),
    "확인",
  );
  assert.equal(
    tfxLive.extractAssistantResponse(
      ADAPTERS.codex,
      "• 일정\n09:00\n다음 단계\n10:36 PM\n›",
    ),
    "일정\n09:00\n다음 단계",
  );
  assert.equal(
    tfxLive.extractResponseSinceMarker({
      beforeRaw: "›",
      raw: `› hello\n• TMUX-OK\n  10:36 PM\n오후 10:36\n${PEER_HOP_DONE_MARKER}\n›`,
      doneMarker: PEER_HOP_DONE_MARKER,
      adapter: ADAPTERS.codex,
    }),
    "TMUX-OK",
  );
});

test("empty tmux session target fails before ask or interrupt", async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "tfx-live-empty-target-"),
  );
  try {
    await writeLoggingFakeTmux(dir);
    const logPath = path.join(dir, "tmux-log.jsonl");
    for (const verb of ["ask", "interrupt"]) {
      await assert.rejects(
        runTfxLive(
          [
            verb,
            "--session",
            ":0.1",
            ...(verb === "ask" ? ["--prompt", "hi"] : []),
          ],
          {
            env: {
              PATH: `${dir}${path.delimiter}${process.env.PATH}`,
              TMUX_LOG: logPath,
            },
          },
        ),
        (error) => {
          assert.match(JSON.parse(error.stdout).error, /session name/);
          return true;
        },
      );
    }
    assert.deepEqual(await readTmuxLog(logPath), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("start and stop reject pane targets before invoking tmux", async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "tfx-live-session-only-"),
  );
  try {
    await writeLoggingFakeTmux(dir);
    const logPath = path.join(dir, "tmux-log.jsonl");
    for (const [verb, target] of [
      ["start", "shared:0.1"],
      ["stop", "shared:0.1"],
      ["stop", "%12"],
      ["stop", "@3"],
      ["stop", "shared.name"],
    ]) {
      await assert.rejects(
        runTfxLive([verb, "--session", target], {
          env: {
            PATH: `${dir}${path.delimiter}${process.env.PATH}`,
            TMUX_LOG: logPath,
          },
        }),
        (error) => {
          assert.match(JSON.parse(error.stdout).error, /session name/);
          return true;
        },
      );
    }
    assert.deepEqual(await readTmuxLog(logPath), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("peer attach fails preflight without starting or stopping tmux sessions", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-live-attach-"));
  try {
    const logPath = path.join(dir, "tmux-log.jsonl");
    const tmuxPath = path.join(dir, "tmux");
    await fs.writeFile(
      tmuxPath,
      [
        "#!/usr/bin/env node",
        "import fs from 'node:fs';",
        "fs.appendFileSync(process.env.TMUX_LOG, `${JSON.stringify(process.argv.slice(2))}\\n`);",
        "process.exit(1);",
      ].join("\n"),
    );
    await fs.chmod(tmuxPath, 0o755);
    const output = JSON.parse(
      await runTfxLive(
        [
          "peer",
          "--attach-a",
          "--cli-a",
          "codex",
          "--session-a",
          "missing:0.1",
          "--cli-b",
          "claude",
          "--transport-b",
          "uds",
          "--short-b",
          "bbbbbbbb",
          "--rounds",
          "1",
        ],
        {
          env: {
            PATH: `${dir}${path.delimiter}${process.env.PATH}`,
            TMUX_LOG: logPath,
            TFX_LIVE_ARTIFACT_DIR: dir,
          },
        },
      ),
    );
    const log = await readTmuxLog(logPath);
    assert.equal(output.attachedA, true);
    assert.match(output.error, /attached codex session not found/);
    assert.deepEqual(log, [["has-session", "-t", "missing"]]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("peer attach reuses tmux sessions and never starts or stops them", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-live-attach-ok-"));
  try {
    await writeReadyFakeTmux(dir);
    const logPath = path.join(dir, "tmux-log.jsonl");
    const statePath = path.join(dir, "tmux-state.json");
    const output = JSON.parse(
      await runTfxLive(
        [
          "peer",
          "--cli-a",
          "codex",
          "--cli-b",
          "claude",
          "--session-a",
          "attachedA",
          "--session-b",
          "attachedB",
          "--attach-a",
          "--attach-b",
          "--rounds",
          "1",
          "--mode",
          "counting",
          "--timeout",
          "1",
          "--settle",
          "1",
          "--poll-interval",
          "1",
        ],
        {
          env: {
            PATH: `${dir}${path.delimiter}${process.env.PATH}`,
            TMUX_LOG: logPath,
            TMUX_STATE: statePath,
            TFX_LIVE_ARTIFACT_DIR: dir,
          },
        },
      ),
    );
    const log = await readTmuxLog(logPath);
    assert.equal(output.attachedA, true);
    assert.equal(output.attachedB, true);
    assert.equal(output.stoppedA, false);
    assert.equal(output.stoppedB, false);
    assert.equal(output.hops_completed, 2);
    assert.equal(log.filter((args) => args[0] === "has-session").length, 2);
    assert.equal(
      log.filter(
        (args) =>
          args[0] === "display-message" &&
          args.at(-1).startsWith("#{pane_current_command}"),
      ).length,
      1,
    );
    assert.equal(
      log.some((args) => ["new-session", "kill-session"].includes(args[0])),
      false,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("peer attached tmux session survives SIGINT and SIGTERM", async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "tfx-live-attach-signal-"),
  );
  try {
    await writeBusyFakeTmux(dir);
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const logPath = path.join(dir, `${signal}.jsonl`);
      const statePath = path.join(dir, `${signal}.json`);
      const child = spawn(
        process.execPath,
        [
          CLI,
          "peer",
          "--cli-a",
          "codex",
          "--session-a",
          "attachedA",
          "--attach-a",
          "--cli-b",
          "claude",
          "--transport-b",
          "uds",
          "--short-b",
          "bbbbbbbb",
          "--rounds",
          "1",
          "--busy-timeout",
          "5",
          "--poll-interval",
          "10",
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            PATH: `${dir}${path.delimiter}${process.env.PATH}`,
            TMUX_LOG: logPath,
            TMUX_STATE: statePath,
            TMUX_BUSY_CAPTURES: "10000",
            TFX_LIVE_ARTIFACT_DIR: dir,
            TRIFLUX_NOTIFY_BELL: "0",
            TRIFLUX_NOTIFY_TOAST: "0",
          },
        },
      );
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      const exited = new Promise((resolve) => child.once("exit", resolve));
      const deadline = Date.now() + 3000;
      let observedCapture = false;
      while (Date.now() < deadline) {
        const log = await fs.readFile(logPath, "utf8").catch(() => "");
        if (log.includes("capture-pane")) {
          observedCapture = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(
        observedCapture,
        true,
        "attached hop did not reach busy capture",
      );
      assert.equal(child.exitCode, null);
      child.kill(signal);
      await exited;
      const output = JSON.parse(stdout);
      assert.equal(output.attachedA, true);
      assert.equal(output.stoppedA, false);
      assert.equal(output.stoppedB, false);
      const log = await readTmuxLog(logPath);
      assert.equal(
        log.some((args) => ["new-session", "kill-session"].includes(args[0])),
        false,
      );
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("peer attached tmux session survives a first-hop busy error", async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "tfx-live-attach-error-"),
  );
  try {
    await writeBusyFakeTmux(dir);
    const logPath = path.join(dir, "tmux-log.jsonl");
    const statePath = path.join(dir, "tmux-state.json");
    const output = JSON.parse(
      await runTfxLive(
        [
          "peer",
          "--cli-a",
          "codex",
          "--session-a",
          "attachedA",
          "--attach-a",
          "--cli-b",
          "claude",
          "--transport-b",
          "uds",
          "--short-b",
          "bbbbbbbb",
          "--rounds",
          "1",
          "--if-busy",
          "fail",
          "--timeout",
          "1",
        ],
        {
          env: {
            PATH: `${dir}${path.delimiter}${process.env.PATH}`,
            TMUX_LOG: logPath,
            TMUX_STATE: statePath,
            TMUX_BUSY_CAPTURES: "10000",
            TFX_LIVE_ARTIFACT_DIR: dir,
          },
        },
      ),
    );
    const log = await readTmuxLog(logPath);
    assert.equal(output.attachedA, true);
    assert.equal(output.stoppedA, false);
    assert.equal(output.stoppedB, false);
    assert.equal(output.hops_completed, 0);
    assert.match(output.error, /target busy/);
    assert.equal(
      log.some((args) =>
        ["new-session", "kill-session", "set-buffer"].includes(args[0]),
      ),
      false,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Codex daemon default socket follows CODEX_HOME symlink and rejects missing socket", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-live-socket-"));
  const oldCodexHome = process.env.CODEX_HOME;
  const actualSocket = path.join(dir, "actual.sock");
  const controlDir = path.join(dir, "codex-home", "app-server-control");
  await fs.mkdir(controlDir, { recursive: true });
  const server = net.createServer();
  try {
    await new Promise((resolve) => server.listen(actualSocket, resolve));
    await fs.symlink(
      actualSocket,
      path.join(controlDir, "app-server-control.sock"),
    );
    process.env.CODEX_HOME = path.join(dir, "codex-home");
    assert.equal(
      tfxLive.resolveCodexDaemonSocket("default"),
      path.join(controlDir, "app-server-control.sock"),
    );
    assert.throws(
      () => tfxLive.resolveCodexDaemonSocket(path.join(dir, "missing.sock")),
      /codex app-server daemon start/,
    );
  } finally {
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("orchestrate rejects explicit exec transport with a Codex socket", async () => {
  await assert.rejects(
    runTfxLive([
      "orchestrate",
      "--task",
      "test",
      "--codex-transport",
      "exec",
      "--codex-socket",
      "default",
    ]),
    (error) => {
      assert.match(
        JSON.parse(error.stdout).error,
        /conflicts with --codex-transport exec/,
      );
      return true;
    },
  );
});

async function runTfxLive(args, options = {}) {
  const { env: extraEnv, cli, ...execOptions } = options;
  const artifactDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "tfx-live-test-artifacts-"),
  );
  try {
    const result = await execFileAsync(
      process.execPath,
      [cli || CLI, ...args],
      {
        timeout: 20_000,
        maxBuffer: 5 * 1024 * 1024,
        ...execOptions,
        env: {
          ...process.env,
          TRIFLUX_NOTIFY_BELL: "0",
          TRIFLUX_NOTIFY_TOAST: "0",
          TFX_LIVE_ARTIFACT_DIR: artifactDir,
          TFX_CODEX_SESSION_REGISTRY_DIR: path.join(
            artifactDir,
            "codex-registry",
          ),
          TFX_CLAUDE_SESSIONS_DIR: path.join(artifactDir, "claude-sessions"),
          CODEX_HOME: path.join(artifactDir, "codex-home"),
          ...(extraEnv || {}),
        },
      },
    );
    return result.stdout;
  } finally {
    await fs.rm(artifactDir, { recursive: true, force: true });
  }
}

async function writeFakeBridge(dir, handlersSource) {
  const bridgePath = path.join(dir, "fake-bridge.mjs");
  await fs.writeFile(
    bridgePath,
    [
      "#!/usr/bin/env node",
      "import fs from 'node:fs/promises';",
      "const [,, verb] = process.argv;",
      "const payloadIndex = process.argv.indexOf('--payload');",
      "const payloadFileIndex = process.argv.indexOf('--payload-file');",
      "let payload = {};",
      "if (payloadIndex >= 0) payload = JSON.parse(process.argv[payloadIndex + 1]);",
      "if (payloadFileIndex >= 0) payload = JSON.parse(await fs.readFile(process.argv[payloadFileIndex + 1], 'utf8'));",
      "const logPath = process.env.FAKE_BRIDGE_LOG;",
      "const prior = logPath ? JSON.parse(await fs.readFile(logPath, 'utf8').catch(() => '[]')) : [];",
      "prior.push({ verb, payload });",
      "if (logPath) await fs.writeFile(logPath, JSON.stringify(prior));",
      handlersSource,
    ].join("\n"),
    "utf8",
  );
  await fs.chmod(bridgePath, 0o755);
  return bridgePath;
}

async function writeReadyFakeTmux(dir) {
  const tmuxPath = path.join(dir, "tmux");
  await fs.writeFile(
    tmuxPath,
    [
      "#!/usr/bin/env node",
      "import fs from 'node:fs';",
      "const args = process.argv.slice(2);",
      "fs.appendFileSync(process.env.TMUX_LOG, `${JSON.stringify(args)}\\n`);",
      "const statePath = process.env.TMUX_STATE;",
      "const state = JSON.parse(fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '{}');",
      "state.buffers ||= {};",
      "state.sessions ||= {};",
      "if (args[0] === 'display-message') console.log('codex\\tcodex');",
      "if (args[0] === 'set-buffer') {",
      "  const bufferName = args[args.indexOf('-b') + 1];",
      "  state.buffers[bufferName] = args[args.indexOf('--') + 1];",
      "  fs.writeFileSync(statePath, JSON.stringify(state));",
      "}",
      "if (args[0] === 'show-buffer') process.stdout.write(state.buffers ? state.buffers[args[args.indexOf('-b') + 1]] : state.buffer);",
      "if (args[0] === 'paste-buffer') {",
      "  const bufferName = args[args.indexOf('-b') + 1];",
      "  const target = args[args.indexOf('-t') + 1];",
      "  state.sessions[target] = { prompt: state.buffers[bufferName], enterCount: 0, submitted: false };",
      "  if (args.includes('-d')) delete state.buffers[bufferName];",
      "  fs.writeFileSync(statePath, JSON.stringify(state));",
      "}",
      "if (args[0] === 'send-keys' && args[3] === '--') {",
      "  state.sessions[args[2]] = { prompt: args[4], enterCount: 0, submitted: false };",
      "  fs.writeFileSync(statePath, JSON.stringify(state));",
      "}",
      "if (args[0] === 'send-keys' && args.length === 4 && args[3] === 'Enter') {",
      "  const session = state.sessions[args[2]];",
      "  if (session?.prompt) {",
      "    session.enterCount += 1;",
      "    const submitAfter = Number(process.env.TMUX_SUBMIT_AFTER_ENTERS || '1');",
      "    session.submitted = process.env.TMUX_NEVER_SUBMIT !== '1' && session.enterCount >= submitAfter;",
      "  }",
      "  fs.writeFileSync(statePath, JSON.stringify(state));",
      "}",
      "if (args[0] === 'capture-pane') {",
      "  const target = args[args.indexOf('-t') + 1];",
      "  const session = state.sessions[target];",
      "  if (session?.submitted) {",
      "    const composer = target.endsWith('B') ? '❯' : '›';",
      "    if (process.env.TMUX_LONG_RESPONSE === '1') {",
      "      const renderedPrompt = process.env.TMUX_HARD_WRAPPED_PROMPT === '1' ? `${composer} Count from 1 to 40, one number per line, then output the word FINISHED on the\\n  last line.` : `${composer} ${session.prompt}`;",
      "      const history = `${renderedPrompt}\\n\\n• 1\\n2\\n3\\n4\\n5\\n6\\n7\\n8\\n9\\n10\\n11\\n12\\n13\\n14\\n15\\n16\\n17\\n18\\n19\\n20\\n21\\n22\\n23\\n24\\n25\\n26\\n27\\n28\\n29\\n30\\n31\\n32\\n33\\n34\\n35\\n36\\n37\\n38\\n39\\n40\\nFINISHED\\n${composer}`;",
      "      const visible = process.env.TMUX_HARD_WRAPPED_PROMPT === '1' ? composer : `36\\n37\\n38\\n39\\n40\\nFINISHED\\n${composer}`;",
      "      console.log(args.includes('-S') ? history : visible);",
      "    } else {",
      "    const echoedPrompt = process.env.TMUX_ECHO_SUBMITTED_PROMPT === '1' ? `${composer} ${session.prompt}\\n\\n` : '';",
      `    const completed = target.endsWith('A') ? '• 1\\n${PEER_HOP_DONE_MARKER}\\n›' : '⏺ 2\\n${PEER_HOP_DONE_MARKER}\\n❯\\nCTX:0/100 (0%)';`,
      "    console.log(`${echoedPrompt}${completed}`);",
      "    }",
      "  } else if (session?.prompt) {",
      "    console.log(`${target.endsWith('B') ? '❯' : '›'} ${session.prompt}`);",
      "  } else {",
      "    console.log(target.endsWith('B') ? '❯\\nCTX:0/100 (0%)' : '›');",
      "  }",
      "}",
    ].join("\n"),
    "utf8",
  );
  await fs.chmod(tmuxPath, 0o755);
  return tmuxPath;
}

async function writeBusyFakeTmux(dir) {
  const tmuxPath = path.join(dir, "tmux");
  await fs.writeFile(
    tmuxPath,
    [
      "#!/usr/bin/env node",
      "import fs from 'node:fs';",
      "const args = process.argv.slice(2);",
      "fs.appendFileSync(process.env.TMUX_LOG, `${JSON.stringify(args)}\\n`);",
      "const file = process.env.TMUX_STATE;",
      "const state = JSON.parse(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '{}');",
      "if (args[0] === 'display-message') console.log('codex\\tcodex');",
      "if (args[0] === 'set-buffer') state.buffer = args[args.indexOf('--') + 1];",
      "if (args[0] === 'show-buffer') process.stdout.write(state.buffer);",
      "if (args[0] === 'capture-pane') {",
      "  if (!args.includes('-S')) state.visible = (state.visible || 0) + 1;",
      "  if (!args.includes('-S') && !state.sent && state.visible > Number(process.env.TMUX_BUSY_CAPTURES || '0') && process.env.TMUX_IDLE_DELAY_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.TMUX_IDLE_DELAY_MS));",
      "  if (process.env.TMUX_READY_FIRST_CAPTURE === '1' && state.visible === 1) console.log('›');",
      "  else if (!state.sent && !state.interrupted && state.visible <= Number(process.env.TMUX_BUSY_CAPTURES || '0')) console.log(process.env.TMUX_BUSY_TEXT || '• Working (0s • esc to interrupt)\\n›');",
      "  else if (state.sent) console.log(`› hello\\n• DONE\\n<<<TFX_PEER_HOP_DONE>>>\\n›`);",
      "  else console.log('›');",
      "}",
      "if (args[0] === 'send-keys' && args.at(-1) === 'Escape') state.interrupted = true;",
      "if (args[0] === 'send-keys' && args.at(-1) === 'Enter') { state.enters = (state.enters || 0) + 1; if (process.env.TMUX_IGNORE_FIRST_ENTER !== '1' || state.enters > 1) state.sent = true; }",
      "fs.writeFileSync(file, JSON.stringify(state));",
    ].join("\n"),
  );
  await fs.chmod(tmuxPath, 0o755);
  return tmuxPath;
}

async function writeLoggingFakeTmux(dir) {
  const tmuxPath = path.join(dir, "tmux");
  await fs.writeFile(
    tmuxPath,
    [
      "#!/usr/bin/env node",
      "import fs from 'node:fs';",
      "fs.appendFileSync(process.env.TMUX_LOG, `${JSON.stringify(process.argv.slice(2))}\\n`);",
    ].join("\n"),
  );
  await fs.chmod(tmuxPath, 0o755);
}

async function writeStaleMarkerFakeTmux(dir) {
  const tmuxPath = path.join(dir, "tmux");
  await fs.writeFile(
    tmuxPath,
    [
      "#!/usr/bin/env node",
      "import fs from 'node:fs';",
      "const args = process.argv.slice(2);",
      "fs.appendFileSync(process.env.TMUX_LOG, `${JSON.stringify(args)}\\n`);",
      "const statePath = process.env.TMUX_STATE;",
      "const state = JSON.parse(fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '{}');",
      "if (args[0] === 'set-buffer') {",
      "  state.buffer = args[args.indexOf('--') + 1];",
      "}",
      "if (args[0] === 'show-buffer') process.stdout.write(state.buffers ? state.buffers[args[args.indexOf('-b') + 1]] : state.buffer);",
      "if (args[0] === 'paste-buffer') {",
      "  state.prompt = state.buffer;",
      "}",
      "if (args[0] === 'send-keys' && args.length === 4 && args[3] === 'Enter') {",
      "  state.submitted = true;",
      "}",
      "if (args[0] === 'capture-pane') {",
      "  if (!state.submitted) {",
      `    console.log('• 이전 응답\\n${PEER_HOP_DONE_MARKER}\\n›');`,
      "  } else {",
      "    state.captureCount = (state.captureCount || 0) + 1;",
      "    if (state.captureCount >= 4) {",
      `      console.log('• 새 응답\\n${PEER_HOP_DONE_MARKER}\\n›');`,
      "    } else {",
      `      console.log('• 이전 응답\\n${PEER_HOP_DONE_MARKER}\\n• Working (0s • esc to interrupt)\\n›');`,
      "    }",
      "  }",
      "}",
      "fs.writeFileSync(statePath, JSON.stringify(state));",
    ].join("\n"),
    "utf8",
  );
  await fs.chmod(tmuxPath, 0o755);
  return tmuxPath;
}

async function readTmuxLog(logPath) {
  const content = await fs.readFile(logPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  if (!content.trim()) return [];
  return content
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("tmux busy wait, fail, and interrupt gate prompt submission", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-live-busy-"));
  try {
    await writeBusyFakeTmux(dir);
    for (const mode of ["wait", "fail", "interrupt"]) {
      const logPath = path.join(dir, `${mode}.jsonl`);
      const statePath = path.join(dir, `${mode}.json`);
      const oldPath = process.env.PATH;
      process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
      process.env.TMUX_LOG = logPath;
      process.env.TMUX_STATE = statePath;
      process.env.TMUX_BUSY_CAPTURES = mode === "wait" ? "2" : "100";
      process.env.TMUX_BUSY_TEXT = "\u001b[32m│ model: loading │\u001b[0m\n›";
      try {
        if (mode === "fail") {
          await assert.rejects(
            tfxLive.doAskViaTmux(ADAPTERS.codex, {
              session: "busy:0.1",
              prompt: "hello",
              ifBusy: mode,
              busyTimeoutMs: 100,
              timeoutMs: 100,
              settleMs: 1,
              pollIntervalMs: 1,
              doneMarker: PEER_HOP_DONE_MARKER,
            }),
            /target busy/,
          );
        } else {
          const result = await tfxLive.doAskViaTmux(ADAPTERS.codex, {
            session: "busy:0.1",
            prompt: "hello",
            ifBusy: mode,
            busyTimeoutMs: 1000,
            timeoutMs: 1000,
            settleMs: 1,
            pollIntervalMs: 1,
            doneMarker: PEER_HOP_DONE_MARKER,
          });
          assert.equal(result.done, true);
          assert.equal(result.ifBusy, mode);
          if (mode === "wait") {
            assert.ok(result.busyWaitedMs > 0);
            assert.ok(
              (await readTmuxLog(logPath)).filter(
                (args) => args[0] === "capture-pane" && !args.includes("-S"),
              ).length >= 3,
            );
          }
        }
      } finally {
        process.env.PATH = oldPath;
        delete process.env.TMUX_LOG;
        delete process.env.TMUX_STATE;
        delete process.env.TMUX_BUSY_CAPTURES;
        delete process.env.TMUX_BUSY_TEXT;
      }
      const log = await readTmuxLog(logPath);
      assert.equal(
        log.some((args) => args[0] === "set-buffer"),
        mode !== "fail",
      );
      assert.equal(
        log.some((args) => args[0] === "send-keys" && args.at(-1) === "Escape"),
        mode === "interrupt",
      );
      for (const args of log.filter((entry) =>
        ["capture-pane", "paste-buffer", "send-keys"].includes(entry[0]),
      )) {
        assert.equal(args[args.indexOf("-t") + 1], "busy:0.1");
      }
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("CLI ask applies tmux busy policy before sending the prompt", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-live-cli-busy-"));
  try {
    await writeBusyFakeTmux(dir);
    for (const mode of ["wait", "fail", "interrupt"]) {
      const logPath = path.join(dir, `${mode}.jsonl`);
      const env = {
        PATH: `${dir}${path.delimiter}${process.env.PATH}`,
        TMUX_LOG: logPath,
        TMUX_STATE: path.join(dir, `${mode}.json`),
        TMUX_BUSY_CAPTURES: mode === "wait" ? "1" : "100",
      };
      const args = [
        "ask",
        "--cli",
        "codex",
        "--session",
        "busy:0.1",
        "--prompt",
        "hello",
        "--if-busy",
        mode,
        "--busy-timeout",
        "4",
        "--timeout",
        "1",
        "--settle",
        "1",
        "--poll-interval",
        "1",
      ];
      if (mode === "fail") {
        await assert.rejects(runTfxLive(args, { env }), (error) => {
          assert.match(
            JSON.parse(error.stdout).error,
            /target busy \(--if-busy fail\)/,
          );
          return true;
        });
      } else {
        const result = JSON.parse(await runTfxLive(args, { env }));
        assert.equal(result.ifBusy, mode);
      }
      const log = await readTmuxLog(logPath);
      assert.equal(
        log.some((entry) => entry[0] === "set-buffer"),
        mode !== "fail",
      );
      assert.equal(
        log.some(
          (entry) => entry[0] === "send-keys" && entry.at(-1) === "Escape",
        ),
        mode === "interrupt",
      );
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("converse and goal-driven forward tmux busy policy to each ask", async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "tfx-live-workflow-busy-"),
  );
  try {
    await writeBusyFakeTmux(dir);
    const promptsPath = path.join(dir, "prompts.txt");
    await fs.writeFile(promptsPath, "one prompt\n");
    for (const verb of ["converse", "goal-driven"]) {
      const logPath = path.join(dir, `${verb}.jsonl`);
      const args = [
        verb,
        "--cli",
        "codex",
        "--session",
        `${verb}A`,
        "--if-busy",
        "fail",
        "--ready-timeout",
        "1",
        "--busy-timeout",
        "1",
        "--timeout",
        "0.2",
        "--poll-interval",
        "1",
        ...(verb === "converse"
          ? ["--prompts-file", promptsPath]
          : ["--goal", "finish", "--max-rounds", "1"]),
      ];
      await assert.rejects(
        runTfxLive(args, {
          env: {
            PATH: `${dir}${path.delimiter}${process.env.PATH}`,
            TMUX_LOG: logPath,
            TMUX_STATE: path.join(dir, `${verb}.json`),
            TMUX_READY_FIRST_CAPTURE: "1",
            TMUX_IGNORE_FIRST_ENTER: "1",
            TMUX_BUSY_CAPTURES: "100",
          },
        }),
        (error) => {
          assert.match(
            JSON.parse(error.stdout).error,
            /target busy \(--if-busy fail\)/,
          );
          return true;
        },
      );
      const log = await readTmuxLog(logPath);
      assert.equal(
        log.some((entry) => entry[0] === "set-buffer"),
        false,
      );
      assert.equal(
        log.some((entry) => entry[0] === "kill-session"),
        true,
      );
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("tmux busy wait uses the final idle capture even when it finishes after deadline", async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "tfx-live-busy-deadline-"),
  );
  const old = {
    PATH: process.env.PATH,
    TMUX_LOG: process.env.TMUX_LOG,
    TMUX_STATE: process.env.TMUX_STATE,
    TMUX_BUSY_CAPTURES: process.env.TMUX_BUSY_CAPTURES,
    TMUX_IDLE_DELAY_MS: process.env.TMUX_IDLE_DELAY_MS,
  };
  try {
    await writeBusyFakeTmux(dir);
    const logPath = path.join(dir, "tmux-log.jsonl");
    process.env.PATH = `${dir}${path.delimiter}${old.PATH}`;
    process.env.TMUX_LOG = logPath;
    process.env.TMUX_STATE = path.join(dir, "state.json");
    process.env.TMUX_BUSY_CAPTURES = "1";
    process.env.TMUX_IDLE_DELAY_MS = "1100";
    const result = await tfxLive.doAskViaTmux(ADAPTERS.codex, {
      session: "busy:0.1",
      prompt: "hello",
      ifBusy: "wait",
      busyTimeoutMs: 1000,
      timeoutMs: 1000,
      settleMs: 1,
      pollIntervalMs: 1,
    });
    assert.equal(result.ifBusy, "wait");
    assert.ok(result.busyWaitedMs >= 1000);
    const log = await readTmuxLog(logPath);
    const sentAt = log.findIndex((args) => args[0] === "set-buffer");
    assert.equal(
      log
        .slice(0, sentAt)
        .filter((args) => args[0] === "capture-pane" && !args.includes("-S"))
        .length,
      2,
    );
    assert.equal(
      log.some((args) => args[0] === "set-buffer"),
      true,
    );
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("extractResponseSinceMarker extracts only the new overlapped region", () => {
  const response = tfxLive.extractResponseSinceMarker?.({
    beforeRaw: ["old response", "›"].join("\n"),
    raw: ["old response", "›", "• 실제 답변", PEER_HOP_DONE_MARKER, "›"].join(
      "\n",
    ),
    doneMarker: PEER_HOP_DONE_MARKER,
    adapter: ADAPTERS.codex,
  });

  assert.equal(response, "실제 답변");
});

test("extractResponseSinceMarker filters interleaved status and chrome lines", () => {
  const response = tfxLive.extractResponseSinceMarker?.({
    beforeRaw: "old response",
    raw: [
      "old response",
      "• Working (1s • esc to interrupt)",
      "• 첫 문장",
      "⚠ warning",
      "Context 12% used",
      "• Starting MCP servers",
      "둘째 문장",
      PEER_HOP_DONE_MARKER,
      "›",
    ].join("\n"),
    doneMarker: PEER_HOP_DONE_MARKER,
    adapter: ADAPTERS.codex,
  });

  assert.equal(response, "첫 문장\n둘째 문장");
});

test("extractResponseSinceMarker drops wrapped prompt and warning continuations", () => {
  const response = tfxLive.extractResponseSinceMarker?.({
    beforeRaw: ["old response", "›"].join("\n"),
    raw: [
      "old response",
      "› short prompt",
      "  wrapped prompt instruction",
      "⚠ warning header",
      "  wrapped warning detail",
      "• 2",
      PEER_HOP_DONE_MARKER,
      "›",
    ].join("\n"),
    doneMarker: PEER_HOP_DONE_MARKER,
    adapter: ADAPTERS.codex,
  });

  assert.equal(response, "2");
});

test("extractResponseSinceMarker returns empty when the marker is missing", () => {
  const response = tfxLive.extractResponseSinceMarker?.({
    beforeRaw: "old response",
    raw: ["old response", "• 완료되지 않은 답변"].join("\n"),
    doneMarker: PEER_HOP_DONE_MARKER,
    adapter: ADAPTERS.codex,
  });

  assert.equal(response, "");
});

test("extractResponseSinceMarker treats raw as new when scrollback has no overlap", () => {
  const response = tfxLive.extractResponseSinceMarker?.({
    beforeRaw: ["scrolled", "away"].join("\n"),
    raw: ["› wrapped prompt", "• 새 답변", PEER_HOP_DONE_MARKER, "›"].join(
      "\n",
    ),
    doneMarker: PEER_HOP_DONE_MARKER,
    adapter: ADAPTERS.codex,
  });

  assert.equal(response, "새 답변");
});

test("doAskViaTmux stops on a done marker without quiet polls", async () => {
  assert.equal(typeof tfxLive.doAskViaTmux, "function");

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-live-marker-"));
  try {
    const logPath = path.join(dir, "tmux-log.jsonl");
    const statePath = path.join(dir, "tmux-state.json");
    await writeReadyFakeTmux(dir);

    const priorPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${priorPath}`;
    process.env.TMUX_LOG = logPath;
    process.env.TMUX_STATE = statePath;
    let result;
    try {
      result = await tfxLive.doAskViaTmux(ADAPTERS.codex, {
        session: "markerA",
        prompt: "short prompt",
        timeoutMs: 5_000,
        settleMs: 1,
        pollIntervalMs: 1_000,
        doneMarker: PEER_HOP_DONE_MARKER,
      });
    } finally {
      process.env.PATH = priorPath;
      delete process.env.TMUX_LOG;
      delete process.env.TMUX_STATE;
    }

    const log = await readTmuxLog(logPath);
    const visibleCaptures = log.filter(
      (args) => args[0] === "capture-pane" && !args.includes("-S"),
    );

    assert.equal(result.done, true);
    assert.equal(result.response, "1");
    assert.equal(visibleCaptures.length, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("doAskViaTmux completes when a long response has scrolled its marker out of view", async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "tfx-live-long-response-"),
  );
  try {
    const logPath = path.join(dir, "tmux-log.jsonl");
    const statePath = path.join(dir, "tmux-state.json");
    await writeReadyFakeTmux(dir);

    const priorPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${priorPath}`;
    process.env.TMUX_LOG = logPath;
    process.env.TMUX_STATE = statePath;
    process.env.TMUX_LONG_RESPONSE = "1";
    process.env.TMUX_HARD_WRAPPED_PROMPT = "1";
    let result;
    try {
      result = await tfxLive.doAskViaTmux(ADAPTERS.codex, {
        session: "longA",
        prompt:
          "Count from 1 to 40, one number per line, then output the word FINISHED on the last line.",
        timeoutMs: 1_000,
        settleMs: 1,
        pollIntervalMs: 1,
      });
    } finally {
      process.env.PATH = priorPath;
      delete process.env.TMUX_LOG;
      delete process.env.TMUX_STATE;
      delete process.env.TMUX_LONG_RESPONSE;
      delete process.env.TMUX_HARD_WRAPPED_PROMPT;
    }

    assert.equal(result.done, true);
    assert.equal(result.matchedCompletion, true);
    assert.match(result.response, /40\nFINISHED$/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("doAskViaTmux preserves a multiline prompt through a named tmux buffer", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-live-multiline-"));
  try {
    const logPath = path.join(dir, "tmux-log.jsonl");
    const statePath = path.join(dir, "tmux-state.json");
    await writeReadyFakeTmux(dir);
    const prompt = "첫 문장입니다.\n\n둘째 문장입니다.\n셋째 문장입니다.";

    const priorPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${priorPath}`;
    process.env.TMUX_LOG = logPath;
    process.env.TMUX_STATE = statePath;
    try {
      await tfxLive.doAskViaTmux(ADAPTERS.codex, {
        session: "multilineA",
        prompt,
        timeoutMs: 5_000,
        settleMs: 1,
        pollIntervalMs: 1,
        doneMarker: PEER_HOP_DONE_MARKER,
      });
    } finally {
      process.env.PATH = priorPath;
      delete process.env.TMUX_LOG;
      delete process.env.TMUX_STATE;
    }

    const log = await readTmuxLog(logPath);
    const setBuffer = log.find((args) => args[0] === "set-buffer");
    const pasteBuffer = log.find((args) => args[0] === "paste-buffer");

    assert.ok(setBuffer, "multiline prompt must be written with set-buffer");
    assert.equal(setBuffer[1], "-b");
    assert.match(setBuffer[2], /^tfx-live-prompt-multilineA-\d+$/);
    assert.deepEqual(setBuffer.slice(3), ["--", prompt]);
    assert.deepEqual(pasteBuffer, [
      "paste-buffer",
      "-b",
      setBuffer[2],
      "-d",
      "-p",
      "-t",
      "multilineA",
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("doAskViaTmux accepts a submitted prompt that remains in pane history", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-live-history-"));
  try {
    const logPath = path.join(dir, "tmux-log.jsonl");
    const statePath = path.join(dir, "tmux-state.json");
    await writeReadyFakeTmux(dir);

    const priorPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${priorPath}`;
    process.env.TMUX_LOG = logPath;
    process.env.TMUX_STATE = statePath;
    process.env.TMUX_ECHO_SUBMITTED_PROMPT = "1";
    let result;
    try {
      result = await tfxLive.doAskViaTmux(ADAPTERS.codex, {
        session: "historyA",
        prompt: "제출 후 history에 남는 프롬프트",
        timeoutMs: 5_000,
        settleMs: 1,
        pollIntervalMs: 1,
        doneMarker: PEER_HOP_DONE_MARKER,
      });
    } finally {
      process.env.PATH = priorPath;
      delete process.env.TMUX_LOG;
      delete process.env.TMUX_STATE;
      delete process.env.TMUX_ECHO_SUBMITTED_PROMPT;
    }

    assert.equal(result.done, true);
    assert.equal(result.response, "1");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("doAskViaTmux rejects a peer marker that remains in an unsubmitted composer", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-live-unsubmitted-"));
  try {
    const logPath = path.join(dir, "tmux-log.jsonl");
    const statePath = path.join(dir, "tmux-state.json");
    await writeReadyFakeTmux(dir);
    const prompt = ["아직 제출되지 않은 프롬프트", PEER_HOP_DONE_MARKER].join(
      "\n",
    );

    const priorPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${priorPath}`;
    process.env.TMUX_LOG = logPath;
    process.env.TMUX_STATE = statePath;
    process.env.TMUX_NEVER_SUBMIT = "1";
    try {
      await assert.rejects(
        tfxLive.doAskViaTmux(ADAPTERS.codex, {
          session: "stuckA",
          prompt,
          timeoutMs: 5_000,
          settleMs: 1,
          pollIntervalMs: 1,
          doneMarker: PEER_HOP_DONE_MARKER,
        }),
        /Prompt did not submit after 3 attempts/,
      );
    } finally {
      process.env.PATH = priorPath;
      delete process.env.TMUX_LOG;
      delete process.env.TMUX_STATE;
      delete process.env.TMUX_NEVER_SUBMIT;
    }

    const log = await readTmuxLog(logPath);
    const enterAttempts = log.filter(
      (args) =>
        args[0] === "send-keys" && args[2] === "stuckA" && args[3] === "Enter",
    );
    assert.equal(enterAttempts.length, 3);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("doAskViaTmux ignores a stale marker from a prior turn", async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "tfx-live-stale-marker-"),
  );
  try {
    const logPath = path.join(dir, "tmux-log.jsonl");
    const statePath = path.join(dir, "tmux-state.json");
    await writeStaleMarkerFakeTmux(dir);

    const priorPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${priorPath}`;
    process.env.TMUX_LOG = logPath;
    process.env.TMUX_STATE = statePath;
    let result;
    try {
      result = await tfxLive.doAskViaTmux(ADAPTERS.codex, {
        session: "staleA",
        prompt: "두 번째 turn 프롬프트",
        timeoutMs: 5_000,
        settleMs: 1,
        pollIntervalMs: 1,
        doneMarker: PEER_HOP_DONE_MARKER,
      });
    } finally {
      process.env.PATH = priorPath;
      delete process.env.TMUX_LOG;
      delete process.env.TMUX_STATE;
    }

    assert.equal(result.done, true);
    assert.equal(result.response, "새 응답");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("peer closure prompt requires a structured B-side declaration", () => {
  const prompt = tfxLive.buildPeerClosurePrompt?.("직전 응답");

  assert.equal(typeof prompt, "string");
  assert.match(prompt, /unresolved_questions/);
  assert.match(prompt, /needs_more_rounds/);
  assert.match(prompt, /agreement_status/);
  assert.match(prompt, /직전 응답/);
  assert.match(prompt, new RegExp(PEER_HOP_DONE_MARKER));
  assert.ok(
    prompt.indexOf("agreement_status") < prompt.indexOf(PEER_HOP_DONE_MARKER),
  );
});

test("peer closure parser recovers from terminal word-wrap inside compact JSON", () => {
  // Real capture: terminal wrap injected a raw newline + indent mid-token
  // ("f\n  alse") since compact JSON has no space near `false` to wrap at.
  const wrapped =
    '{"agreement_status":"complete","unresolved_questions":[],"needs_more_rounds":f\n  alse,"summary":"7×8+3 계산에서 중간값 56, 최종값 59로 구분 표기하기로\n  합의."}';

  const parsed = tfxLive.parsePeerClosure?.(wrapped);

  assert.deepEqual(parsed, {
    structured: true,
    declaredComplete: true,
    unresolvedQuestions: [],
    needsMoreRounds: false,
  });
});

test("peer closure parser accepts only resolved structured agreement", () => {
  const complete = tfxLive.parsePeerClosure?.(
    JSON.stringify({
      agreement_status: "complete",
      unresolved_questions: [],
      needs_more_rounds: false,
      summary: "합의함",
    }),
  );
  const unresolved = tfxLive.parsePeerClosure?.(
    JSON.stringify({
      agreement_status: "complete",
      unresolved_questions: ["배포 시점"],
      needs_more_rounds: false,
    }),
  );
  const malformed = tfxLive.parsePeerClosure?.(
    [
      "{broken}",
      "agreement_status: complete",
      "unresolved_questions: []",
      "needs_more_rounds: false",
    ].join("\n"),
  );
  const schemaIncomplete = tfxLive.parsePeerClosure?.(
    [
      '{"agreement_status":"complete"}',
      "agreement_status: complete",
      "unresolved_questions: []",
      "needs_more_rounds: false",
    ].join("\n"),
  );
  const markerNeedsMore = tfxLive.parsePeerClosure?.(
    [
      "agreement_status: complete",
      "unresolved_questions: []",
      "needs_more_rounds: TRUE",
    ].join("\n"),
  );

  assert.deepEqual(complete, {
    structured: true,
    declaredComplete: true,
    unresolvedQuestions: [],
    needsMoreRounds: false,
  });
  assert.equal(unresolved.structured, true);
  assert.equal(unresolved.declaredComplete, true);
  assert.deepEqual(unresolved.unresolvedQuestions, ["배포 시점"]);
  assert.equal(malformed.structured, false);
  assert.equal(
    tfxLive.derivePeerStatus?.({
      hopsCompleted: 2,
      closure: malformed,
    }),
    "partial",
  );
  assert.equal(schemaIncomplete.structured, false);
  assert.equal(
    tfxLive.derivePeerStatus?.({
      hopsCompleted: 2,
      closure: schemaIncomplete,
    }),
    "partial",
  );
  assert.equal(markerNeedsMore.needsMoreRounds, true);
  assert.equal(
    tfxLive.derivePeerStatus?.({
      hopsCompleted: 2,
      closure: markerNeedsMore,
    }),
    "partial",
  );
});

test("peer harness derives complete, partial, and failed independently", () => {
  const resolvedClosure = {
    structured: true,
    declaredComplete: true,
    unresolvedQuestions: [],
    needsMoreRounds: false,
  };

  assert.equal(
    tfxLive.derivePeerStatus?.({
      hopsCompleted: 4,
      closure: resolvedClosure,
    }),
    "complete",
  );
  assert.equal(
    tfxLive.derivePeerStatus?.({
      hopsCompleted: 3,
      closure: null,
    }),
    "partial",
  );
  assert.equal(
    tfxLive.derivePeerStatus?.({
      hopsCompleted: 4,
      closure: resolvedClosure,
      exitReason: "timeout",
    }),
    "partial",
  );
  assert.equal(
    tfxLive.derivePeerStatus?.({
      hopsCompleted: 0,
      closure: null,
    }),
    "failed",
  );
});

test("peer errors preserve timeout versus transport exit reasons", () => {
  assert.equal(
    tfxLive.classifyPeerExitReason?.(new Error("request timed out")),
    "timeout",
  );
  assert.equal(
    tfxLive.classifyPeerExitReason?.(new Error("tmux session missing")),
    "transport_error",
  );
});

test("peer signal controller persists transcript/status before stop and aborts", async () => {
  const events = [];
  const exits = [];
  const output = { hops: [{ hop: 1 }] };
  const controller = tfxLive.createPeerSignalController?.({
    output,
    timeoutMs: 50,
    persistTranscript: () => events.push("transcript"),
    persistStatus: () => events.push("status"),
    stopSessions: async () => events.push("stop"),
    printOutput: () => events.push("print"),
    exitProcess: (code) => exits.push(code),
  });

  assert.ok(controller);
  await controller.handle("SIGINT");
  assert.deepEqual(events, ["transcript", "status", "stop", "print"]);
  assert.deepEqual(exits, [130]);
  assert.equal(output.status, "aborted");
  assert.equal(output.exit_reason, "user_interrupt");
  assert.equal(output.hops_completed, 1);
});

test("peer signal controller force-exits immediately on a second signal", async () => {
  const exits = [];
  let releaseStop;
  const stopPending = new Promise((resolve) => {
    releaseStop = resolve;
  });
  const output = { hops: [] };
  const controller = tfxLive.createPeerSignalController?.({
    output,
    timeoutMs: 50,
    persistTranscript() {},
    persistStatus() {},
    stopSessions: () => stopPending,
    printOutput() {},
    exitProcess: (code) => exits.push(code),
  });

  assert.ok(controller);
  const first = controller.handle("SIGTERM");
  assert.equal(output.status, "aborted");
  assert.equal(output.exit_reason, "terminated");
  assert.equal(output.hops_completed, 0);
  await controller.handle("SIGTERM");
  assert.deepEqual(exits, [143]);
  releaseStop();
  await first;
  assert.deepEqual(exits, [143]);
});

test("peer signal controller stops waiting when the graceful window expires", async () => {
  const events = [];
  const exits = [];
  const controller = tfxLive.createPeerSignalController?.({
    output: { hops: [{ hop: 1 }] },
    persistTranscript: () => events.push("transcript"),
    persistStatus: () => events.push("status"),
    stopSessions: () => {
      events.push("stop");
      return new Promise(() => {});
    },
    printOutput: () => events.push("print"),
    exitProcess: (code) => exits.push(code),
    setTimer: (callback) => {
      callback();
      return "timer";
    },
    clearTimer: () => events.push("clear-timer"),
  });

  assert.ok(controller);
  await controller.handle("SIGINT");
  assert.deepEqual(events, [
    "transcript",
    "status",
    "stop",
    "clear-timer",
    "print",
  ]);
  assert.deepEqual(exits, [130]);
});

test("tfx-live peer replaces the final B hop with closure and persists complete status", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-live-closure-"));
  try {
    const logPath = path.join(dir, "bridge-log.json");
    const artifactDir = path.join(dir, "artifacts");
    const bridgePath = await writeFakeBridge(
      dir,
      [
        "if (verb !== 'daemon-attach') process.exit(2);",
        "const isClosure = payload.prompt.includes('unresolved_questions');",
        `const text = isClosure ? JSON.stringify({agreement_status:'complete',unresolved_questions:[],needs_more_rounds:false,summary:'done'}) : '첫 번째 제안\\n${PEER_HOP_DONE_MARKER}';`,
        "console.log(JSON.stringify({ok:true,text,raw:text,matchedCompletion:true,timedOut:false,closed:false,inputSent:true}));",
      ].join("\n"),
    );

    const result = JSON.parse(
      await runTfxLive(
        [
          "peer",
          "--cli-a",
          "claude",
          "--cli-b",
          "claude",
          "--transport-a",
          "uds",
          "--transport-b",
          "uds",
          "--short-a",
          "aaaaaaaa",
          "--short-b",
          "bbbbbbbb",
          "--bridge",
          bridgePath,
          "--mode",
          "freeform",
          "--seed",
          "설계를 합의하자",
          "--rounds",
          "1",
          "--timeout",
          "1",
        ],
        {
          env: {
            FAKE_BRIDGE_LOG: logPath,
            TFX_LIVE_ARTIFACT_DIR: artifactDir,
            TFX_CODEX_SESSION_REGISTRY_DIR: path.join(
              artifactDir,
              "codex-registry",
            ),
            TFX_CLAUDE_SESSIONS_DIR: path.join(artifactDir, "claude-sessions"),
            CODEX_HOME: path.join(artifactDir, "codex-home"),
          },
        },
      ),
    );
    const log = JSON.parse(await fs.readFile(logPath, "utf8"));
    const transcript = JSON.parse(
      await fs.readFile(result.transcript_path, "utf8"),
    );
    const status = JSON.parse(await fs.readFile(result.status_path, "utf8"));

    assert.equal(log.length, 2);
    assert.equal(log[1].payload.short, "bbbbbbbb");
    assert.match(log[0].payload.prompt, new RegExp(PEER_HOP_DONE_MARKER));
    assert.match(log[1].payload.prompt, /unresolved_questions/);
    assert.match(log[1].payload.prompt, new RegExp(PEER_HOP_DONE_MARKER));
    assert.doesNotMatch(
      log[1].payload.prompt
        .split("The other party's latest response was: ")[1]
        .split("\nAfter the JSON")[0],
      new RegExp(PEER_HOP_DONE_MARKER),
    );
    assert.equal(result.hops.length, 2);
    assert.equal(result.hops[1].from, "b");
    assert.equal(result.hops_completed, 2);
    assert.equal(result.status, "complete");
    assert.equal(result.stoppedA, false);
    assert.equal(result.stoppedB, false);
    assert.equal(transcript.hops_completed, 2);
    assert.equal(status.status, "complete");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("tfx-live peer SIGINT emits aborted output and leaves transcript/status files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-live-sigint-"));
  let child;
  try {
    const logPath = path.join(dir, "bridge-log.json");
    const artifactDir = path.join(dir, "artifacts");
    const bridgePath = await writeFakeBridge(
      dir,
      [
        "if (verb !== 'daemon-attach') process.exit(2);",
        "const isClosure = payload.prompt.includes('unresolved_questions');",
        "if (isClosure) await new Promise((resolve) => setTimeout(resolve, 1000));",
        "const text = isClosure ? '{}' : '첫 번째 제안';",
        "console.log(JSON.stringify({ok:true,text,raw:text,matchedCompletion:true,timedOut:false,closed:false,inputSent:true}));",
      ].join("\n"),
    );

    child = spawn(
      process.execPath,
      [
        CLI,
        "peer",
        "--cli-a",
        "claude",
        "--cli-b",
        "claude",
        "--transport-a",
        "uds",
        "--transport-b",
        "uds",
        "--short-a",
        "aaaaaaaa",
        "--short-b",
        "bbbbbbbb",
        "--bridge",
        bridgePath,
        "--mode",
        "freeform",
        "--seed",
        "설계를 합의하자",
        "--rounds",
        "1",
        "--timeout",
        "5",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          TRIFLUX_NOTIFY_BELL: "0",
          TRIFLUX_NOTIFY_TOAST: "0",
          FAKE_BRIDGE_LOG: logPath,
          TFX_LIVE_ARTIFACT_DIR: artifactDir,
          TFX_CODEX_SESSION_REGISTRY_DIR: path.join(
            artifactDir,
            "codex-registry",
          ),
          TFX_CLAUDE_SESSIONS_DIR: path.join(artifactDir, "claude-sessions"),
          CODEX_HOME: path.join(artifactDir, "codex-home"),
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    // 가짜 브리지는 로그를 통째로 다시 쓰므로 쓰는 도중에는 비어 있을 수 있다.
    const readEntries = () =>
      fs
        .readFile(logPath, "utf8")
        .then(JSON.parse)
        .catch(() => []);
    const deadline = Date.now() + 3000;
    let entries = [];
    while (Date.now() < deadline) {
      entries = await readEntries();
      if (entries.length >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(entries.length, 2, "closure hop did not start before SIGINT");

    child.kill("SIGINT");
    const exit = await new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const result = JSON.parse(stdout);
    const transcript = JSON.parse(
      await fs.readFile(result.transcript_path, "utf8"),
    );
    const status = JSON.parse(await fs.readFile(result.status_path, "utf8"));

    assert.deepEqual(exit, { code: 130, signal: null });
    assert.equal(stderr, "");
    assert.equal(result.status, "aborted");
    assert.equal(result.exit_reason, "user_interrupt");
    assert.equal(result.hops_completed, 1);
    assert.equal(transcript.hops_completed, 1);
    assert.equal(status.status, "aborted");
  } finally {
    if (child?.exitCode === null && child?.signalCode === null) {
      child.kill("SIGKILL");
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("buildLaunchKeys adds only a Codex model override", () => {
  assert.deepEqual(buildLaunchKeys(ADAPTERS.codex, { model: "gpt-5.6-sol" }), [
    "codex --dangerously-bypass-approvals-and-sandbox -c 'model=\"gpt-5.6-sol\"'",
    "Enter",
  ]);
});

test("buildLaunchKeys adds only a Codex effort override", () => {
  assert.deepEqual(buildLaunchKeys(ADAPTERS.codex, { effort: "xhigh" }), [
    "codex --dangerously-bypass-approvals-and-sandbox -c 'model_reasoning_effort=\"xhigh\"'",
    "Enter",
  ]);
});

test("buildLaunchKeys adds Codex model and effort overrides", () => {
  assert.deepEqual(
    buildLaunchKeys(ADAPTERS.codex, {
      model: "gpt-5.6-sol",
      effort: "xhigh",
    }),
    [
      "codex --dangerously-bypass-approvals-and-sandbox -c 'model=\"gpt-5.6-sol\"' -c 'model_reasoning_effort=\"xhigh\"'",
      "Enter",
    ],
  );
});

test("buildLaunchKeys preserves Codex launchKeys when no override is set", () => {
  assert.strictEqual(
    buildLaunchKeys(ADAPTERS.codex, {}),
    ADAPTERS.codex.launchKeys,
  );
});

test("buildLaunchKeys shell-quotes a Codex override containing spaces", () => {
  assert.deepEqual(
    buildLaunchKeys(ADAPTERS.codex, {
      model: "custom model; echo injected",
    }),
    [
      "codex --dangerously-bypass-approvals-and-sandbox -c 'model=\"custom model; echo injected\"'",
      "Enter",
    ],
  );
});

test("buildLaunchKeys adds only a Claude model override", () => {
  assert.deepEqual(
    buildLaunchKeys(ADAPTERS.claude, { model: "claude-opus-4-1" }),
    [
      "DISABLE_OMC=1 OMC_SKIP_HOOKS=all TFX_SKIP_HOOKS=1 claude --model claude-opus-4-1",
      "Enter",
    ],
  );
});

test("buildLaunchKeys adds only a Claude effort override", () => {
  assert.deepEqual(buildLaunchKeys(ADAPTERS.claude, { effort: "high" }), [
    "DISABLE_OMC=1 OMC_SKIP_HOOKS=all TFX_SKIP_HOOKS=1 claude --effort high",
    "Enter",
  ]);
});

test("buildLaunchKeys adds Claude model and effort overrides", () => {
  assert.deepEqual(
    buildLaunchKeys(ADAPTERS.claude, {
      model: "claude-opus-4-1",
      effort: "high",
    }),
    [
      "DISABLE_OMC=1 OMC_SKIP_HOOKS=all TFX_SKIP_HOOKS=1 claude --model claude-opus-4-1 --effort high",
      "Enter",
    ],
  );
});

test("buildLaunchKeys preserves Claude launchKeys when no override is set", () => {
  assert.strictEqual(
    buildLaunchKeys(ADAPTERS.claude, {}),
    ADAPTERS.claude.launchKeys,
  );
});

test("buildLaunchKeys shell-quotes a Claude override containing spaces", () => {
  assert.deepEqual(
    buildLaunchKeys(ADAPTERS.claude, {
      model: "custom model; echo injected",
    }),
    [
      "DISABLE_OMC=1 OMC_SKIP_HOOKS=all TFX_SKIP_HOOKS=1 claude --model 'custom model; echo injected'",
      "Enter",
    ],
  );
});

test("tfx-live start maps generic model and effort flags into launch keys", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-live-start-flags-"));
  try {
    const logPath = path.join(dir, "tmux-log.jsonl");
    const statePath = path.join(dir, "tmux-state.json");
    await writeReadyFakeTmux(dir);

    const result = JSON.parse(
      await runTfxLive(
        [
          "start",
          "--cli",
          "codex",
          "--session",
          "start-codex",
          "--model",
          "custom model",
          "--effort",
          "xhigh",
          "--ready-timeout",
          "0.2",
          "--poll-interval",
          "1",
        ],
        {
          env: {
            PATH: `${dir}${path.delimiter}${process.env.PATH}`,
            TMUX_LOG: logPath,
            TMUX_STATE: statePath,
          },
        },
      ),
    );
    const log = await readTmuxLog(logPath);
    const launch = log.find(
      (args) =>
        args[0] === "send-keys" &&
        args[2] === "start-codex" &&
        args.length === 5,
    );

    assert.equal(result.ready, true);
    assert.equal(result.nameGenerated, true);
    assert.match(result.name, /^\d{1,2}\.\d{1,2} start-codex$/);
    assert.equal(result.nameApplied, false);
    assert.ok(log.some((args) => args.includes(`/rename ${result.name}`)));
    assert.deepEqual(launch, [
      "send-keys",
      "-t",
      "start-codex",
      "codex --dangerously-bypass-approvals-and-sandbox -c 'model=\"custom model\"' -c 'model_reasoning_effort=\"xhigh\"'",
      "Enter",
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("tfx-live start keeps resume launch keys ahead of model overrides", async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "tfx-live-resume-flags-"),
  );
  try {
    const logPath = path.join(dir, "tmux-log.jsonl");
    const statePath = path.join(dir, "tmux-state.json");
    await writeReadyFakeTmux(dir);

    await runTfxLive(
      [
        "start",
        "--cli",
        "codex",
        "--session",
        "resume-codex",
        "--resume",
        "resume id",
        "--model",
        "ignored model",
        "--effort",
        "xhigh",
        "--ready-timeout",
        "0.2",
        "--poll-interval",
        "1",
      ],
      {
        env: {
          PATH: `${dir}${path.delimiter}${process.env.PATH}`,
          TMUX_LOG: logPath,
          TMUX_STATE: statePath,
        },
      },
    );
    const log = await readTmuxLog(logPath);
    const launch = log.find(
      (args) =>
        args[0] === "send-keys" &&
        args[2] === "resume-codex" &&
        args.length === 5,
    );

    assert.equal(
      log.some((args) => args.some((arg) => arg.startsWith("/rename "))),
      false,
    );
    assert.deepEqual(launch, [
      "send-keys",
      "-t",
      "resume-codex",
      "codex resume 'resume id' --dangerously-bypass-approvals-and-sandbox",
      "Enter",
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("tfx-live peer maps side-specific model and effort flags", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-live-peer-flags-"));
  try {
    const logPath = path.join(dir, "tmux-log.jsonl");
    const statePath = path.join(dir, "tmux-state.json");
    await writeReadyFakeTmux(dir);

    const result = JSON.parse(
      await runTfxLive(
        [
          "peer",
          "--session-a",
          "peerA",
          "--session-b",
          "peerB",
          "--model-a",
          "codex model",
          "--effort-a",
          "xhigh",
          "--model-b",
          "claude model",
          "--effort-b",
          "high",
          "--rounds",
          "1",
          "--timeout",
          "0.2",
          "--ready-timeout",
          "0.2",
          "--settle",
          "1",
          "--poll-interval",
          "1",
        ],
        {
          env: {
            PATH: `${dir}${path.delimiter}${process.env.PATH}`,
            TMUX_LOG: logPath,
            TMUX_STATE: statePath,
          },
        },
      ),
    );
    const log = await readTmuxLog(logPath);
    const launches = log.filter(
      (args) =>
        args[0] === "send-keys" && args[3] !== "--" && args.length === 5,
    );

    assert.deepEqual(result.numbers, [1, 2]);
    assert.equal(result.stoppedA, true);
    assert.equal(result.stoppedB, true);
    assert.deepEqual(launches, [
      [
        "send-keys",
        "-t",
        "peerA",
        "codex --dangerously-bypass-approvals-and-sandbox -c 'model=\"codex model\"' -c 'model_reasoning_effort=\"xhigh\"'",
        "Enter",
      ],
      [
        "send-keys",
        "-t",
        "peerB",
        `DISABLE_OMC=1 OMC_SKIP_HOOKS=all TFX_SKIP_HOOKS=1 claude -n '${new Date().getMonth() + 1}.${new Date().getDate()} peerB' --model 'claude model' --effort high`,
        "Enter",
      ],
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("tfx-live help documents UDS-first auto default", async () => {
  const help = await runTfxLive(["ask", "--prompt", "--help"]);
  assert.match(help, /tfx-live ask/);
  assert.doesNotMatch(help, /tfx-live stop/);
  const stdout = await runTfxLive(["--help"]);

  assert.match(stdout, /tfx-live start .*\[--model ID\] \[--effort TIER\]/);
  assert.match(stdout, /tfx-live ask/);
  assert.match(stdout, /tfx-live interrupt/);
  assert.match(stdout, /tfx-live probe/);
  assert.match(
    stdout,
    /tfx-live peer .*\[--model-a ID\] \[--model-b ID\] \[--effort-a TIER\] \[--effort-b TIER\]/,
  );
  assert.match(
    stdout,
    /auto is the default for Claude when --short\/--session-id is present/,
  );
});

test("tmux no-wait confirms submission and reports submitted without waiting for an answer", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-send-"));
  try {
    await writeReadyFakeTmux(dir);
    const log = path.join(dir, "tmux.jsonl");
    const result = JSON.parse(
      await runTfxLive(
        [
          "ask",
          "--session",
          "sendA",
          "--prompt",
          "hello",
          "--no-wait",
          "--settle",
          "1",
        ],
        {
          env: {
            PATH: `${dir}${path.delimiter}${process.env.PATH}`,
            TMUX_LOG: log,
            TMUX_STATE: path.join(dir, "state.json"),
          },
        },
      ),
    );
    assert.equal(result.status, "submitted");
    assert.equal(result.inputSent, true);
    assert.equal(result.done, false);
    assert.equal(Object.hasOwn(result, "timedOut"), false);
    const calls = await readTmuxLog(log);
    assert.equal(
      calls.find((args) => args[0] === "set-buffer").at(-1),
      `[tfx-live req=${result.requestId}]\nhello`,
    );
    assert.equal(
      calls.some((args) => args.includes("C-u")),
      false,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("auto does not resend uncertain UDS input or bypass the context guard", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-once-"));
  try {
    const bridge = await writeFakeBridge(
      dir,
      `
if (verb === 'daemon-probe') console.log(JSON.stringify({ok:true,target:{short:'aaaa'}}));
else console.log(process.env.ATTACH_RESULT);
`,
    );
    await writeLoggingFakeTmux(dir);
    const log = path.join(dir, "tmux.jsonl");
    for (const attach of [
      { ok: false, inputSent: true, timedOut: true },
      { ok: false, error: "disconnected" },
      { ok: false, errorCode: "context-limit", inputSent: false },
    ]) {
      const result = JSON.parse(
        await runTfxLive(
          [
            "ask",
            "--cli",
            "claude",
            "--short",
            "aaaa",
            "--session",
            "fallback",
            "--bridge",
            bridge,
            "--prompt",
            "hello",
          ],
          {
            env: {
              PATH: `${dir}${path.delimiter}${process.env.PATH}`,
              TMUX_LOG: log,
              ATTACH_RESULT: JSON.stringify(attach),
            },
          },
        ),
      );
      assert.equal(
        result.errorCode ?? result.status,
        attach.errorCode ?? "unknown",
      );
    }
    assert.equal(
      (await readTmuxLog(log)).some((args) => args[0] === "set-buffer"),
      false,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("tfx-live runs main() when invoked through a symlink (npm global bin shim)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-live-symlink-"));
  try {
    const symlinkPath = path.join(dir, "tfx-live");
    await fs.symlink(CLI, symlinkPath);
    const stdout = await runTfxLive(["--help"], { cli: symlinkPath });

    assert.match(stdout, /tfx-live ask/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("tfx-live list-sessions discovers Codex tmux sessions and filters exact cwd", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-live-sessions-"));
  try {
    const codexCwd = path.join(dir, "codex-worktree");
    const otherCwd = path.join(dir, "other-worktree");
    const tmuxPath = path.join(dir, "tmux");
    const logPath = path.join(dir, "tmux-args.json");
    await fs.mkdir(codexCwd);
    await fs.mkdir(otherCwd);
    const normalizedCodexCwd = await fs.realpath(codexCwd);
    await fs.writeFile(
      tmuxPath,
      [
        "#!/usr/bin/env node",
        "import fs from 'node:fs/promises';",
        "await fs.writeFile(process.env.TMUX_LOG, JSON.stringify(process.argv.slice(2)));",
        "console.log([",
        `  'omx-live\\t1735689600\\t1\\t0\\t0\\t${codexCwd}\\tzsh\\tbash -lc \\'omx_codex_pid=123; exec codex\\'',`,
        `  'manual-codex\\t1735776000\\t0\\t1\\t2\\t${otherCwd}\\tcodex\\tcodex',`,
        `  'claude-live\\t1735862400\\t0\\t0\\t1\\t${codexCwd}\\tclaude\\tclaude',`,
        "].join('\\n'));",
      ].join("\n"),
      "utf8",
    );
    await fs.chmod(tmuxPath, 0o755);

    const env = {
      TMUX_LOG: logPath,
      PATH: `${dir}${path.delimiter}${process.env.PATH}`,
    };
    const all = JSON.parse(
      await runTfxLive(["list-sessions", "--cli", "codex"], { env }),
    );
    const filtered = JSON.parse(
      await runTfxLive(["list-sessions", "--cli", "codex", "--cwd", codexCwd], {
        env,
      }),
    );
    const tmuxArgs = JSON.parse(await fs.readFile(logPath, "utf8"));

    assert.deepEqual(tmuxArgs.slice(0, 3), ["list-panes", "-a", "-F"]);
    assert.equal(all.ok, true);
    assert.equal(all.cli, "codex");
    assert.deepEqual(
      all.sessions.map((session) => session.session),
      ["manual-codex", "omx-live"],
    );
    assert.deepEqual(all.sessions[1], {
      session: "omx-live",
      startedAt: "2025-01-01T00:00:00.000Z",
      startedAtEpoch: 1735689600,
      cwd: normalizedCodexCwd,
      attached: true,
      target: "omx-live:0.0",
      panes: [
        { target: "omx-live:0.0", cwd: normalizedCodexCwd, command: "zsh" },
      ],
    });
    assert.deepEqual(
      filtered.sessions.map((session) => session.session),
      ["omx-live"],
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("tfx-live probe returns fake daemon-probe JSON", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-live-probe-json-"));
  try {
    const logPath = path.join(dir, "bridge-log.json");
    const bridgePath = await writeFakeBridge(
      dir,
      [
        "if (verb !== 'daemon-probe') process.exit(2);",
        "console.log(JSON.stringify({ok:true,sessions:[],daemon:{status:'available'}}));",
      ].join("\n"),
    );
    const result = JSON.parse(
      await runTfxLive(
        [
          "probe",
          "--short",
          "00000000",
          "--bridge",
          bridgePath,
          "--timeout",
          "1",
        ],
        { env: { FAKE_BRIDGE_LOG: logPath } },
      ),
    );
    assert.deepEqual(result, {
      ok: true,
      sessions: [],
      daemon: { status: "available" },
    });
    assert.deepEqual(JSON.parse(await fs.readFile(logPath, "utf8")), [
      {
        verb: "daemon-probe",
        payload: { includeContext: true, short: "00000000" },
      },
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("tfx-live ask defaults Claude daemon refs to auto transport and reports fallback", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-live-bugs-"));

  try {
    const bugReportDir = path.join(dir, "reports");
    const bridgePath = await writeFakeBridge(
      dir,
      [
        "if (verb !== 'daemon-probe') process.exit(2);",
        "console.log(JSON.stringify({ok:false,reason:'daemon-unavailable',sessions:[],daemon:null,daemons:[],candidateResults:[],callerProvenance:{codexLauncher:'test'}}));",
      ].join("\n"),
    );
    const stdout = await runTfxLive(
      [
        "ask",
        "--cli",
        "claude",
        "--short",
        "00000000",
        "--prompt",
        "noop",
        "--bridge",
        bridgePath,
        "--timeout",
        "1",
      ],
      {
        env: {
          TFX_LIVE_BUG_REPORT_DIR: bugReportDir,
        },
      },
    );
    const result = JSON.parse(stdout);

    assert.equal(result.cli, "claude");
    assert.equal(result.transport, "auto");
    assert.equal(result.transportSelected, "none");
    assert.equal(result.done, false);
    assert.match(result.error, /no --session for tmux fallback/);

    const reports = await fs.readdir(bugReportDir);
    assert.equal(reports.length, 1);
    assert.match(reports[0], /^uds-fallback-/);
    const report = JSON.parse(
      await fs.readFile(path.join(bugReportDir, reports[0]), "utf8"),
    );
    assert.equal(report.kind, "uds-fallback");
    assert.equal(report.target.short, "00000000");
    assert.equal(report.bridgePath, bridgePath);
    assert.ok(Object.hasOwn(report.probe, "daemon"));
    assert.ok(Object.hasOwn(report.probe, "daemons"));
    assert.ok(Object.hasOwn(report.probe, "candidateResults"));
    assert.ok(Object.hasOwn(report.probe, "callerProvenance"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("tfx-live probe forwards --config-dir to daemon-probe", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-live-probe-"));
  try {
    const logPath = path.join(dir, "bridge-log.json");
    const configDir = path.join(dir, "claude-config");
    const bridgePath = await writeFakeBridge(
      dir,
      [
        "if (verb !== 'daemon-probe') process.exit(2);",
        "console.log(JSON.stringify({ok:true,sessions:[],daemon:{configDir:payload.configDir},candidateResults:[],callerProvenance:{codexLauncher:'codex'}}));",
      ].join("\n"),
    );

    const stdout = await runTfxLive(
      [
        "probe",
        "--short",
        "facefeed",
        "--config-dir",
        configDir,
        "--bridge",
        bridgePath,
        "--timeout",
        "1",
      ],
      { env: { ...process.env, FAKE_BRIDGE_LOG: logPath } },
    );
    const result = JSON.parse(stdout);
    const log = JSON.parse(await fs.readFile(logPath, "utf8"));

    assert.equal(result.ok, true);
    assert.deepEqual(log, [
      {
        verb: "daemon-probe",
        payload: { includeContext: true, short: "facefeed", configDir },
      },
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("tfx-live ask --transport auto forwards --config-dir to probe and selected attach", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-live-ask-auto-"));
  try {
    const logPath = path.join(dir, "bridge-log.json");
    const configDir = path.join(dir, "claude-config");
    const bridgePath = await writeFakeBridge(
      dir,
      [
        "if (verb === 'daemon-probe') {",
        "  console.log(JSON.stringify({ok:true,sessions:[{short:'facefeed',sessionId:'sess-1'}],target:{short:'facefeed',sessionId:'sess-1'},daemon:{configDir:payload.configDir,configDirSource:'explicit'},candidateResults:[{configDirSource:'explicit',ok:true,sessionCount:1}],callerProvenance:{codexLauncher:'omx'}}));",
        "} else if (verb === 'daemon-attach') {",
        "  console.log(JSON.stringify({ok:true,text:'ATTACH_OK',raw:'ATTACH_OK',matchedCompletion:true,timedOut:false,closed:false,inputSent:true,daemon:{configDir:payload.configDir,configDirSource:'explicit'},candidateResults:[{configDirSource:'explicit',ok:true,sessionCount:1}],callerProvenance:{codexLauncher:'omx'}}));",
        "} else process.exit(2);",
      ].join("\n"),
    );

    const stdout = await runTfxLive(
      [
        "ask",
        "--cli",
        "claude",
        "--transport",
        "auto",
        "--short",
        "facefeed",
        "--prompt",
        "hello",
        "--config-dir",
        configDir,
        "--bridge",
        bridgePath,
        "--timeout",
        "1",
      ],
      { env: { ...process.env, FAKE_BRIDGE_LOG: logPath } },
    );
    const result = JSON.parse(stdout);
    const log = JSON.parse(await fs.readFile(logPath, "utf8"));

    assert.equal(result.done, true);
    assert.equal(result.response, "ATTACH_OK");
    assert.equal(result.transportSelected, "uds");
    assert.equal(result.daemon.configDir, configDir);
    assert.deepEqual(
      log.map((entry) => entry.payload.configDir),
      [configDir, configDir],
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("tfx-live interrupt forwards --config-dir to daemon-interrupt and returns provenance", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-live-interrupt-"));
  try {
    const logPath = path.join(dir, "bridge-log.json");
    const configDir = path.join(dir, "claude-config");
    const bridgePath = await writeFakeBridge(
      dir,
      [
        "if (verb !== 'daemon-interrupt') process.exit(2);",
        "console.log(JSON.stringify({ok:true,done:false,aborted:true,reason:'user_interrupt',inputSent:true,daemon:{configDir:payload.configDir,configDirSource:'explicit'},candidateResults:[{configDirSource:'explicit',ok:true,sessionCount:1}],callerProvenance:{codexLauncher:'omx'}}));",
      ].join("\n"),
    );

    const stdout = await runTfxLive(
      [
        "interrupt",
        "--cli",
        "claude",
        "--transport",
        "uds",
        "--short",
        "facefeed",
        "--config-dir",
        configDir,
        "--bridge",
        bridgePath,
        "--timeout",
        "1",
      ],
      { env: { ...process.env, FAKE_BRIDGE_LOG: logPath } },
    );
    const result = JSON.parse(stdout);
    const log = JSON.parse(await fs.readFile(logPath, "utf8"));

    assert.equal(result.aborted, true);
    assert.equal(result.daemon.configDir, configDir);
    assert.deepEqual(log[0].payload, {
      timeoutMs: 1000,
      short: "facefeed",
      configDir,
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("tfx-live interrupt returns the common abort contract through UDS bridge", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-live-bridge-"));
  try {
    const bridgePath = path.join(dir, "fake-bridge.mjs");
    await fs.writeFile(
      bridgePath,
      [
        "#!/usr/bin/env node",
        "const [,, verb] = process.argv;",
        "if (verb !== 'daemon-interrupt') process.exit(2);",
        "console.log(JSON.stringify({ok:true,done:false,aborted:true,reason:'user_interrupt',transport:'uds',inputSent:true}));",
      ].join("\n"),
      "utf8",
    );

    const stdout = await runTfxLive([
      "interrupt",
      "--cli",
      "claude",
      "--transport",
      "uds",
      "--short",
      "facefeed",
      "--bridge",
      bridgePath,
      "--timeout",
      "1",
    ]);
    const result = JSON.parse(stdout);

    assert.equal(result.cli, "claude");
    assert.equal(result.transport, "uds");
    assert.equal(result.done, false);
    assert.equal(result.aborted, true);
    assert.equal(result.reason, "user_interrupt");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("tfx-live interrupt returns the common abort contract through tmux Escape", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-live-tmux-"));
  try {
    const logPath = path.join(dir, "tmux-args.json");
    const tmuxPath = path.join(dir, "tmux");
    await fs.writeFile(
      tmuxPath,
      [
        "#!/usr/bin/env node",
        "await import('node:fs/promises').then(({writeFile}) => writeFile(process.env.TMUX_LOG, JSON.stringify(process.argv.slice(2))));",
      ].join("\n"),
      "utf8",
    );
    await fs.chmod(tmuxPath, 0o755);

    const stdout = await runTfxLive(
      [
        "interrupt",
        "--cli",
        "claude",
        "--transport",
        "tmux",
        "--session",
        "live-peer",
      ],
      {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          TMUX_LOG: logPath,
        },
      },
    );
    const result = JSON.parse(stdout);
    const tmuxArgs = JSON.parse(await fs.readFile(logPath, "utf8"));

    assert.equal(result.cli, "claude");
    assert.equal(result.transport, "tmux");
    assert.equal(result.done, false);
    assert.equal(result.aborted, true);
    assert.equal(result.reason, "user_interrupt");
    assert.deepEqual(tmuxArgs, ["send-keys", "-t", "live-peer", "Escape"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Claude discovery matches live pane owners and descendants up to four levels", async () => {
  const dir = await fs.mkdtemp(path.resolve(".test-claude-sessions-"));
  try {
    const sessionsDir = path.join(dir, "claude-sessions");
    await fs.mkdir(sessionsDir);
    const records = [
      {
        pid: 100,
        sessionId: "session-direct",
        tmux: "team:part.one:@2.%7",
        name: "Direct",
        nameSource: "user",
        status: "idle",
      },
      {
        pid: 104,
        sessionId: "session-deep",
        tmux: "team:part.one:@2.%8",
        name: "Deep",
        nameSource: "auto",
        status: "busy",
      },
      { pid: 105, sessionId: "too-deep", tmux: "team:part.one:@2.%8" },
      { pid: 200, sessionId: "unrelated", tmux: "team:part.one:@2.%8" },
      { pid: 201, sessionId: "dead", tmux: "team:part.one:@2.%9" },
      { pid: 100, sessionId: "missing-pane", tmux: "team:part.one:@2.%99" },
      {
        pid: 100,
        sessionId: "malformed-coordinate",
        tmux: "team:part.one:2.7",
      },
    ];
    for (const [i, record] of records.entries()) {
      await fs.writeFile(
        path.join(sessionsDir, `${i}.json`),
        JSON.stringify(record),
      );
    }
    await fs.writeFile(path.join(sessionsDir, "broken.json"), "{bad");
    const cwd = await fs.realpath(dir);
    const deps = {
      env: { TFX_CLAUDE_SESSIONS_DIR: sessionsDir },
      runTmux: async (_remote, args) => {
        assert.deepEqual(args.slice(0, 3), ["list-panes", "-a", "-F"]);
        assert.match(args[3], /#\{pane_id\}/);
        return {
          stdout: [
            `team:part.one\t1735689600\t0\t3\t1\t${cwd}\tclaude\tclaude\t/dev/ttys1\t100\t%7`,
            `team:part.one\t1735689600\t0\t3\t2\t${cwd}\tzsh\tzsh\t/dev/ttys2\t100\t%8`,
            `team:part.one\t1735689600\t0\t3\t3\t${cwd}\tclaude\tclaude\t/dev/ttys3\t201\t%9`,
          ].join("\n"),
        };
      },
      psExec: async (command, args) => {
        assert.equal(command, "ps");
        assert.deepEqual(args, ["-eo", "pid=,ppid="]);
        return {
          stdout: "100 1\n101 100\n102 101\n103 102\n104 103\n105 104\n200 1",
        };
      },
      isAlive: (pid) => pid !== 201,
    };
    const all = await tfxLive.discoverClaudeTmuxSessions({}, deps);
    assert.deepEqual(all, {
      ok: true,
      cli: "claude",
      cwd: null,
      sessions: [
        {
          session: "team:part.one",
          target: "team:part.one:3.1",
          paneId: "%7",
          cwd,
          pid: 100,
          sessionId: "session-direct",
          short: "session-",
          name: "Direct",
          title: "Direct",
          nameSource: "user",
          status: "idle",
        },
        {
          session: "team:part.one",
          target: "team:part.one:3.2",
          paneId: "%8",
          cwd,
          pid: 104,
          sessionId: "session-deep",
          short: "session-",
          name: "Deep",
          title: "Deep",
          nameSource: "auto",
          status: "busy",
        },
      ],
    });
    assert.equal(
      (await tfxLive.discoverClaudeTmuxSessions({ cwd: dir }, deps)).sessions
        .length,
      2,
    );
    assert.deepEqual(
      (
        await tfxLive.discoverClaudeTmuxSessions(
          { cwd: path.join(dir, "other") },
          deps,
        )
      ).sessions,
      [],
    );
    assert.deepEqual(
      (
        await tfxLive.discoverClaudeTmuxSessions(
          {},
          {
            ...deps,
            env: { TFX_CLAUDE_SESSIONS_DIR: path.join(dir, "missing") },
          },
        )
      ).sessions,
      [],
    );
    const renamed = await tfxLive.discoverClaudeTmuxSessions(
      {},
      {
        ...deps,
        runTmux: async (...args) => ({
          stdout: (await deps.runTmux(...args)).stdout.replaceAll(
            "team:part.one",
            "renamed:session",
          ),
        }),
      },
    );
    assert.deepEqual(
      renamed.sessions.map((session) => session.target),
      ["renamed:session:3.1", "renamed:session:3.2"],
    );
    const failed = await tfxLive.discoverClaudeTmuxSessions(
      {},
      {
        ...deps,
        runTmux: async () => {
          throw new Error("no tmux");
        },
      },
    );
    assert.equal(failed.ok, false);
    assert.equal(failed.reason, "tmux-unavailable");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Claude list-sessions rejects remote and UDS discovery", async () => {
  for (const args of [
    ["--remote", "host"],
    ["--transport", "uds"],
  ]) {
    await assert.rejects(
      runTfxLive(["list-sessions", "--cli", "claude", ...args]),
      (error) => {
        const output = JSON.parse(error.stdout);
        assert.equal(output.ok, false);
        assert.match(output.error, /Claude.*local.*tmux|claude.*tmux.*local/i);
        return true;
      },
    );
  }
});

test("Codex discovery enriches only matching panes with registry thread names", async () => {
  const dir = await fs.mkdtemp(path.resolve(".test-codex-discovery-"));
  try {
    const registryDir = path.join(dir, "registry");
    const codexHome = path.join(dir, "codex-home");
    await fs.mkdir(registryDir);
    await fs.mkdir(codexHome);
    const records = [
      { pid: 100, sessionId: "thread-one", tmuxPane: "%7" },
      { pid: 208, sessionId: "thread-two", tmuxPane: "%8" },
      { pid: 900, sessionId: "unrelated", tmuxPane: "%9" },
      { pid: 408, sessionId: "at-depth-eight", tmuxPane: "%10" },
      { pid: 509, sessionId: "beyond-depth-eight", tmuxPane: "%11" },
    ];
    await fs.writeFile(
      path.join(codexHome, "session_index.jsonl"),
      [
        JSON.stringify({ id: "thread-one", thread_name: "Old" }),
        "{bad",
        JSON.stringify({ id: "thread-one", thread_name: "Latest" }),
      ].join("\n"),
    );
    const deps = {
      env: {
        TFX_CODEX_SESSION_REGISTRY_DIR: registryDir,
        CODEX_HOME: codexHome,
      },
      readCodexSessionRecords: ({ dir: requestedDir }) => {
        assert.equal(requestedDir, registryDir);
        return records;
      },
      runTmux: async () => ({
        stdout: [
          `team\t1735689600\t1\t0\t0\t${dir}\tcodex\tcodex\t/dev/ttys1\t100\t%7`,
          `team\t1735689600\t1\t0\t1\t${dir}\tcodex\tcodex\t/dev/ttys2\t200\t%8`,
          `other\t1735689600\t0\t1\t0\t${dir}\tcodex\tcodex\t/dev/ttys3\t300\t%9`,
          `other\t1735689600\t0\t1\t1\t${dir}\tcodex\tcodex\t/dev/ttys4\t400\t%10`,
          `other\t1735689600\t0\t1\t2\t${dir}\tcodex\tcodex\t/dev/ttys5\t500\t%11`,
        ].join("\n"),
      }),
      psExec: async (command, args, options) => {
        assert.equal(command, "ps");
        assert.deepEqual(args, ["-eo", "pid=,ppid="]);
        assert.equal(options.timeout, 1000);
        return {
          stdout: [
            "100 1",
            "200 1",
            "207 200",
            "208 207",
            "300 1",
            "900 1",
            "400 1",
            "401 400",
            "402 401",
            "403 402",
            "404 403",
            "405 404",
            "406 405",
            "407 406",
            "408 407",
            "500 1",
            "501 500",
            "502 501",
            "503 502",
            "504 503",
            "505 504",
            "506 505",
            "507 506",
            "508 507",
            "509 508",
          ].join("\n"),
        };
      },
    };
    const result = await tfxLive.discoverCodexTmuxSessions({}, deps);
    const panes = result.sessions.find(
      (session) => session.session === "team",
    ).panes;
    assert.equal(panes[0].threadId, "thread-one");
    assert.equal(panes[0].name, "Latest");
    assert.equal(panes[1].threadId, "thread-two");
    assert.equal(panes[1].name, null);
    const other = result.sessions.find(
      (session) => session.session === "other",
    ).panes;
    assert.equal(Object.hasOwn(other[0], "threadId"), false);
    assert.equal(Object.hasOwn(other[0], "name"), false);
    assert.equal(other[1].threadId, "at-depth-eight");
    assert.equal(Object.hasOwn(other[2], "threadId"), false);
    const noPs = await tfxLive.discoverCodexTmuxSessions(
      {},
      {
        ...deps,
        psExec: async () => {
          throw new Error("ps unavailable");
        },
      },
    );
    const noPsPanes = noPs.sessions.find(
      (session) => session.session === "team",
    ).panes;
    assert.equal(noPsPanes[0].threadId, "thread-one");
    assert.equal(Object.hasOwn(noPsPanes[1], "threadId"), false);
    const remote = await tfxLive.discoverCodexTmuxSessions(
      { remote: "host" },
      deps,
    );
    assert.equal(
      Object.hasOwn(
        remote.sessions.find((session) => session.session === "team").panes[0],
        "threadId",
      ),
      false,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Claude list-sessions CLI reads the overridden registry and uses pane cwd", async () => {
  const dir = await fs.mkdtemp(path.resolve(".test-claude-cli-"));
  try {
    const sessionsDir = path.join(dir, "sessions");
    await fs.mkdir(sessionsDir);
    await fs.writeFile(
      path.join(sessionsDir, `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        sessionId: "abcdef12-session",
        cwd: "/stale/cwd",
        tmux: "claude:work.tree:@4.%17",
        name: "Work",
        nameSource: "user",
        status: "idle",
      }),
    );
    const paneCwd = await fs.realpath(dir);
    await fs.writeFile(
      path.join(dir, "tmux"),
      [
        "#!/usr/bin/env node",
        `console.log(${JSON.stringify(`claude:work.tree\t1735689600\t0\t2\t3\t${paneCwd}\tclaude\tclaude\t/dev/ttys1\t${process.pid}\t%17`)});`,
      ].join("\n"),
      { mode: 0o755 },
    );
    await fs.writeFile(
      path.join(dir, "ps"),
      "#!/usr/bin/env node\nconsole.log('');\n",
      { mode: 0o755 },
    );
    const env = {
      TFX_CLAUDE_SESSIONS_DIR: sessionsDir,
      PATH: `${dir}${path.delimiter}${process.env.PATH}`,
    };
    const result = JSON.parse(
      await runTfxLive(["list-sessions", "--cli", "claude", "--cwd", dir], {
        env,
      }),
    );
    const automatic = JSON.parse(
      await runTfxLive(
        [
          "list-sessions",
          "--cli",
          "claude",
          "--transport",
          "auto",
          "--cwd",
          dir,
        ],
        { env },
      ),
    );
    assert.deepEqual(automatic, result);
    assert.deepEqual(result, {
      ok: true,
      cli: "claude",
      cwd: paneCwd,
      sessions: [
        {
          session: "claude:work.tree",
          target: "claude:work.tree:2.3",
          paneId: "%17",
          cwd: paneCwd,
          pid: process.pid,
          sessionId: "abcdef12-session",
          short: "abcdef12",
          name: "Work",
          title: "Work",
          nameSource: "user",
          status: "idle",
        },
      ],
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

const claudeTitleFixtures = [
  {
    label: "derived names use the latest trimmed custom title",
    transcript:
      '{"type":"ai-title","aiTitle":"Old"}\n{"type":"custom-title","customTitle":"  최신 제목  "}\n',
    expected: "최신 제목",
  },
  {
    label: "a newer AI title wins over an older custom title",
    transcript:
      '{"type":"custom-title","customTitle":"Old"}\n{"type":"ai-title","aiTitle":"  Latest AI  "}',
    expected: "Latest AI",
  },
  {
    label: "customTitle wins over aiTitle on the same line",
    transcript: '{"type":"ai-title","customTitle":" Custom ","aiTitle":"AI"}\n',
    expected: "Custom",
  },
  {
    label: "blank customTitle skips the line even when aiTitle is present",
    transcript:
      '{"type":"ai-title","aiTitle":"Earlier"}\n{"type":"custom-title","customTitle":"  ","aiTitle":"Ignored"}\n',
    expected: "Earlier",
  },
  {
    label: "null customTitle falls back to aiTitle",
    transcript:
      '{"type":"ai-title","customTitle":null,"aiTitle":" AI fallback "}\n',
    expected: "AI fallback",
  },
  {
    label: "malformed, unrelated, and empty title lines are skipped",
    transcript:
      '{"type":"ai-title","aiTitle":"Earlier"}\r\n{bad\nnull\n{"type":"user","customTitle":"Ignored"}\n{"type":"ai-title","aiTitle":12}\n{"type":"custom-title","customTitle":" \\n "}\n{"type":"ai-title"}\n',
    expected: "Earlier",
  },
  {
    label: "an empty user name triggers transcript lookup",
    name: "",
    nameSource: "user",
    transcript: '{"type":"ai-title","aiTitle":"Recovered"}\n',
    expected: "Recovered",
  },
  {
    label: "a missing name triggers transcript lookup",
    name: null,
    nameSource: "auto",
    transcript: '{"type":"ai-title","aiTitle":"Recovered"}\n',
    expected: "Recovered",
  },
  {
    label: "a whitespace-only name triggers transcript lookup",
    name: " \t ",
    nameSource: "user",
    transcript: '{"type":"ai-title","aiTitle":"Recovered"}\n',
    expected: "Recovered",
  },
  {
    label: "a user name is preserved instead of the transcript title",
    name: "  User name  ",
    nameSource: "user",
    transcript: '{"type":"custom-title","customTitle":"Ignored"}\n',
    expected: "  User name  ",
  },
  {
    label: "an automatic registry name is preserved",
    name: "Auto name",
    nameSource: "auto",
    transcript: '{"type":"ai-title","aiTitle":"Ignored"}\n',
    expected: "Auto name",
  },
  {
    label: "a name without nameSource is preserved",
    name: "Legacy name",
    nameSource: null,
    transcript: '{"type":"ai-title","aiTitle":"Ignored"}\n',
    expected: "Legacy name",
  },
  {
    label: "a missing transcript returns null instead of the derived handle",
    expected: null,
  },
  {
    label: "an empty transcript returns null",
    transcript: "",
    expected: null,
  },
  {
    label: "a transcript without valid titles returns null",
    transcript:
      '{bad\n{"type":"assistant","aiTitle":"Ignored"}\n{"type":"custom-title","customTitle":" "}\n',
    expected: null,
  },
  {
    label: "a missing projects directory returns null",
    missingProjects: true,
    expected: null,
  },
  {
    label: "titles before the last 262144 bytes are ignored",
    transcript:
      '{"type":"custom-title","customTitle":"Too old"}\n' + "x".repeat(262144),
    expected: null,
  },
  {
    label: "a truncated first line does not hide a valid title in the tail",
    transcript:
      `{"type":"assistant","text":"${"가".repeat(100000)}"}\n` +
      '{"type":"ai-title","aiTitle":"  꼬리 제목  "}\n{partial',
    expected: "꼬리 제목",
  },
  {
    label: "a title at the start of the 262144-byte tail is included",
    transcript:
      "x".repeat(262144) +
      '{"type":"ai-title","aiTitle":"Boundary"}\n' +
      "x".repeat(
        262144 -
          Buffer.byteLength('{"type":"ai-title","aiTitle":"Boundary"}\n'),
      ),
    expected: "Boundary",
  },
];

for (const fixture of claudeTitleFixtures) {
  test(`Claude discovery title: ${fixture.label}`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-claude-title-"));
    try {
      const sessionsDir = path.join(dir, "sessions");
      const projectsDir = path.join(dir, "projects");
      const record = {
        pid: 100,
        sessionId: "conversation-session",
        tmux: "claude:@1.%7",
        name: fixture.name === undefined ? "Derived handle" : fixture.name,
        nameSource:
          fixture.nameSource === undefined ? "derived" : fixture.nameSource,
      };
      await fs.mkdir(sessionsDir);
      await fs.writeFile(
        path.join(sessionsDir, "100.json"),
        JSON.stringify(record),
      );
      if (!fixture.missingProjects) {
        await fs.mkdir(path.join(projectsDir, "a-unrelated"), {
          recursive: true,
        });
        await fs.mkdir(path.join(projectsDir, "z-project"));
      }
      if (fixture.transcript !== undefined) {
        await fs.writeFile(
          path.join(projectsDir, "z-project", "conversation-session.jsonl"),
          fixture.transcript,
        );
        await fs.writeFile(
          path.join(projectsDir, "a-unrelated", "other-session.jsonl"),
          '{"type":"custom-title","customTitle":"Wrong session"}\n',
        );
      }
      const result = await tfxLive.discoverClaudeTmuxSessions(
        {},
        {
          env: {
            HOME: dir,
            TFX_CLAUDE_SESSIONS_DIR: sessionsDir,
            TFX_CLAUDE_PROJECTS_DIR: projectsDir,
          },
          runTmux: async () => ({
            stdout: `claude\t0\t0\t1\t0\t${dir}\tclaude\tclaude\t/dev/ttys1\t100\t%7`,
          }),
          psExec: async () => ({ stdout: "" }),
          isAlive: () => true,
        },
      );
      assert.equal(result.ok, true);
      assert.equal(result.sessions.length, 1);
      assert.equal(result.sessions[0].title, fixture.expected);
      assert.equal(result.sessions[0].name, record.name);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}

test("stop parses one Claude daemon target", () => {
  assert.equal(tfxLive.stopOpts({ short: "abc12345" }).short, "abc12345");
  assert.equal(
    tfxLive.stopOpts({ "session-id": "session-1" }).sessionId,
    "session-1",
  );
  assert.throws(
    () => tfxLive.stopOpts({ short: "abc12345", session: "cl1" }),
    /one of/,
  );
});
