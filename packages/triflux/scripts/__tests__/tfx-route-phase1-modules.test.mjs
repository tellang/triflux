import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { registerAgent, removeAgent } from "../lib/agent-json.mjs";
import { createJob, getJobResult, getJobStatus } from "../lib/async.mjs";
import { buildPreflightEnv, shouldWarnGhAuth } from "../lib/env.mjs";
import { restartHub, withHubRestart } from "../lib/hub.mjs";
import { PidTracker } from "../lib/pid.mjs";
import {
  detectQuotaText,
  getRerouteTarget,
  QuotaStreamBuffer,
} from "../lib/quota.mjs";
import { claimTask, completeTask } from "../lib/team.mjs";
import { runWithTimeout } from "../lib/timeout.mjs";
import { resolveTmpDir } from "../lib/tmp.mjs";
import {
  detectTopLevelCodexConfig,
  patchMcpApprovalMode,
} from "../lib/toml.mjs";

const SCRATCH = mkdtempSync(join(tmpdir(), "tfx-route-phase1-"));
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../..");

after(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe("Phase 1 timeout/tmp/pid/env/toml modules", () => {
  test("runWithTimeout returns exit code 124 and aborts a long process", async () => {
    const started = Date.now();
    const result = await runWithTimeout(
      process.execPath,
      ["-e", "setTimeout(() => {}, 5000)"],
      { timeoutMs: 100 },
    );

    assert.equal(result.timedOut, true);
    assert.equal(result.code, 124);
    assert.ok(Date.now() - started < 2000);
  });

  test("resolveTmpDir uses os.tmpdir as the standard default and creates it", () => {
    const dir = resolveTmpDir({ env: {}, cwd: SCRATCH });
    assert.equal(dir, tmpdir());
    assert.ok(existsSync(dir));
  });

  test("PidTracker records pids and cleanup tree-kills live entries", async () => {
    const killed = [];
    const tracker = new PidTracker(join(SCRATCH, "pids"), {
      isAlive: (pid) => pid === 12345,
      killTree: async (pid) => killed.push(pid),
    });

    tracker.track(12345);
    tracker.track(99999);
    await tracker.cleanup();

    assert.deepEqual(killed, [12345]);
    assert.equal(existsSync(join(SCRATCH, "pids")), false);
  });

  test("buildPreflightEnv preserves caller values and fills noninteractive defaults", () => {
    const env = buildPreflightEnv({
      GIT_TERMINAL_PROMPT: "1",
      GH_TOKEN: "token",
    });

    assert.equal(env.GIT_TERMINAL_PROMPT, "1");
    assert.equal(env.GIT_ASKPASS, "false");
    assert.equal(env.npm_config_yes, "true");
    assert.equal(
      shouldWarnGhAuth(env, { ghExists: true, ghAuthenticated: false }),
      false,
    );
    assert.equal(
      shouldWarnGhAuth({}, { ghExists: true, ghAuthenticated: false }),
      true,
    );
  });

  test("patchMcpApprovalMode structurally rewrites approve and detects top-level config only", () => {
    const source = [
      'approval_mode = "auto"',
      'sandbox = "danger-full-access"',
      "",
      "[mcp_servers.demo.tools.lookup]",
      'approval_mode = "approve"',
    ].join("\n");

    const detection = detectTopLevelCodexConfig(source);
    const patched = patchMcpApprovalMode(source);

    assert.equal(detection.hasTopLevelSandboxOrApproval, true);
    assert.equal(patched.changed, true);
    assert.equal(patched.count, 1);
    assert.match(patched.toml, /approval_mode = "full-auto"/);
  });
});

describe("Phase 1 async/agent-json/hub/team/quota modules", () => {
  test("async jobs use JSON state, status mapping, and result fallback", async () => {
    const jobsDir = join(SCRATCH, "jobs");
    const job = createJob({
      jobsDir,
      command: process.execPath,
      args: ["-e", "console.log('job-ok')"],
      timeoutMs: 5000,
    });

    let status = getJobStatus(job.id, { jobsDir });
    assert.match(status.text, /starting|running/);

    for (let i = 0; i < 20; i += 1) {
      status = getJobStatus(job.id, { jobsDir });
      if (status.state === "done") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    assert.equal(status.state, "done");
    assert.equal(getJobResult(job.id, { jobsDir }).stdout.trim(), "job-ok");
  });

  test("registerAgent writes per-process JSON and removeAgent deletes it", () => {
    const file = registerAgent({
      tmpDir: SCRATCH,
      pid: 42,
      cli: "codex",
      agent: "executor",
      started: 123,
    });

    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
      pid: 42,
      cli: "codex",
      agent: "executor",
      started: 123,
    });
    removeAgent({ tmpDir: SCRATCH, pid: 42 });
    assert.equal(existsSync(file), false);
  });

  test("restartHub spawns server and polls native fetch status", async () => {
    const calls = [];
    const status = [false, true];
    const result = await restartHub({
      hubUrl: "http://127.0.0.1:4567",
      hubServer: join(SCRATCH, "server.mjs"),
      spawnFn: (_cmd, _args, opts) => {
        calls.push(opts.env.TFX_HUB_PORT);
        return { pid: 777, unref() {} };
      },
      fetchFn: async () => ({ ok: status.shift() }),
      sleepMs: async () => {},
    });

    assert.equal(result.ok, true);
    assert.equal(result.pid, 777);
    assert.deepEqual(calls, ["4567"]);
  });

  test("withHubRestart retries a failing bridge call after restart", async () => {
    let attempts = 0;
    const result = await withHubRestart({
      action: async () => {
        attempts += 1;
        return attempts === 2 ? { ok: true } : { ok: false };
      },
      restart: async () => ({ ok: true }),
    });

    assert.equal(result.ok, true);
    assert.equal(attempts, 2);
  });

  test("team claim/complete call native bridge functions and keep local backup", async () => {
    const calls = [];
    const env = {
      TFX_TEAM_NAME: "alpha",
      TFX_TEAM_TASK_ID: "task-1",
      TFX_TEAM_AGENT_NAME: "executor-1",
      TFX_RESULT_DIR: join(SCRATCH, "results"),
    };
    const bridge = {
      claim: async (payload) => {
        calls.push(["claim", payload]);
        return { ok: true };
      },
      complete: async (payload) => {
        calls.push(["complete", payload]);
        return { ok: true };
      },
    };

    assert.equal((await claimTask({ env, bridge })).claimed, true);
    const completion = await completeTask({
      env,
      bridge,
      result: "success",
      summary: "finished",
      now: () => "2026-05-20T00:00:00.000Z",
    });

    assert.equal(completion.completed, true);
    assert.deepEqual(
      calls.map(([name]) => name),
      ["claim", "complete"],
    );
    assert.equal(
      JSON.parse(readFileSync(join(env.TFX_RESULT_DIR, "task-1.json"), "utf8"))
        .summary,
      "finished",
    );
  });

  test("quota detection buffers stderr text and maps allowed reroute targets", () => {
    const buffer = new QuotaStreamBuffer();
    buffer.push("normal prefix ");
    buffer.push("RESOURCE_EXHAUSTED: quota exceeded");

    assert.equal(detectQuotaText(buffer.text), true);
    assert.equal(getRerouteTarget("codex"), "antigravity");
    assert.equal(getRerouteTarget("gemini"), "antigravity");
    assert.equal(getRerouteTarget("antigravity"), "codex");
    assert.equal(getRerouteTarget("claude-native"), null);
  });
});

describe("Phase 1 node invocation surface", () => {
  test("TFX_ROUTE_NODE=1 handles --job-status in Node lane without bash delegation", () => {
    const jobsDir = join(SCRATCH, "cli-jobs");
    const jobDir = join(jobsDir, "known-job");
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      join(jobDir, "state.json"),
      JSON.stringify({ state: "done", exitCode: 0 }),
    );
    writeFileSync(join(jobDir, "done"), "");
    writeFileSync(join(jobDir, "exit_code"), "0");
    writeFileSync(join(jobDir, "result.log"), "ok\n");

    const out = execFileSync(
      "bash",
      ["scripts/tfx-route.sh", "--job-status", "known-job"],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: { ...process.env, TFX_ROUTE_NODE: "1", TFX_JOBS_DIR: jobsDir },
      },
    );

    assert.equal(out.trim(), "done");
  });
});
