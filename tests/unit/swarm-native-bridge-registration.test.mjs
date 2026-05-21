import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  deriveClaudeDaemonPaths,
  registerSwarmShard,
} from "../../hub/team/claude-native-bridge.mjs";

async function listenDaemon(sockPath) {
  const requests = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk;
      if (!data.includes("\n")) return;
      const request = JSON.parse(data.slice(0, data.indexOf("\n")));
      requests.push(request);
      if (request.op === "list") {
        socket.end(
          `${JSON.stringify({
            ok: true,
            jobs: [
              {
                short: requests[0]?.d?.short,
                pid: process.pid,
                startedAt: 1234,
              },
            ],
          })}\n`,
        );
        return;
      }
      socket.end(`${JSON.stringify({ ok: true })}\n`);
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, resolve);
  });

  return { server, requests };
}

test("local shard registers Triflux swarm shard row with shard display name", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-swarm-bridge-"));
  const configDir = path.join(tmp, "claude");
  const paths = deriveClaudeDaemonPaths({ configDir });
  await fs.mkdir(paths.daemonDir, { recursive: true });
  const { server, requests } = await listenDaemon(paths.controlSock);

  try {
    const expectedDisplayName = "Triflux swarm run42 02/05 codex api";
    const registration = await registerSwarmShard({
      sessionId: "swarm-run42-api-feedface",
      cli: "codex",
      role: "executor",
      swarmName: "run42",
      shardIndex: 2,
      shardCount: 5,
      shardName: "api",
      cwd: "/tmp/project",
      host: "local",
      configDir,
    });

    const dispatch = requests.find((request) => request.op === "dispatch");
    assert.equal(registration.skipped, false);
    assert.match(dispatch.d.short, /^[a-f0-9]{8}$/u);
    assert.match(dispatch.d.sessionId, /^[a-f0-9]{8}-/u);
    assert.notEqual(dispatch.d.sessionId, "swarm-run42-api-feedface");
    assert.equal(registration.swarmSessionId, "swarm-run42-api-feedface");
    assert.equal(registration.sessionId, dispatch.d.sessionId);
    assert.equal(registration.displayName, expectedDisplayName);
    assert.equal(dispatch.d.cwd, "/tmp/project");
    assert.equal(dispatch.d.seed.name, expectedDisplayName);
    assert.equal(dispatch.d.seed.intent, expectedDisplayName);

    const projection = JSON.parse(
      await fs.readFile(path.join(paths.sessionsDir, `${process.pid}.json`)),
    );
    await fs.mkdir(path.join(paths.jobsDir, dispatch.d.short), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(paths.jobsDir, dispatch.d.short, "state.json"),
      JSON.stringify({ name: expectedDisplayName }),
      "utf8",
    );
    assert.equal(projection.name, expectedDisplayName);
    assert.equal(projection.agent, "codex");
    assert.equal(projection.sessionId, dispatch.d.sessionId);
    assert.equal(projection.jobId, dispatch.d.short);
    assert.equal(projection.bridgeSessionId, `session_${dispatch.d.short}`);

    await registration.close();
    await assert.rejects(
      fs.access(path.join(paths.jobsDir, dispatch.d.short, "state.json")),
      /ENOENT/u,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("remote shard skips native bridge registration and emits warning", async () => {
  const warnings = [];
  const registration = await registerSwarmShard({
    sessionId: "swarm-run42-api-feedface",
    cli: "codex",
    role: "executor",
    shardName: "api",
    cwd: "/tmp/project",
    host: "ultra4",
    swarmName: "run42",
    shardIndex: 1,
    shardCount: 2,
    _deps: {
      warn(message) {
        warnings.push(message);
      },
      sendClaudeControlRequest() {
        throw new Error("remote shard must not dispatch locally");
      },
    },
  });

  assert.equal(registration.skipped, true);
  assert.equal(registration.host, "ultra4");
  assert.equal(registration.displayName, "Triflux swarm run42 01/02 codex api");
  assert.match(warnings[0], /remote shard.*ultra4.*skipping/u);
});
