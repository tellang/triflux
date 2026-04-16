// hub/team/tui-synapse.mjs — Synapse 실시간 관제 (Phase 3)
// HTTP polling 기반 이벤트 수신 + 메트릭 수집 + 스파크라인 렌더링

import { color, dim, MOCHA } from "./ansi.mjs";
import { sparkline } from "./tui-widgets.mjs";

const DEFAULT_SYNAPSE_BASE_URL = "http://127.0.0.1:27888";
const DEFAULT_POLL_INTERVAL_MS = 2000;
const MAX_METRIC_SAMPLES = 30;

// ── SynapseEventStream ────────────────────────────────────────────────────
/**
 * Synapse 서버로부터 이벤트를 polling으로 수신
 * @param {object} [opts]
 * @param {string} [opts.baseUrl] - Synapse 서버 URL
 * @param {number} [opts.pollIntervalMs] - polling 간격
 * @param {function} [opts.fetchImpl] - fetch 구현 (테스트용)
 * @param {function} [opts.onEvent] - 이벤트 콜백
 * @param {function} [opts.onError] - 에러 콜백
 */
export function createSynapseEventStream(opts = {}) {
  const {
    baseUrl = DEFAULT_SYNAPSE_BASE_URL,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    onEvent,
    onError,
  } = opts;

  const fetchImpl = opts.fetchImpl || globalThis.fetch?.bind(globalThis);
  let timer = null;
  let lastEventId = 0;
  let running = false;

  async function poll(force = false) {
    if (!fetchImpl || (!running && !force)) return;
    try {
      const url = new URL("/synapse/events", baseUrl);
      url.searchParams.set("since", String(lastEventId));
      const res = await fetchImpl(url.toString(), {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout?.(5000),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.events)) {
        for (const event of data.events) {
          if (event.id > lastEventId) lastEventId = event.id;
          onEvent?.(event);
        }
      }
    } catch (err) {
      onError?.(err);
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      // 즉시 첫 poll + 주기적 반복
      poll();
      timer = setInterval(poll, pollIntervalMs);
      if (timer.unref) timer.unref();
    },

    stop() {
      running = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },

    get isRunning() {
      return running;
    },

    /** 테스트/수동 용: 즉시 poll 실행 (running 상태 무관) */
    async pollOnce() {
      await poll(true);
    },

    reset() {
      lastEventId = 0;
    },
  };
}

// ── MetricsCollector ──────────────────────────────────────────────────────
/**
 * Synapse 이벤트에서 메트릭(토큰, 지연시간, 성공률)을 수집
 */
export function createMetricsCollector(opts = {}) {
  const { maxSamples = MAX_METRIC_SAMPLES } = opts;

  const metrics = {
    tokenRates: [],     // 초당 토큰 소비율
    latencies: [],      // 요청 지연시간 (ms)
    successRates: [],   // 성공률 (0-1)
    eventCount: 0,
    lastEventAt: 0,
  };

  function pushSample(arr, value) {
    arr.push(value);
    if (arr.length > maxSamples) arr.shift();
  }

  return {
    /** Synapse 이벤트를 처리하여 메트릭 갱신 */
    ingest(event) {
      if (!event || typeof event !== "object") return;
      metrics.eventCount++;
      metrics.lastEventAt = Date.now();

      // 토큰 소비율
      if (typeof event.tokens === "number" && event.tokens > 0) {
        const elapsed = event.elapsed || 1;
        pushSample(metrics.tokenRates, event.tokens / elapsed);
      }

      // 지연시간
      if (typeof event.latencyMs === "number") {
        pushSample(metrics.latencies, event.latencyMs);
      }

      // 성공률 (이벤트별 ok/fail)
      if (event.status) {
        const ok = event.status === "ok" || event.status === "completed" ? 1 : 0;
        pushSample(metrics.successRates, ok);
      }
    },

    /** 현재 메트릭 스냅샷 반환 */
    snapshot() {
      const avgLatency =
        metrics.latencies.length > 0
          ? metrics.latencies.reduce((a, b) => a + b, 0) / metrics.latencies.length
          : 0;
      const avgSuccessRate =
        metrics.successRates.length > 0
          ? metrics.successRates.reduce((a, b) => a + b, 0) /
            metrics.successRates.length
          : 1;
      const lastTokenRate =
        metrics.tokenRates.length > 0
          ? metrics.tokenRates[metrics.tokenRates.length - 1]
          : 0;

      return {
        tokenRates: [...metrics.tokenRates],
        latencies: [...metrics.latencies],
        successRates: [...metrics.successRates],
        avgLatency: Math.round(avgLatency),
        avgSuccessRate: Math.round(avgSuccessRate * 100),
        lastTokenRate: Math.round(lastTokenRate),
        eventCount: metrics.eventCount,
        lastEventAt: metrics.lastEventAt,
      };
    },

    reset() {
      metrics.tokenRates.length = 0;
      metrics.latencies.length = 0;
      metrics.successRates.length = 0;
      metrics.eventCount = 0;
      metrics.lastEventAt = 0;
    },
  };
}

// ── Tier1 메트릭 렌더러 ───────────────────────────────────────────────────
/**
 * Synapse 메트릭을 Tier1에 표시할 한 줄 문자열로 렌더링
 * @param {object} snapshot - MetricsCollector.snapshot() 결과
 * @param {number} [width=60] - 최대 표시 폭
 * @returns {string} 렌더링된 메트릭 행
 */
export function renderMetricsTier1(snapshot, width = 60) {
  if (!snapshot || snapshot.eventCount === 0) {
    return dim("synapse: waiting for events…");
  }

  const parts = [];

  // 토큰 스파크라인
  if (snapshot.tokenRates.length > 0) {
    const spark = sparkline(snapshot.tokenRates, 8, MOCHA.executing);
    parts.push(`tok/s ${spark} ${color(String(snapshot.lastTokenRate), MOCHA.executing)}`);
  }

  // 지연시간
  if (snapshot.latencies.length > 0) {
    const latColor =
      snapshot.avgLatency > 1000 ? MOCHA.fail :
      snapshot.avgLatency > 500 ? MOCHA.partial : MOCHA.ok;
    parts.push(`lat ${color(`${snapshot.avgLatency}ms`, latColor)}`);
  }

  // 성공률
  if (snapshot.successRates.length > 0) {
    const srColor =
      snapshot.avgSuccessRate < 80 ? MOCHA.fail :
      snapshot.avgSuccessRate < 95 ? MOCHA.partial : MOCHA.ok;
    parts.push(`ok ${color(`${snapshot.avgSuccessRate}%`, srColor)}`);
  }

  // 이벤트 카운트
  parts.push(dim(`ev:${snapshot.eventCount}`));

  return parts.join(dim(" │ "));
}
