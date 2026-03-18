#!/usr/bin/env node
// tfx-batch-stats.mjs v1.0 — batch-events.jsonl 소비자
//
// tfx-route-post.mjs가 기록한 AIMD 이벤트를 읽어서:
//   1. 에이전트별 성공/실패/타임아웃 통계 집계
//   2. AIMD(Additive Increase / Multiplicative Decrease) batch_size 계산
//
// 사용법:
//   node tfx-batch-stats.mjs stats [--recent]     에이전트별 통계 (--recent: 30분)
//   node tfx-batch-stats.mjs batch                 현재 권장 batch_size
//   node tfx-batch-stats.mjs agent <name>          특정 에이전트 통계

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CACHE_DIR = join(homedir(), ".claude", "cache");
const EVENTS_FILE = join(CACHE_DIR, "batch-events.jsonl");

// AIMD 파라미터
const AIMD_INITIAL = 3;
const AIMD_MIN = 1;
const AIMD_MAX = 10;
const AIMD_INC = 1;        // 성공 시 +1
const AIMD_DEC = 0.5;      // 실패 시 ×0.5
const WINDOW_MS = 30 * 60 * 1000; // 30분 윈도우

// ── 이벤트 읽기 ──
export function readBatchEvents(opts = {}) {
  const { sinceMs = 0, agent = null } = opts;
  try {
    const lines = readFileSync(EVENTS_FILE, "utf-8").trim().split("\n").filter(Boolean);
    return lines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e && (!sinceMs || e.ts >= sinceMs) && (!agent || e.agent === agent));
  } catch {
    return [];
  }
}

// ── 에이전트별 통계 ──
export function getAgentStats(opts = {}) {
  const events = readBatchEvents(opts);
  const stats = {};

  for (const ev of events) {
    if (!stats[ev.agent]) stats[ev.agent] = { success: 0, fail: 0, timeout: 0, total: 0 };
    const s = stats[ev.agent];
    if (ev.result === "success" || ev.result === "success_with_warnings") s.success++;
    else if (ev.result === "timeout") s.timeout++;
    else s.fail++;
    s.total++;
  }

  for (const s of Object.values(stats)) {
    s.successRate = s.total > 0 ? +(s.success / s.total).toFixed(2) : 0;
  }

  return { total: events.length, agents: stats };
}

// ── AIMD batch_size 계산 ──
// 최근 윈도우 이벤트를 순회하며 성공 시 +1, 실패 시 ×0.5
export function getAimdBatchSize() {
  const since = Date.now() - WINDOW_MS;
  const events = readBatchEvents({ sinceMs: since });
  if (events.length === 0) return AIMD_INITIAL;

  let batch = AIMD_INITIAL;
  for (const ev of events) {
    if (ev.result === "success" || ev.result === "success_with_warnings") {
      batch = Math.min(AIMD_MAX, batch + AIMD_INC);
    } else {
      batch = Math.max(AIMD_MIN, Math.floor(batch * AIMD_DEC));
    }
  }
  return batch;
}

// ── CLI 진입점 ──
const scriptName = process.argv[1] || "";
if (scriptName.endsWith("tfx-batch-stats.mjs")) {
  const cmd = process.argv[2] || "stats";
  const recent = process.argv.includes("--recent");
  const sinceMs = recent ? Date.now() - WINDOW_MS : 0;

  if (cmd === "batch") {
    console.log(JSON.stringify({ batchSize: getAimdBatchSize(), window: "30m" }));
  } else if (cmd === "agent") {
    const name = process.argv[3];
    if (!name) { console.error("에이전트명 필수: node tfx-batch-stats.mjs agent executor"); process.exit(1); }
    console.log(JSON.stringify(getAgentStats({ sinceMs, agent: name }), null, 2));
  } else {
    console.log(JSON.stringify(getAgentStats({ sinceMs }), null, 2));
  }
}
