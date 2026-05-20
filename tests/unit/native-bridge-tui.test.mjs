import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseTeamArgs } from "../../hub/team/cli/commands/start/parse-args.mjs";
import { writeBridgeSession } from "../../hub/team/headless-bridge-session.mjs";

// Setup Mock State Dir
const MOCK_STATE_DIR = path.join(
  os.tmpdir(),
  `mock-claude-state-${Date.now()}`,
);

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

test("CLI start parser should default nativeBridge to false", () => {
  const result = parseTeamArgs(["start"]);
  assert.equal(
    result.nativeBridge,
    false,
    "nativeBridge should default to false",
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

test("runHeadless must bypass psmux loop when nativeBridge option is true", async () => {
  const { runHeadless } = await import("../../hub/team/headless.mjs");

  const result = await runHeadless("session_nb_test", [], {
    nativeBridge: true,
  });

  assert.equal(result.bypassed, true, "Should bypass and return bypassed true");
  assert.equal(result.status, "ok", "Should return status ok");
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
