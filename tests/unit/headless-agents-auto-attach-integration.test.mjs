import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function writeFakeMux(binPath, logPath, statePath) {
  const source = `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n", "utf8");
const statePath = ${JSON.stringify(statePath)};
const state = JSON.parse(readFileSync(statePath, "utf8"));
const saveState = () => writeFileSync(statePath, JSON.stringify(state), "utf8");
const recordLifecycle = (type, session) => {
  state.events.push({ type, session, active: Object.keys(state.sessions).sort() });
  saveState();
};
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : "";
};
const rawTarget = valueAfter("-s") || valueAfter("-t") || "observer";
const session = rawTarget.split(":")[0];
const format = valueAfter("-F");

if (args[0] === "has-session") {
  recordLifecycle(state.sessions[session] ? "has-present" : "has-absent", session);
  process.exit(state.sessions[session] ? 0 : 1);
}
if (args[0] === "new-session") {
  if (state.sessions[session]) {
    recordLifecycle("new-duplicate", session);
    process.exit(11);
  }
  state.sessions[session] = true;
  recordLifecycle("new", session);
  process.stdout.write(session + ":0.0\\n");
  process.exit(0);
}
if (args[0] === "kill-session") {
  if (!state.sessions[session]) {
    recordLifecycle("kill-missing", session);
    process.exit(1);
  }
  delete state.sessions[session];
  recordLifecycle("kill", session);
  process.exit(0);
}
if (
  process.env.FAKE_MUX_FAIL_INIT === "1" &&
  args[0] === "select-layout"
) {
  process.exit(8);
}
if (
  process.env.FAKE_MUX_FAIL_VIEWER === "1" &&
  args[0] === "send-keys" &&
  args.some((arg) => arg.includes("tui-viewer.mjs"))
) {
  process.exit(9);
}
if (
  process.env.FAKE_MUX_FAIL_ATTACH === "1" &&
  args[0] === "split-window" &&
  args.includes("attach-session")
) {
  process.exit(10);
}

if (args[0] === "list-panes") {
  if (format.includes("pane_pid")) {
    process.stdout.write("");
  } else if (format.includes("pane_dead")) {
    process.stdout.write("0\\tlead\\t" + session + ":0.0\\t0\\t\\n");
  } else {
    process.stdout.write("0\\t" + session + ":0.0\\n");
  }
} else if (args[0] === "list-sessions") {
  process.stdout.write(format === "#{session_attached}" ? "0\\n" : "");
}
`;
  await fs.writeFile(binPath, source, { mode: 0o755 });
}

