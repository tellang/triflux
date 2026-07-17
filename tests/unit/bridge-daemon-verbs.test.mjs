import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parseArgs, readBridgePayload } from "../../hub/bridge.mjs";
import { deriveClaudeDaemonPaths } from "../../hub/team/claude-daemon-control.mjs";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const BRIDGE = path.join(PROJECT_ROOT, "hub", "bridge.mjs");
const TEST_DAEMON_TMP_ROOT = await fs.mkdtemp("/tmp/tfx-bds-");

test.after(async () => {
  await fs.rm(TEST_DAEMON_TMP_ROOT, { recursive: true, force: true });
});

function parseBridgeStdout(stdout) {
  const line = String(stdout).trim().split("\n").filter(Boolean).at(-1);
  assert.ok(line, "bridge should write one JSON line");
  return JSON.parse(line);
}

async function runBridge(args, options = {}) {
  const commandArgs = [...args];
  const payloadIndex = commandArgs.indexOf("--payload");
  if (payloadIndex !== -1) {
    commandArgs[payloadIndex + 1] = JSON.stringify({
      ...JSON.parse(commandArgs[payloadIndex + 1]),
      tmpRoot: TEST_DAEMON_TMP_ROOT,
    });
  }
  try {
    const result = await execFileAsync(
      process.execPath,
      [BRIDGE, ...commandArgs],
      {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        env: { ...process.env, ...options.env },
        input: options.input,
      },
    );
    return parseBridgeStdout(result.stdout);
  } catch (error) {
    if (options.allowFailure && error.stdout) {
      return parseBridgeStdout(error.stdout);
    }
    throw error;
  }
}

async function listenFakeDaemon(
  controlSock,
  {
    jobs,
    attachText = "✻ Fermenting… (esc to interrupt)\n⏺ BRIDGE_ATTACH_OK\n❯ \n",
  },
) {
  await fs.mkdir(path.dirname(controlSock), { recursive: true });
  const requests = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let controlBuffer = "";
    let attachedInput = "";
    let attachStarted = false;
    let attachResponseSent = false;
    socket.on("data", (chunk) => {
      if (attachStarted) {
        attachedInput += chunk;
        if (
          attachResponseSent ||
          !attachedInput.includes("\x1b[200~") ||
          !attachedInput.includes("\x1b[201~")
        ) {
          return;
        }
        attachResponseSent = true;
        socket.write(attachText);
        return;
      }

      controlBuffer += chunk;
      if (!controlBuffer.includes("\n")) return;
      const newlineIndex = controlBuffer.indexOf("\n");
      const line = controlBuffer.slice(0, newlineIndex);
      const request = JSON.parse(line);
      requests.push(request);
      if (request.op === "list") {
        socket.end(`${JSON.stringify({ ok: true, jobs })}\n`);
        return;
      }
      if (request.op === "attach") {
        socket.write(
          `${JSON.stringify({ ok: true, op: "attach", state: "done" })}\n`,
        );
        attachStarted = true;
        attachedInput = controlBuffer.slice(newlineIndex + 1);
        if (
          attachedInput.includes("\x1b[200~") &&
          attachedInput.includes("\x1b[201~")
        ) {
          attachResponseSent = true;
          socket.write(attachText);
        }
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(controlSock, resolve);
  });

  return { server, requests };
}

async function listenFakeInterruptDaemon(controlSock, { jobs }) {
  await fs.mkdir(path.dirname(controlSock), { recursive: true });
  const requests = [];
  let attachedInput = "";
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let controlBuffer = "";
    let attachStarted = false;
    socket.on("data", (chunk) => {
      if (attachStarted) {
        attachedInput += chunk;
        if (attachedInput.includes("\x1b")) {
          socket.end("interrupted\n");
        }
        return;
      }

      controlBuffer += chunk;
      if (!controlBuffer.includes("\n")) return;
      const newlineIndex = controlBuffer.indexOf("\n");
      const line = controlBuffer.slice(0, newlineIndex);
      const request = JSON.parse(line);
      requests.push(request);
      if (request.op === "list") {
        socket.end(`${JSON.stringify({ ok: true, jobs })}\n`);
        return;
      }
      if (request.op === "attach") {
        socket.write(
          `${JSON.stringify({
            ok: true,
            op: "attach",
            via: "spare",
            tempo: "active",
            state: "working",
          })}\n`,
        );
        attachStarted = true;
        attachedInput += controlBuffer.slice(newlineIndex + 1);
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(controlSock, resolve);
  });

  return {
    server,
    requests,
    get attachedInput() {
      return attachedInput;
    },
  };
}

async function withTempConfig(fn) {
  const configDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "triflux-bridge-daemon-"),
  );
  const daemonDir = deriveClaudeDaemonPaths({
    configDir,
    tmpRoot: TEST_DAEMON_TMP_ROOT,
  }).daemonDir;
  try {
    return await fn(configDir);
  } finally {
    await fs.rm(configDir, { recursive: true, force: true });
    await fs.rm(daemonDir, { recursive: true, force: true });
  }
}

