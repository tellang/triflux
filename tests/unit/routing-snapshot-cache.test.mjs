// tests/unit/routing-snapshot-cache.test.mjs
//
// PRD: .omx/plans/prd-dynamic-routing-engine.md (shard D-2)
//
// Phase 1 acceptance suite for `getDefaultSnapshot()` in-process cache wrapper.
// builder 를 mock 으로 주입해서 실제 HUD/broker IO 없이 cache hit/miss/TTL/
// forceRefresh/maxAgeMs override/주입된 now 동작을 결정적으로 검증한다.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  __internal__,
  getDefaultSnapshot,
  resetSnapshotCache,
  tryGetCachedSnapshot,
} from "../../hub/routing-snapshot.mjs";

const DEFAULT_TTL_MS = 900_000; // 모듈 내부 DEFAULT_CACHE_TTL_MS 와 정합
const NOW = 1778832000000; // 2026-05-15T08:00:00Z

function mkBuilder() {
  let calls = 0;
  const builder = async ({ now }) => {
    calls += 1;
    return {
      schemaVersion: 1,
      observedAt: now,
      claude: null,
      codex: null,
      broker: null,
      _fakeCallId: calls,
    };
  };
  return {
    builder,
    get calls() {
      return calls;
    },
  };
}

describe("routing-snapshot cache — getDefaultSnapshot()", () => {
  beforeEach(() => {
    resetSnapshotCache();
  });

  it("C-01: resetSnapshotCache 후 첫 호출은 builder 를 실행한다", async () => {
    const tracker = mkBuilder();
    const snap = await getDefaultSnapshot({
      now: NOW,
      builder: tracker.builder,
    });
    assert.equal(tracker.calls, 1);
    assert.equal(snap._fakeCallId, 1);
    assert.equal(snap.observedAt, NOW);
  });

  it("C-02: TTL 안 (now 동일) 두 번째 호출은 builder 를 재호출하지 않고 같은 snapshot 을 반환한다", async () => {
    const tracker = mkBuilder();
    const first = await getDefaultSnapshot({
      now: NOW,
      builder: tracker.builder,
    });
    const second = await getDefaultSnapshot({
      now: NOW,
      builder: tracker.builder,
    });
    assert.equal(tracker.calls, 1);
    assert.strictEqual(first, second); // 같은 reference
  });

  it("C-03: TTL 만료 (now += DEFAULT_TTL + 1) 시 builder 가 다시 호출된다", async () => {
    const tracker = mkBuilder();
    await getDefaultSnapshot({ now: NOW, builder: tracker.builder });
    const refreshed = await getDefaultSnapshot({
      now: NOW + DEFAULT_TTL_MS + 1,
      builder: tracker.builder,
    });
    assert.equal(tracker.calls, 2);
    assert.equal(refreshed._fakeCallId, 2);
    assert.equal(refreshed.observedAt, NOW + DEFAULT_TTL_MS + 1);
  });

  it("C-04: forceRefresh:true 는 cache 를 무시하고 builder 를 재호출한다", async () => {
    const tracker = mkBuilder();
    await getDefaultSnapshot({ now: NOW, builder: tracker.builder });
    const refreshed = await getDefaultSnapshot({
      now: NOW,
      builder: tracker.builder,
      forceRefresh: true,
    });
    assert.equal(tracker.calls, 2);
    assert.equal(refreshed._fakeCallId, 2);
  });

  it("C-05: maxAgeMs override 가 DEFAULT_TTL 보다 우선 적용된다", async () => {
    const tracker = mkBuilder();
    await getDefaultSnapshot({
      now: NOW,
      builder: tracker.builder,
      maxAgeMs: 1000,
    });
    // 1001ms 후 호출 → custom TTL 만료 → builder 재호출
    const refreshed = await getDefaultSnapshot({
      now: NOW + 1001,
      builder: tracker.builder,
      maxAgeMs: 1000,
    });
    assert.equal(tracker.calls, 2);
    assert.equal(refreshed._fakeCallId, 2);

    // 같은 시점에 다시 호출 → custom TTL 안 → cache hit
    const cached = await getDefaultSnapshot({
      now: NOW + 1001,
      builder: tracker.builder,
      maxAgeMs: 1000,
    });
    assert.equal(tracker.calls, 2);
    assert.strictEqual(cached, refreshed);
  });

  it("C-06: now 인자가 주어지면 Date.now() 대신 그 값으로 age 를 판정한다 (pure-fn)", async () => {
    const tracker = mkBuilder();
    // 첫 호출: 임의 epoch 주입
    const baseEpoch = 1_000_000_000_000;
    await getDefaultSnapshot({ now: baseEpoch, builder: tracker.builder });
    // 캐시 상태 확인 — fetchedAt 이 주입한 now 와 같아야 한다
    const state = __internal__.getCacheStateForTest();
    assert.equal(state.fetchedAt, baseEpoch);

    // TTL 안 시점이지만 Date.now() 가 무엇이든 주입된 now 로 age 판정
    const cached = await getDefaultSnapshot({
      now: baseEpoch + DEFAULT_TTL_MS - 1,
      builder: tracker.builder,
    });
    assert.equal(tracker.calls, 1);
    assert.equal(cached._fakeCallId, 1);

    // 주입된 now 가 TTL 경계를 넘으면 재호출
    const refreshed = await getDefaultSnapshot({
      now: baseEpoch + DEFAULT_TTL_MS,
      builder: tracker.builder,
    });
    assert.equal(tracker.calls, 2);
    assert.equal(refreshed._fakeCallId, 2);
  });
});

