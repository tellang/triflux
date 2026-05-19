// tests/unit/conductor-dynamic-routing.test.mjs
//
// Phase 1 wire-up — conductor.spawnSession 안의 sync dynamic routing override.
//
// 인변량 검증:
//   1. spawnSession 은 여전히 sync 함수 — broker.lease atomic 체인 보존 (commit 761fb7a8).
//   2. env opt-in (TRIFLUX_DYNAMIC_ROUTING=1|true) 일 때만 발화.
//   3. 원격 세션은 wire-up skip.
//   4. snapshot 은 D-2 cache 의 sync getter 만 사용 — cache miss 면 fail-closed.
//   5. evaluator 의 결정이 config.agent 와 다를 때만 override + eventLog 기록.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resetSnapshotCache } from "../../hub/routing-snapshot.mjs";
import { createConductor } from "../../hub/team/conductor.mjs";

process.setMaxListeners(50);

const ENV_FLAG = "TRIFLUX_DYNAMIC_ROUTING";

function makeTmpDir() {
  const dir = join(
    tmpdir(),
    `tfx-conductor-dr-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeMockSpawn() {
  return function mockSpawn() {
    const child = new EventEmitter();
    child.pid = Math.floor(Math.random() * 1_000_000) + 1;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.end();
      child.stderr.end();
      child.emit("exit", 0, null);
    });
    return child;
  };
}

function makeConductor(logsDir, overrides = {}) {
  return createConductor({
    logsDir,
    maxRestarts: 1,
    graceMs: 200,
    probeOpts: {
      intervalMs: 999_999,
      l1ThresholdMs: 999_999,
      l3ThresholdMs: 999_999,
    },
    ...overrides,
    deps: {
      spawn: makeMockSpawn(),
      ...(overrides.deps || {}),
    },
  });
}

function readEvents(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return [];
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitForEvents(conductor, predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const events = readEvents(conductor.eventLogPath);
    if (predicate(events)) return events;
    await new Promise((r) => setTimeout(r, 25));
  }
  return readEvents(conductor.eventLogPath);
}

let logsDir;
let conductor;
let originalEnvFlag;

beforeEach(() => {
  logsDir = makeTmpDir();
  conductor = makeConductor(logsDir);
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
    await conductor.shutdown("afterEach_cleanup");
  } catch {
    /* already shutdown */
  }
  try {
    rmSync(logsDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("conductor: dynamic routing wire-up — env gate", () => {
  it("D-01: env 미설정 시 override event 가 발생하지 않는다", async () => {
    const cfg = {
      id: "no-env-flag",
      agent: "claude",
      prompt: "echo",
    };
    conductor.spawnSession(cfg);
    const events = await waitForEvents(conductor, (es) =>
      es.some((e) => e.event === "spawn"),
    );
    const override = events.find((e) => e.event === "dynamic_route_override");
    assert.equal(
      override,
      undefined,
      "env OFF 인데 dynamic_route_override 가 발생했다",
    );
  });

  it("D-02: env=1 + cache empty + agent=claude → codex 로 override (fail-closed)", async () => {
    process.env[ENV_FLAG] = "1";
    const cfg = {
      id: "fail-closed-claude",
      agent: "claude",
      prompt: "echo",
    };
    conductor.spawnSession(cfg);
    const events = await waitForEvents(conductor, (es) =>
      es.some((e) => e.event === "dynamic_route_override"),
    );
    const override = events.find((e) => e.event === "dynamic_route_override");
    assert.ok(override, "override event 가 발생하지 않았다");
    assert.equal(override.session, cfg.id);
    assert.equal(override.original, "claude");
    assert.equal(override.override, "codex");
    // fail-closed = makeFallback → scenario:"fallback"
    assert.equal(override.scenario, "fallback");
    assert.equal(typeof override.decisionId, "string");
  });

  it("D-03: env='true' string 도 활성화한다", async () => {
    process.env[ENV_FLAG] = "true";
    const cfg = {
      id: "env-true-string",
      agent: "claude",
      prompt: "echo",
    };
    conductor.spawnSession(cfg);
    const events = await waitForEvents(conductor, (es) =>
      es.some((e) => e.event === "dynamic_route_override"),
    );
    const override = events.find((e) => e.event === "dynamic_route_override");
    assert.ok(override, "env='true' 인데 override 안 발생");
  });

  it("D-04: env=0 (명시 비활성) 시 wire-up 발화하지 않는다", async () => {
    process.env[ENV_FLAG] = "0";
    const cfg = {
      id: "env-explicit-off",
      agent: "claude",
      prompt: "echo",
    };
    conductor.spawnSession(cfg);
    const events = await waitForEvents(conductor, (es) =>
      es.some((e) => e.event === "spawn"),
    );
    const override = events.find((e) => e.event === "dynamic_route_override");
    assert.equal(override, undefined, "env=0 인데 override 가 발생");
  });
});

describe("conductor: dynamic routing wire-up — no-op cases", () => {
  it("D-05: env=1 + agent=codex (fallback decision 과 동일) → override event 없음", async () => {
    process.env[ENV_FLAG] = "1";
    const cfg = {
      id: "noop-codex",
      agent: "codex",
      prompt: "echo",
    };
    conductor.spawnSession(cfg);
    const events = await waitForEvents(conductor, (es) =>
      es.some((e) => e.event === "spawn"),
    );
    const override = events.find((e) => e.event === "dynamic_route_override");
    assert.equal(
      override,
      undefined,
      "agent=codex 인데 override 발생 (no-op이어야 함)",
    );
  });

  it("D-06: env=1 + remote=true → wire-up skip (override event 없음)", async () => {
    process.env[ENV_FLAG] = "1";
    const cfg = {
      id: "remote-skip",
      agent: "claude",
      prompt: "echo",
      remote: true,
      host: "test-host",
    };
    // remote 세션은 launcher 없이 startRemoteSession 으로 진입. mock 환경에서는
    // 곧바로 종료되지만 wire-up gate 만 검증한다.
    try {
      conductor.spawnSession(cfg);
    } catch {
      /* remote start mock 부족 — gate 결과만 검증 */
    }
    await new Promise((r) => setTimeout(r, 100));
    const events = readEvents(conductor.eventLogPath);
    const override = events.find((e) => e.event === "dynamic_route_override");
    assert.equal(override, undefined, "remote 세션인데 override 발생");
  });
});

describe("conductor: dynamic routing wire-up — invariant 보존", () => {
  it("D-07: spawnSession 은 여전히 sync 함수 — string id 즉시 반환", () => {
    process.env[ENV_FLAG] = "1";
    const cfg = {
      id: "sync-return-check",
      agent: "claude",
      prompt: "echo",
    };
    const id = conductor.spawnSession(cfg);
    assert.equal(typeof id, "string");
    assert.equal(id, "sync-return-check");
  });

  it("D-08: env=1 + override 발생 시에도 spawn 흐름이 정상 완료된다", async () => {
    process.env[ENV_FLAG] = "1";
    const cfg = {
      id: "spawn-after-override",
      agent: "claude",
      prompt: "echo",
    };
    conductor.spawnSession(cfg);
    const events = await waitForEvents(
      conductor,
      (es) =>
        es.some((e) => e.event === "dynamic_route_override") &&
        es.some((e) => e.event === "spawn"),
      3000,
    );
    const override = events.find((e) => e.event === "dynamic_route_override");
    const spawn = events.find((e) => e.event === "spawn");
    assert.ok(override, "override event 누락");
    assert.ok(spawn, "spawn event 누락 — override 후 spawn 흐름 끊김");
    // override 후 spawn 의 agent 가 override 된 cli 와 일치해야 한다
    assert.equal(spawn.agent, override.override);
  });

  it("D-09: env=1 + cache miss 흐름이 broker.lease 흐름과 충돌하지 않는다", async () => {
    process.env[ENV_FLAG] = "1";
    // broker mock 으로 lease 호출 추적
    const leaseCalls = [];
    const mockBroker = new EventEmitter();
    mockBroker.lease = (req) => {
      leaseCalls.push(req);
      return null; // no lease available
    };
    mockBroker.nextAvailableEta = () => Date.now() + 60_000;
    mockBroker.release = () => {};

    await conductor.shutdown("recreate_for_broker_test");
    conductor = makeConductor(logsDir, { broker: mockBroker });

    const cfg = {
      id: "broker-after-override",
      agent: "claude",
      prompt: "echo",
    };
    conductor.spawnSession(cfg);

    await waitForEvents(
      conductor,
      (es) =>
        es.some((e) => e.event === "dynamic_route_override") &&
        es.some((e) => e.event === "broker_no_lease"),
      3000,
    );
    // broker.lease 호출은 override 된 cli (codex) 로 일어나야 한다
    assert.ok(leaseCalls.length > 0, "broker.lease 호출 안 됨");
    assert.equal(
      leaseCalls[0].provider,
      "codex",
      "broker.lease 가 override 전 agent 로 호출됨 — atomic 체인 깨짐",
    );
  });
});
