#!/usr/bin/env node
// scripts/preflight-cache.mjs — 세션 시작 시 preflight 점검 캐싱

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

const CACHE_DIR = join(homedir(), ".claude", "cache");
const CACHE_FILE = join(CACHE_DIR, "tfx-preflight.json");
const CACHE_TTL_MS = 30_000; // 30초

function checkHub() {
  try {
    const res = execSync("curl -sf http://127.0.0.1:27888/status", { timeout: 3000, encoding: "utf8" });
    const data = JSON.parse(res);
    return { ok: true, state: data?.hub?.state || "unknown", pid: data?.pid };
  } catch {
    return { ok: false, state: "unreachable" };
  }
}

function checkRoute() {
  const routePath = join(homedir(), ".claude", "scripts", "tfx-route.sh");
  return { ok: existsSync(routePath), path: routePath };
}

function checkCli(name) {
  try {
    const path = execSync(`which ${name} 2>/dev/null || where ${name} 2>nul`, { encoding: "utf8", timeout: 2000 }).trim();
    return { ok: !!path, path };
  } catch {
    return { ok: false };
  }
}

function runPreflight() {
  const result = {
    timestamp: Date.now(),
    hub: checkHub(),
    route: checkRoute(),
    codex: checkCli("codex"),
    gemini: checkCli("gemini"),
    ok: false,
  };
  result.ok = result.hub.ok && result.route.ok;
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
  if (!result.route.ok) details.push("route:missing");
  console.log(details.length ? `${summary} (${details.join(", ")})` : summary);
}

export { runPreflight, CACHE_FILE, CACHE_TTL_MS };
