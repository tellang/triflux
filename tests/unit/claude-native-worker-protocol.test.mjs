import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

import {
  buildPtyControlFrame,
  buildPtyDataFrame,
  buildIsolatedDaemonEnv,
  decodePtyFrames,
  deriveDaemonPaths,
  extractPtyFrames,
  getProcStart,
  parseJsonLine,
  buildRosterEntry,
} from "../../experiments/native-bridge-feasibility/claude-native-worker-protocol.mjs";
import { startFakeNativeWorker } from "../../experiments/native-bridge-feasibility/fake-claude-native-worker.mjs";

test("deriveDaemonPaths uses Claude /tmp hash convention", () => {
  const configDir = path.join(os.tmpdir(), "fake-claude-config");
  const expectedHash = crypto
    .createHash("sha256")
    .update(path.resolve(configDir))
    .digest("hex")
    .slice(0, 8);

  const paths = deriveDaemonPaths({ configDir, uid: 501, tmpRoot: "/tmp" });

  assert.equal(paths.hash, expectedHash);
  assert.equal(paths.controlSock, `/tmp/cc-daemon-501/${expectedHash}/control.sock`);
  assert.equal(paths.rosterPath, path.join(configDir, "daemon", "roster.json"));
});

test("parseJsonLine parses the first newline-delimited JSON frame", () => {
  assert.deepEqual(parseJsonLine('{"ok":true}\n{"ignored":true}\n'), { ok: true });
});

test("PTY frame codec round trips data and control frames", () => {
  const combined = Buffer.concat([
    buildPtyDataFrame("hello"),
    buildPtyControlFrame({ t: "hello", replPid: 123, version: "2.1.145" }),
  ]);

  const frames = decodePtyFrames(combined);

  assert.equal(frames.length, 2);
  assert.equal(frames[0].kind, 0);
  assert.equal(frames[0].payload.toString("utf8"), "hello");
  assert.deepEqual(frames[1], {
    kind: 1,
    ctrl: { t: "hello", replPid: 123, version: "2.1.145" },
  });
});

test("PTY incremental codec preserves partial frames", () => {
  const firstFrame = buildPtyDataFrame("hello");
  const combined = Buffer.concat([
    firstFrame,
    buildPtyControlFrame({ t: "resize", cols: 100, rows: 30 }),
  ]);
  const first = extractPtyFrames(combined.subarray(0, combined.length - 3));

  assert.equal(first.frames.length, 1);
  assert.equal(first.rest.length, combined.length - 3 - firstFrame.length);

  const second = extractPtyFrames(Buffer.concat([first.rest, combined.subarray(combined.length - 3)]));
  assert.deepEqual(second.frames[0], { kind: 1, ctrl: { t: "resize", cols: 100, rows: 30 } });
  assert.equal(second.rest.length, 0);
});

test("buildIsolatedDaemonEnv scrubs credential-like Claude provider env", () => {
  const env = buildIsolatedDaemonEnv("/tmp/isolated-claude", {
    PATH: "/bin",
    HOME: "/Users/example",
    CLAUDE_CODE_OAUTH_TOKEN: "secret",
    ANTHROPIC_API_KEY: "secret",
    ANTHROPIC_BASE_URL: "https://example.invalid",
  });

  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/tmp/isolated-claude");
  assert.equal(env.CLAUDE_CONFIG_DIR, "/tmp/isolated-claude");
  assert.equal("CLAUDE_CODE_OAUTH_TOKEN" in env, false);
  assert.equal("ANTHROPIC_API_KEY" in env, false);
  assert.equal("ANTHROPIC_BASE_URL" in env, false);
});

test("getProcStart rejects non-integer pids before invoking ps", () => {
  assert.throws(() => getProcStart("1; echo bad"), /invalid pid/);
});

test("buildRosterEntry creates a schema-shaped worker entry", () => {
  const entry = buildRosterEntry({
    short: "feedface",
    pid: 12345,
    procStart: "Wed May 20 07:18:59 2026",
    cwd: "/tmp/project",
    startedAt: 1779261539079,
    rendezvousSock: "/tmp/fake.rv.sock",
    ptySock: "/tmp/fake.pty.sock",
    messagingSock: "/tmp/fake.msg.sock",
  });

  assert.equal(entry.pid, 12345);
  assert.equal(entry.procStart, "Wed May 20 07:18:59 2026");
  assert.equal(entry.dispatch.short, "feedface");
  assert.equal(entry.dispatch.launch.mode, "exec");
  assert.equal(entry.rendezvousSock, "/tmp/fake.rv.sock");
  assert.equal(entry.ptySock, "/tmp/fake.pty.sock");
  assert.equal(entry.messagingSock, "/tmp/fake.msg.sock");
});

test("buildRosterEntry can use prompt launch shape for RV-capable adoption", () => {
  const entry = buildRosterEntry({
    short: "feedface",
    pid: 12345,
    procStart: "Wed May 20 07:18:59 2026",
    cwd: "/tmp/project",
    rendezvousSock: "/tmp/fake.rv.sock",
    ptySock: "/tmp/fake.pty.sock",
    launchMode: "prompt",
  });

  assert.deepEqual(entry.dispatch.launch, {
    mode: "prompt",
    args: ["--", "tfx fake native worker"],
  });
});

test("fake native worker accepts RV and PTY connections", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fake-native-worker-"));
  const rvSock = path.join(dir, "worker.rv.sock");
  const ptySock = path.join(dir, "worker.pty.sock");
  const worker = await startFakeNativeWorker({ rvSock, ptySock, pid: process.pid });

  try {
    const rv = net.connect(rvSock);
    await once(rv, "connect");
    rv.write('{"proto":1,"role":"supervisor","supervisorPid":123}\n');
    const rvData = await once(rv, "data");
    assert.match(rvData[0].toString("utf8"), /"type":"heartbeat"/);
    rv.destroy();

    const pty = net.connect(ptySock);
    await once(pty, "connect");
    const ptyData = await once(pty, "data");
    const frames = decodePtyFrames(ptyData[0]);
    assert.deepEqual(frames[0].ctrl, { t: "hello", replPid: process.pid, version: "2.1.145" });
    assert.equal(frames.some((frame) => frame.kind === 0), true);
    pty.destroy();
  } finally {
    await worker.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
