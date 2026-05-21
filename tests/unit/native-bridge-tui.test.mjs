import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deriveClaudeDaemonPaths,
  extractPtyFrames,
  startClaudeNativeBridge,
} from "../../hub/team/claude-native-bridge.mjs";
import { parseTeamArgs } from "../../hub/team/cli/commands/start/parse-args.mjs";
import { writeBridgeSession } from "../../hub/team/headless-bridge-session.mjs";

// Setup Mock State Dir
const MOCK_STATE_DIR = path.join(
  os.tmpdir(),
  `mock-claude-state-${Date.now()}`,
);

function readJsonLine(sockPath, { timeoutMs = 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(sockPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out waiting for JSON line: ${sockPath}`));
    }, timeoutMs);
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)));
    });
  });
}

function readPtyFrames(sockPath, { timeoutMs = 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(sockPath);
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out waiting for PTY frames: ${sockPath}`));
    }, timeoutMs);
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const { frames } = extractPtyFrames(buffer);
      if (frames.some((frame) => frame.kind === 0)) {
        clearTimeout(timer);
        socket.destroy();
        resolve(frames);
      }
    });
  });
}

test("CLI start parser should resolve --native-bridge option correctly", () => {
  const result = parseTeamArgs(["start", "--native-bridge"]);
  assert.equal(
    result.nativeBridge,
    true,
    "nativeBridge should be parsed as true when --native-bridge is passed",
  );
});

test("CLI start parser should resolve -nb option correctly", () => {
  const result = parseTeamArgs(["start", "-nb"]);
  assert.equal(
    result.nativeBridge,
    true,
    "nativeBridge should be parsed as true when -nb is passed",
  );
});

test("CLI start parser defaults headless native bridge UI to agents mode", () => {
  const result = parseTeamArgs(["start", "--teammate-mode", "headless"]);
  assert.equal(
    result.nativeBridge,
    true,
    "headless nativeBridge should default to true",
  );
  assert.equal(
    result.nativeBridgeMode,
    "agents",
    "headless nativeBridgeMode should default to agents",
  );
});

test("CLI start parser keeps interactive native bridge UI default-off", () => {
  assert.equal(
    parseTeamArgs(["start", "--teammate-mode", "tmux"]).nativeBridge,
    false,
  );
  assert.equal(
    parseTeamArgs(["start", "--teammate-mode", "wt"]).nativeBridge,
    false,
  );
});

test("Session persistence should write valid JSON to sessions folder", async () => {
  const testSessionId = "session_hl_test_99";
  const testSocket = "/tmp/claude-test-99.sock";

  await fs.mkdir(path.join(MOCK_STATE_DIR, "sessions"), { recursive: true });

  // Call actual implementation
  await writeBridgeSession(testSessionId, testSocket, MOCK_STATE_DIR);

  const filePath = path.join(
    MOCK_STATE_DIR,
    "sessions",
    `${testSessionId}.json`,
  );

  const fileExists = await fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
  assert.equal(fileExists, true, "Session file must be written to disk");

  const content = await fs.readFile(filePath, "utf8");
  const data = JSON.parse(content);

  assert.equal(data.session_id, testSessionId, "Session ID must match");
  assert.equal(data.messagingSock, testSocket, "Socket path must match");
  assert.equal(data.status, "RUNNING", "Status must be RUNNING");

  // Cleanup mock dir
  await fs.rm(MOCK_STATE_DIR, { recursive: true, force: true });
});

test("runHeadless no longer bypasses assignments when nativeBridge is true", async () => {
  const { runHeadless } = await import("../../hub/team/headless.mjs");

  const result = await runHeadless("session-nb-empty", [], {
    nativeBridge: true,
  });

  assert.equal(result.sessionName, "session-nb-empty");
  assert.deepEqual(result.results, []);
  assert.equal(Object.hasOwn(result, "bypassed"), false);
});

test("Claude native bridge writes roster entries and cleans only its workers", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-native-prod-"));
  const configDir = path.join(tmp, "claude");
  const paths = deriveClaudeDaemonPaths({ configDir });
  await fs.mkdir(path.dirname(paths.rosterPath), { recursive: true });
  await fs.writeFile(
    paths.rosterPath,
    `${JSON.stringify({
      proto: 1,
      supervisorPid: 123,
      updatedAt: 1,
      workers: { existing: { pid: 1, sessionId: "existing" } },
    })}\n`,
  );

  const bridge = await startClaudeNativeBridge({
    sessionName: "session-prod",
    assignments: [{ cli: "codex", role: "executor", prompt: "do work" }],
    configDir,
    tmpRoot: tmp,
  });

  const roster = JSON.parse(await fs.readFile(paths.rosterPath, "utf8"));
  assert.ok(roster.workers.existing);
  assert.equal(bridge.workers.length, 1);
  assert.ok(roster.workers[bridge.workers[0]]);
  assert.equal(
    roster.workers[bridge.workers[0]].dispatch.launch.mode,
    "prompt",
  );
  assert.ok(roster.workers[bridge.workers[0]].rendezvousSock);
  assert.ok(roster.workers[bridge.workers[0]].ptySock);

  await bridge.close();

  const cleaned = JSON.parse(await fs.readFile(paths.rosterPath, "utf8"));
  assert.ok(cleaned.workers.existing);
  assert.equal(cleaned.workers[bridge.workers[0]], undefined);
  await fs.rm(tmp, { recursive: true, force: true });
});

test("Claude native bridge exposes RV state and PTY frames", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-native-prod-"));
  const configDir = path.join(tmp, "claude");
  const bridge = await startClaudeNativeBridge({
    sessionName: "session-prod-io",
    assignments: [{ cli: "codex", role: "executor", prompt: "do work" }],
    configDir,
    tmpRoot: tmp,
  });
  const paths = deriveClaudeDaemonPaths({ configDir });
  const roster = JSON.parse(await fs.readFile(paths.rosterPath, "utf8"));
  const entry = roster.workers[bridge.workers[0]];

  bridge.handleProgress({
    type: "progress",
    paneName: "worker-1",
    cli: "codex",
    snapshot: "first line\nlatest progress",
  });

  const rv = await readJsonLine(entry.rendezvousSock);
  assert.equal(rv.type, "heartbeat");

  const frames = await readPtyFrames(entry.ptySock);
  assert.equal(frames[0].kind, 1);
  assert.equal(frames[0].ctrl.t, "hello");
  assert.ok(frames.some((frame) => frame.kind === 0));

  await bridge.close();
  await fs.rm(tmp, { recursive: true, force: true });
});
