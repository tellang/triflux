import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseTeamArgs } from "../../hub/team/cli/commands/start/parse-args.mjs";
import {
  attachHeadlessTmuxPane,
  createDaemonObservationSession,
  createHeadlessAutoAttachHandler,
} from "../../hub/team/headless.mjs";

const attachedTmuxEnv = {
  TMUX: "/tmp/tmux-501/default,1234,0",
  TMUX_PANE: "%7",
};

function createHarness({
  platform = "darwin",
  env = attachedTmuxEnv,
  autoAttach = true,
  dashboard = true,
} = {}) {
  const calls = {
    tmux: [],
    dashboard: [],
    terminal: [],
    progress: [],
  };
  const handler = createHeadlessAutoAttachHandler(
    "tfx-headless;$(touch /tmp/injected)",
    2,
    {
      autoAttach,
      dashboard,
      dashboardLayout: "lite",
      dashboardSize: 0.3,
      dashboardAnchor: "window",
      onProgress: (event) => calls.progress.push(event),
      _deps: {
        platform,
        env,
        psmuxExec: (args) => calls.tmux.push(args),
        attachDashboardTab: (...args) => calls.dashboard.push(args),
        autoAttachTerminal: (...args) => calls.terminal.push(args),
      },
    },
  );
  return { calls, handler };
}