// Phase 1 wire-up 보강 — sync hot path (conductor.spawnSession) 가 broker.lease
// atomic 인변량을 깨지 않고 dynamic routing decision 을 평가하려면 cache 의
// fresh entry 를 sync 로 읽을 수 있어야 한다. tryGetCachedSnapshot() 는
// builder 를 호출하지 않고, fresh 면 snapshot, 아니면 null 만 반환한다.
describe("routing-snapshot cache — tryGetCachedSnapshot() sync getter", () => {
  beforeEach(() => {
    resetSnapshotCache();
  });

  it("S-01: cache 가 비어있으면 null 을 반환한다 (cache miss)", () => {
    assert.equal(tryGetCachedSnapshot({ now: NOW }), null);
  });

  it("S-02: getDefaultSnapshot 으로 채운 cache 를 sync 로 읽을 수 있다", async () => {
    const tracker = mkBuilder();
    const built = await getDefaultSnapshot({
      now: NOW,
      builder: tracker.builder,
    });
    const cached = tryGetCachedSnapshot({ now: NOW });
    assert.strictEqual(cached, built);
  });

  it("S-03: TTL 만료 시 builder 호출 없이 null 을 반환한다 (sync fail-closed)", async () => {
    const tracker = mkBuilder();
    await getDefaultSnapshot({ now: NOW, builder: tracker.builder });
    const expired = tryGetCachedSnapshot({ now: NOW + DEFAULT_TTL_MS + 1 });
    assert.equal(expired, null);
    // builder 는 호출되지 않아야 한다 (sync IO 없음 보장)
    assert.equal(tracker.calls, 1);
  });

  it("S-04: maxAgeMs override 가 적용된다", async () => {
    const tracker = mkBuilder();
    await getDefaultSnapshot({ now: NOW, builder: tracker.builder });
    // custom 짧은 TTL (1000ms) — 1001ms 후 호출 → cache miss
    const expired = tryGetCachedSnapshot({
      now: NOW + 1001,
      maxAgeMs: 1000,
    });
    assert.equal(expired, null);
    // 같은 시점이라도 default TTL 안이면 hit
    const hit = tryGetCachedSnapshot({ now: NOW + 1001 });
    assert.ok(hit, "default TTL 안에서는 hit 이어야 한다");
  });

  it("S-05: __internal__.setCacheForTest 로 주입된 cache 도 읽힌다", () => {
    const fakeSnapshot = {
      schemaVersion: 1,
      observedAt: NOW,
      claude: null,
      codex: null,
      broker: null,
      _injected: true,
    };
    __internal__.setCacheForTest({ snapshot: fakeSnapshot, fetchedAt: NOW });
    const cached = tryGetCachedSnapshot({ now: NOW + 100 });
    assert.strictEqual(cached, fakeSnapshot);
  });

  it("S-06: now 인자 미주입 시 Date.now() 사용 — fresh cache hit 보장", () => {
    const fakeSnapshot = {
      schemaVersion: 1,
      observedAt: Date.now(),
      claude: null,
      codex: null,
      broker: null,
    };
    // 현재 시각으로 cache 주입
    __internal__.setCacheForTest({
      snapshot: fakeSnapshot,
      fetchedAt: Date.now(),
    });
    // now 인자 없이 호출 — Date.now() 가 fetchedAt 근처라 TTL 안
    const cached = tryGetCachedSnapshot();
    assert.strictEqual(cached, fakeSnapshot);
  });
});
