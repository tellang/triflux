// tests/unit/swarm-hypervisor.test.mjs — swarm-hypervisor 유닛 테스트

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  createSwarmHypervisor,
  SWARM_STATES,
} from "../../hub/team/swarm-hypervisor.mjs";
import { planSwarm } from "../../hub/team/swarm-planner.mjs";

process.setMaxListeners(50);

// ── Helpers ──────────────────────────────────────────────────

function makeTmpDir() {
  const dir = join(tmpdir(), `tfx-swarm-hv-test-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, windowsHide: true });
  execFileSync("git", ["config", "user.email", "test@test.com"], {
    cwd: dir,
    windowsHide: true,
  });
  execFileSync("git", ["config", "user.name", "Test"], {
    cwd: dir,
    windowsHide: true,
  });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], {
    cwd: dir,
    windowsHide: true,
  });
  return dir;
}

const SIMPLE_PRD = `
## Shard: worker-a
- agent: claude
- files: src/a.mjs
- prompt: echo test a

## Shard: worker-b
- agent: claude
- files: src/b.mjs
- depends: worker-a
- prompt: echo test b
`;

const PARALLEL_PRD = `
## Shard: worker-a
- agent: claude
- files: src/a.mjs
- prompt: echo test a

## Shard: worker-b
- agent: claude
- files: src/b.mjs
- prompt: echo test b
`;

const CRITICAL_PRD = `
## Shard: critical-shard
- agent: codex
- files: src/critical.mjs
- critical: true
- prompt: critical work

## Shard: normal-shard
- agent: codex
- files: src/normal.mjs
- prompt: normal work
`;

const SINGLE_PRD = `
## Shard: worker-a
- agent: claude
- files: src/a.mjs
- prompt: echo test a
`;

const SIMPLE_NO_FILES_PRD = `
## Shard: worker-a
- agent: claude
- prompt: echo test a

## Shard: worker-b
- agent: claude
- depends: worker-a
- prompt: echo test b
`;

const PARALLEL_NO_FILES_PRD = `
## Shard: worker-a
- agent: claude
- prompt: echo test a

## Shard: worker-b
- agent: claude
- prompt: echo test b
`;

const SINGLE_NO_FILES_PRD = `
## Shard: worker-a
- agent: claude
- prompt: echo test a
`;

function createMockConductorFactory() {
  const conductors = [];
  const createConductor = (opts) => {
    let completed = false;
    let deadHandler = null;
    let sessionConfig = null;
    const conductor = {
      spawnSession(config) {
        sessionConfig = config;
      },
      on(event, handler) {
        if (event === "dead") deadHandler = handler;
      },
      getSnapshot() {
        return completed
          ? [{ state: "completed", outPath: sessionConfig?.outPath || null }]
          : [{ state: "healthy", outPath: sessionConfig?.outPath || null }];
      },
      shutdown() {
        completed = true;
        return Promise.resolve();
      },
      complete(sessionId = sessionConfig?.id || "session", completionPayload) {
        completed = true;
        sessionConfig?.onCompleted?.({ sessionId, completionPayload });
        opts.onCompleted?.(sessionId);
      },
      fail(reason = "failed", sessionId = sessionConfig?.id || "session") {
        completed = true;
        deadHandler?.({ sessionId, reason });
      },
      get sessionConfig() {
        return sessionConfig;
      },
    };
    conductors.push(conductor);
    return conductor;
  };
  return { createConductor, conductors };
}

function createTestHypervisor(workdir, logsDir, overrides = {}) {
  const { createConductor, conductors } = createMockConductorFactory();
  const hv = createSwarmHypervisor({
    workdir,
    logsDir,
    maxRestarts: 0,
    graceMs: 200,
    probeOpts: {
      intervalMs: 999_999,
      l1ThresholdMs: 999_999,
      l3ThresholdMs: 999_999,
    },
    ...overrides,
    _deps: {
      createConductor,
      ...(overrides._deps || {}),
    },
  });
  return { hv, conductors };
}

function readEventLog(filePath) {
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitForCondition(check, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition wait timeout");
}

// ── Tests ────────────────────────────────────────────────────

describe("swarm-hypervisor", () => {
  let workdir;
  let logsDir;
  let hv;

  beforeEach(() => {
    workdir = makeTmpDir();
    logsDir = join(workdir, "logs");
    mkdirSync(logsDir, { recursive: true });
    hv = null;
  });

  afterEach(async () => {
    if (hv) {
      try {
        await hv.shutdown("test_cleanup");
      } catch {
        /* ignore */
      }
    }
    try {
      rmSync(workdir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  describe("createSwarmHypervisor", () => {
    it("requires workdir and logsDir", () => {
      assert.throws(() => createSwarmHypervisor({}), /workdir is required/);
      assert.throws(
        () => createSwarmHypervisor({ workdir }),
        /logsDir is required/,
      );
    });

    it("creates hypervisor in PLANNING state", () => {
      hv = createSwarmHypervisor({ workdir, logsDir });
      assert.equal(hv.state, SWARM_STATES.PLANNING);
    });

    it("creates one shared mesh registry for all shard conductors", async () => {
      const plan = planSwarm(null, { content: PARALLEL_PRD });
      const conductorOpts = [];
      const registry = {
        register() {},
        unregister() {},
        discover() {
          return [];
        },
        getAgent() {
          return null;
        },
        listAll() {
          return [];
        },
        clear() {},
      };

      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        _deps: {
          createRegistry: () => registry,
          createConductor: (opts) => {
            conductorOpts.push(opts);
            return {
              spawnSession() {},
              on() {},
              getSnapshot() {
                return [];
              },
              shutdown() {
                return Promise.resolve();
              },
            };
          },
        },
      });

      await hv.launch(plan);

      assert.equal(hv.getMeshRegistry(), registry);
      assert.equal(conductorOpts.length, 2);
      assert.ok(conductorOpts.every((opts) => opts.meshRegistry === registry));
      assert.ok(conductorOpts.every((opts) => opts.enableMesh === true));
    });

    it("falls back to a noop mesh registry when registry creation fails", async () => {
      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        _deps: {
          createRegistry: () => {
            throw new Error("boom");
          },
        },
      });

      const registry = hv.getMeshRegistry();
      assert.deepEqual(registry.discover("any-capability"), []);
      assert.equal(registry.getAgent("missing"), null);
      assert.deepEqual(registry.listAll(), []);
      assert.doesNotThrow(() => registry.clear());

      await hv.shutdown("test_fallback_cleanup");
      hv = null;
    });
  });

  describe("launch", () => {
    it("transitions to RUNNING state on launch", async () => {
      const plan = planSwarm(null, { content: PARALLEL_PRD });
      ({ hv } = createTestHypervisor(workdir, logsDir));

      const status = await hv.launch(plan);
      assert.equal(hv.state, SWARM_STATES.RUNNING);
      assert.equal(status.totalShards, 2);
      assert.ok(status.mergeOrder.length > 0);
    });

    it("returns done promise for awaiting integration completion", async () => {
      const plan = planSwarm(null, { content: PARALLEL_PRD });
      ({ hv } = createTestHypervisor(workdir, logsDir));

      const status = await hv.launch(plan);
      assert.equal(
        typeof status.done?.then,
        "function",
        "done은 Promise여야 함",
      );
    });

    it("launches dependent shard only after prerequisite completion", async () => {
      const plan = planSwarm(null, { content: SIMPLE_PRD });
      const setup = createTestHypervisor(workdir, logsDir);
      hv = setup.hv;
      const { conductors } = setup;

      await hv.launch(plan);
      assert.equal(conductors.length, 1, "초기에는 선행 shard만 launch");

      conductors[0].complete();
      await waitForCondition(() => conductors.length === 2, 6000);

      const runningStatus = hv.getStatus();
      assert.equal(runningStatus.completedShards, 1);
    });

    it("tracks launched, completed, and integrated shards as separate states", async () => {
      const plan = planSwarm(null, { content: SIMPLE_NO_FILES_PRD });
      const { createConductor, conductors } = createMockConductorFactory();
      let releaseIntegration = () => {};
      const integrationGate = new Promise((resolve) => {
        releaseIntegration = resolve;
      });

      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        runId: "issue-8",
        _deps: {
          createConductor,
          prepareIntegrationBranch: async () => ({
            integrationBranch: "swarm/issue-8/merge",
            baseCommit: "base123",
          }),
          rebaseShardOntoIntegration: async () => {
            await integrationGate;
            return { ok: true, headCommit: "head123" };
          },
          cleanupWorktree: async () => {},
        },
      });

      const integrationDone = new Promise((resolve) => {
        hv.on("integrationComplete", resolve);
      });

      await hv.launch(plan);

      let status = hv.getStatus();
      assert.equal(status.completedShards, 0);
      assert.deepEqual(
        status.workers.map((worker) => worker.shard),
        ["worker-a"],
        "only ready shards should be launched before dependencies complete",
      );
      assert.equal(status.workers[0].integrated, false);

      conductors[0].complete();
      await waitForCondition(() => conductors.length === 2, 6000);

      status = hv.getStatus();
      assert.equal(status.completedShards, 1);
      assert.equal(
        status.workers.find((worker) => worker.shard === "worker-a")
          ?.integrated,
        false,
      );
      assert.equal(
        status.workers.find((worker) => worker.shard === "worker-b")
          ?.integrated,
        false,
      );

      conductors[1].complete();
      await waitForCondition(() => hv.state === SWARM_STATES.INTEGRATING, 6000);

      status = hv.getStatus();
      assert.equal(status.completedShards, 2);
      assert.ok(
        status.workers.every((worker) => worker.integrated === false),
        "integration should remain separate from shard completion",
      );

      releaseIntegration();
      await integrationDone;

      status = hv.getStatus();
      assert.equal(status.state, SWARM_STATES.COMPLETED);
      assert.equal(status.completedShards, 2);
      assert.ok(
        status.workers.every((worker) => worker.integrated === true),
        "integrated flag should flip only after integration succeeds",
      );
    });

    it("prevents double launch", async () => {
      const plan = planSwarm(null, { content: PARALLEL_PRD });
      ({ hv } = createTestHypervisor(workdir, logsDir));

      await hv.launch(plan);
      await assert.rejects(() => hv.launch(plan), /Cannot launch/);
    });

    it("uses PID-file Hub URL resolution for keepalive status probes", async () => {
      const plan = planSwarm(null, { content: SINGLE_NO_FILES_PRD });
      const originalSetInterval = globalThis.setInterval;
      const originalClearInterval = globalThis.clearInterval;
      const originalFetch = globalThis.fetch;
      const timer = {};
      let keepaliveTick = null;
      let keepaliveDelay = null;
      const fetchCalls = [];
      const { createConductor } = createMockConductorFactory();

      globalThis.setInterval = (fn, delay) => {
        keepaliveTick = fn;
        keepaliveDelay = delay;
        return timer;
      };
      globalThis.clearInterval = (id) => {
        assert.equal(id, timer);
      };
      globalThis.fetch = async (url, opts = {}) => {
        fetchCalls.push({ url: String(url), signal: opts.signal });
        return { ok: true };
      };

      try {
        hv = createSwarmHypervisor({
          workdir,
          logsDir,
          _deps: {
            createConductor,
            ensureHubAlive: null,
            getHubInfo: async () => ({
              host: "127.0.0.1",
              port: 28777,
              url: "http://127.0.0.1:28777/mcp",
            }),
            ensureWorktree: async ({ slug, runId }) => ({
              worktreePath: `${workdir}/.codex-swarm/wt-${slug}`,
              branchName: `swarm/${runId}/${slug}`,
            }),
          },
        });

        await hv.launch(plan);
        assert.equal(keepaliveDelay, 5 * 60 * 1000);
        assert.equal(typeof keepaliveTick, "function");

        await keepaliveTick();

        assert.equal(fetchCalls.length, 1);
        assert.equal(fetchCalls[0].url, "http://127.0.0.1:28777/status");
        assert.ok(fetchCalls[0].signal instanceof AbortSignal);
      } finally {
        if (hv) {
          await hv.shutdown("test_keepalive_cleanup");
          hv = null;
        }
        globalThis.setInterval = originalSetInterval;
        globalThis.clearInterval = originalClearInterval;
        globalThis.fetch = originalFetch;
      }
    });

    it("launches redundant workers for critical shards", async () => {
      const plan = planSwarm(null, { content: CRITICAL_PRD });
      ({ hv } = createTestHypervisor(workdir, logsDir));

      await hv.launch(plan);
      assert.deepEqual(plan.criticalShards, ["critical-shard"]);
    });

    it("wires ensureWorktree metadata into spawned session configs", async () => {
      const plan = planSwarm(null, { content: SINGLE_PRD });
      const ensureCalls = [];
      const { createConductor, conductors } = createMockConductorFactory();

      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        runId: "issue-4",
        baseBranch: "develop",
        _deps: {
          createConductor,
          ensureWorktree: async (opts) => {
            ensureCalls.push(opts);
            return {
              worktreePath: `${workdir}/.codex-swarm/wt-${opts.slug}`,
              branchName: `swarm/${opts.runId}/${opts.slug}`,
            };
          },
        },
      });

      await hv.launch(plan);

      assert.equal(ensureCalls.length, 1);
      assert.equal(ensureCalls[0].slug, "worker-a");
      assert.equal(ensureCalls[0].baseBranch, "develop");
      assert.equal(ensureCalls[0].runId, "issue-4");
      assert.equal(conductors.length, 1);
      assert.equal(
        conductors[0].sessionConfig.workdir,
        `${workdir}/.codex-swarm/wt-worker-a`,
      );
      assert.equal(
        conductors[0].sessionConfig.worktreePath,
        `${workdir}/.codex-swarm/wt-worker-a`,
      );
      assert.equal(
        conductors[0].sessionConfig.branchName,
        "swarm/issue-4/worker-a",
      );
    });

    it("rebases shard branches onto the integration branch and cleans up worktrees", async () => {
      const plan = planSwarm(null, { content: SINGLE_NO_FILES_PRD });
      const { createConductor, conductors } = createMockConductorFactory();
      const rebaseCalls = [];
      const cleanupCalls = [];

      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        runId: "issue-4",
        baseBranch: "main",
        _deps: {
          createConductor,
          ensureWorktree: async ({ slug, runId }) => ({
            worktreePath: `${workdir}/.codex-swarm/wt-${slug}`,
            branchName: `swarm/${runId}/${slug}`,
          }),
          prepareIntegrationBranch: async () => ({
            integrationBranch: "swarm/issue-4/merge",
            baseCommit: "abc123",
          }),
          rebaseShardOntoIntegration: async (opts) => {
            rebaseCalls.push(opts);
            return { ok: true, headCommit: "def456" };
          },
          cleanupWorktree: async (opts) => {
            cleanupCalls.push(opts);
          },
        },
      });

      const integrationDone = new Promise((resolve) => {
        hv.on("integrationComplete", resolve);
      });

      await hv.launch(plan);
      conductors[0].complete();
      await integrationDone;

      assert.deepEqual(rebaseCalls, [
        {
          shardBranch: "swarm/issue-4/worker-a",
          integrationBranch: "swarm/issue-4/merge",
          rootDir: workdir,
        },
      ]);
      assert.deepEqual(cleanupCalls, [
        {
          worktreePath: `${workdir}/.codex-swarm/wt-worker-a`,
          branchName: "swarm/issue-4/worker-a",
          rootDir: workdir,
          force: false,
        },
      ]);
    });

    it("exposes an awaitable integrationComplete promise", async () => {
      const plan = planSwarm(null, { content: SINGLE_NO_FILES_PRD });
      const { createConductor, conductors } = createMockConductorFactory();
      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        runId: "awaitable-success",
        _deps: {
          createConductor,
          ensureWorktree: async ({ slug, runId }) => ({
            worktreePath: `${workdir}/.codex-swarm/wt-${slug}`,
            branchName: `swarm/${runId}/${slug}`,
          }),
          prepareIntegrationBranch: async () => ({
            integrationBranch: "swarm/awaitable-success/merge",
            baseCommit: "abc123",
          }),
          rebaseShardOntoIntegration: async ({ shardBranch }) => ({
            ok: true,
            headCommit: `head:${shardBranch}`,
          }),
          cleanupWorktree: async () => {},
        },
      });

      const integrationDone = hv.integrationComplete();

      await hv.launch(plan);
      assert.equal(hv.getStatus().integrationPromise.state, "pending");

      conductors[0].complete();

      const result = await integrationDone;
      assert.deepEqual(result.integrated, ["worker-a"]);
      assert.deepEqual(result.failed, []);
      assert.equal(result.partial, false);
      assert.equal(hv.getStatus().integrationPromise.state, "fulfilled");
    });

    it("resolves integrationComplete with partial results when a shard fails", async () => {
      const plan = planSwarm(null, { content: PARALLEL_NO_FILES_PRD });
      const { createConductor, conductors } = createMockConductorFactory();
      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        runId: "awaitable-partial",
        _deps: {
          createConductor,
          ensureWorktree: async ({ slug, runId }) => ({
            worktreePath: `${workdir}/.codex-swarm/wt-${slug}`,
            branchName: `swarm/${runId}/${slug}`,
          }),
          prepareIntegrationBranch: async () => ({
            integrationBranch: "swarm/awaitable-partial/merge",
            baseCommit: "abc123",
          }),
          rebaseShardOntoIntegration: async ({ shardBranch }) => ({
            ok: true,
            headCommit: `head:${shardBranch}`,
          }),
          cleanupWorktree: async () => {},
        },
      });

      await hv.launch(plan);
      conductors[0].fail("worker crashed");
      conductors[1].complete();

      const result = await hv.integrationComplete();
      assert.deepEqual(result.integrated, ["worker-b"]);
      assert.deepEqual(result.failed, ["worker-a"]);
      assert.equal(result.partial, true);
      assert.equal(hv.getStatus().integrationPromise.partial, true);
    });

    it("cascades dep failure to dependents so integration can complete", async () => {
      const plan = planSwarm(null, { content: SIMPLE_NO_FILES_PRD });
      const { createConductor, conductors } = createMockConductorFactory();
      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        runId: "cascade-dep",
        _deps: {
          createConductor,
          ensureWorktree: async ({ slug, runId }) => ({
            worktreePath: `${workdir}/.codex-swarm/wt-${slug}`,
            branchName: `swarm/${runId}/${slug}`,
          }),
          prepareIntegrationBranch: async () => ({
            integrationBranch: "swarm/cascade-dep/merge",
            baseCommit: "abc123",
          }),
          rebaseShardOntoIntegration: async ({ shardBranch }) => ({
            ok: true,
            headCommit: `head:${shardBranch}`,
          }),
          cleanupWorktree: async () => {},
        },
      });

      await hv.launch(plan);
      // worker-b depends on worker-a; if worker-a dies, worker-b never launches.
      // Without cascade, allDone would never be true → integration hangs.
      conductors[0].fail("worker-a crashed");

      const result = await hv.integrationComplete();
      assert.deepEqual(result.integrated, []);
      assert.deepEqual([...result.failed].sort(), ["worker-a", "worker-b"]);
      assert.equal(result.partial, true);
      assert.equal(hv.getStatus().failedShards, 2);
    });
  });

  describe("getStatus", () => {
    it("returns full status snapshot", async () => {
      const plan = planSwarm(null, { content: SIMPLE_PRD });
      ({ hv } = createTestHypervisor(workdir, logsDir));

      await hv.launch(plan);
      const status = hv.getStatus();

      assert.equal(status.state, SWARM_STATES.RUNNING);
      assert.equal(status.totalShards, 2);
      assert.ok(Array.isArray(status.workers));
      assert.ok(Array.isArray(status.mergeOrder));
      assert.ok(Array.isArray(status.locks));
      assert.equal(status.integrationPromise.state, "pending");
    });

    it("synthesizes authoritative worker status from conductor sessions", async () => {
      const plan = planSwarm(null, { content: SINGLE_PRD });
      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        _deps: {
          createConductor: () => ({
            spawnSession() {},
            on() {},
            getSnapshot() {
              return [
                {
                  state: "input_wait",
                  outPath: null,
                  health: { l1: "input_wait" },
                },
              ];
            },
            shutdown() {
              return Promise.resolve();
            },
          }),
        },
      });

      await hv.launch(plan);
      const status = hv.getStatus();

      assert.equal(status.workers[0].authoritativeStatus, "blocked");
      assert.equal(status.workers[0].authoritativeReason, "user_input");
    });
  });

  describe("validateResult", () => {
    it("passes when worker modifies only its leased files", async () => {
      const plan = planSwarm(null, { content: PARALLEL_PRD });
      ({ hv } = createTestHypervisor(workdir, logsDir));

      await hv.launch(plan);

      const result = hv.validateResult("worker-a", ["src/a.mjs"]);
      assert.equal(result.ok, true);
      assert.equal(result.violations.length, 0);
    });

    it("detects violations when worker modifies other shard files", async () => {
      const plan = planSwarm(null, { content: PARALLEL_PRD });
      ({ hv } = createTestHypervisor(workdir, logsDir));

      await hv.launch(plan);

      // worker-a tries to modify worker-b's file
      const result = hv.validateResult("worker-a", ["src/b.mjs"]);
      assert.equal(result.ok, false);
      assert.equal(result.violations.length, 1);
    });

    it("fails integration when a code-changing shard has no commit evidence", async () => {
      const plan = planSwarm(null, { content: SINGLE_PRD });
      const { createConductor, conductors } = createMockConductorFactory();
      let rebaseCalled = false;

      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        runId: "no-commit-guard",
        _deps: {
          createConductor,
          prepareIntegrationBranch: async () => ({
            integrationBranch: "swarm/no-commit-guard/merge",
            baseCommit: "abc123",
          }),
          rebaseShardOntoIntegration: async () => {
            rebaseCalled = true;
            return { ok: true, headCommit: "should-not-happen" };
          },
          cleanupWorktree: async () => {},
        },
      });

      await hv.launch(plan);
      conductors[0].complete();

      const result = await hv.integrationComplete();
      const status = hv.getStatus();

      assert.equal(rebaseCalled, false);
      assert.deepEqual(result.integrated, []);
      assert.deepEqual(result.failed, ["worker-a"]);
      assert.equal(result.partial, true);
      assert.equal(status.workers[0].failureInfo?.mode, "F6_no_commit");
      assert.equal(status.workers[0].authoritativeStatus, "failed");
      assert.equal(status.workers[0].commitEvidence?.commitsAhead, 0);
    });

    it("fails shard with F7 when worker completion omits commits_made", async () => {
      const plan = planSwarm(null, { content: SINGLE_PRD });
      const { createConductor, conductors } = createMockConductorFactory();
      let rebaseCalled = false;
      let collectCalled = false;

      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        runId: "worker-enforce-f7",
        _deps: {
          createConductor,
          ensureWorktree: async ({ slug, runId }) => ({
            worktreePath: `${workdir}/.codex-swarm/wt-${slug}`,
            branchName: `swarm/${runId}/${slug}`,
          }),
          prepareIntegrationBranch: async () => ({
            integrationBranch: "swarm/worker-enforce-f7/merge",
            baseCommit: "abc123",
          }),
          rebaseShardOntoIntegration: async () => {
            rebaseCalled = true;
            return { ok: true, headCommit: "should-not-happen" };
          },
          cleanupWorktree: async () => {
            collectCalled = true;
          },
        },
      });

      const events = [];
      hv.on("shardFailed", (e) => events.push(e));

      await hv.launch(plan);
      // Worker reports status=ok but with no commits_made → F7 trip.
      conductors[0].complete(undefined, { status: "ok" });

      const result = await hv.integrationComplete();
      const status = hv.getStatus();

      assert.equal(rebaseCalled, false, "rebase must be skipped when F7 trips");
      assert.equal(collectCalled, true, "worktree cleanup must run on F7");
      assert.deepEqual(result.integrated, []);
      assert.deepEqual(result.failed, ["worker-a"]);
      assert.equal(result.partial, true);
      assert.equal(
        status.workers[0].failureInfo?.mode,
        "F7_worker_did_not_commit",
      );
      assert.equal(
        status.workers[0].failureInfo?.reason,
        "missing_commits_made",
      );
      const f7Event = events.find(
        (e) => e.failureMode === "F7_worker_did_not_commit",
      );
      assert.ok(f7Event, "shardFailed event with F7 failureMode expected");
    });
  });

  describe("shutdown", () => {
    it("auto-cleans failed shard worktrees on shutdown by default", async () => {
      const plan = planSwarm(null, { content: SINGLE_NO_FILES_PRD });
      const { createConductor, conductors } = createMockConductorFactory();
      const cleanupCalls = [];

      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        runId: "failed-cleanup",
        _deps: {
          createConductor,
          ensureWorktree: async ({ slug, runId }) => ({
            worktreePath: `${workdir}/.codex-swarm/wt-${slug}`,
            branchName: `swarm/${runId}/${slug}`,
          }),
          cleanupWorktree: async (opts) => {
            cleanupCalls.push(opts);
          },
        },
      });

      await hv.launch(plan);
      conductors[0].fail("worker crashed");
      await waitForCondition(() => hv.getStatus().failedShards === 1);
      await hv.shutdown("test_failure_cleanup");

      assert.deepEqual(cleanupCalls, [
        {
          worktreePath: `${workdir}/.codex-swarm/wt-worker-a`,
          branchName: "swarm/failed-cleanup/worker-a",
          rootDir: workdir,
          force: true,
        },
      ]);

      const autoCleanupEvent = readEventLog(hv.eventLogPath).find(
        (entry) => entry.event === "worktree_auto_cleanup",
      );
      assert.deepEqual(
        autoCleanupEvent && {
          shard: autoCleanupEvent.shard,
          worktreePath: autoCleanupEvent.worktreePath,
          reason: autoCleanupEvent.reason,
        },
        {
          shard: "worker-a",
          worktreePath: `${workdir}/.codex-swarm/wt-worker-a`,
          reason: "F1_crash",
        },
      );

      hv = null;
    });

    it("saves a recovery patch for failed shard worktrees before cleanup", async () => {
      const plan = planSwarm(null, { content: SINGLE_NO_FILES_PRD });
      const { createConductor, conductors } = createMockConductorFactory();
      const preserveCalls = [];

      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        runId: "recovery-save",
        _deps: {
          createConductor,
          ensureWorktree: async ({ slug, runId }) => ({
            worktreePath: `${workdir}/.codex-swarm/wt-${slug}`,
            branchName: `swarm/${runId}/${slug}`,
          }),
          cleanupWorktree: async () => {},
          preserveWorktreePatch: async (opts) => {
            preserveCalls.push(opts);
            return {
              ok: true,
              patchPath: `${opts.recoveryDir}/${opts.shardId}.patch`,
              manifestPath: `${opts.recoveryDir}/manifest.json`,
            };
          },
        },
      });

      await hv.launch(plan);
      conductors[0].fail("worker crashed");
      await waitForCondition(() => hv.getStatus().failedShards === 1);
      await hv.shutdown("test_preservation");

      assert.equal(preserveCalls.length, 1, "preservation must be invoked");
      assert.equal(preserveCalls[0].shardId, "worker-a");
      assert.equal(
        preserveCalls[0].worktreePath,
        `${workdir}/.codex-swarm/wt-worker-a`,
      );
      assert.equal(
        preserveCalls[0].recoveryDir,
        join(workdir, ".codex-swarm", "recovery"),
      );

      const savedEvent = readEventLog(hv.eventLogPath).find(
        (entry) => entry.event === "recovery_patch_saved",
      );
      assert.ok(savedEvent, "recovery_patch_saved event must be emitted");
      assert.equal(savedEvent.shard, "worker-a");
      assert.equal(
        savedEvent.patchPath,
        `${join(workdir, ".codex-swarm", "recovery")}/worker-a.patch`,
      );
      assert.equal(savedEvent.reason, "F1_crash");

      hv = null;
    });

    it("continues cleanup when preservation throws", async () => {
      const plan = planSwarm(null, { content: SINGLE_NO_FILES_PRD });
      const { createConductor, conductors } = createMockConductorFactory();
      const cleanupCalls = [];

      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        runId: "recovery-throws",
        _deps: {
          createConductor,
          ensureWorktree: async ({ slug, runId }) => ({
            worktreePath: `${workdir}/.codex-swarm/wt-${slug}`,
            branchName: `swarm/${runId}/${slug}`,
          }),
          cleanupWorktree: async (opts) => {
            cleanupCalls.push(opts);
          },
          preserveWorktreePatch: async () => {
            throw new Error("simulated preservation failure");
          },
        },
      });

      await hv.launch(plan);
      conductors[0].fail("worker crashed");
      await waitForCondition(() => hv.getStatus().failedShards === 1);
      await hv.shutdown("test_preservation_failure");

      assert.equal(
        cleanupCalls.length,
        1,
        "cleanup must run even when preservation throws",
      );
      assert.equal(
        readEventLog(hv.eventLogPath).some(
          (entry) => entry.event === "recovery_patch_saved",
        ),
        false,
        "no recovery_patch_saved event when preservation fails",
      );

      hv = null;
    });

    it("skips recovery patch emission for clean worktrees", async () => {
      const plan = planSwarm(null, { content: SINGLE_NO_FILES_PRD });
      const { createConductor, conductors } = createMockConductorFactory();
      const preserveCalls = [];

      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        runId: "recovery-skip",
        _deps: {
          createConductor,
          ensureWorktree: async ({ slug, runId }) => ({
            worktreePath: `${workdir}/.codex-swarm/wt-${slug}`,
            branchName: `swarm/${runId}/${slug}`,
          }),
          cleanupWorktree: async () => {},
          preserveWorktreePatch: async (opts) => {
            preserveCalls.push(opts);
            return { ok: true, skipped: true };
          },
        },
      });

      await hv.launch(plan);
      conductors[0].fail("worker crashed");
      await waitForCondition(() => hv.getStatus().failedShards === 1);
      await hv.shutdown("test_preservation_skip");

      assert.equal(preserveCalls.length, 1);
      assert.equal(
        readEventLog(hv.eventLogPath).some(
          (entry) => entry.event === "recovery_patch_saved",
        ),
        false,
        "clean worktree must not emit recovery_patch_saved",
      );

      hv = null;
    });

    it("preserves failed shard worktrees when keepFailedWorktrees=true", async () => {
      const plan = planSwarm(null, { content: SINGLE_NO_FILES_PRD });
      const { createConductor, conductors } = createMockConductorFactory();
      const cleanupCalls = [];

      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        runId: "failed-keep",
        keepFailedWorktrees: true,
        _deps: {
          createConductor,
          ensureWorktree: async ({ slug, runId }) => ({
            worktreePath: `${workdir}/.codex-swarm/wt-${slug}`,
            branchName: `swarm/${runId}/${slug}`,
          }),
          cleanupWorktree: async (opts) => {
            cleanupCalls.push(opts);
          },
        },
      });

      await hv.launch(plan);
      conductors[0].fail("worker crashed");
      await waitForCondition(() => hv.getStatus().failedShards === 1);
      await hv.shutdown("test_keep_failed");

      assert.deepEqual(cleanupCalls, []);
      assert.equal(
        readEventLog(hv.eventLogPath).some(
          (entry) => entry.event === "worktree_auto_cleanup",
        ),
        false,
      );

      hv = null;
    });

    it("transitions to FAILED state on early shutdown", async () => {
      const plan = planSwarm(null, { content: SIMPLE_PRD });
      ({ hv } = createTestHypervisor(workdir, logsDir));

      await hv.launch(plan);
      await hv.shutdown("test_abort");

      assert.equal(hv.state, SWARM_STATES.FAILED);
      hv = null; // afterEach won't call it again
    });

    it("emits shutdown event", async () => {
      ({ hv } = createTestHypervisor(workdir, logsDir));

      let emitted = false;
      hv.on("shutdown", () => {
        emitted = true;
      });

      const plan = planSwarm(null, { content: SIMPLE_PRD });
      await hv.launch(plan);
      await hv.shutdown("test");

      assert.equal(emitted, true);
      hv = null; // afterEach won't call it again
    });

    it("clears the shared mesh registry during shutdown", async () => {
      let cleared = 0;
      const registry = {
        register() {},
        unregister() {},
        discover() {
          return [];
        },
        getAgent() {
          return null;
        },
        listAll() {
          return [];
        },
        clear() {
          cleared += 1;
        },
      };

      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        _deps: {
          createRegistry: () => registry,
        },
      });

      await hv.shutdown("test_registry_cleanup");

      assert.equal(cleared, 1);
      hv = null;
    });
  });

  describe("events", () => {
    it("emits stateChange events", async () => {
      ({ hv } = createTestHypervisor(workdir, logsDir));

      const events = [];
      hv.on("stateChange", (e) => events.push(e));

      const plan = planSwarm(null, { content: SIMPLE_PRD });
      await hv.launch(plan);

      assert.ok(events.length >= 2); // PLANNING→LAUNCHING→RUNNING
      assert.equal(events[0].from, SWARM_STATES.PLANNING);
      assert.equal(events[0].to, SWARM_STATES.LAUNCHING);
    });
  });
});