describe("headless tmux auto-attach", () => {
  for (const dashboard of [true, false]) {
    it(`attached macOS tmux에서 dashboard=${dashboard}여도 pane을 한 번만 표시한다`, () => {
      const { calls, handler } = createHarness({ dashboard });
      const event = { type: "session_created", dashboardLayout: "split-2col" };

      assert.doesNotThrow(() => handler(event));
      assert.doesNotThrow(() => handler(event));

      assert.equal(calls.tmux.length, 1);
      assert.deepEqual(calls.tmux[0], [
        "split-window",
        "-v",
        "-l",
        "30%",
        "-t",
        "%7",
        "env",
        "-u",
        "TMUX",
        "tmux",
        "-S",
        "/tmp/tmux-501/default",
        "attach-session",
        "-t",
        "tfx-headlesstouchtmpinjected",
      ]);
      assert.equal(calls.dashboard.length, 0);
      assert.equal(calls.terminal.length, 0);
      assert.equal(calls.progress.length, 2);
    });
  }

  it("Linux attached tmux에서도 같은 pane attach 경로를 사용한다", () => {
    const { calls, handler } = createHarness({ platform: "linux" });

    handler({ type: "session_created" });

    assert.equal(calls.tmux.length, 1);
    assert.equal(calls.dashboard.length, 0);
    assert.equal(calls.terminal.length, 0);
  });

  it("autoAttach=false이면 pane을 만들지 않고 progress는 전달한다", () => {
    const { calls, handler } = createHarness({ autoAttach: false });

    handler({ type: "session_created" });

    assert.equal(calls.tmux.length, 0);
    assert.equal(calls.dashboard.length, 0);
    assert.equal(calls.terminal.length, 0);
    assert.equal(calls.progress.length, 1);
  });

  for (const env of [
    {},
    { TMUX: attachedTmuxEnv.TMUX },
    { ...attachedTmuxEnv, TMUX_PANE: "7; display-message" },
  ]) {
    it(`tmux env가 부적합하면 fail-open한다: ${JSON.stringify(env)}`, () => {
      const { calls, handler } = createHarness({ env });
      const event = { type: "session_created" };

      assert.doesNotThrow(() => handler(event));

      assert.equal(calls.tmux.length, 0);
      assert.deepEqual(calls.progress[0], {
        type: "observer_warning",
        stage: "auto_attach",
        message: "auto-attach returned false",
        sessionName: "tfx-headlesstouchtmpinjected",
      });
      assert.strictEqual(calls.progress[1], event);
    });
  }

  it("split-window 실패를 삼키고 같은 session_created에서 재시도하지 않는다", () => {
    let attempts = 0;
    const progress = [];
    const handler = createHeadlessAutoAttachHandler("safe-session", 1, {
      autoAttach: true,
      dashboard: true,
      onProgress: (event) => progress.push(event),
      _deps: {
        platform: "darwin",
        env: attachedTmuxEnv,
        psmuxExec() {
          attempts += 1;
          throw new Error("split failed");
        },
      },
    });

    const event = { type: "session_created" };
    assert.doesNotThrow(() => handler(event));
    assert.doesNotThrow(() => handler(event));

    assert.equal(attempts, 1);
    assert.deepEqual(progress[0], {
      type: "observer_warning",
      stage: "tmux_split",
      message: "split failed",
      sessionName: "safe-session",
    });
    assert.strictEqual(progress[1], event);
    assert.strictEqual(progress[2], event);
  });

  for (const [name, attachHeadlessTmuxPane, expectedMessage] of [
    [
      "sync throw",
      () => {
        throw new Error("sync attach failed");
      },
      "sync attach failed",
    ],
    ["boolean false", () => false, "auto-attach returned false"],
    [
      "async rejection",
      () => Promise.reject(new Error("async attach failed")),
      "async attach failed",
    ],
  ]) {
    it(`${name} attach 실패를 warning으로 남기고 session_created를 보존한다`, async () => {
      const progress = [];
      const event = { type: "session_created", dashboardLayout: "lite" };
      const handler = createHeadlessAutoAttachHandler("safe-session", 1, {
        autoAttach: true,
        onProgress: (progressEvent) => progress.push(progressEvent),
        _deps: { platform: "darwin", attachHeadlessTmuxPane },
      });

      assert.doesNotThrow(() => handler(event));
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(progress.length, 2);
      assert.strictEqual(
        progress.find(
          (progressEvent) => progressEvent.type === "session_created",
        ),
        event,
      );
      assert.deepEqual(
        progress.find(
          (progressEvent) => progressEvent.type === "observer_warning",
        ),
        {
          type: "observer_warning",
          stage: "auto_attach",
          message: expectedMessage,
          sessionName: "safe-session",
        },
      );
    });
  }

  for (const warningFailure of ["sync throw", "async rejection"]) {
    it(`warning callback의 ${warningFailure}도 session_created 전달을 막지 않는다`, async () => {
      const delivered = [];
      let warningCalls = 0;
      const event = { type: "session_created" };
      const handler = createHeadlessAutoAttachHandler("safe-session", 1, {
        autoAttach: true,
        onProgress(progressEvent) {
          if (progressEvent.type === "observer_warning") {
            warningCalls += 1;
            if (warningFailure === "async rejection") {
              return Promise.reject(new Error("async warning sink failed"));
            }
            throw new Error("sync warning sink failed");
          }
          delivered.push(progressEvent);
        },
        _deps: {
          platform: "darwin",
          attachHeadlessTmuxPane: () => false,
        },
      });

      assert.doesNotThrow(() => handler(event));
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(warningCalls, 1);
      assert.strictEqual(delivered[0], event);
    });
  }

  for (const dashboard of [true, false]) {
    it(`Windows dashboard=${dashboard}는 기존 WT helper를 유지한다`, () => {
      const { calls, handler } = createHarness({
        platform: "win32",
        dashboard,
      });

      handler({ type: "session_created", dashboardLayout: "split-2col" });

      assert.equal(calls.tmux.length, 0);
      assert.equal(calls.dashboard.length, dashboard ? 1 : 0);
      assert.equal(calls.terminal.length, dashboard ? 0 : 1);
    });
  }
});

describe("headless pane/native bridge opt-outs", () => {
  it("--no-auto-attach는 pane만 끄고 native bridge default-on을 유지한다", () => {
    const parsed = parseTeamArgs([
      "--teammate-mode",
      "headless",
      "--no-auto-attach",
      "task",
    ]);

    assert.equal(parsed.autoAttach, false);
    assert.equal(parsed.nativeBridge, true);
  });

  it("--no-native-bridge-ui는 bridge만 끄고 pane auto-attach를 유지한다", () => {
    const parsed = parseTeamArgs([
      "--teammate-mode",
      "headless",
      "--no-native-bridge-ui",
      "task",
    ]);

    assert.equal(parsed.autoAttach, true);
    assert.equal(parsed.nativeBridge, false);
  });
});

