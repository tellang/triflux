// tests/unit/swarm-hypervisor.test.mjs — swarm-hypervisor 유닛 테스트

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
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
      complete(sessionId = sessionConfig?.id || "session") {
        completed = true;
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

    it("prevents double launch", async () => {
      const plan = planSwarm(null, { content: PARALLEL_PRD });
      ({ hv } = createTestHypervisor(workdir, logsDir));

      await hv.launch(plan);
      await assert.rejects(() => hv.launch(plan), /Cannot launch/);
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
      const plan = planSwarm(null, { content: SINGLE_PRD });
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
        },
      ]);
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
    });
  });

  describe("validateResult", () => {
    it("passes when worker modifies only its leased files", async () => {
      const plan = planSwarm(null, { content: SIMPLE_PRD });
      ({ hv } = createTestHypervisor(workdir, logsDir));

      await hv.launch(plan);

      const result = hv.validateResult("worker-a", ["src/a.mjs"]);
      assert.equal(result.ok, true);
      assert.equal(result.violations.length, 0);
    });

    it("detects violations when worker modifies other shard files", async () => {
      const plan = planSwarm(null, { content: SIMPLE_PRD });
      ({ hv } = createTestHypervisor(workdir, logsDir));

      await hv.launch(plan);

      // worker-a tries to modify worker-b's file
      const result = hv.validateResult("worker-a", ["src/b.mjs"]);
      assert.equal(result.ok, false);
      assert.equal(result.violations.length, 1);
    });
  });

  describe("shutdown", () => {
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