async function withTempClaudeHome(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "triflux-home-"));
  const defaultConfig = path.join(home, ".claude");
  const omcRuntime = path.join(defaultConfig, ".omc-launch");
  const customConfig = path.join(home, "custom-claude");
  const configDirs = [defaultConfig, omcRuntime, customConfig];
  await fs.mkdir(omcRuntime, { recursive: true });
  await fs.writeFile(
    path.join(omcRuntime, ".omc-launch-profile.json"),
    JSON.stringify({
      sourceConfigDir: defaultConfig,
      sourceClaudeMd: path.join(defaultConfig, "CLAUDE-omc.md"),
    }),
    "utf8",
  );
  try {
    return await fn({ home, defaultConfig, omcRuntime, customConfig });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await Promise.all(
      configDirs.map((configDir) =>
        fs.rm(
          deriveClaudeDaemonPaths({
            configDir,
            tmpRoot: TEST_DAEMON_TMP_ROOT,
          }).daemonDir,
          {
            recursive: true,
            force: true,
          },
        ),
      ),
    );
  }
}

test("readBridgePayload parses --payload JSON", () => {
  const args = parseArgs(["--payload", '{"prompt":"hello","timeoutMs":123}']);
  assert.deepEqual(readBridgePayload(args), {
    prompt: "hello",
    timeoutMs: 123,
  });
});

