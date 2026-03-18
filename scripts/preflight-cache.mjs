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
    const res = execSync("curl -sf http://127.0.0.1:27888/status", { timeout: 3000, encoding: "utf8", windowsHide: true });
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
    const path = execSync(`which ${name} 2>/dev/null || where ${name} 2>nul`, { encoding: "utf8", timeout: 2000, windowsHide: true }).trim();
    return { ok: !!path, path };
  } catch {
    return { ok: false };
  }
}

/** Codex auth.json의 JWT에서 chatgpt_plan_type 추출 (pro/plus/free) */
function detectCodexPlan() {
  try {
    const authPath = join(homedir(), ".codex", "auth.json");
    if (!existsSync(authPath)) return { plan: "unknown", source: "no_auth" };
    const auth = JSON.parse(readFileSync(authPath, "utf8"));
    if (auth.auth_mode !== "chatgpt") return { plan: "api", source: "api_key" };
    const token = auth.tokens?.id_token || auth.tokens?.access_token;
    if (!token) return { plan: "unknown", source: "no_token" };
    // JWT payload = 2번째 파트, base64url 디코딩
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    const plan = payload?.["https://api.openai.com/auth"]?.chatgpt_plan_type || "unknown";
    return { plan, source: "jwt" };
  } catch {
    return { plan: "unknown", source: "error" };
  }
}

function runPreflight() {
  const result = {
    timestamp: Date.now(),
    hub: checkHub(),
    route: checkRoute(),
    codex: checkCli("codex"),
    gemini: checkCli("gemini"),
    codex_plan: detectCodexPlan(),
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
