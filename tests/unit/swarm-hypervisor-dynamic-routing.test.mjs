// tests/unit/swarm-hypervisor-dynamic-routing.test.mjs
//
// Phase 1 wire-up 2 — swarm-hypervisor.launch() plan-time dynamic routing.
//
// 인변량 검증:
//   1. launch() 는 plan-time, async path → D-1 facade 의 await routeRequest 사용 OK.
//   2. env opt-in (TRIFLUX_DYNAMIC_ROUTING=1|true) 일 때만 발화.
//   3. team_size = plan.shards.length 매핑.
//   4. decision.shards[i].cli !== plan.shards[i].agent 일 때만 1:1 override.
//   5. cache miss / error 시 fail-closed — plan 그대로.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resetSnapshotCache } from "../../hub/routing-snapshot.mjs";
import { createSwarmHypervisor } from "../../hub/team/swarm-hypervisor.mjs";

process.setMaxListeners(50);

const ENV_FLAG = "TRIFLUX_DYNAMIC_ROUTING";

function makeTmpDir(prefix) {
  const dir = join(
    tmpdir(),
    `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createMockConductor() {
  const sessions = [];
  const conductor = new EventEmitter();
  conductor.spawnSession = (config) => {
    sessions.push(config);
    setImmediate(() =>
      config.onCompleted?.({ sessionId: config.id, completionPayload: null }),
    );
    return config.id;
  };
  conductor.killSession = async () => {};
  conductor.shutdown = async () => {};
  conductor.sendInput = () => false;
  conductor.getSnapshot = () => [];
  conductor.eventLogPath = null;
  conductor.getMeshRegistry = () => null;
  return { conductor, sessions };
}

function createMockConductorFactory() {
  const conductors = [];
  return {
    createConductor: () => {
      const { conductor } = createMockConductor();
      conductors.push(conductor);
      return conductor;
    },
    conductors,
  };
}

function makePlan({ shards } = {}) {
  return {
    shards: shards || [
      {
        name: "worker-a",
        agent: "claude",
        files: [],
        depends: [],
        prompt: "echo",
      },
    ],
    mergeOrder: (shards || [{ name: "worker-a" }]).map((s) => s.name),
    conflicts: [],
  };
}

function makeHypervisor(workdir, logsDir, overrides = {}) {
  const factory = createMockConductorFactory();
  const hv = createSwarmHypervisor({
    workdir,
    logsDir,
    maxRestarts: 0,
    graceMs: 100,
    probeOpts: {
      intervalMs: 999_999,
      l1ThresholdMs: 999_999,
      l3ThresholdMs: 999_999,
    },
    ...overrides,
    _deps: {
      createConductor: factory.createConductor,
      ensureWorktree: async ({ slug, runId }) => ({
        worktreePath: join(workdir, ".codex-swarm", `wt-${slug}`),
        branchName: `swarm/${runId}/${slug}`,
      }),
      prepareIntegrationBranch: async () => ({
        integrationBranch: "swarm/test/merge",
        baseCommit: "abc123",
      }),
      rebaseShardOntoIntegration: async () => ({
        ok: true,
        headCommit: "def456",
      }),
      cleanupShardProcesses: async () => {},
      cleanupWorktree: async () => {},
      ensureHubAlive: null,
      getHubInfo: null,
      ...(overrides._deps || {}),
    },
  });
  return { hv, factory };
}

function readSwarmEvents(logsDir) {
  const path = join(logsDir, "swarm-events.jsonl");
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function waitFor(check, timeoutMs = 1500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

let workdir;
let logsDir;
let hv;
let originalEnvFlag;

beforeEach(() => {
  workdir = makeTmpDir("tfx-swarm-dr-work");
  logsDir = makeTmpDir("tfx-swarm-dr-logs");
  originalEnvFlag = process.env[ENV_FLAG];
  delete process.env[ENV_FLAG];
  resetSnapshotCache();
});

afterEach(async () => {
  if (originalEnvFlag === undefined) {
    delete process.env[ENV_FLAG];
  } else {
    process.env[ENV_FLAG] = originalEnvFlag;
  }
  try {
    await hv?.shutdown?.();
  } catch {
    /* may not exist */
  }
  for (const dir of [workdir, logsDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("swarm-hypervisor: dynamic routing wire-up — env gate", () => {
  it("S2-01: env 미설정 시 dynamic_route_plan_decision 이벤트 없음", async () => {
    const result = makeHypervisor(workdir, logsDir);
    hv = result.hv;
    const plan = makePlan();
    await hv.launch(plan);
    await waitFor(() =>
      readSwarmEvents(logsDir).some((e) => e.event === "swarm_state"),
    );
    const events = readSwarmEvents(logsDir);
    const dr = events.find((e) => e.event === "dynamic_route_plan_decision");
    assert.equal(dr, undefined, "env OFF 인데 plan_decision 이벤트 발생");
    // plan.shards 의 agent 가 보존되어야 한다
    assert.equal(plan.shards[0].agent, "claude");
  });

  it("S2-02: env=1 + cache miss + agent=claude → codex override (fail-closed)", async () => {
    process.env[ENV_FLAG] = "1";
    const result = makeHypervisor(workdir, logsDir);
    hv = result.hv;
    const plan = makePlan();
    await hv.launch(plan);
    await waitFor(() =>
      readSwarmEvents(logsDir).some(
        (e) => e.event === "dynamic_route_plan_decision",
      ),
    );
    const events = readSwarmEvents(logsDir);
    const dr = events.find((e) => e.event === "dynamic_route_plan_decision");
    assert.ok(dr, "plan_decision 이벤트 누락");
    assert.equal(dr.scenario, "fallback");
    assert.equal(dr.planShardCount, 1);

    const ov = events.find((e) => e.event === "dynamic_route_plan_overrides");
    assert.ok(ov, "override 이벤트 누락 (claude → codex 변경 예상)");
    assert.equal(ov.count, 1);
    assert.equal(ov.overrides[0].original, "claude");
    assert.equal(ov.overrides[0].override, "codex");
    // 실제 plan.shards 도 mutated 되어야 한다 (후속 launchShard 가 새 agent 사용)
    assert.equal(plan.shards[0].agent, "codex");
  });

  it("S2-03: env=1 + agent=codex (already fallback) → override 이벤트 없음", async () => {
    process.env[ENV_FLAG] = "1";
    const result = makeHypervisor(workdir, logsDir);
    hv = result.hv;
    const plan = makePlan({
      shards: [
        {
          name: "worker-a",
          agent: "codex",
          files: [],
          depends: [],
          prompt: "echo",
        },
      ],
    });
    await hv.launch(plan);
    await waitFor(() =>
      readSwarmEvents(logsDir).some(
        (e) => e.event === "dynamic_route_plan_decision",
      ),
    );
    const events = readSwarmEvents(logsDir);
    const dr = events.find((e) => e.event === "dynamic_route_plan_decision");
    assert.ok(dr, "plan_decision 이벤트 누락");
    // 결정은 발화했지만 cli == agent 라 override 이벤트는 없음
    const ov = events.find((e) => e.event === "dynamic_route_plan_overrides");
    assert.equal(ov, undefined, "agent=codex 인데 override 발생");
    assert.equal(plan.shards[0].agent, "codex");
  });

  it("S2-04: env='true' 도 활성화한다", async () => {
    process.env[ENV_FLAG] = "true";
    const result = makeHypervisor(workdir, logsDir);
    hv = result.hv;
    const plan = makePlan();
    await hv.launch(plan);
    await waitFor(() =>
      readSwarmEvents(logsDir).some(
        (e) => e.event === "dynamic_route_plan_decision",
      ),
    );
    const events = readSwarmEvents(logsDir);
    const dr = events.find((e) => e.event === "dynamic_route_plan_decision");
    assert.ok(dr, "env='true' 인데 plan_decision 안 발생");
  });

  it("S2-05: env=0 (명시 비활성) — wire-up 발화 안 함", async () => {
    process.env[ENV_FLAG] = "0";
    const result = makeHypervisor(workdir, logsDir);
    hv = result.hv;
    const plan = makePlan();
    await hv.launch(plan);
    await waitFor(() =>
      readSwarmEvents(logsDir).some((e) => e.event === "swarm_state"),
    );
    const events = readSwarmEvents(logsDir);
    const dr = events.find((e) => e.event === "dynamic_route_plan_decision");
    assert.equal(dr, undefined, "env=0 인데 plan_decision 발생");
  });
});

describe("swarm-hypervisor: dynamic routing wire-up — multi-shard", () => {
  it("S2-06: 다중 shard 의 1:1 override (모두 claude → 모두 codex fallback)", async () => {
    process.env[ENV_FLAG] = "1";
    const result = makeHypervisor(workdir, logsDir);
    hv = result.hv;
    const plan = makePlan({
      shards: [
        {
          name: "worker-a",
          agent: "claude",
          files: [],
          depends: [],
          prompt: "echo a",
        },
        {
          name: "worker-b",
          agent: "claude",
          files: [],
          depends: [],
          prompt: "echo b",
        },
      ],
    });
    await hv.launch(plan);
    await waitFor(() =>
      readSwarmEvents(logsDir).some(
        (e) => e.event === "dynamic_route_plan_decision",
      ),
    );
    const events = readSwarmEvents(logsDir);
    const dr = events.find((e) => e.event === "dynamic_route_plan_decision");
    assert.ok(dr);
    assert.equal(dr.planShardCount, 2);

    // fallback decision 은 shards 1개 (codex-default) 만 반환 → 0번째만 override
    // 1번째는 decision.shards[1] 가 undefined 라 plan 그대로
    const ov = events.find((e) => e.event === "dynamic_route_plan_overrides");
    assert.ok(ov, "override 이벤트 누락");
    assert.equal(ov.count, 1);
    assert.equal(ov.overrides[0].shard, "worker-a");
    assert.equal(plan.shards[0].agent, "codex");
    assert.equal(
      plan.shards[1].agent,
      "claude",
      "decision.shards[1] 가 없어서 plan.shards[1] 는 그대로 유지되어야 한다",
    );
  });

  it("S2-07: plan.shards 가 빈 배열이면 wire-up skip", async () => {
    process.env[ENV_FLAG] = "1";
    const result = makeHypervisor(workdir, logsDir);
    hv = result.hv;
    const plan = {
      shards: [],
      mergeOrder: [],
      conflicts: [],
    };
    await hv.launch(plan);
    await waitFor(() =>
      readSwarmEvents(logsDir).some((e) => e.event === "swarm_state"),
    );
    const events = readSwarmEvents(logsDir);
    const dr = events.find((e) => e.event === "dynamic_route_plan_decision");
    assert.equal(dr, undefined, "빈 plan.shards 에서 wire-up 발화");
  });
});