test("readBridgePayload parses --payload-file JSON", async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "triflux-bridge-payload-"),
  );
  try {
    const payloadPath = path.join(dir, "payload.json");
    await fs.writeFile(
      payloadPath,
      '{"short":"abc12345","prompt":"from file"}\n',
      "utf8",
    );
    const args = parseArgs(["--payload-file", payloadPath]);
    assert.deepEqual(readBridgePayload(args), {
      short: "abc12345",
      prompt: "from file",
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("readBridgePayload parses --payload-file - from stdin text", () => {
  const args = parseArgs(["--payload-file", "-"]);
  assert.deepEqual(readBridgePayload(args, '{"prompt":"stdin"}'), {
    prompt: "stdin",
  });
});

test("daemon-probe lists fake daemon sessions and resolves target by short", async () => {
  await withTempConfig(async (configDir) => {
    const paths = deriveClaudeDaemonPaths({
      configDir,
      tmpRoot: TEST_DAEMON_TMP_ROOT,
    });
    const fake = await listenFakeDaemon(paths.controlSock, {
      jobs: [{ short: "abcd1234", sessionId: "sess-1", state: "ready" }],
    });
    try {
      const payload = { configDir, short: "abcd1234", timeoutMs: 1000 };
      const out = await runBridge([
        "daemon-probe",
        "--payload",
        JSON.stringify(payload),
      ]);
      assert.equal(out.ok, true);
      assert.equal(out.controlSock, paths.controlSock);
      assert.deepEqual(out.sessions, [
        {
          short: "abcd1234",
          id: "abcd1234",
          sessionId: "sess-1",
          session_id: "sess-1",
          state: "ready",
          status: "ready",
        },
      ]);
      assert.deepEqual(out.target, {
        short: "abcd1234",
        id: "abcd1234",
        sessionId: "sess-1",
        session_id: "sess-1",
        state: "ready",
        status: "ready",
      });
      assert.deepEqual(fake.requests, [{ proto: 1, op: "list" }]);
    } finally {
      await new Promise((resolve) => fake.server.close(resolve));
    }
  });
});

test("daemon-probe normalizes Claude agent-view state/status row variants", async () => {
  await withTempConfig(async (configDir) => {
    const paths = deriveClaudeDaemonPaths({
      configDir,
      tmpRoot: TEST_DAEMON_TMP_ROOT,
    });
    const fake = await listenFakeDaemon(paths.controlSock, {
      jobs: [
        {
          id: "beadfeed",
          cwd: "/tmp/repo",
          kind: "bg",
          sessionId: "session-beadfeed",
          state: "blocked",
          waitingFor: "permission prompt",
        },
      ],
    });
    try {
      const payload = {
        configDir,
        sessionId: "session-beadfeed",
        timeoutMs: 1000,
      };
      const out = await runBridge([
        "daemon-probe",
        "--payload",
        JSON.stringify(payload),
      ]);
      assert.equal(out.ok, true);
      assert.equal(out.sessions[0].short, "beadfeed");
      assert.equal(out.sessions[0].state, "blocked");
      assert.equal(out.sessions[0].status, "blocked");
      assert.equal(out.target.short, "beadfeed");
      assert.equal(out.target.waitingFor, "permission prompt");
    } finally {
      await new Promise((resolve) => fake.server.close(resolve));
    }
  });
});

test("daemon-attach resolves sessionId, sends prompt, and returns assistant text", async () => {
  await withTempConfig(async (configDir) => {
    await fs.mkdir(path.join(configDir, "daemon"), { recursive: true });
    await fs.writeFile(
      path.join(configDir, "daemon", "control.key"),
      "bridge-attach-secret\n",
      "utf8",
    );
    const paths = deriveClaudeDaemonPaths({
      configDir,
      tmpRoot: TEST_DAEMON_TMP_ROOT,
    });
    const fake = await listenFakeDaemon(paths.controlSock, {
      jobs: [{ short: "facefeed", sessionId: "session-attach" }],
    });
    try {
      const payloadPath = path.join(configDir, "attach-payload.json");
      await fs.writeFile(
        payloadPath,
        JSON.stringify({
          configDir,
          tmpRoot: TEST_DAEMON_TMP_ROOT,
          sessionId: "session-attach",
          prompt: "say bridge ok",
          timeoutMs: 1500,
          cols: 132,
          rows: 37,
        }),
        "utf8",
      );
      const out = await runBridge([
        "daemon-attach",
        "--payload-file",
        payloadPath,
      ]);
      assert.equal(out.ok, true);
      assert.equal(out.text, "BRIDGE_ATTACH_OK");
      assert.equal(out.matchedCompletion, true);
      assert.equal(out.timedOut, false);
      assert.equal(out.inputSent, true);
      assert.equal(out.closed, false);
      assert.deepEqual(fake.requests, [
        { proto: 1, op: "list" },
        {
          proto: 1,
          op: "attach",
          short: "facefeed",
          cols: 132,
          rows: 37,
          caps: { terminal: null, mux: null, ssh: false },
          auth: "bridge-attach-secret",
        },
      ]);
    } finally {
      await new Promise((resolve) => fake.server.close(resolve));
    }
  });
});

test("daemon-attach returns the full failure response shape before input", async () => {
  await withTempConfig(async (configDir) => {
    const out = await runBridge(
      [
        "daemon-attach",
        "--payload",
        JSON.stringify({
          configDir,
          short: "missing1",
          prompt: "this should not be sent",
          timeoutMs: 100,
        }),
      ],
      { allowFailure: true },
    );

    assert.equal(out.ok, false);
    assert.equal(out.text, "");
    assert.equal(out.raw, "");
    assert.equal(out.responseRaw, "");
    assert.equal(out.matchedCompletion, false);
    assert.equal(out.timedOut, false);
    assert.equal(out.closed, false);
    assert.equal(out.inputSent, false);
    assert.match(out.error, /ENOENT|ECONNREFUSED|control\.sock/u);
  });
});

test("daemon-interrupt attaches to a daemon PTY and sends Escape", async () => {
  await withTempConfig(async (configDir) => {
    await fs.mkdir(path.join(configDir, "daemon"), { recursive: true });
    await fs.writeFile(
      path.join(configDir, "daemon", "control.key"),
      "bridge-interrupt-secret\n",
      "utf8",
    );
    const paths = deriveClaudeDaemonPaths({
      configDir,
      tmpRoot: TEST_DAEMON_TMP_ROOT,
    });
    const fake = await listenFakeInterruptDaemon(paths.controlSock, {
      jobs: [{ short: "facefeed", sessionId: "interrupt-session" }],
    });

    try {
      const out = await runBridge([
        "daemon-interrupt",
        "--payload",
        JSON.stringify({
          configDir,
          short: "facefeed",
          timeoutMs: 1000,
        }),
      ]);

      assert.equal(out.ok, true);
      assert.equal(out.done, false);
      assert.equal(out.aborted, true);
      assert.equal(out.reason, "user_interrupt");
      assert.equal(out.inputSent, true);
      assert.match(fake.attachedInput, /\x1b/);
      assert.deepEqual(fake.requests, [
        { proto: 1, op: "list" },
        {
          proto: 1,
          op: "attach",
          short: "facefeed",
          cols: 240,
          rows: 40,
          caps: { terminal: null, mux: null, ssh: false },
          auth: "bridge-interrupt-secret",
        },
      ]);
    } finally {
      await new Promise((resolve) => fake.server.close(resolve));
    }
  });
});

test("daemon-probe discovers an OMC runtime daemon in ambient OMX caller env", async () => {
  await withTempClaudeHome(async ({ home, omcRuntime }) => {
    const omcPaths = deriveClaudeDaemonPaths({
      configDir: omcRuntime,
      tmpRoot: TEST_DAEMON_TMP_ROOT,
    });
    const jobs = [{ short: "omc12345", sessionId: "omc-session" }];
    const fake = await listenFakeDaemon(omcPaths.controlSock, { jobs });
    try {
      const out = await runBridge(
        [
          "daemon-probe",
          "--payload",
          JSON.stringify({ short: "omc12345", timeoutMs: 1000 }),
        ],
        {
          env: {
            HOME: home,
            CLAUDE_CONFIG_DIR: "",
            CODEX_THREAD_ID: "codex-thread",
            OMX_SESSION_ID: "omx-session",
          },
          allowFailure: true,
        },
      );

      assert.equal(out.ok, true);
      assert.equal(out.controlSock, omcPaths.controlSock);
      assert.equal(out.daemon.configDir, omcRuntime);
      assert.equal(out.daemon.configDirSource, "omc-runtime");
      assert.equal(out.daemon.claudeLauncher, "omc");
      assert.equal(out.callerProvenance.codexLauncher, "omx");
      assert.deepEqual(out.sessions, [
        {
          short: "omc12345",
          id: "omc12345",
          sessionId: "omc-session",
          session_id: "omc-session",
          state: "unknown",
          status: "unknown",
        },
      ]);
      assert.equal(Object.hasOwn(out.sessions[0], "daemon"), false);
      assert.deepEqual(
        out.candidateResults.map((candidate) => ({
          source: candidate.configDirSource,
          ok: candidate.ok,
          sessionCount: candidate.sessionCount,
        })),
        [
          { source: "omc-runtime", ok: true, sessionCount: 1 },
          { source: "default", ok: false, sessionCount: 0 },
        ],
      );
      assert.deepEqual(fake.requests, [{ proto: 1, op: "list" }]);
    } finally {
      await new Promise((resolve) => fake.server.close(resolve));
    }
  });
});

test("daemon-attach in ambient mode selects OMC runtime and resolves compact session ids", async () => {
  await withTempClaudeHome(async ({ home, omcRuntime }) => {
    const omcPaths = deriveClaudeDaemonPaths({
      configDir: omcRuntime,
      tmpRoot: TEST_DAEMON_TMP_ROOT,
    });
    const fake = await listenFakeDaemon(omcPaths.controlSock, {
      jobs: [{ short: "facefeed", d: { sessionId: "compact-session" } }],
    });
    try {
      const out = await runBridge(
        [
          "daemon-attach",
          "--payload",
          JSON.stringify({
            sessionId: "compact-session",
            prompt: "say bridge ok",
            timeoutMs: 1500,
          }),
        ],
        {
          env: {
            HOME: home,
            CLAUDE_CONFIG_DIR: "",
            CODEX_THREAD_ID: "codex-thread",
            OMX_ENTRY_PATH:
              "/opt/homebrew/lib/node_modules/oh-my-codex/dist/cli/omx.js",
          },
        },
      );

      assert.equal(out.ok, true);
      assert.equal(out.text, "BRIDGE_ATTACH_OK");
      assert.equal(out.daemon.configDirSource, "omc-runtime");
      assert.equal(out.daemon.claudeLauncher, "omc");
      assert.equal(out.callerProvenance.codexLauncher, "omx");
      assert.deepEqual(fake.requests, [
        { proto: 1, op: "list" },
        {
          proto: 1,
          op: "attach",
          short: "facefeed",
          cols: 240,
          rows: 40,
          caps: { terminal: null, mux: null, ssh: false },
        },
      ]);
    } finally {
      await new Promise((resolve) => fake.server.close(resolve));
    }
  });
});

test("daemon-interrupt in ambient mode selects OMC runtime before sending Escape", async () => {
  await withTempClaudeHome(async ({ home, omcRuntime }) => {
    const omcPaths = deriveClaudeDaemonPaths({
      configDir: omcRuntime,
      tmpRoot: TEST_DAEMON_TMP_ROOT,
    });
    const fake = await listenFakeInterruptDaemon(omcPaths.controlSock, {
      jobs: [{ short: "cab005e", sessionId: "interrupt-session" }],
    });
    try {
      const out = await runBridge(
        [
          "daemon-interrupt",
          "--payload",
          JSON.stringify({
            sessionId: "interrupt-session",
            timeoutMs: 1000,
          }),
        ],
        {
          env: {
            HOME: home,
            CLAUDE_CONFIG_DIR: "",
            CODEX_THREAD_ID: "codex-thread",
            OMX_SESSION_ID: "omx-session",
          },
          allowFailure: true,
        },
      );

      assert.equal(out.ok, true);
      assert.equal(out.aborted, true);
      assert.equal(out.reason, "user_interrupt");
      assert.equal(out.daemon.configDirSource, "omc-runtime");
      assert.equal(out.callerProvenance.codexLauncher, "omx");
      assert.match(fake.attachedInput, /\x1b/u);
      assert.deepEqual(fake.requests, [
        { proto: 1, op: "list" },
        {
          proto: 1,
          op: "attach",
          short: "cab005e",
          cols: 240,
          rows: 40,
          caps: { terminal: null, mux: null, ssh: false },
        },
      ]);
    } finally {
      await new Promise((resolve) => fake.server.close(resolve));
    }
  });
});

test("daemon-attach rejects duplicate ambient targets before attaching", async () => {
  await withTempClaudeHome(async ({ home, defaultConfig, omcRuntime }) => {
    const omcPaths = deriveClaudeDaemonPaths({
      configDir: omcRuntime,
      tmpRoot: TEST_DAEMON_TMP_ROOT,
    });
    const defaultPaths = deriveClaudeDaemonPaths({
      configDir: defaultConfig,
      tmpRoot: TEST_DAEMON_TMP_ROOT,
    });
    const omcFake = await listenFakeDaemon(omcPaths.controlSock, {
      jobs: [{ short: "dupe0001", sessionId: "omc-dupe" }],
    });
    const defaultFake = await listenFakeDaemon(defaultPaths.controlSock, {
      jobs: [{ short: "dupe0001", sessionId: "default-dupe" }],
    });
    try {
      const out = await runBridge(
        [
          "daemon-attach",
          "--payload",
          JSON.stringify({
            short: "dupe0001",
            prompt: "must not attach",
            timeoutMs: 1000,
          }),
        ],
        {
          env: {
            HOME: home,
            CLAUDE_CONFIG_DIR: "",
            CODEX_THREAD_ID: "codex-thread",
            OMX_SESSION_ID: "omx-session",
          },
          allowFailure: true,
        },
      );

      assert.equal(out.ok, false);
      assert.equal(out.reason, "ambiguous-target");
      assert.equal(out.inputSent, false);
      assert.equal(out.daemon, null);
      assert.equal(out.matches.length, 2);
      assert.deepEqual(
        out.matches.map((match) => match.daemon.configDirSource).sort(),
        ["default", "omc-runtime"],
      );
      assert.deepEqual(omcFake.requests, [{ proto: 1, op: "list" }]);
      assert.deepEqual(defaultFake.requests, [{ proto: 1, op: "list" }]);
    } finally {
      await new Promise((resolve) => omcFake.server.close(resolve));
      await new Promise((resolve) => defaultFake.server.close(resolve));
    }
  });
});

test("explicit configDir is exact-only and never falls back to ambient OMC", async () => {
  await withTempClaudeHome(async ({ home, omcRuntime, customConfig }) => {
    const omcPaths = deriveClaudeDaemonPaths({
      configDir: omcRuntime,
      tmpRoot: TEST_DAEMON_TMP_ROOT,
    });
    const fake = await listenFakeDaemon(omcPaths.controlSock, {
      jobs: [{ short: "omc12345", sessionId: "omc-session" }],
    });
    try {
      const out = await runBridge(
        [
          "daemon-probe",
          "--payload",
          JSON.stringify({
            configDir: customConfig,
            short: "omc12345",
            timeoutMs: 100,
          }),
        ],
        {
          env: {
            HOME: home,
            CLAUDE_CONFIG_DIR: "",
            CODEX_THREAD_ID: "codex-thread",
            OMX_SESSION_ID: "omx-session",
          },
          allowFailure: true,
        },
      );

      assert.equal(out.ok, false);
      assert.equal(out.reason, "daemon-dir-missing");
      assert.equal(out.daemon, null);
      assert.deepEqual(
        out.candidateResults.map((candidate) => candidate.configDirSource),
        ["explicit"],
      );
      assert.deepEqual(fake.requests, []);
    } finally {
      await new Promise((resolve) => fake.server.close(resolve));
    }
  });
});

test("CLAUDE_CONFIG_DIR env mode is strict and never falls back to ambient OMC", async () => {
  await withTempClaudeHome(async ({ home, defaultConfig, omcRuntime }) => {
    const omcPaths = deriveClaudeDaemonPaths({
      configDir: omcRuntime,
      tmpRoot: TEST_DAEMON_TMP_ROOT,
    });
    const fake = await listenFakeDaemon(omcPaths.controlSock, {
      jobs: [{ short: "omc12345", sessionId: "omc-session" }],
    });
    try {
      const out = await runBridge(
        [
          "daemon-attach",
          "--payload",
          JSON.stringify({
            short: "omc12345",
            prompt: "must not attach",
            timeoutMs: 100,
          }),
        ],
        {
          env: {
            HOME: home,
            CLAUDE_CONFIG_DIR: defaultConfig,
            CODEX_THREAD_ID: "codex-thread",
            OMX_SESSION_ID: "omx-session",
          },
          allowFailure: true,
        },
      );

      assert.equal(out.ok, false);
      assert.equal(out.reason, "daemon-dir-missing");
      assert.equal(out.inputSent, false);
      assert.deepEqual(
        out.candidateResults.map((candidate) => candidate.configDirSource),
        ["env"],
      );
      assert.deepEqual(fake.requests, []);
    } finally {
      await new Promise((resolve) => fake.server.close(resolve));
    }
  });
});
