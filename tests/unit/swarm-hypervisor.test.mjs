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

const CRITICAL_NO_FILES_PRD = `
## Shard: critical-shard
- agent: codex
- critical: true
- prompt: critical work

## Shard: normal-shard
- agent: codex
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
    let topPids = [];
    const conductor = {
      spawnSession(config) {
        sessionConfig = config;
      },
      on(event, handler) {
        if (event === "dead") deadHandler = handler;
      },
      getSnapshot() {
        const snapshot = completed
          ? [{ state: "completed", outPath: sessionConfig?.outPath || null }]
          : [{ state: "healthy", outPath: sessionConfig?.outPath || null }];
        snapshot.topPids = topPids;
        return snapshot;
      },
      shutdown() {
        completed = true;
        return Promise.resolve();
      },
      setTopPids(pids) {
        topPids = pids;
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

    it("does not let an invalid redundant completion kill a healthy primary", async () => {
      const plan = planSwarm(null, { content: CRITICAL_NO_FILES_PRD });
      const { createConductor, conductors } = createMockConductorFactory();
      const rebaseCalls = [];

      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        runId: "redundant-invalid-completion",
        _deps: {
          createConductor,
          ensureWorktree: async ({ slug, runId }) => ({
            worktreePath: `${workdir}/.codex-swarm/wt-${slug}`,
            branchName: `swarm/${runId}/${slug}`,
          }),
          prepareIntegrationBranch: async () => ({
            integrationBranch: "swarm/redundant-invalid-completion/merge",
            baseCommit: "abc123",
          }),
          rebaseShardOntoIntegration: async ({ shardName, shardBranch }) => {
            rebaseCalls.push({ shardName, shardBranch });
            return {
              ok: true,
              headCommit: `head:${shardBranch}`,
              strategy: "cherry-pick",
              commits: 1,
              notes: "test integration",
            };
          },
          cleanupWorktree: async () => {},
        },
      });

      await hv.launch(plan);
      assert.equal(conductors.length, 3);

      const primary = conductors.find(
        (item) =>
          item.sessionConfig.worktreePath.includes("wt-critical-shard") &&
          !item.sessionConfig.worktreePath.includes("redundant"),
      );
      const redundant = conductors.find((item) =>
        item.sessionConfig.worktreePath.includes("wt-critical-shard-redundant"),
      );
      assert.ok(primary, "primary conductor expected");
      assert.ok(redundant, "redundant conductor expected");

      redundant.complete(undefined, {
        status: "failed",
        reason: "OAuth timeout",
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.equal(
        primary.getSnapshot()[0].state,
        "healthy",
        "invalid redundant completion must not stop the primary",
      );
      assert.equal(hv.getStatus().completedShards, 0);

      primary.complete(undefined, {
        status: "ok",
        commits_made: [{ sha: "abc1234", message: "fix: primary result" }],
      });
      conductors
        .find((item) => item.sessionConfig.id.includes("normal-shard"))
        .complete();

      const result = await hv.integrationComplete();
      assert.deepEqual(result.failed, []);
      assert.deepEqual(result.integrated, ["critical-shard", "normal-shard"]);
      assert.ok(rebaseCalls[0].shardBranch.endsWith("/critical-shard"));

      const events = readEventLog(hv.eventLogPath);
      assert.ok(
        events.some(
          (entry) =>
            entry.event === "redundant_completion_rejected" &&
            entry.reason === "worker_reported_failed:OAuth timeout",
        ),
      );
      assert.equal(
        events.some((entry) => entry.event === "redundant_wins"),
        false,
      );
    });

    it("rejects a no-commit redundant completion and keeps the primary alive (#394)", async () => {
      // The exact #394 regression: a redundant worker (agy/gemini) signals
      // completion with NO structured payload (F7 is bypassed) and zero commits.
      // It must NOT win the shard nor SIGKILL the working primary.
      const plan = planSwarm(null, { content: CRITICAL_PRD });
      const { createConductor, conductors } = createMockConductorFactory();
      const rebaseCalls = [];

      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        runId: "redundant-no-commit",
        _deps: {
          createConductor,
          // Only the redundant shard branch (…/critical-shard-redundant) has
          // zero commits. Match the branch suffix, not the runId — a runId
          // containing "redundant" must not poison the integration merge range.
          git: async (args) => {
            if (args[0] === "rev-list") {
              const range = args[args.length - 1] || "";
              return range.endsWith("-redundant") ? "0" : "2";
            }
            if (args[0] === "rev-parse") return "deadbeefcafe";
            return ""; // status --short → clean
          },
          ensureWorktree: async ({ slug, runId }) => ({
            worktreePath: `${workdir}/.codex-swarm/wt-${slug}`,
            branchName: `swarm/${runId}/${slug}`,
          }),
          prepareIntegrationBranch: async () => ({
            integrationBranch: "swarm/redundant-no-commit/merge",
            baseCommit: "abc123",
          }),
          rebaseShardOntoIntegration: async ({ shardName, shardBranch }) => {
            rebaseCalls.push({ shardName, shardBranch });
            return {
              ok: true,
              headCommit: `head:${shardBranch}`,
              strategy: "cherry-pick",
              commits: 2,
              notes: "test integration",
            };
          },
          cleanupWorktree: async () => {},
        },
      });

      await hv.launch(plan);
      const primary = conductors.find(
        (item) =>
          item.sessionConfig.worktreePath.includes("wt-critical-shard") &&
          !item.sessionConfig.worktreePath.includes("redundant"),
      );
      const redundant = conductors.find((item) =>
        item.sessionConfig.worktreePath.includes("wt-critical-shard-redundant"),
      );
      assert.ok(primary, "primary conductor expected");
      assert.ok(redundant, "redundant conductor expected");

      // No payload at all — legacy/agy completion that bypasses the F7 check.
      redundant.complete(undefined, undefined);
      await new Promise((resolve) => setTimeout(resolve, 30));

      assert.equal(
        primary.getSnapshot()[0].state,
        "healthy",
        "a no-commit redundant completion must not stop the primary",
      );
      assert.equal(hv.getStatus().completedShards, 0);

      const events = readEventLog(hv.eventLogPath);
      assert.ok(
        events.some(
          (entry) =>
            entry.event === "redundant_win_rejected" &&
            entry.reason === "no_commit" &&
            entry.shard === "critical-shard" &&
            entry.commitsAhead === 0,
        ),
        "redundant_win_rejected (no_commit) must be logged",
      );
      assert.equal(
        events.some((entry) => entry.event === "redundant_wins"),
        false,
        "no redundant_wins for a worker with zero commits",
      );

      // The primary is still the authoritative attempt — let it finish.
      primary.complete(undefined, {
        status: "ok",
        commits_made: [{ sha: "abc1234", message: "fix: primary result" }],
      });
      conductors
        .find((item) => item.sessionConfig.id.includes("normal-shard"))
        .complete(undefined, {
          status: "ok",
          commits_made: [{ sha: "def5678", message: "feat: normal" }],
        });

      const result = await hv.integrationComplete();
      assert.deepEqual(result.integrated, ["critical-shard", "normal-shard"]);
      // Integration must use the PRIMARY branch, never the rejected redundant.
      assert.ok(rebaseCalls[0].shardBranch.endsWith("/critical-shard"));

      // afterEach shuts the hypervisor down (closes the event-log stream).
    });

    it("rejects a redundant completion that claims commits git cannot confirm (#394)", async () => {
      // Defense-in-depth: even a schema-valid payload claiming commits_made is
      // not trusted. Authoritative git evidence (commitsAhead) is the gate.
      const plan = planSwarm(null, { content: CRITICAL_PRD });
      const { createConductor, conductors } = createMockConductorFactory();

      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        runId: "redundant-phantom-commit",
        _deps: {
          createConductor,
          git: async (args) => {
            if (args[0] === "rev-list") {
              // Only the redundant shard branch (…/critical-shard-redundant)
              // has zero commits. Match the branch suffix, not the runId — a
              // runId containing "redundant" must not poison the merge range.
              const range = args[args.length - 1] || "";
              return range.endsWith("-redundant") ? "0" : "2";
            }
            if (args[0] === "rev-parse") return "deadbeefcafe";
            return "";
          },
          ensureWorktree: async ({ slug, runId }) => ({
            worktreePath: `${workdir}/.codex-swarm/wt-${slug}`,
            branchName: `swarm/${runId}/${slug}`,
          }),
          prepareIntegrationBranch: async () => ({
            integrationBranch: "swarm/redundant-phantom-commit/merge",
            baseCommit: "abc123",
          }),
          rebaseShardOntoIntegration: async () => ({
            ok: true,
            headCommit: "head",
            strategy: "cherry-pick",
            commits: 2,
          }),
          cleanupWorktree: async () => {},
        },
      });

      await hv.launch(plan);
      const primary = conductors.find(
        (item) =>
          item.sessionConfig.worktreePath.includes("wt-critical-shard") &&
          !item.sessionConfig.worktreePath.includes("redundant"),
      );
      const redundant = conductors.find((item) =>
        item.sessionConfig.worktreePath.includes("wt-critical-shard-redundant"),
      );

      // Schema-valid, but the claimed commits don't exist in git.
      redundant.complete(undefined, {
        status: "ok",
        commits_made: [
          { sha: "phantom0", message: "claims work it never did" },
        ],
      });
      await new Promise((resolve) => setTimeout(resolve, 30));

      assert.equal(
        primary.getSnapshot()[0].state,
        "healthy",
        "a phantom-commit redundant completion must not stop the primary",
      );
      const events = readEventLog(hv.eventLogPath);
      assert.ok(
        events.some(
          (entry) =>
            entry.event === "redundant_win_rejected" &&
            entry.reason === "no_commit",
        ),
      );
      assert.equal(
        events.some((entry) => entry.event === "redundant_wins"),
        false,
      );

      // afterEach shuts the hypervisor down (closes the event-log stream).
    });

    it("rejects a redundant completion with commits but a dirty worktree (#394)", async () => {
      // commitsAhead > 0 alone is insufficient: a dirty worktree means
      // integration would F6-fail this branch, so promoting it would kill the
      // primary for nothing. The gate requires evidence.ok (commits AND clean).
      const plan = planSwarm(null, { content: CRITICAL_PRD });
      const { createConductor, conductors } = createMockConductorFactory();

      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        runId: "redundant-dirty",
        _deps: {
          createConductor,
          git: async (args, cwd) => {
            if (args[0] === "rev-list") return "2"; // every branch has commits
            if (args[0] === "rev-parse") return "deadbeefcafe";
            if (args[0] === "status") {
              // Only the redundant worktree carries uncommitted changes.
              return cwd?.includes("redundant") ? "?? src/junk.mjs" : "";
            }
            return "";
          },
          ensureWorktree: async ({ slug, runId }) => ({
            worktreePath: `${workdir}/.codex-swarm/wt-${slug}`,
            branchName: `swarm/${runId}/${slug}`,
          }),
          prepareIntegrationBranch: async () => ({
            integrationBranch: "swarm/redundant-dirty/merge",
            baseCommit: "abc123",
          }),
          rebaseShardOntoIntegration: async () => ({
            ok: true,
            headCommit: "head",
            strategy: "cherry-pick",
            commits: 2,
          }),
          cleanupWorktree: async () => {},
        },
      });

      await hv.launch(plan);
      const primary = conductors.find(
        (item) =>
          item.sessionConfig.worktreePath.includes("wt-critical-shard") &&
          !item.sessionConfig.worktreePath.includes("redundant"),
      );
      const redundant = conductors.find((item) =>
        item.sessionConfig.worktreePath.includes("wt-critical-shard-redundant"),
      );

      redundant.complete(undefined, {
        status: "ok",
        commits_made: [
          { sha: "dirty123", message: "committed but left a mess" },
        ],
      });
      await new Promise((resolve) => setTimeout(resolve, 30));

      assert.equal(
        primary.getSnapshot()[0].state,
        "healthy",
        "a dirty redundant worktree must not stop the primary",
      );
      const events = readEventLog(hv.eventLogPath);
      assert.ok(
        events.some(
          (entry) =>
            entry.event === "redundant_win_rejected" &&
            entry.reason === "dirty_worktree" &&
            entry.dirty === true,
        ),
        "redundant_win_rejected (dirty_worktree) must be logged",
      );
      assert.equal(
        events.some((entry) => entry.event === "redundant_wins"),
        false,
        "no redundant_wins when the redundant worktree is dirty",
      );

      // afterEach shuts the hypervisor down (closes the event-log stream).
    });

    it("lets a redundant worker with real commits win and retire the primary (#394)", async () => {
      // Positive path: the redundant worker actually produced commits, so it is
      // a valid winner and the primary is shut down.
      const plan = planSwarm(null, { content: CRITICAL_PRD });
      const { createConductor, conductors } = createMockConductorFactory();
      const rebaseCalls = [];

      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        runId: "redundant-real-commit",
        _deps: {
          createConductor,
          // Every branch — including the redundant one — has commits.
          git: async (args) => {
            if (args[0] === "rev-list") return "2";
            if (args[0] === "rev-parse") return "deadbeefcafe";
            return "";
          },
          ensureWorktree: async ({ slug, runId }) => ({
            worktreePath: `${workdir}/.codex-swarm/wt-${slug}`,
            branchName: `swarm/${runId}/${slug}`,
          }),
          prepareIntegrationBranch: async () => ({
            integrationBranch: "swarm/redundant-real-commit/merge",
            baseCommit: "abc123",
          }),
          rebaseShardOntoIntegration: async ({ shardName, shardBranch }) => {
            rebaseCalls.push({ shardName, shardBranch });
            return {
              ok: true,
              headCommit: `head:${shardBranch}`,
              strategy: "cherry-pick",
              commits: 2,
            };
          },
          cleanupWorktree: async () => {},
        },
      });

      await hv.launch(plan);
      const primary = conductors.find(
        (item) =>
          item.sessionConfig.worktreePath.includes("wt-critical-shard") &&
          !item.sessionConfig.worktreePath.includes("redundant"),
      );
      const redundant = conductors.find((item) =>
        item.sessionConfig.worktreePath.includes("wt-critical-shard-redundant"),
      );

      redundant.complete(undefined, {
        status: "ok",
        commits_made: [
          { sha: "real1234", message: "fix: redundant did the work" },
        ],
      });
      await new Promise((resolve) => setTimeout(resolve, 30));

      const events = readEventLog(hv.eventLogPath);
      assert.ok(
        events.some(
          (entry) =>
            entry.event === "redundant_wins" &&
            entry.shard === "critical-shard" &&
            entry.commitsAhead === 2,
        ),
        "redundant_wins must fire with commit evidence",
      );
      assert.equal(
        primary.getSnapshot()[0].state,
        "completed",
        "the primary must be shut down once the redundant worker wins",
      );

      conductors
        .find((item) => item.sessionConfig.id.includes("normal-shard"))
        .complete(undefined, {
          status: "ok",
          commits_made: [{ sha: "def5678", message: "feat: normal" }],
        });

      const result = await hv.integrationComplete();
      assert.deepEqual(result.integrated, ["critical-shard", "normal-shard"]);
      // The winning shard integrates from the redundant branch.
      assert.ok(
        rebaseCalls.some((call) =>
          call.shardBranch.endsWith("/critical-shard-redundant"),
        ),
        "integration must use the winning redundant branch",
      );

      // afterEach shuts the hypervisor down (closes the event-log stream).
    });

    it("does not let a slow redundant evidence probe flip a primary that won mid-await (#394 race)", async () => {
      // TOCTOU race: redundant completes first and finalizeRedundantWin awaits
      // git evidence; the primary completes DURING that await. When the probe
      // resumes it must NOT flip the already-decided winner.
      const plan = planSwarm(null, { content: CRITICAL_PRD });
      const { createConductor, conductors } = createMockConductorFactory();
      const rebaseCalls = [];
      let releaseRedundantGit;
      const redundantGitGate = new Promise((resolve) => {
        releaseRedundantGit = resolve;
      });

      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        runId: "redundant-race",
        _deps: {
          createConductor,
          // The redundant-branch probe blocks until the test releases it, so the
          // primary can win while finalizeRedundantWin is awaiting evidence.
          git: async (args) => {
            if (args[0] === "rev-list") {
              const range = args[args.length - 1] || "";
              if (range.endsWith("-redundant")) {
                await redundantGitGate;
                return "2"; // redundant did commit — but it is already too late
              }
              return "2";
            }
            if (args[0] === "rev-parse") return "deadbeefcafe";
            return "";
          },
          ensureWorktree: async ({ slug, runId }) => ({
            worktreePath: `${workdir}/.codex-swarm/wt-${slug}`,
            branchName: `swarm/${runId}/${slug}`,
          }),
          prepareIntegrationBranch: async () => ({
            integrationBranch: "swarm/redundant-race/merge",
            baseCommit: "abc123",
          }),
          rebaseShardOntoIntegration: async ({ shardName, shardBranch }) => {
            rebaseCalls.push({ shardName, shardBranch });
            return {
              ok: true,
              headCommit: `head:${shardBranch}`,
              strategy: "cherry-pick",
              commits: 2,
            };
          },
          cleanupWorktree: async () => {},
        },
      });

      await hv.launch(plan);
      const primary = conductors.find(
        (item) =>
          item.sessionConfig.worktreePath.includes("wt-critical-shard") &&
          !item.sessionConfig.worktreePath.includes("redundant"),
      );

      const redundant = conductors.find((item) =>
        item.sessionConfig.worktreePath.includes("wt-critical-shard-redundant"),
      );

      // Redundant completes first → finalizeRedundantWin starts and blocks on
      // the gated git probe.
      redundant.complete(undefined, {
        status: "ok",
        commits_made: [{ sha: "redun123", message: "redundant work" }],
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      // While the probe is blocked, the primary (and normal shard) win.
      primary.complete(undefined, {
        status: "ok",
        commits_made: [{ sha: "prim1234", message: "primary work" }],
      });
      conductors
        .find((item) => item.sessionConfig.id.includes("normal-shard"))
        .complete(undefined, {
          status: "ok",
          commits_made: [{ sha: "norm5678", message: "normal" }],
        });
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Now let the redundant probe resume — it must observe the settled shard.
      releaseRedundantGit();
      await new Promise((resolve) => setTimeout(resolve, 20));

      const result = await hv.integrationComplete();
      assert.deepEqual(result.integrated, ["critical-shard", "normal-shard"]);
      // Critical shard must integrate from the PRIMARY branch, not the redundant.
      const criticalRebase = rebaseCalls.find((call) =>
        call.shardBranch.includes("critical-shard"),
      );
      assert.ok(
        criticalRebase.shardBranch.endsWith("/critical-shard"),
        "winner must stay the primary, not the late redundant",
      );

      await hv.shutdown("test_flush");
      const events = readEventLog(hv.eventLogPath);
      assert.ok(
        events.some(
          (entry) =>
            entry.event === "redundant_win_superseded" &&
            entry.phase === "after_evidence",
        ),
        "the superseded redundant must be logged after the evidence hop",
      );
      assert.equal(
        events.some((entry) => entry.event === "redundant_wins"),
        false,
        "no redundant_wins once the primary already won",
      );
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
      assert.ok(
        conductors[0].sessionConfig.prompt.includes(
          "Lease-scoped Acceptance / Lint Guard",
        ),
      );
      assert.ok(
        conductors[0].sessionConfig.prompt.includes(
          `작업 루트(절대경로): ${workdir}/.codex-swarm/wt-worker-a — 아래 lease 경로와 모든 상대경로는 이 루트 기준으로만 해석한다.`,
        ),
      );
      assert.ok(conductors[0].sessionConfig.prompt.includes("- src/a.mjs"));
      assert.ok(
        conductors[0].sessionConfig.prompt.includes(
          "npx biome check <changed-files-or-lease-files>",
        ),
      );
    });

    it("keeps native bridge registration disabled for direct hypervisor construction", async () => {
      const plan = planSwarm(null, { content: SINGLE_PRD });
      const registerCalls = [];
      const { createConductor } = createMockConductorFactory();

      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        runId: "native-bridge-default-off",
        _deps: {
          createConductor,
          registerSwarmShard: async (opts) => {
            registerCalls.push(opts);
            return { close() {} };
          },
          ensureWorktree: async ({ slug, runId }) => ({
            worktreePath: `${workdir}/.codex-swarm/wt-${slug}`,
            branchName: `swarm/${runId}/${slug}`,
          }),
        },
      });

      await hv.launch(plan);

      assert.deepEqual(registerCalls, []);
    });

    it("registers native bridge shard rows under the parent project cwd", async () => {
      const plan = planSwarm(null, { content: SINGLE_PRD });
      const registerCalls = [];
      const closeCalls = [];
      const { createConductor, conductors } = createMockConductorFactory();

      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        runId: "native-bridge-parent-cwd",
        nativeBridge: true,
        _deps: {
          createConductor,
          registerSwarmShard: async (opts) => {
            registerCalls.push(opts);
            return {
              displayName:
                "Triflux swarm native-bridge-parent-cwd 01/01 claude worker-a",
              close: () => closeCalls.push(opts.shardName),
            };
          },
          ensureWorktree: async ({ slug, runId }) => ({
            worktreePath: `${workdir}/.codex-swarm/wt-${slug}`,
            branchName: `swarm/${runId}/${slug}`,
          }),
        },
      });

      await hv.launch(plan);

      assert.equal(registerCalls.length, 1);
      assert.equal(registerCalls[0].shardName, "worker-a");
      assert.equal(registerCalls[0].cwd, workdir);
      assert.equal(registerCalls[0].sessionId, conductors[0].sessionConfig.id);
      assert.equal(registerCalls[0].swarmName, "native-bridge-parent-cwd");
      assert.equal(registerCalls[0].shardIndex, 1);
      assert.equal(registerCalls[0].shardCount, 1);
      assert.equal(
        conductors[0].sessionConfig.workdir,
        `${workdir}/.codex-swarm/wt-worker-a`,
      );

      await hv.shutdown("native_bridge_parent_cwd_cleanup");
      assert.equal(
        readEventLog(hv.eventLogPath).find(
          (entry) => entry.event === "native_bridge_registration",
        )?.displayName,
        "Triflux swarm native-bridge-parent-cwd 01/01 claude worker-a",
      );
      hv = null;
      assert.deepEqual(closeCalls, ["worker-a"]);
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

    it("maybeCleanupWorktree closes native bridge before process and worktree cleanup", async () => {
      const plan = planSwarm(null, { content: SINGLE_NO_FILES_PRD });
      const { createConductor, conductors } = createMockConductorFactory();
      const calls = [];

      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        runId: "process-cleanup-order",
        nativeBridge: true,
        _deps: {
          createConductor,
          registerSwarmShard: async (opts) => ({
            close: async () => {
              calls.push({ type: "bridge", opts });
            },
          }),
          ensureWorktree: async ({ slug, runId }) => ({
            worktreePath: `${workdir}/.codex-swarm/wt-${slug}`,
            branchName: `swarm/${runId}/${slug}`,
          }),
          prepareIntegrationBranch: async () => ({
            integrationBranch: "swarm/process-cleanup-order/merge",
            baseCommit: "abc123",
          }),
          rebaseShardOntoIntegration: async () => ({
            ok: true,
            headCommit: "def456",
          }),
          cleanupShardProcesses: async (opts) => {
            calls.push({ type: "process", opts });
            return { killed: 1, byCategory: { node: 1 } };
          },
          cleanupWorktree: async (opts) => {
            calls.push({ type: "worktree", opts });
          },
        },
      });

      await hv.launch(plan);
      conductors[0].setTopPids([12345]);
      conductors[0].complete();
      await hv.integrationComplete();

      assert.deepEqual(
        calls.map((call) => call.type),
        ["bridge", "process", "worktree"],
      );
      assert.deepEqual(calls[0].opts.cwd, workdir);
      assert.deepEqual(calls[0].opts.shardName, "worker-a");
      assert.deepEqual(calls[1].opts, {
        worktreePath: `${workdir}/.codex-swarm/wt-worker-a`,
        sessionIds: [conductors[0].sessionConfig.id],
        topPids: [12345],
        runId: "process-cleanup-order",
        shardName: "worker-a",
      });
    });

    it("maybeCleanupWorktree skips remote shards", async () => {
      const basePlan = planSwarm(null, { content: SINGLE_NO_FILES_PRD });
      const plan = {
        ...basePlan,
        shards: [
          {
            ...basePlan.shards[0],
            host: "remote-host",
            _remoteEnv: { claudePath: "claude" },
          },
        ],
      };
      const { createConductor, conductors } = createMockConductorFactory();
      const cleanupCalls = [];

      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        runId: "remote-cleanup-skip",
        _deps: {
          createConductor,
          ensureWorktree: async ({ slug, runId }) => ({
            worktreePath: `${workdir}/.codex-swarm/wt-${slug}`,
            branchName: `swarm/${runId}/${slug}`,
          }),
          prepareIntegrationBranch: async () => ({
            integrationBranch: "swarm/remote-cleanup-skip/merge",
            baseCommit: "abc123",
          }),
          rebaseShardOntoIntegration: async () => ({
            ok: true,
            headCommit: "def456",
          }),
          cleanupShardProcesses: async (opts) => {
            cleanupCalls.push({ type: "process", opts });
          },
          cleanupWorktree: async (opts) => {
            cleanupCalls.push({ type: "worktree", opts });
          },
        },
      });

      await hv.launch(plan);
      conductors[0].complete();
      await hv.integrationComplete();

      assert.deepEqual(cleanupCalls, []);
    });

    it("maybeCleanupWorktree continues on cleanupShardProcesses failure", async () => {
      const plan = planSwarm(null, { content: SINGLE_NO_FILES_PRD });
      const { createConductor, conductors } = createMockConductorFactory();
      const cleanupCalls = [];

      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        runId: "process-cleanup-failure",
        _deps: {
          createConductor,
          ensureWorktree: async ({ slug, runId }) => ({
            worktreePath: `${workdir}/.codex-swarm/wt-${slug}`,
            branchName: `swarm/${runId}/${slug}`,
          }),
          prepareIntegrationBranch: async () => ({
            integrationBranch: "swarm/process-cleanup-failure/merge",
            baseCommit: "abc123",
          }),
          rebaseShardOntoIntegration: async () => ({
            ok: true,
            headCommit: "def456",
          }),
          cleanupShardProcesses: async () => {
            throw new Error("simulated process cleanup failure");
          },
          cleanupWorktree: async (opts) => {
            cleanupCalls.push(opts);
          },
        },
      });

      await hv.launch(plan);
      conductors[0].complete();
      await hv.integrationComplete();

      assert.equal(cleanupCalls.length, 1);
      await hv.shutdown("flush_process_cleanup_failure");
      assert.equal(
        readEventLog(hv.eventLogPath).some(
          (entry) => entry.event === "process_cleanup_failed",
        ),
        true,
      );
    });

    it("summary includes processCleanup metadata", async () => {
      const plan = planSwarm(null, { content: SINGLE_NO_FILES_PRD });
      const { createConductor, conductors } = createMockConductorFactory();

      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        runId: "process-cleanup-summary",
        _deps: {
          createConductor,
          ensureWorktree: async ({ slug, runId }) => ({
            worktreePath: `${workdir}/.codex-swarm/wt-${slug}`,
            branchName: `swarm/${runId}/${slug}`,
          }),
          prepareIntegrationBranch: async () => ({
            integrationBranch: "swarm/process-cleanup-summary/merge",
            baseCommit: "abc123",
          }),
          rebaseShardOntoIntegration: async () => ({
            ok: true,
            headCommit: "def456",
          }),
          cleanupShardProcesses: async () => ({
            killed: 3,
            byCategory: { node: 2, bash: 1 },
          }),
          cleanupWorktree: async () => {},
        },
      });

      await hv.launch(plan);
      conductors[0].complete();
      const result = await hv.integrationComplete();

      assert.deepEqual(result.processCleanup, {
        totalKilled: 3,
        byCategory: { node: 2, bash: 1 },
      });
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

    it("reports per-shard integration strategy and recovery patch trail", async () => {
      const plan = planSwarm(null, { content: PARALLEL_NO_FILES_PRD });
      const { createConductor, conductors } = createMockConductorFactory();
      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        runId: "integration-report",
        _deps: {
          createConductor,
          ensureWorktree: async ({ slug, runId }) => ({
            worktreePath: `${workdir}/.codex-swarm/wt-${slug}`,
            branchName: `swarm/${runId}/${slug}`,
          }),
          prepareIntegrationBranch: async () => ({
            integrationBranch: "swarm/integration-report/merge",
            baseCommit: "abc123",
          }),
          rebaseShardOntoIntegration: async ({ shardBranch }) =>
            shardBranch.endsWith("/worker-a")
              ? {
                  ok: true,
                  headCommit: "aaa1111",
                  strategy: "auto-ff",
                  commits: 3,
                  notes: "linear (merge --ff-only)",
                }
              : {
                  ok: false,
                  strategy: "failed",
                  commits: 2,
                  error: "conflict in pkg.json",
                },
          cleanupWorktree: async () => {},
          preserveWorktreePatch: async (opts) => ({
            ok: true,
            patchPath: `${opts.recoveryDir}/${opts.shardId}.patch`,
            manifestPath: `${opts.recoveryDir}/manifest.json`,
          }),
        },
      });

      await hv.launch(plan);
      conductors[0].complete();
      conductors[1].complete();

      const result = await hv.integrationComplete();

      assert.deepEqual(result.integrated, ["worker-a"]);
      assert.deepEqual(result.integrationFailures, ["worker-b"]);
      assert.equal(result.report.length, 2);
      assert.deepEqual(result.report[0], {
        shard: "worker-a",
        strategy: "auto-ff",
        commits: 3,
        finalSha: "aaa1111",
        notes: "linear (merge --ff-only)",
        recoveryPatch: null,
      });
      assert.equal(result.report[1].shard, "worker-b");
      assert.equal(result.report[1].strategy, "failed");
      assert.equal(result.report[1].commits, 2);
      assert.match(result.report[1].notes, /conflict in pkg\.json/u);
      assert.equal(
        result.report[1].recoveryPatch,
        `${join(workdir, ".codex-swarm", "recovery")}/worker-b.patch`,
      );
      assert.deepEqual(hv.getStatus().integrationPromise.report, result.report);

      let reportEvents = [];
      await waitForCondition(() => {
        reportEvents = readEventLog(hv.eventLogPath).filter(
          (entry) => entry.event === "integration_shard_report",
        );
        return reportEvents.length === 2;
      });
      assert.equal(reportEvents.length, 2);
      assert.equal(reportEvents[0].strategy, "auto-ff");
      assert.equal(
        reportEvents[1].recoveryPatch,
        result.report[1].recoveryPatch,
      );
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

    it("shutdown cleanups all launched local workers", async () => {
      const plan = planSwarm(null, { content: PARALLEL_NO_FILES_PRD });
      const { createConductor } = createMockConductorFactory();
      const processCleanupCalls = [];
      const worktreeCleanupCalls = [];

      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        runId: "shutdown-all-local",
        _deps: {
          createConductor,
          ensureWorktree: async ({ slug, runId }) => ({
            worktreePath: `${workdir}/.codex-swarm/wt-${slug}`,
            branchName: `swarm/${runId}/${slug}`,
          }),
          cleanupShardProcesses: async (opts) => {
            processCleanupCalls.push(opts);
            return { killed: 0, byCategory: {} };
          },
          cleanupWorktree: async (opts) => {
            worktreeCleanupCalls.push(opts);
          },
        },
      });

      await hv.launch(plan);
      await hv.shutdown("test_shutdown_cleanup_all");

      assert.deepEqual(
        processCleanupCalls.map((call) => call.shardName).sort(),
        ["worker-a", "worker-b"],
      );
      assert.deepEqual(
        worktreeCleanupCalls
          .map((call) => ({
            worktreePath: call.worktreePath,
            branchName: call.branchName,
            force: call.force,
          }))
          .sort((a, b) => a.worktreePath.localeCompare(b.worktreePath)),
        [
          {
            worktreePath: `${workdir}/.codex-swarm/wt-worker-a`,
            branchName: "swarm/shutdown-all-local/worker-a",
            force: true,
          },
          {
            worktreePath: `${workdir}/.codex-swarm/wt-worker-b`,
            branchName: "swarm/shutdown-all-local/worker-b",
            force: true,
          },
        ],
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

    it("preserves uncommitted work on the success teardown path (#394)", async () => {
      // #394 secondary case (hub-observability): a worker exits 0 with dirty,
      // uncommitted work. With no shard.files it bypasses the integration
      // commit-evidence guard and reaches the SUCCESS cleanup, which carries no
      // failureReason. Preservation must still run so the work is not lost.
      const plan = planSwarm(null, { content: SINGLE_NO_FILES_PRD });
      const { createConductor, conductors } = createMockConductorFactory();
      const preserveCalls = [];

      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        runId: "recovery-success-path",
        _deps: {
          createConductor,
          git: async (args) => {
            if (args[0] === "rev-list") return "1";
            if (args[0] === "rev-parse") return "deadbeefcafe";
            return "";
          },
          ensureWorktree: async ({ slug, runId }) => ({
            worktreePath: `${workdir}/.codex-swarm/wt-${slug}`,
            branchName: `swarm/${runId}/${slug}`,
          }),
          prepareIntegrationBranch: async () => ({
            integrationBranch: "swarm/recovery-success-path/merge",
            baseCommit: "abc123",
          }),
          rebaseShardOntoIntegration: async ({ shardBranch }) => ({
            ok: true,
            headCommit: `head:${shardBranch}`,
            strategy: "cherry-pick",
            commits: 1,
          }),
          cleanupWorktree: async () => {},
          // Dirty worktree — preservation captures a patch (not skipped).
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
      conductors[0].complete(undefined, {
        status: "ok",
        commits_made: [{ sha: "abc1234", message: "feat: work" }],
      });

      const result = await hv.integrationComplete();
      assert.deepEqual(result.integrated, ["worker-a"]);

      assert.equal(
        preserveCalls.length,
        1,
        "preservation must run on the success teardown path",
      );

      // Flush the async event-log write stream to disk before reading it.
      await hv.shutdown("test_flush");

      const savedEvent = readEventLog(hv.eventLogPath).find(
        (entry) => entry.event === "recovery_patch_saved",
      );
      assert.ok(
        savedEvent,
        "recovery_patch_saved must fire on success cleanup",
      );
      assert.equal(savedEvent.shard, "worker-a");
      assert.equal(savedEvent.reason, "dirty_on_cleanup");

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
