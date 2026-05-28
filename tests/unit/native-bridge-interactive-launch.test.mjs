import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { describe, it } from "node:test";

import {
  buildPtyControlFrame,
  buildPtyDataFrame,
  deriveClaudeDaemonPaths,
  extractPtyFrames,
  startClaudeNativeBridge,
} from "../../hub/team/claude-native-bridge.mjs";
import { parseTeamArgs } from "../../hub/team/cli/commands/start/parse-args.mjs";
import { createSwarmHypervisor } from "../../hub/team/swarm-hypervisor.mjs";
import { planSwarm } from "../../hub/team/swarm-planner.mjs";

function createFakeTransportFactory() {
  const transports = [];
  const createTransport = (options) => {
    const transport = {
      options,
      startCalls: 0,
      stopCalls: 0,
      writeInputValues: [],
      resizeCalls: [],
      async start() {
        this.startCalls += 1;
      },
      async writeInput(value) {
        this.writeInputValues.push(Buffer.from(value));
      },
      async resize(value) {
        this.resizeCalls.push(value);
      },
      async stop() {
        this.stopCalls += 1;
      },
      emit(chunk) {
        options.onData(chunk);
      },
    };
    transports.push(transport);
    return transport;
  };
  return { createTransport, transports };
}

async function connectPty(sockPath) {
  const socket = net.connect(sockPath);
  await once(socket, "connect");
  socket.unref();
  return socket;
}

async function waitForFrame(socket, predicate, { timeoutMs = 1000 } = {}) {
  let buffer = Buffer.alloc(0);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const chunk = await Promise.race([
      once(socket, "data").then(([value]) => value),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("timed out waiting for frame")),
          remaining,
        ),
      ),
    ]);
    buffer = Buffer.concat([buffer, chunk]);
    const result = extractPtyFrames(buffer);
    buffer = result.rest;
    const match = result.frames.find(predicate);
    if (match) return match;
  }
  throw new Error("timed out waiting for frame");
}

async function waitForCondition(predicate, message, { timeoutMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

test("startClaudeNativeBridge interactive workers launch tmux transport from worker cwd", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-native-int-"));
  const configDir = path.join(tmp, "claude");
  const fake = createFakeTransportFactory();
  const bridge = await startClaudeNativeBridge({
    sessionName: "session-interactive",
    assignments: [
      {
        cli: "codex",
        role: "executor",
        prompt: "do work",
        cwd: "/tmp/shard-worktree",
      },
    ],
    configDir,
    workerType: "interactive",
    launchCmd: "codex",
    createTransport: fake.createTransport,
  });
  const paths = deriveClaudeDaemonPaths({ configDir });
  const roster = JSON.parse(await fs.readFile(paths.rosterPath, "utf8"));
  const entry = roster.workers[bridge.workers[0]];
  const transport = fake.transports[0];
  const socket = await connectPty(entry.ptySock);

  try {
    await waitForFrame(
      socket,
      (frame) => frame.kind === 1 && frame.ctrl?.t === "live",
    );
    assert.equal(fake.transports.length, 1);
    assert.equal(transport.startCalls, 1);
    assert.match(
      transport.options.sessionName,
      /^session-interactive-worker-1/u,
    );
    assert.equal(transport.options.cwd, "/tmp/shard-worktree");
    assert.equal(transport.options.launchCmd, "codex");
    assert.deepEqual(entry.dispatch.env, {});
    assert.equal(entry.cwd, "/tmp/shard-worktree");

    socket.write(buildPtyDataFrame("hello\n"));
    await waitForCondition(
      () => transport.writeInputValues.length === 1,
      "timed out waiting for transport input",
    );
    assert.equal(transport.writeInputValues[0].toString("utf8"), "hello\n");

    transport.emit("codex output\n");
    const outputFrame = await waitForFrame(socket, (frame) => frame.kind === 0);
    assert.equal(outputFrame.payload.toString("utf8"), "codex output\n");

    socket.write(buildPtyControlFrame({ t: "resize", cols: 100, rows: 33 }));
    await waitForCondition(
      () => transport.resizeCalls.length === 1,
      "timed out waiting for transport resize",
    );
    assert.deepEqual(transport.resizeCalls, [{ cols: 100, rows: 33 }]);

    socket.write(buildPtyControlFrame({ t: "kill", sig: "SIGTERM" }));
    await waitForCondition(
      () => transport.stopCalls === 1,
      "timed out waiting for transport stop",
    );
  } finally {
    socket.destroy();
    await bridge.close().catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("CLI start parser accepts native bridge interactive attach mode", () => {
  const result = parseTeamArgs([
    "start",
    "--teammate-mode",
    "headless",
    "--native-bridge-mode",
    "interactive-attach",
  ]);

  assert.equal(result.nativeBridge, true);
  assert.equal(result.nativeBridgeMode, "interactive-attach");
});

describe("swarm native bridge interactive shard registration", () => {
  const INTERACTIVE_PRD = `
## Shard: worker-a
- agent: codex
- interactive: true
- files: src/a.mjs
- prompt: echo test a
`;

  function makeTmpDir() {
    const dir = path.join(
      os.tmpdir(),
      `tfx-native-int-hv-${process.pid}-${Date.now()}`,
    );
    return fs.mkdir(dir, { recursive: true }).then(() => dir);
  }

  it("passes interactive shard registration the shard worktree cwd", async () => {
    const workdir = await makeTmpDir();
    const logsDir = path.join(workdir, "logs");
    const registerCalls = [];
    const conductors = [];
    const createConductor = () => {
      const conductor = {
        sessionConfig: null,
        spawnSession(config) {
          this.sessionConfig = config;
        },
        on() {},
        getSnapshot() {
          return [];
        },
        shutdown() {},
      };
      conductors.push(conductor);
      return conductor;
    };

    const hv = createSwarmHypervisor({
      workdir,
      logsDir,
      runId: "interactive-native-bridge",
      nativeBridge: true,
      graceMs: 1,
      keepFailedWorktrees: true,
      _deps: {
        createConductor,
        registerSwarmShard: async (opts) => {
          registerCalls.push(opts);
          return { displayName: "Triflux swarm interactive", close() {} };
        },
        ensureWorktree: async ({ slug, runId }) => ({
          worktreePath: `${workdir}/.codex-swarm/wt-${slug}`,
          branchName: `swarm/${runId}/${slug}`,
        }),
      },
    });

    try {
      await hv.launch(planSwarm(null, { content: INTERACTIVE_PRD }));

      assert.equal(registerCalls.length, 1);
      assert.equal(registerCalls[0].interactive, true);
      assert.equal(registerCalls[0].cwd, `${workdir}/.codex-swarm/wt-worker-a`);
      assert.equal(registerCalls[0].sessionId, conductors[0].sessionConfig.id);
    } finally {
      await hv.shutdown("test_cleanup").catch(() => {});
      await fs.rm(workdir, { recursive: true, force: true });
    }
  });
});
