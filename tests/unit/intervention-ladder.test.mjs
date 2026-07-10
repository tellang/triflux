import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  buildResumeArgv,
  createFileActivitySource,
  createInterventionLadder,
  detectChannel,
  extractCodexSessionIdFromRolloutPath,
  resolveCodexRolloutFile,
  resolveHardCeilingMs,
  resolveStallThresholdMs,
} from "../../hub/team/intervention.mjs";

const FAST = {
  interruptSettleMs: 1,
  reinstructWaitMs: 30,
  resumeWaitMs: 30,
  activityPollMs: 1,
  sigtermGraceMs: 1,
};
const tempDirs = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "triflux-intervention-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length)
    rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe("intervention ladder", () => {
  it("detectChannel은 명시값 > app server > daemon > pane > pid 순서다", () => {
    assert.equal(detectChannel({ channel: "process", paneId: "x" }), "process");
    assert.equal(
      detectChannel({ appServer: { client: {}, threadId: "t" }, pid: 1 }),
      "codex-app-server",
    );
    assert.equal(
      detectChannel({
        daemon: { controlSock: "/fake", short: "a" },
        paneId: "x",
      }),
      "claude-daemon",
    );
    assert.equal(detectChannel({ paneId: "x", pid: 1 }), "tmux-pane");
    assert.equal(detectChannel({ pid: 1 }), "process");
    assert.equal(detectChannel({}), null);
  });

  it("daemon interrupt+재지시 후 주입된 활동 서명 변화면 reactivated다", async () => {
    let signature = "before";
    const calls = [];
    const result = await createInterventionLadder({
      target: {
        daemon: {
          controlSock: "/tmp/fake.sock",
          short: "short",
          configDir: "/tmp/cfg",
        },
      },
      readActivitySignature: () => signature,
      config: FAST,
      deps: {
        daemonControl: {
          buildDaemonControlAuth: async () => ({ auth: "test" }),
          interruptClaudeDaemonSession: async () => ({ inputSent: true }),
          attachClaudeDaemonSession: async ({ input }) => {
            calls.push(input);
            signature = "after";
            return { inputSent: true };
          },
        },
        killProcess: () => {
          throw new Error("must not kill");
        },
        isPidAlive: () => true,
      },
    }).intervene();

    assert.equal(result.outcome, "reactivated");
    assert.equal(result.step, "reinstruct");
    assert.ok(calls[0].includes("[triflux intervention]"));
    assert.deepEqual(Object.keys(result.attempts[0]).sort(), [
      "detail",
      "endedAt",
      "ok",
      "startedAt",
      "step",
    ]);
  });

  it("process codex는 rollout UUID로 resume handler를 호출해 resumed가 된다", async () => {
    let signature = "0";
    const calls = [];
    const result = await createInterventionLadder({
      target: {
        channel: "process",
        pid: 42,
        cli: "codex",
        rolloutFile:
          "/tmp/rollout-x-019e43e2-c23d-71a2-b6c8-3186d3a31b72.jsonl",
      },
      readActivitySignature: () => signature,
      config: FAST,
      deps: {
        probeResumeCapability: async () => true,
        isPidAlive: () => false,
        killProcess: () => true,
        resumeHandler: async (args) => {
          calls.push(args);
          signature = "1";
          return { ok: true };
        },
      },
    }).intervene();

    assert.equal(result.outcome, "resumed");
    assert.equal(calls[0].cli, "codex");
    assert.equal(calls[0].sessionId, "019e43e2-c23d-71a2-b6c8-3186d3a31b72");
    assert.equal(result.attempts[0].step, "resume");
  });

  it("resume 미지원은 기록하고 SIGTERM으로 진행한다", async () => {
    const kills = [];
    const result = await createInterventionLadder({
      target: { pid: 42, cli: "codex" },
      readActivitySignature: () => "fixed",
      config: FAST,
      deps: {
        probeResumeCapability: async () => false,
        isPidAlive: () => false,
        killProcess: (pid, options) => {
          kills.push([pid, options.signal, options.tree]);
          return true;
        },
      },
    }).intervene();

    assert.equal(result.outcome, "terminated");
    assert.equal(result.attempts[0].detail, "capability_unsupported");
    assert.deepEqual(kills, [[42, "SIGTERM", true]]);
  });

  it("SIGTERM 이후 생존하면 SIGKILL(force+tree)로 승격한다", async () => {
    let killed = false;
    const signals = [];
    const result = await createInterventionLadder({
      target: { pid: 777 },
      readActivitySignature: () => "fixed",
      config: FAST,
      deps: {
        probeResumeCapability: async () => false,
        killProcess: (_pid, options) => {
          signals.push(options);
          if (options.signal === "SIGKILL") killed = true;
          return true;
        },
        isPidAlive: () => !killed,
      },
    }).intervene();

    assert.equal(result.outcome, "killed");
    assert.deepEqual(
      signals.map((entry) => entry.signal),
      ["SIGTERM", "SIGKILL"],
    );
    assert.equal(signals[1].force, true);
    assert.equal(signals[1].tree, true);
  });

  it("interactive pane은 cli별 interrupt와 prompt injection을 사용한다", async () => {
    let signature = "before";
    const keys = [];
    const result = await createInterventionLadder({
      target: { paneId: "team:0.1", cli: "claude", interactive: true },
      readActivitySignature: () => signature,
      config: FAST,
      deps: {
        psmuxExec: (args) => keys.push(args),
        injectPrompt: () => {
          signature = "after";
        },
      },
    }).intervene();

    assert.equal(result.outcome, "reactivated");
    assert.deepEqual(keys[0], ["send-keys", "-t", "team:0.1", "Escape"]);
  });

  it("headless pane은 rung ①을 건너뛰고 stdin을 주입하지 않는다", async () => {
    const result = await createInterventionLadder({
      target: { paneId: "team:0.1", cli: "codex", interactive: false },
      readActivitySignature: () => "fixed",
      config: FAST,
      deps: {
        probeResumeCapability: async () => false,
        psmuxExec: () => "999",
        injectPrompt: () => {
          throw new Error("must not inject");
        },
        killProcess: () => true,
        isPidAlive: () => false,
      },
    }).intervene();

    assert.equal(result.attempts[0].detail, "headless_pane_no_input_channel");
  });

  it("codex app-server는 동일 thread에 interrupt와 start를 보낸다", async () => {
    let signature = "before";
    const calls = [];
    const result = await createInterventionLadder({
      target: {
        appServer: {
          threadId: "thread-1",
          client: {
            request: async (method, params) => {
              calls.push([method, params]);
              if (method === "turn/start") signature = "after";
            },
          },
        },
      },
      readActivitySignature: () => signature,
      config: FAST,
    }).intervene();

    assert.equal(result.outcome, "reactivated");
    assert.deepEqual(calls[0], ["turn/interrupt", { threadId: "thread-1" }]);
    assert.equal(calls[1][0], "turn/start");
    assert.equal(calls[1][1].threadId, "thread-1");
  });

  it("helper는 rollout ID, argv, 파일 서명 및 lifecycle 기본값을 보존한다", () => {
    assert.equal(
      extractCodexSessionIdFromRolloutPath(
        "/x/rollout-a-019e43e2-c23d-71a2-b6c8-3186d3a31b72.jsonl",
      ),
      "019e43e2-c23d-71a2-b6c8-3186d3a31b72",
    );
    assert.deepEqual(
      buildResumeArgv({ cli: "claude", sessionId: "s", prompt: "p" }),
      ["claude", "-p", "--resume", "s", "p"],
    );
    assert.deepEqual(
      buildResumeArgv({ cli: "codex", sessionId: "s", prompt: "p" }),
      ["codex", "exec", "resume", "s", "p"],
    );
    const file = join(tempDir(), "activity.log");
    writeFileSync(file, "a");
    const read = createFileActivitySource({ files: [file] });
    const before = read();
    writeFileSync(file, "changed");
    assert.notEqual(read(), before);
    assert.equal(resolveStallThresholdMs({}), 1_200_000);
    assert.equal(resolveHardCeilingMs({}), 21_600_000);
  });

  it("rollout 탐색은 주입된 lsof 결과만 사용해 hermetic하게 동작한다", async () => {
    const rollout =
      "/tmp/codex/sessions/2026/07/10/rollout-x-019e43e2-c23d-71a2-b6c8-3186d3a31b72.jsonl";
    const result = await resolveCodexRolloutFile({
      pid: 99,
      codexHome: "/tmp/codex",
      deps: {
        execFileAsync: async () => ({ stdout: `p99\nn${rollout}\n` }),
        readdir: async () => {
          throw new Error("must not use /proc");
        },
      },
    });
    assert.equal(result, rollout);
  });
});