async function listenFakeClaudeDaemon(controlSock) {
  const jobs = new Map();
  const requests = [];
  const sockets = new Set();
  await fs.mkdir(path.dirname(controlSock), { recursive: true });

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline));
      requests.push(request);

      if (request.op === "dispatch") {
        const command = request.d?.launch?.args?.at(-1) || "";
        const token =
          command.match(/__TFX_HEADLESS_DONE__:([^:"]+):/u)?.[1] || "missing";
        const resultFile =
          command.match(/(\/[^'\s]+\/tfx-headless\/[^'\s]+\.txt)/u)?.[1] || "";
        jobs.set(request.d.short, {
          short: request.d.short,
          sessionId: request.d.sessionId,
          bridgeSessionId: `bridge-${request.d.short}`,
          pid: process.pid,
          startedAt: Date.now(),
          token,
          resultFile,
        });
        socket.end(`${JSON.stringify({ ok: true, op: "dispatch" })}\n`);
        return;
      }

      if (request.op === "list") {
        socket.end(
          `${JSON.stringify({ ok: true, op: "list", jobs: [...jobs.values()] })}\n`,
        );
        return;
      }

      if (request.op === "subscribe") {
        const job = jobs.get(request.short);
        if (job?.resultFile) {
          await fs.writeFile(
            job.resultFile,
            "status: ok\nlead_action: accept\nverdict: fake daemon completed\nconfidence: high\nfiles_changed: []\n",
            "utf8",
          );
        }
        socket.write(
          `${JSON.stringify({ line: `live:${request.short}\n` })}\n`,
        );
        socket.end(
          `${JSON.stringify({ line: `__TFX_HEADLESS_DONE__:${job?.token}:0\n` })}\n`,
        );
        return;
      }

      if (request.op === "kill") {
        socket.end(`${JSON.stringify({ ok: true, op: "kill" })}\n`);
        return;
      }

      socket.end(`${JSON.stringify({ ok: false, error: "unsupported" })}\n`);
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(controlSock, resolve);
  });

  return {
    requests,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("default agents headless flow queues one file-viewer command and requests one tmux observation split", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agents-observer-red-"));
  const muxLog = path.join(tmp, "mux.jsonl");
  const muxStatePath = path.join(tmp, "mux-state.json");
  const fakeMux = path.join(tmp, "fake-mux.mjs");
  const configDir = path.join(tmp, "claude-config");
  const originalEnv = {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    PSMUX_BIN: process.env.PSMUX_BIN,
    TFX_HUB_PIPE: process.env.TFX_HUB_PIPE,
    TFX_HUB_URL: process.env.TFX_HUB_URL,
    TMUX: process.env.TMUX,
    TMUX_PANE: process.env.TMUX_PANE,
    FAKE_MUX_FAIL_ATTACH: process.env.FAKE_MUX_FAIL_ATTACH,
    FAKE_MUX_FAIL_INIT: process.env.FAKE_MUX_FAIL_INIT,
    FAKE_MUX_FAIL_VIEWER: process.env.FAKE_MUX_FAIL_VIEWER,
  };
  let daemon;

  try {
    await fs.writeFile(
      muxStatePath,
      JSON.stringify({ sessions: {}, events: [] }),
      "utf8",
    );
    await writeFakeMux(fakeMux, muxLog, muxStatePath);
    process.env.CLAUDE_CONFIG_DIR = configDir;
    process.env.PSMUX_BIN = fakeMux;
    process.env.TFX_HUB_PIPE = path.join(tmp, "missing-hub.sock");
    process.env.TFX_HUB_URL = "http://127.0.0.1:9";
    process.env.TMUX = path.join(tmp, "tmux.sock") + ",1234,0";
    process.env.TMUX_PANE = "%7";

    const { deriveClaudeDaemonPaths } = await import(
      "../../hub/team/claude-daemon-control.mjs"
    );
    daemon = await listenFakeClaudeDaemon(
      deriveClaudeDaemonPaths({ configDir }).controlSock,
    );

    const { parseTeamArgs } = await import(
      "../../hub/team/cli/commands/start/parse-args.mjs"
    );
    const { startHeadlessTeam } = await import(
      "../../hub/team/cli/commands/start/start-headless.mjs"
    );
    const parsed = parseTeamArgs([
      "--teammate-mode",
      "headless",
      "default agents observer",
    ]);
    assert.equal(parsed.autoAttach, true);
    assert.equal(parsed.dashboard, true);
    assert.equal(parsed.nativeBridge, true);
    assert.equal(parsed.nativeBridgeMode, "agents");

    const runCase = async ({
      dashboard = false,
      autoAttach = true,
      tmuxAttached = true,
      failAttach = false,
      failInit = false,
      failViewer = false,
      foreignSession = false,
    } = {}) => {
      const sessionId = `agents-observer-${randomUUID().slice(0, 8)}`;
      if (tmuxAttached) {
        process.env.TMUX = path.join(tmp, "tmux.sock") + ",1234,0";
        process.env.TMUX_PANE = "%7";
      } else {
        delete process.env.TMUX;
        delete process.env.TMUX_PANE;
      }
      if (failAttach) process.env.FAKE_MUX_FAIL_ATTACH = "1";
      else delete process.env.FAKE_MUX_FAIL_ATTACH;
      if (failInit) process.env.FAKE_MUX_FAIL_INIT = "1";
      else delete process.env.FAKE_MUX_FAIL_INIT;
      if (failViewer) process.env.FAKE_MUX_FAIL_VIEWER = "1";
      else delete process.env.FAKE_MUX_FAIL_VIEWER;
      if (foreignSession) {
        const state = JSON.parse(await fs.readFile(muxStatePath, "utf8"));
        state.sessions[sessionId] = true;
        await fs.writeFile(muxStatePath, JSON.stringify(state), "utf8");
      }

      try {
        await startHeadlessTeam({
          sessionId,
          task: parsed.task,
          lead: parsed.lead,
          agents: parsed.agents,
          subtasks: parsed.agents.map((agent) => `fake ${agent} task`),
          layout: parsed.layout,
          assigns: parsed.assigns,
          autoAttach,
          progressive: parsed.progressive,
          timeoutSec: 5,
          verbose: false,
          dashboard,
          dashboardLayout: parsed.dashboardLayout,
          dashboardSize: parsed.dashboardSize,
          dashboardAnchor: parsed.dashboardAnchor,
          nativeBridge: parsed.nativeBridge,
          nativeBridgeMode: parsed.nativeBridgeMode,
        });
      } finally {
        delete process.env.FAKE_MUX_FAIL_ATTACH;
        delete process.env.FAKE_MUX_FAIL_INIT;
        delete process.env.FAKE_MUX_FAIL_VIEWER;
      }
      return sessionId;
    };

    const sessionIds = [
      await runCase({ dashboard: true }),
      await runCase({ dashboard: false }),
    ];
    const autoAttachDisabledId = await runCase({ autoAttach: false });
    const tmuxMissingId = await runCase({ tmuxAttached: false });
    const viewerFailureId = await runCase({ failViewer: true });
    const attachFailureId = await runCase({ failAttach: true });
    const initializationFailureId = await runCase({ failInit: true });
    const foreignDuplicateId = await runCase({ foreignSession: true });

    const muxCalls = (await fs.readFile(muxLog, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const muxState = JSON.parse(await fs.readFile(muxStatePath, "utf8"));
    assert.equal(
      daemon.requests.filter((request) => request.op === "dispatch").length,
      parsed.agents.length * 8,
      "the real nativeBridgeMode=agents dispatch branch must run",
    );
    assert.ok(
      daemon.requests.some((request) => request.op === "kill"),
      "daemon cleanup must remain active",
    );

    for (const sessionId of sessionIds) {
      const sessionCalls = muxCalls.filter((args) =>
        args.some((arg) => String(arg).includes(sessionId)),
      );
      const attachSplits = sessionCalls.filter(
        (args) => args[0] === "split-window" && args.includes("attach-session"),
      );
      const observerCommands = sessionCalls.filter(
        (args) =>
          args[0] === "send-keys" &&
          args.includes("-l") &&
          args.some(
            (arg) =>
              arg.includes("tui-viewer.mjs") &&
              arg.includes("--source files") &&
              arg.includes(`--workers ${parsed.agents.length}`),
          ),
      );
      const cleanupCalls = sessionCalls.filter(
        (args) => args[0] === "kill-session",
      );

      assert.equal(
        attachSplits.length,
        1,
        `session ${sessionId} must expose exactly one observation split: ${JSON.stringify(sessionCalls)}`,
      );
      assert.equal(
        observerCommands.length,
        1,
        "the fake mux must receive one file-viewer command; send-keys does not execute it",
      );
      assert.equal(
        cleanupCalls.length,
        1,
        "observer cleanup must use mux boundary",
      );
      assert.deepEqual(attachSplits[0].slice(0, 7), [
        "split-window",
        "-v",
        "-l",
        "30%",
        "-t",
        "%7",
        "env",
      ]);
      assert.ok(
        sessionCalls.indexOf(observerCommands[0]) <
          sessionCalls.indexOf(attachSplits[0]),
        "the viewer command must be queued before the outer attach is requested",
      );
    }

    for (const sessionId of [autoAttachDisabledId, tmuxMissingId]) {
      const sessionCalls = muxCalls.filter((args) =>
        args.some((arg) => String(arg).includes(sessionId)),
      );
      assert.equal(
        sessionCalls.filter((args) => args[0] === "new-session").length,
        0,
        "observer session must not be created when observation is disabled",
      );
      assert.equal(
        sessionCalls.filter(
          (args) =>
            args[0] === "split-window" && args.includes("attach-session"),
        ).length,
        0,
      );
    }

    const viewerFailureCalls = muxCalls.filter((args) =>
      args.some((arg) => String(arg).includes(viewerFailureId)),
    );
    assert.equal(
      viewerFailureCalls.filter((args) => args[0] === "new-session").length,
      1,
    );
    assert.equal(
      viewerFailureCalls.filter(
        (args) => args[0] === "split-window" && args.includes("attach-session"),
      ).length,
      0,
      "viewer creation failure must not expose an empty outer pane",
    );
    assert.equal(
      viewerFailureCalls.filter((args) => args[0] === "kill-session").length,
      1,
      "partially-created observer session must be cleaned exactly once",
    );

    const attachFailureCalls = muxCalls.filter((args) =>
      args.some((arg) => String(arg).includes(attachFailureId)),
    );
    assert.equal(
      attachFailureCalls.filter(
        (args) => args[0] === "split-window" && args.includes("attach-session"),
      ).length,
      1,
      "outer viewer failure is fail-open after one attempt",
    );
    assert.equal(
      attachFailureCalls.filter((args) => args[0] === "kill-session").length,
      1,
      "owned observer cleanup runs exactly once after outer attach failure",
    );

    const initializationFailureCalls = muxCalls.filter((args) =>
      args.some((arg) => String(arg).includes(initializationFailureId)),
    );
    const initializationCommands = initializationFailureCalls.map(
      (args) => args[0],
    );
    assert.equal(
      initializationCommands.filter((command) => command === "new-session")
        .length,
      1,
    );
    assert.equal(
      initializationCommands.filter((command) => command === "select-layout")
        .length,
      1,
    );
    assert.equal(
      initializationCommands.filter((command) => command === "kill-session")
        .length,
      1,
      "transactional create rollback must be the only cleanup",
    );
    assert.equal(
      initializationCommands.filter((command) => command === "has-session")
        .length,
      0,
      "headless must not infer ownership from preflight or post-failure existence",
    );
    assert.equal(
      initializationFailureCalls.some(
        (args) =>
          args[0] === "send-keys" &&
          args.some((arg) => arg.includes("tui-viewer.mjs")),
      ),
      false,
      "viewer queuing must not start after transactional initialization fails",
    );
    assert.ok(
      initializationCommands.indexOf("new-session") <
        initializationCommands.indexOf("select-layout") &&
        initializationCommands.indexOf("select-layout") <
          initializationCommands.indexOf("kill-session"),
      "rollback must occur after the owned session's initialization failure",
    );

    const foreignDuplicateCalls = muxCalls.filter((args) =>
      args.some((arg) => String(arg).includes(foreignDuplicateId)),
    );
    assert.equal(
      foreignDuplicateCalls.filter((args) => args[0] === "new-session").length,
      1,
      "foreign duplicate is detected only by the transactional create attempt",
    );
    assert.equal(
      foreignDuplicateCalls.filter((args) => args[0] === "kill-session").length,
      0,
      "foreign duplicate must never cross the killPsmuxSession boundary",
    );
    assert.equal(
      foreignDuplicateCalls.filter((args) => args[0] === "has-session").length,
      0,
      "ownership must not be inferred from session existence",
    );
    assert.equal(
      foreignDuplicateCalls.some(
        (args) =>
          args[0] === "send-keys" &&
          args.some((arg) => arg.includes("tui-viewer.mjs")),
      ),
      false,
      "fake viewer command queue must stay untouched after duplicate create",
    );

    assert.deepEqual(
      muxState.sessions,
      { [foreignDuplicateId]: true },
      "only the pre-seeded foreign observation session must remain",
    );
    for (const sessionId of sessionIds) {
      assert.deepEqual(
        muxState.events
          .filter((event) => event.session === sessionId)
          .map((event) => event.type),
        ["new", "kill"],
        `session ${sessionId} must have one ownership acquisition and one release`,
      );
    }
    assert.deepEqual(
      muxState.events
        .filter((event) => event.session === initializationFailureId)
        .map((event) => event.type),
      ["new", "kill"],
      "owned-session rollback must not be followed by kill-missing",
    );
    assert.deepEqual(
      muxState.events
        .filter((event) => event.session === foreignDuplicateId)
        .map((event) => event.type),
      ["new-duplicate"],
      "foreign duplicate must survive without any cleanup transition",
    );
  } finally {
    await daemon?.close();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
