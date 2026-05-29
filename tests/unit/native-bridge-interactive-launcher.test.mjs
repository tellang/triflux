import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { parseBridgeConfig } from "../../hub/team/daemon-pty-tmux-bridge.mjs";
import { launchAdoptedInteractiveWorker } from "../../hub/team/interactive-native-launcher.mjs";

function createDispatchFakes() {
  const calls = {
    derive: [],
    dispatch: [],
    teardown: [],
    rosterWrites: [],
  };
  const paths = {
    controlSock: "/tmp/claude/control.sock",
    rosterPath: "/tmp/claude/daemon/roster.json",
    sessionsDir: "/tmp/claude/sessions",
    jobsDir: "/tmp/claude/jobs",
  };
  const deps = {
    deriveClaudeDaemonPaths(options) {
      calls.derive.push(options);
      return paths;
    },
    buildDaemonExecDispatchPayload(options) {
      calls.payload = options;
      return {
        proto: 1,
        short: options.short,
        sessionId: `${options.short}-session`,
        cwd: options.cwd,
        launch: {
          mode: "exec",
          cmd: "/bin/zsh",
          args: ["-lc", options.command],
        },
        seed: { name: options.name },
        cols: options.cols,
        rows: options.rows,
      };
    },
    async dispatchClaudeDaemonJob(options) {
      calls.dispatch.push(options);
      return {
        ok: true,
        short: options.payload.short,
        sessionId: options.payload.sessionId,
        pid: 12345,
        bridgeSessionId: "cse_daemon_pty",
        sessionProjectionPath: "/tmp/claude/sessions/projection.json",
      };
    },
    async teardownClaudeDaemonJob(options) {
      calls.teardown.push(options);
    },
    mergeRosterWorkers(...args) {
      calls.rosterWrites.push(args);
      throw new Error("roster adoption path must not be used");
    },
    startInteractiveNativeWorker() {
      throw new Error("roster-only worker must not be started");
    },
  };
  return { calls, deps, paths };
}

test("launchAdoptedInteractiveWorker dispatches a daemon exec job that runs the pty tmux bridge", async () => {
  const { calls, deps, paths } = createDispatchFakes();

  const handle = await launchAdoptedInteractiveWorker({
    cwd: "/tmp/project with spaces",
    sessionName: "tfx-session",
    launchCmd: "codex --profile gpt55_low",
    cli: "codex",
    role: "executor",
    configDir: "/tmp/claude",
    _deps: deps,
  });

  assert.match(handle.short, /^[a-f0-9]{8}$/);
  assert.equal(handle.displayName, "Triflux codex executor");
  assert.equal(handle.sessionId, `${handle.short}-session`);
  assert.equal(handle.pid, 12345);
  assert.equal(handle.bridgeSessionId, "cse_daemon_pty");
  assert.equal(
    handle.sessionProjectionPath,
    "/tmp/claude/sessions/projection.json",
  );
  assert.equal(handle.controlSock, paths.controlSock);

  assert.deepEqual(calls.derive, [{ configDir: "/tmp/claude" }]);
  assert.equal(calls.dispatch.length, 1);
  assert.equal(calls.dispatch[0].paths, paths);
  assert.equal(calls.dispatch[0].controlSock, paths.controlSock);
  assert.equal(calls.dispatch[0].agent, "codex");
  assert.equal(calls.dispatch[0].name, "Triflux codex executor");
  assert.equal(calls.dispatch[0].cwd, "/tmp/project with spaces");
  assert.equal(calls.dispatch[0].dispatchTimeoutMs, 5000);

  assert.equal(calls.payload.short, handle.short);
  assert.equal(calls.payload.cwd, "/tmp/project with spaces");
  assert.equal(calls.payload.name, "Triflux codex executor");
  assert.equal(calls.payload.cols, 120);
  assert.equal(calls.payload.rows, 40);
  assert.match(
    calls.payload.command,
    /^'[^']*node' '[^']*daemon-pty-tmux-bridge\.mjs' --config [A-Za-z0-9+/]+={0,2}$/,
  );

  const [, configArg] = calls.payload.command.match(
    / --config ([A-Za-z0-9+/]+={0,2})$/,
  );
  const bridgeConfig = parseBridgeConfig(["--config", configArg]);
  assert.deepEqual(bridgeConfig, {
    sessionName: "tfx-session",
    launchCmd: "codex --profile gpt55_low",
    cwd: path.resolve("/tmp/project with spaces"),
    env: {},
    cols: 120,
    rows: 40,
  });
  assert.equal(calls.rosterWrites.length, 0);

  await handle.close();
  await handle.close();

  assert.deepEqual(calls.teardown, [
    {
      controlSock: paths.controlSock,
      paths,
      short: handle.short,
      sessionProjectionPath: "/tmp/claude/sessions/projection.json",
      sessionId: `${handle.short}-session`,
    },
  ]);
});