describe("headless cleanup ownership", () => {
  it("headless module은 raw tmux kill-session cleanup을 추가하지 않는다", () => {
    const source = readFileSync(
      join(import.meta.dirname, "../../hub/team/headless.mjs"),
      "utf8",
    );

    assert.doesNotMatch(source, /psmuxExec\(\s*\[\s*["']kill-session["']/u);
  });
});

describe("daemon observation session", () => {
  function observerHarness(overrides = {}) {
    let exists = false;
    const calls = { exists: [], create: [], theme: [], send: [], kill: [] };
    const deps = {
      platform: "darwin",
      env: attachedTmuxEnv,
      psmuxSessionExists(sessionName) {
        calls.exists.push(sessionName);
        return exists;
      },
      createPsmuxSession(sessionName, opts) {
        calls.create.push([sessionName, opts]);
        exists = true;
        return { sessionName, panes: [`${sessionName}:0.0`] };
      },
      applyTrifluxTheme: (sessionName) => calls.theme.push(sessionName),
      sendKeysToPane: (...args) => calls.send.push(args),
      killPsmuxSession(sessionName) {
        calls.kill.push(sessionName);
        exists = false;
      },
      ...overrides,
    };
    return { calls, deps };
  }

  for (const dashboard of [true, false]) {
    it(`dashboard=${dashboard}에서 daemon file viewer session을 한 번 만든다`, () => {
      const { calls, deps } = observerHarness();
      const observer = createDaemonObservationSession(
        "agents;$(touch /tmp/injected)",
        [
          { resultFile: "/tmp/worker-1.txt" },
          { resultFile: "/tmp/worker-2.txt" },
        ],
        {
          autoAttach: true,
          dashboard,
          dashboardLayout: "lite",
          _deps: deps,
        },
      );

      assert.equal(observer.sessionName, "agentstouchtmpinjected");
      assert.equal(observer.dashboardLayout, "lite");
      assert.equal(calls.create.length, 1);
      assert.equal(calls.theme.length, 1);
      assert.equal(calls.send.length, 1);
      assert.equal(calls.kill.length, 0);
      assert.equal(calls.exists.length, 0);
      assert.match(calls.send[0][1], /tui-viewer\.mjs/u);
      assert.match(calls.send[0][1], /--source files/u);
      assert.match(calls.send[0][1], /--workers 2/u);
      assert.doesNotMatch(calls.send[0][1], /touch \/tmp/u);
    });
  }

  for (const [name, options] of [
    ["autoAttach=false", { autoAttach: false }],
    ["tmux env 없음", { autoAttach: true, env: {} }],
    ["Windows", { autoAttach: true, platform: "win32" }],
  ]) {
    it(`${name}이면 observer session을 만들지 않는다`, () => {
      const { calls, deps } = observerHarness({
        ...(options.env ? { env: options.env } : {}),
        ...(options.platform ? { platform: options.platform } : {}),
      });
      const observer = createDaemonObservationSession(
        "safe-session",
        [{ resultFile: "/tmp/worker-1.txt" }],
        {
          autoAttach: options.autoAttach,
          dashboard: true,
          _deps: deps,
        },
      );

      assert.equal(observer, null);
      assert.equal(calls.create.length, 0);
      assert.equal(calls.send.length, 0);
      assert.equal(calls.kill.length, 0);
    });
  }

  it("viewer 실행 실패는 생성된 observer session만 cleanup하고 fail-open한다", () => {
    const progress = [];
    const { calls, deps } = observerHarness({
      sendKeysToPane() {
        throw new Error("viewer failed");
      },
    });

    const observer = createDaemonObservationSession(
      "safe-session",
      [{ resultFile: "/tmp/worker-1.txt" }],
      {
        autoAttach: true,
        dashboard: true,
        onProgress: (event) => progress.push(event),
        _deps: deps,
      },
    );

    assert.equal(observer, null);
    assert.equal(calls.create.length, 1);
    assert.deepEqual(calls.kill, ["safe-session"]);
    assert.deepEqual(progress, [
      {
        type: "observer_warning",
        stage: "observer_viewer_start",
        message: "viewer failed",
        sessionName: "safe-session",
      },
    ]);
  });

  it("createSession race 실패는 caller가 타인 session을 kill하지 않는다", () => {
    let existenceChecks = 0;
    const progress = [];
    const { calls, deps } = observerHarness({
      psmuxSessionExists() {
        existenceChecks += 1;
        return existenceChecks > 1;
      },
      createPsmuxSession(sessionName, opts) {
        calls.create.push([sessionName, opts]);
        throw new Error("duplicate session created by another caller");
      },
    });

    const observer = createDaemonObservationSession(
      "raced-session",
      [{ resultFile: "/tmp/worker-1.txt" }],
      {
        autoAttach: true,
        dashboard: true,
        onProgress: (event) => progress.push(event),
        _deps: deps,
      },
    );

    assert.equal(observer, null);
    assert.equal(existenceChecks, 0);
    assert.deepEqual(calls.kill, []);
    assert.deepEqual(progress, [
      {
        type: "observer_warning",
        stage: "observer_session_create",
        message: "duplicate session created by another caller",
        sessionName: "raced-session",
      },
    ]);
  });

  it("같은 이름의 pre-existing session은 observer 생성 실패 시에도 kill하지 않는다", () => {
    const progress = [];
    const { calls, deps } = observerHarness({
      psmuxSessionExists: () => true,
      createPsmuxSession(sessionName, opts) {
        calls.create.push([sessionName, opts]);
        throw new Error("duplicate session");
      },
    });

    const observer = createDaemonObservationSession(
      "existing-session",
      [{ resultFile: "/tmp/worker-1.txt" }],
      {
        autoAttach: true,
        dashboard: true,
        onProgress: (event) => progress.push(event),
        _deps: deps,
      },
    );

    assert.equal(observer, null);
    assert.equal(calls.exists.length, 0);
    assert.deepEqual(calls.kill, []);
    assert.deepEqual(progress, [
      {
        type: "observer_warning",
        stage: "observer_session_create",
        message: "duplicate session",
        sessionName: "existing-session",
      },
    ]);
  });

  it("observer warning callback 실패도 반환된 session cleanup을 막지 않는다", () => {
    let warningCalls = 0;
    const { calls, deps } = observerHarness({
      applyTrifluxTheme() {
        throw new Error("theme failed");
      },
    });

    assert.doesNotThrow(() =>
      createDaemonObservationSession(
        "safe-session",
        [{ resultFile: "/tmp/worker-1.txt" }],
        {
          autoAttach: true,
          dashboard: true,
          onProgress() {
            warningCalls += 1;
            throw new Error("warning sink failed");
          },
          _deps: deps,
        },
      ),
    );

    assert.equal(warningCalls, 1);
    assert.deepEqual(calls.kill, ["safe-session"]);
    assert.equal(calls.exists.length, 0);
  });
});

describe("attachHeadlessTmuxPane", () => {
  it("custom tmux socket을 nested attach argv에 그대로 보존한다", () => {
    const calls = [];
    const socketPath = "/tmp/tmux-501/custom socket;$(not-a-shell)";

    assert.equal(
      attachHeadlessTmuxPane("custom-socket", {
        _deps: {
          platform: "darwin",
          env: {
            TMUX: `${socketPath},4321,7`,
            TMUX_PANE: "%9",
          },
          psmuxExec: (args) => calls.push(args),
        },
      }),
      true,
    );

    assert.deepEqual(calls, [
      [
        "split-window",
        "-v",
        "-l",
        "30%",
        "-t",
        "%9",
        "env",
        "-u",
        "TMUX",
        "tmux",
        "-S",
        socketPath,
        "attach-session",
        "-t",
        "custom-socket",
      ],
    ]);
  });

  it("TMUX socket field가 비어 있으면 split 없이 fail-open한다", () => {
    let called = false;

    assert.equal(
      attachHeadlessTmuxPane("safe-session", {
        _deps: {
          platform: "darwin",
          env: { TMUX: ",4321,7", TMUX_PANE: "%9" },
          psmuxExec: () => {
            called = true;
          },
        },
      }),
      false,
    );

    assert.equal(called, false);
  });

  it("session name과 target pane을 argv 경계에서 검증한다", () => {
    const calls = [];

    assert.equal(
      attachHeadlessTmuxPane("alpha; rm -rf /", {
        _deps: {
          platform: "darwin",
          env: attachedTmuxEnv,
          psmuxExec: (args) => calls.push(args),
        },
      }),
      true,
    );

    assert.equal(calls[0].at(-1), "alpharm-rf");
    assert.equal(calls[0][5], "%7");
  });
});
