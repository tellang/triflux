import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildDaemonExecDispatchPayload,
  deriveClaudeDaemonPaths,
  findDaemonJobByShort,
  sendClaudeControlRequest,
  sendKillBySessionId,
} from "../../hub/team/claude-daemon-control.mjs";

function listenJsonServer(sockPath, handler) {
  const requests = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let data = "";
    socket.on("data", async (chunk) => {
      data += chunk;
      if (!data.includes("\n")) return;
      const line = data.slice(0, data.indexOf("\n"));
      const request = JSON.parse(line);
      requests.push(request);
      const response = await handler(request);
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, () => resolve({ server, requests }));
  });
}

test("deriveClaudeDaemonPaths matches Claude daemon hash convention", () => {
  const configDir = path.join(os.tmpdir(), "claude-control-test");
  const hash = crypto
    .createHash("sha256")
    .update(path.resolve(configDir))
    .digest("hex")
    .slice(0, 8);

  const paths = deriveClaudeDaemonPaths({
    configDir,
    uid: 501,
    tmpRoot: "/tmp",
  });

  assert.equal(paths.configDir, path.resolve(configDir));
  assert.equal(paths.daemonDir, `/tmp/cc-daemon-501/${hash}`);
  assert.equal(paths.controlSock, `/tmp/cc-daemon-501/${hash}/control.sock`);
  assert.equal(
    paths.sessionsDir,
    path.join(path.resolve(configDir), "sessions"),
  );
});

test("sendClaudeControlRequest sends one JSON line and parses first response line", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-control-"));
  const sockPath = path.join(dir, "control.sock");
  const { server, requests } = await listenJsonServer(sockPath, (request) => ({
    ok: true,
    op: request.op,
    jobs: [],
  }));

  try {
    const response = await sendClaudeControlRequest(sockPath, {
      proto: 1,
      op: "list",
    });

    assert.deepEqual(response, { ok: true, op: "list", jobs: [] });
    assert.deepEqual(requests, [{ proto: 1, op: "list" }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("buildDaemonExecDispatchPayload names a Triflux worker and launches shell exec", () => {
  const payload = buildDaemonExecDispatchPayload({
    short: "a1b2c3d4",
    cwd: "/tmp/project",
    command: "printf ok",
    name: "Triflux codex executor",
    createdAt: 1234,
    cols: 100,
    rows: 30,
  });

  assert.equal(payload.proto, 1);
  assert.equal(payload.short, "a1b2c3d4");
  assert.match(payload.sessionId, /^a1b2c3d4-/);
  assert.equal(payload.source, "shell");
  assert.equal(payload.cwd, "/tmp/project");
  assert.deepEqual(payload.launch, {
    mode: "exec",
    cmd: "/bin/zsh",
    args: ["-lc", "printf ok"],
  });
  assert.equal(payload.seed.name, "Triflux codex executor");
});

test("findDaemonJobByShort returns a daemon list job by short id", () => {
  const job = findDaemonJobByShort(
    { ok: true, jobs: [{ short: "11111111" }, { short: "22222222", pid: 42 }] },
    "22222222",
  );

  assert.deepEqual(job, { short: "22222222", pid: 42 });
  assert.equal(findDaemonJobByShort({ ok: true, jobs: [] }, "missing"), null);
});

test("killDaemonJobBySessionId resolves short then sends kill", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-kill-session-"));
  const sockPath = path.join(dir, "control.sock");
  const seen = [];
  const { server } = await listenJsonServer(sockPath, (request) => {
    seen.push(request);
    if (request.op === "list") {
      return {
        ok: true,
        op: "list",
        jobs: [
          { short: "keep1111", sessionId: "other-session" },
          { short: "kill2222", sessionId: "session-target" },
        ],
      };
    }
    return { ok: true, op: request.op, killed: request.short };
  });

  try {
    const result = await sendKillBySessionId({
      daemonPaths: { controlSock: sockPath },
      sessionId: "session-target",
    });

    assert.equal(result.ok, true);
    assert.equal(result.killed, "kill2222");
    assert.deepEqual(seen, [
      { proto: 1, op: "list" },
      { proto: 1, op: "kill", short: "kill2222" },
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
