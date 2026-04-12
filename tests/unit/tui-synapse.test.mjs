// tests/unit/tui-synapse.test.mjs — Synapse 실시간 관제 테스트

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createMetricsCollector,
  createSynapseEventStream,
  renderMetricsTier1,
} from "../../hub/team/tui-synapse.mjs";
import { stripAnsi } from "../../hub/team/ansi.mjs";

describe("createMetricsCollector", () => {
  it("이벤트 수집 후 스냅샷 반환", () => {
    const collector = createMetricsCollector();
    collector.ingest({ tokens: 100, elapsed: 1, latencyMs: 200, status: "ok" });
    collector.ingest({ tokens: 200, elapsed: 2, latencyMs: 150, status: "ok" });

    const snap = collector.snapshot();
    assert.equal(snap.eventCount, 2);
    assert.equal(snap.tokenRates.length, 2);
    assert.equal(snap.latencies.length, 2);
    assert.equal(snap.avgSuccessRate, 100);
  });

  it("성공률 계산 (혼합 상태)", () => {
    const collector = createMetricsCollector();
    collector.ingest({ status: "ok" });
    collector.ingest({ status: "ok" });
    collector.ingest({ status: "failed" });
    collector.ingest({ status: "ok" });

    const snap = collector.snapshot();
    assert.equal(snap.avgSuccessRate, 75);
  });

  it("빈 상태에서 기본값", () => {
    const collector = createMetricsCollector();
    const snap = collector.snapshot();
    assert.equal(snap.eventCount, 0);
    assert.equal(snap.avgLatency, 0);
    assert.equal(snap.avgSuccessRate, 100);
  });

  it("maxSamples 초과 시 오래된 데이터 제거", () => {
    const collector = createMetricsCollector({ maxSamples: 3 });
    for (let i = 0; i < 5; i++) {
      collector.ingest({ latencyMs: i * 100 });
    }
    assert.equal(collector.snapshot().latencies.length, 3);
  });

  it("잘못된 이벤트 무시", () => {
    const collector = createMetricsCollector();
    collector.ingest(null);
    collector.ingest(undefined);
    collector.ingest("string");
    assert.equal(collector.snapshot().eventCount, 0);
  });

  it("reset 후 빈 상태", () => {
    const collector = createMetricsCollector();
    collector.ingest({ tokens: 100, elapsed: 1, status: "ok" });
    collector.reset();
    assert.equal(collector.snapshot().eventCount, 0);
  });
});

describe("createSynapseEventStream", () => {
  it("polling으로 이벤트를 수신한다", async () => {
    const events = [];
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ events: [{ id: 1, type: "heartbeat" }, { id: 2, type: "status" }] }),
    });

    const stream = createSynapseEventStream({
      fetchImpl: mockFetch,
      pollIntervalMs: 100_000, // 자동 poll 방지
      onEvent: (ev) => events.push(ev),
    });

    await stream.pollOnce();
    assert.equal(events.length, 2);
    assert.equal(events[0].id, 1);
    assert.equal(events[1].id, 2);
  });

  it("lastEventId 이후 이벤트만 수신", async () => {
    let callCount = 0;
    const mockFetch = async (url) => {
      callCount++;
      const since = new URL(url).searchParams.get("since");
      if (since === "0") {
        return { ok: true, json: async () => ({ events: [{ id: 5, type: "a" }] }) };
      }
      return { ok: true, json: async () => ({ events: [] }) };
    };

    const events = [];
    const stream = createSynapseEventStream({
      fetchImpl: mockFetch,
      onEvent: (ev) => events.push(ev),
    });

    await stream.pollOnce(); // since=0 → id:5
    await stream.pollOnce(); // since=5 → 빈 배열
    assert.equal(events.length, 1);
    assert.equal(callCount, 2);
  });

  it("fetch 에러 시 onError 호출", async () => {
    const errors = [];
    const mockFetch = async () => { throw new Error("network"); };

    const stream = createSynapseEventStream({
      fetchImpl: mockFetch,
      onError: (err) => errors.push(err),
    });

    await stream.pollOnce();
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, "network");
  });

  it("start/stop 제어", () => {
    const stream = createSynapseEventStream({ fetchImpl: async () => ({ ok: false }) });
    assert.equal(stream.isRunning, false);
    stream.start();
    assert.equal(stream.isRunning, true);
    stream.stop();
    assert.equal(stream.isRunning, false);
  });
});

describe("renderMetricsTier1", () => {
  it("이벤트 없으면 대기 메시지", () => {
    const result = stripAnsi(renderMetricsTier1({ eventCount: 0 }));
    assert.ok(result.includes("waiting"));
  });

  it("메트릭이 있으면 토큰/지연/성공률 표시", () => {
    const snap = {
      tokenRates: [50, 60, 70],
      latencies: [100, 200],
      successRates: [1, 1, 0.5],
      avgLatency: 150,
      avgSuccessRate: 83,
      lastTokenRate: 70,
      eventCount: 5,
      lastEventAt: Date.now(),
    };
    const result = stripAnsi(renderMetricsTier1(snap));
    assert.ok(result.includes("tok/s"));
    assert.ok(result.includes("lat"));
    assert.ok(result.includes("150ms"));
    assert.ok(result.includes("ok"));
    assert.ok(result.includes("83%"));
    assert.ok(result.includes("ev:5"));
  });

  it("null 스냅샷 → 대기 메시지", () => {
    const result = stripAnsi(renderMetricsTier1(null));
    assert.ok(result.includes("waiting"));
  });
});
