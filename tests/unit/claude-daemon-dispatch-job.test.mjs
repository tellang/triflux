import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  deriveClaudeDaemonPaths,
  dispatchClaudeDaemonJob,
  teardownClaudeDaemonJob,
} from "../../hub/team/claude-daemon-control.mjs";

// 데몬 control.sock 을 흉내내는 최소 서버. dispatch/list/kill 요청을 기록한다.
async function listenDaemon(sockPath, { short, pid, expectedAuth }) {
  const requests = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk;
      if (!data.includes("\n")) return;
      const request = JSON.parse(data.slice(0, data.indexOf("\n")));
      requests.push(request);
      if (
        request.op === "dispatch" &&
        expectedAuth !== undefined &&
        request.auth !== expectedAuth
      ) {
        socket.end(
          `${JSON.stringify({
            ok: false,
            code: "EAUTH",
            error: "dispatch rejected: invalid daemon control key",
          })}\n`,
        );
        return;
      }
      if (request.op === "list") {
        socket.end(
          `${JSON.stringify({
            ok: true,
            jobs: [{ short, pid, startedAt: 4321 }],
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

test("dispatchClaudeDaemonJob emits op:dispatch, resolves pid+bridge, writes projection", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-dispatch-job-"));
  const configDir = path.join(tmp, "claude");
  const paths = deriveClaudeDaemonPaths({ configDir });
  await fs.mkdir(paths.daemonDir, { recursive: true });
  const short = "abcd1234";
  const { server, requests } = await listenDaemon(paths.controlSock, {
    short,
    pid: process.pid,
  });

  try {
    const payload = {
      proto: 1,
      short,
      sessionId: "abcd1234-sess",
      cwd: "/tmp/project",
      seed: { name: "Triflux codex worker" },
    };
    const result = await dispatchClaudeDaemonJob({
      paths,
      controlSock: paths.controlSock,
      payload,
      agent: "codex",
      name: "Triflux codex worker",
      cwd: "/tmp/project",
      dispatchTimeoutMs: 5000,
      _deps: {
        getProcStart: () => "Mon Jan 1 00:00:00 2026",
        resolveDaemonBridgeSessionId: async () => "cse_01DispatchJob",
      },
    });

    // op:'dispatch' 페이로드가 정확히 controlSock 으로 나갔는지
    const dispatch = requests.find((r) => r.op === "dispatch");
    assert.ok(dispatch, "dispatch request should be sent");
    assert.equal(dispatch.proto, 1);
    assert.equal(dispatch.d.short, short);
    assert.equal(dispatch.d.sessionId, "abcd1234-sess");
    assert.equal(dispatch.timeoutMs, 5000);

    // 헬퍼는 plain 필드를 반환한다 (caller record 로 Object.assign 가능).
    assert.equal(result.ok, true);
    assert.equal(result.short, short);
    assert.equal(result.sessionId, "abcd1234-sess");
    assert.equal(result.pid, process.pid);
    assert.equal(result.bridgeSessionId, "cse_01DispatchJob");
    assert.equal(result.controlSock, paths.controlSock);
    assert.ok(result.job);
    assert.ok(result.sessionProjectionPath);

    const projection = JSON.parse(
      await fs.readFile(result.sessionProjectionPath, "utf8"),
    );
    assert.equal(projection.sessionId, "abcd1234-sess");
    assert.equal(projection.agent, "codex");
    assert.equal(projection.jobId, short);
    assert.equal(projection.bridgeSessionId, "session_01DispatchJob");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("dispatchClaudeDaemonJob projection:'skip' does not build/write a projection", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-dispatch-skip-"));
  const configDir = path.join(tmp, "claude");
  const paths = deriveClaudeDaemonPaths({ configDir });
  await fs.mkdir(paths.daemonDir, { recursive: true });
  const short = "skip5678";
  const { server, requests } = await listenDaemon(paths.controlSock, {
    short,
    pid: process.pid,
  });

  let projectionBuilt = false;
  try {
    const result = await dispatchClaudeDaemonJob({
      paths,
      controlSock: paths.controlSock,
      payload: { proto: 1, short, sessionId: "skip5678-sess" },
      agent: "codex",
      name: "skip projection",
      cwd: "/tmp/project",
      projection: "skip",
      _deps: {
        getProcStart: () => "Mon Jan 1 00:00:00 2026",
        resolveDaemonBridgeSessionId: async () => "cse_skip",
        buildClaudeSessionProjection: () => {
          projectionBuilt = true;
          return {};
        },
      },
    });

    assert.equal(projectionBuilt, false);
    assert.equal(result.sessionProjectionPath, "");
    assert.equal(result.bridgeSessionId, "cse_skip");
    assert.ok(requests.find((r) => r.op === "dispatch"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("dispatchClaudeDaemonJob throws when daemon dispatch is not ok", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-dispatch-fail-"));
  const configDir = path.join(tmp, "claude");
  const paths = deriveClaudeDaemonPaths({ configDir });
  await fs.mkdir(paths.daemonDir, { recursive: true });

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", () => socket.end(`${JSON.stringify({ ok: false })}\n`));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.controlSock, resolve);
  });

  try {
    await assert.rejects(
      dispatchClaudeDaemonJob({
        paths,
        controlSock: paths.controlSock,
        payload: { proto: 1, short: "fail0000", sessionId: "fail0000-sess" },
        agent: "codex",
        name: "fail dispatch",
        cwd: "/tmp/project",
      }),
      /dispatch failed/u,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("teardownClaudeDaemonJob attempts every step even when killDaemonJob throws", async () => {
  const calls = [];
  await teardownClaudeDaemonJob({
    controlSock: "/tmp/does-not-matter.sock",
    short: "tear1234",
    sessionProjectionPath: "/tmp/proj.json",
    jobsDir: "/tmp/jobs",
    removeJobState: true,
    _deps: {
      removeClaudeSessionProjection: async () => {
        calls.push("removeProjection");
      },
      killDaemonJob: async () => {
        calls.push("killDaemonJob");
        throw new Error("kill exploded");
      },
      removeClaudeJobState: async () => {
        calls.push("removeJobState");
      },
    },
  });

  // killDaemonJob 이 throw 해도 .catch 로 삼키고 모든 스텝이 시도되어야 한다.
  assert.deepEqual(calls.sort(), [
    "killDaemonJob",
    "removeJobState",
    "removeProjection",
  ]);
});

test("teardownClaudeDaemonJob passes daemon control auth to short kill", async () => {
  const calls = [];
  await teardownClaudeDaemonJob({
    paths: {
      controlSock: "/tmp/does-not-matter.sock",
      configDir: "/tmp/claude-auth-scope",
    },
    short: "tear5678",
    _deps: {
      buildDaemonControlAuth: async (configDir) => {
        calls.push(["buildAuth", configDir]);
        return { auth: "teardown-secret" };
      },
      killDaemonJob: async (controlSock, short, options) => {
        calls.push(["killDaemonJob", controlSock, short, options]);
      },
    },
  });

  assert.deepEqual(calls, [
    ["buildAuth", "/tmp/claude-auth-scope"],
    [
      "killDaemonJob",
      "/tmp/does-not-matter.sock",
      "tear5678",
      { auth: "teardown-secret" },
    ],
  ]);
});

test("dispatchClaudeDaemonJob presents daemon control.key as auth when present", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-dispatch-auth-"));
  const configDir = path.join(tmp, "claude");
  const paths = deriveClaudeDaemonPaths({ configDir });
  await fs.mkdir(paths.daemonDir, { recursive: true });
  await fs.mkdir(path.join(configDir, "daemon"), { recursive: true });
  await fs.writeFile(
    path.join(configDir, "daemon", "control.key"),
    "feedface00112233\n",
    "utf8",
  );
  const short = "auth1234";
  const { server, requests } = await listenDaemon(paths.controlSock, {
    short,
    pid: process.pid,
  });

  try {
    await dispatchClaudeDaemonJob({
      paths,
      controlSock: paths.controlSock,
      payload: { proto: 1, short, sessionId: "auth1234-sess", cwd: "/tmp/p" },
      agent: "codex",
      name: "auth worker",
      cwd: "/tmp/p",
      _deps: {
        getProcStart: () => "Mon Jan 1 00:00:00 2026",
        resolveDaemonBridgeSessionId: async () => "cse_01Auth",
      },
    });
    const dispatch = requests.find((r) => r.op === "dispatch");
    assert.equal(
      dispatch.auth,
      "feedface00112233",
      "control.key must be presented as auth (daemon enforces EAUTH otherwise)",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("dispatchClaudeDaemonJob reads the source control.key for an OMC runtime config", async () => {
  const tmp = await fs.mkdtemp(
    path.join(os.tmpdir(), "tfx-dispatch-omc-auth-"),
  );
  const sourceConfigDir = path.join(tmp, "claude");
  const runtimeConfigDir = path.join(sourceConfigDir, ".omc-launch");
  const paths = deriveClaudeDaemonPaths({ configDir: runtimeConfigDir });
  const controlKey = "omc-source-control-key";
  await fs.mkdir(paths.daemonDir, { recursive: true });
  await fs.mkdir(runtimeConfigDir, { recursive: true });
  await fs.mkdir(path.join(sourceConfigDir, "daemon"), { recursive: true });
  await fs.writeFile(
    path.join(runtimeConfigDir, ".omc-launch-profile.json"),
    JSON.stringify({ sourceConfigDir }),
    "utf8",
  );
  await fs.writeFile(
    path.join(sourceConfigDir, "daemon", "control.key"),
    `${controlKey}\n`,
    "utf8",
  );
  const short = "omca1234";
  const { server, requests } = await listenDaemon(paths.controlSock, {
    short,
    pid: process.pid,
    expectedAuth: controlKey,
  });

  try {
    await dispatchClaudeDaemonJob({
      paths,
      controlSock: paths.controlSock,
      payload: { proto: 1, short, sessionId: "omca1234-sess", cwd: "/tmp/p" },
      agent: "codex",
      name: "OMC auth worker",
      cwd: "/tmp/p",
      _deps: {
        getProcStart: () => "Mon Jan 1 00:00:00 2026",
        resolveDaemonBridgeSessionId: async () => "cse_01OmcAuth",
      },
    });
    const dispatch = requests.find((request) => request.op === "dispatch");
    assert.equal(dispatch.auth, controlKey);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("dispatchClaudeDaemonJob preserves EAUTH when the OMC source control.key is absent", async () => {
  const tmp = await fs.mkdtemp(
    path.join(os.tmpdir(), "tfx-dispatch-omc-noauth-"),
  );
  const sourceConfigDir = path.join(tmp, "claude");
  const runtimeConfigDir = path.join(sourceConfigDir, ".omc-launch");
  const paths = deriveClaudeDaemonPaths({ configDir: runtimeConfigDir });
  await fs.mkdir(paths.daemonDir, { recursive: true });
  await fs.mkdir(runtimeConfigDir, { recursive: true });
  await fs.writeFile(
    path.join(runtimeConfigDir, ".omc-launch-profile.json"),
    JSON.stringify({ sourceConfigDir }),
    "utf8",
  );
  const { server, requests } = await listenDaemon(paths.controlSock, {
    short: "omcno567",
    pid: process.pid,
    expectedAuth: "omc-source-control-key",
  });

  try {
    await assert.rejects(
      dispatchClaudeDaemonJob({
        paths,
        controlSock: paths.controlSock,
        payload: {
          proto: 1,
          short: "omcno567",
          sessionId: "omcno567-sess",
          cwd: "/tmp/p",
        },
        agent: "codex",
        name: "OMC missing auth worker",
        cwd: "/tmp/p",
      }),
      /invalid daemon control key/,
    );
    const dispatch = requests.find((request) => request.op === "dispatch");
    assert.equal(dispatch.auth, undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("dispatchClaudeDaemonJob omits auth when control.key is absent (legacy daemon)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-dispatch-noauth-"));
  const configDir = path.join(tmp, "claude");
  const paths = deriveClaudeDaemonPaths({ configDir });
  await fs.mkdir(paths.daemonDir, { recursive: true });
  const short = "noau5678";
  const { server, requests } = await listenDaemon(paths.controlSock, {
    short,
    pid: process.pid,
  });

  try {
    await dispatchClaudeDaemonJob({
      paths,
      controlSock: paths.controlSock,
      payload: { proto: 1, short, sessionId: "noau5678-sess", cwd: "/tmp/p" },
      agent: "codex",
      name: "noauth worker",
      cwd: "/tmp/p",
      _deps: {
        getProcStart: () => "Mon Jan 1 00:00:00 2026",
        resolveDaemonBridgeSessionId: async () => "cse_01NoAuth",
      },
    });
    const dispatch = requests.find((r) => r.op === "dispatch");
    assert.equal(dispatch.auth, undefined, "no key file → no auth field");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("dispatchClaudeDaemonJob preserves daemon rejection reason in error message", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-dispatch-reject-"));
  const configDir = path.join(tmp, "claude");
  const paths = deriveClaudeDaemonPaths({ configDir });
  await fs.mkdir(paths.daemonDir, { recursive: true });
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", () => {
      socket.end(
        `${JSON.stringify({
          ok: false,
          error:
            "dispatch rejected: this client didn't present the daemon control key",
          code: "EAUTH",
        })}\n`,
      );
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.controlSock, resolve);
  });

  try {
    await assert.rejects(
      dispatchClaudeDaemonJob({
        paths,
        controlSock: paths.controlSock,
        payload: { proto: 1, short: "rej90abc", sessionId: "rej-sess" },
        agent: "codex",
        name: "reject worker",
        cwd: "/tmp/p",
      }),
      /didn't present the daemon control key/,
      "daemon error reason must surface in the thrown message",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
