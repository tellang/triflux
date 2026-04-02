#!/usr/bin/env node
// scripts/preflight-cache.mjs — 세션 시작 시 preflight 점검 캐싱

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { checkCli, checkHub, detectCodexPlan } from "./lib/env-probe.mjs";

const __filename = fileURLToPath(import.meta.url);
const PKG_ROOT = join(dirname(__filename), "..");

const CACHE_DIR = join(homedir(), ".claude", "cache");
const CACHE_FILE = join(CACHE_DIR, "tfx-preflight.json");
const CACHE_TTL_MS = 3_600_000; // 1시간 (세션당 1회, SessionStart 훅에서 갱신)

function checkRoute() {
  const routePath = join(homedir(), ".claude", "scripts", "tfx-route.sh");
  return { ok: existsSync(routePath), path: routePath };
}

function runPreflight() {
  const result = {
    timestamp: Date.now(),
    hub: checkHub({ pkgRoot: PKG_ROOT }),
    route: checkRoute(),
    codex: checkCli("codex"),
    gemini: checkCli("gemini"),
    codex_plan: detectCodexPlan(),
    ok: false,
  };
  result.ok = result.hub.ok && result.route.ok;

  // CLI 가용성 → available_agents (triage에서 참조)
  const agents = [];
  if (result.codex.ok) agents.push("codex");
  if (result.gemini.ok) agents.push("gemini");
  agents.push("claude"); // claude는 항상 가용
  result.available_agents = agents;

  return result;
}

// 캐시 읽기 (TTL 검증 포함)
export function readPreflightCache() {
  try {
    const data = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    if (Date.now() - data.timestamp < CACHE_TTL_MS) return data;
  } catch {}
  return null;
}

// 메인 실행
if (process.argv[1]?.endsWith("preflight-cache.mjs")) {
  const result = runPreflight();
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(result, null, 2));
  // 간결 출력 (hook stdout)
  const summary = result.ok ? "preflight: ok" : "preflight: FAIL";
  const details = [];
  if (!result.hub.ok) details.push("hub:" + result.hub.state);
  else if (result.hub.restarted) details.push("hub:restarted");
  if (!result.route.ok) details.push("route:missing");
  if (result.available_agents.length === 1) details.push("agents:claude-only");
  console.log(details.length ? `${summary} (${details.join(", ")})` : summary);
}

export { runPreflight, CACHE_FILE, CACHE_TTL_MS };
