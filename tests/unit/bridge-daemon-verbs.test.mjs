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

function parseBridgeStdout(stdout) {
  const line = String(stdout).trim().split("\n").filter(Boolean).at(-1);
  assert.ok(line, "bridge should write one JSON line");
  return JSON.parse(line);
}

async function runBridge(args, options = {}) {
  try {
    const result = await execFileAsync(process.execPath, [BRIDGE, ...args], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      env: { ...process.env, ...options.env },
      input: options.input,
    });
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

async function withTempConfig(fn) {
  const configDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "triflux-bridge-daemon-"),
  );
  const daemonDir = deriveClaudeDaemonPaths({ configDir }).daemonDir;
  try {
    return await fn(configDir);
  } finally {
    await fs.rm(configDir, { recursive: true, force: true });
    await fs.rm(daemonDir, { recursive: true, force: true });
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
    const paths = deriveClaudeDaemonPaths({ configDir });
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
        { short: "abcd1234", sessionId: "sess-1", state: "ready" },
      ]);
      assert.deepEqual(out.target, {
        short: "abcd1234",
        sessionId: "sess-1",
        state: "ready",
      });
      assert.deepEqual(fake.requests, [{ proto: 1, op: "list" }]);
    } finally {
      await new Promise((resolve) => fake.server.close(resolve));
    }
  });
});

test("daemon-attach resolves sessionId, sends prompt, and returns assistant text", async () => {
  await withTempConfig(async (configDir) => {
    const paths = deriveClaudeDaemonPaths({ configDir });
    const fake = await listenFakeDaemon(paths.controlSock, {
      jobs: [{ short: "facefeed", sessionId: "session-attach" }],
    });
    try {
      const payloadPath = path.join(configDir, "attach-payload.json");
      await fs.writeFile(
        payloadPath,
        JSON.stringify({
          configDir,
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
    const paths = deriveClaudeDaemonPaths({ configDir });
    const requests = [];
    let attachedInput = "";
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let firstLine = "";
      socket.on("data", (chunk) => {
        if (!firstLine.includes("\n")) {
          firstLine += chunk;
          if (!firstLine.includes("\n")) return;
          const line = firstLine.slice(0, firstLine.indexOf("\n"));
          const request = JSON.parse(line);
          requests.push(request);
          socket.write(
            `${JSON.stringify({
              ok: true,
              op: "attach",
              via: "spare",
              tempo: "active",
              state: "working",
            })}\n`,
          );
          attachedInput += firstLine.slice(firstLine.indexOf("\n") + 1);
          return;
        }

        attachedInput += chunk;
        if (attachedInput.includes("\x1b")) {
          socket.end("interrupted\n");
        }
      });
    });

    try {
      await fs.mkdir(path.dirname(paths.controlSock), { recursive: true });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(paths.controlSock, resolve);
      });

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
      assert.match(attachedInput, /\x1b/);
      assert.deepEqual(requests, [
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
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
