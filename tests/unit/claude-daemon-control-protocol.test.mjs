import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import fs from "node:fs/promises";

import {
  buildDispatchPayload,
  deriveDaemonPaths,
  readJsonLine,
  redactControlResponse,
  redactSubscribeMessages,
  sendControlRequest,
} from "../../experiments/native-bridge-feasibility/claude-daemon-dispatch-poc.mjs";

test("deriveDaemonPaths matches Claude daemon temp path convention", () => {
  const configDir = path.join(os.tmpdir(), "fake-claude-config");
  const expectedHash = crypto
    .createHash("sha256")
    .update(path.resolve(configDir))
    .digest("hex")
    .slice(0, 8);

  const paths = deriveDaemonPaths({ configDir, uid: 501, tmpRoot: "/tmp" });

  assert.equal(paths.configDir, configDir);
  assert.equal(paths.hash, expectedHash);
  assert.equal(paths.daemonDir, `/tmp/cc-daemon-501/${expectedHash}`);
  assert.equal(paths.controlSock, `/tmp/cc-daemon-501/${expectedHash}/control.sock`);
});

test("deriveDaemonPaths defaults to Claude's /tmp daemon root on macOS", () => {
  const configDir = path.join(os.tmpdir(), "fake-claude-config");
  const paths = deriveDaemonPaths({ configDir, uid: 501 });

  assert.match(paths.daemonDir, /^\/tmp\/cc-daemon-501\/[a-f0-9]{8}$/);
  assert.equal(paths.controlSock, path.join(paths.daemonDir, "control.sock"));
});

test("buildDispatchPayload creates a schema-compatible exec dispatch", () => {
  const payload = buildDispatchPayload({
    short: "deadbeef",
    cwd: "/tmp/project",
    createdAt: 1234,
    mode: "exec",
    command: "/bin/sh",
    args: ["-lc", "printf ok"],
  });

  assert.equal(payload.proto, 1);
  assert.equal(payload.short, "deadbeef");
  assert.match(payload.sessionId, /^deadbeef-/);
  assert.equal(payload.source, "shell");
  assert.equal(payload.cwd, "/tmp/project");
  assert.deepEqual(payload.launch, {
    mode: "exec",
    cmd: "/bin/sh",
    args: ["-lc", "printf ok"],
  });
  assert.deepEqual(payload.env, {});
  assert.equal(payload.isolation, "none");
  assert.deepEqual(payload.respawnFlags, []);
});

test("readJsonLine parses the first JSON line and leaves later bytes alone", () => {
  const parsed = readJsonLine('{"ok":true,"op":"list"}\n{"ignored":true}\n');
  assert.deepEqual(parsed, { ok: true, op: "list" });
});

test("redactControlResponse removes live worker prompt details from list reports", () => {
  const redacted = redactControlResponse({
    ok: true,
    op: "list",
    jobs: [
      {
        short: "deadbeef",
        pid: 123,
        sessionId: "deadbeef-1111-2222-3333-444444444444",
        state: "working",
        tempo: "active",
        cwd: "/tmp/project",
        name: "demo",
        detail: "private progress detail",
        intent: "private prompt",
        needs: "private needs",
      },
    ],
  });

  assert.deepEqual(redacted, {
    ok: true,
    op: "list",
    jobs: [
      {
        short: "deadbeef",
        pid: 123,
        sessionId: "deadbeef-1111-2222-3333-444444444444",
        state: "working",
        tempo: "active",
        cwd: "/tmp/project",
        name: "demo",
      },
    ],
  });
});

test("redactSubscribeMessages removes record intent and detail", () => {
  const redacted = redactSubscribeMessages([
    {
      type: "snapshot",
      record: {
        short: "deadbeef",
        pid: 123,
        sessionId: "deadbeef-1111-2222-3333-444444444444",
        state: "running",
        tempo: "active",
        cwd: "/tmp/project",
        detail: "private progress detail",
        intent: "private prompt",
      },
      streamTail: ["ok"],
    },
    {
      type: "state",
      patch: {
        detail: "private progress detail",
        outcome: "done",
      },
    },
    {
      type: "stream",
      line: "ok",
    },
  ]);

  assert.deepEqual(redacted, [
    {
      type: "snapshot",
      record: {
        short: "deadbeef",
        pid: 123,
        sessionId: "deadbeef-1111-2222-3333-444444444444",
        state: "running",
        tempo: "active",
        cwd: "/tmp/project",
      },
      streamTail: ["ok"],
    },
    {
      type: "state",
      patch: {
        outcome: "done",
      },
    },
    {
      type: "stream",
      bytes: 2,
    },
  ]);
});


test("sendControlRequest speaks Claude daemon JSON-line control protocol", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-daemon-test-"));
  const sock = path.join(dir, "control.sock");
  const seen = [];
  const server = net.createServer((conn) => {
    conn.setEncoding("utf8");
    let data = "";
    conn.on("data", (chunk) => {
      data += chunk;
      if (!data.includes("\n")) return;
      seen.push(JSON.parse(data.slice(0, data.indexOf("\n"))));
      conn.end(`${JSON.stringify({ ok: true, op: "list", jobs: [] })}\n`);
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(sock, resolve);
  });

  try {
    const response = await sendControlRequest(
      sock,
      { proto: 1, op: "list" },
      { timeoutMs: 1000 },
    );
    assert.deepEqual(response, { ok: true, op: "list", jobs: [] });
    assert.deepEqual(seen, [{ proto: 1, op: "list" }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
