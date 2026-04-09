#!/usr/bin/env node
// scripts/preflight-cache.mjs — 세션 시작 시 preflight 점검 캐싱

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkHub, detectCodexPlan, probeClis } from "./lib/env-probe.mjs";

const __filename = fileURLToPath(import.meta.url);
const PKG_ROOT = join(dirname(__filename), "..");

const CACHE_DIR = join(homedir(), ".claude", "cache");
const CACHE_FILE = join(CACHE_DIR, "tfx-preflight.json");
const CACHE_TTL_MS = 3_600_000; // 1시간 (세션당 1회, SessionStart 훅에서 갱신)

function checkRoute() {
  const routePath = join(homedir(), ".claude", "scripts", "tfx-route.sh");
  return { ok: existsSync(routePath), path: routePath };
}

async function runPreflight() {
  const cliChecks = await probeClis(["codex", "gemini"]);
  const result = {
    timestamp: Date.now(),
    hub: checkHub({ pkgRoot: PKG_ROOT }),
    route: checkRoute(),
    codex: cliChecks.codex || { ok: false },
    gemini: cliChecks.gemini || { ok: false },
    codex_plan: detectCodexPlan(),
    ok: false,
  };
  result.ok = result.hub.ok && result.route.ok;

  const agents = [];
  if (result.codex.ok) agents.push("codex");
  if (result.gemini.ok) agents.push("gemini");
  agents.push("claude");
  result.available_agents = agents;

  return result;
}

export function readPreflightCache() {
  try {
    const data = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    if (Date.now() - data.timestamp < CACHE_TTL_MS) return data;
  } catch {}
  return null;
}

export async function run(stdinData) {
  void stdinData;

  const result = await runPreflight();
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(result, null, 2));

  const summary = result.ok ? "preflight: ok" : "preflight: FAIL";
  const details = [];
  if (!result.hub.ok) details.push("hub:" + result.hub.state);
  else if (result.hub.restarted) details.push("hub:restarted");
  if (!result.route.ok) details.push("route:missing");
  if (result.available_agents.length === 1) details.push("agents:claude-only");

  return {
    code: 0,
    stdout: `${details.length ? `${summary} (${details.join(", ")})` : summary}\n`,
    stderr: "",
  };
}

const isMain =
  process.argv[1] &&
  import.meta.url.endsWith(
    process.argv[1].replace(/\\/g, "/").split("/").pop(),
  );

if (isMain) {
  const result = await run();
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.code);
}

export { CACHE_FILE, CACHE_TTL_MS, runPreflight };
