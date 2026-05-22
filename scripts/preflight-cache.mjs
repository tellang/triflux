#!/usr/bin/env node
// scripts/preflight-cache.mjs — 세션 시작 시 preflight 점검 캐싱

import { spawnSync } from "node:child_process";
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
const ANTIGRAVITY_AUTH_READY_SKEW_MS = CACHE_TTL_MS + 60_000;

function checkRoute({ homeDir = homedir(), existsSyncFn = existsSync } = {}) {
  const routePath = join(homeDir, ".claude", "scripts", "tfx-route.sh");
  return { ok: existsSyncFn(routePath), path: routePath };
}

function checkAntigravityCredential({
  homeDir,
  existsSyncFn,
  readFileSyncFn,
  now = Date.now(),
}) {
  const paths = [
    join(homeDir, ".gemini", "oauth_creds.json"),
    join(homeDir, ".gemini", "antigravity-cli", "oauth_creds.json"),
    join(homeDir, ".gemini", "antigravity-cli", "credentials.json"),
  ];

  let reason = "auth_missing";
  for (const path of paths) {
    if (!existsSyncFn(path)) continue;

    try {
      const credential = JSON.parse(readFileSyncFn(path, "utf8"));
      if (
        Number.isFinite(credential?.expiry_date) &&
        credential.expiry_date > now + ANTIGRAVITY_AUTH_READY_SKEW_MS
      ) {
        return { ok: true, path };
      }
      reason = "auth_expired";
    } catch {
      reason = "auth_invalid";
    }
  }

  return { ok: false, reason };
}

function checkAntigravitySmoke(cliPath, { spawnSyncFn, timeout = 8000 } = {}) {
  try {
    const smoke = spawnSyncFn(
      cliPath,
      ["--print", "--dangerously-skip-permissions", "--print-timeout=3s"],
      {
        encoding: "utf8",
        input: "Return exactly AGY_OK\n",
        stdio: ["pipe", "pipe", "pipe"],
        timeout,
        windowsHide: true,
      },
    );
    return (
      !smoke.error &&
      !smoke.signal &&
      (smoke.status == null || smoke.status === 0) &&
      String(smoke.stdout || "")
        .split(/\r?\n/)
        .some((line) => line.trim() === "AGY_OK")
    );
  } catch {
    return false;
  }
}

function checkAntigravityReadiness(
  cliResult,
  {
    homeDir = homedir(),
    existsSyncFn = existsSync,
    readFileSyncFn = readFileSync,
    spawnSyncFn = spawnSync,
    timeout = 2000,
  } = {},
) {
  if (!cliResult?.ok || !cliResult.path)
    return { ok: false, reason: "missing" };

  let helpText = "";
  try {
    const help = spawnSyncFn(cliResult.path, ["--help"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      windowsHide: true,
    });
    if (help.error || (help.status != null && help.status !== 0)) {
      return { ok: false, path: cliResult.path, reason: "help_failed" };
    }
    helpText = [help.stdout, help.stderr].filter(Boolean).join("\n");
  } catch {
    return { ok: false, path: cliResult.path, reason: "help_failed" };
  }

  const hasHeadlessFlags =
    helpText.includes("--print") &&
    helpText.includes("--dangerously-skip-permissions");
  if (!hasHeadlessFlags) {
    return { ok: false, path: cliResult.path, reason: "headless_unsupported" };
  }

  const credential = checkAntigravityCredential({
    homeDir,
    existsSyncFn,
    readFileSyncFn,
  });
  if (!credential.ok) {
    if (
      credential.reason === "auth_expired" &&
      checkAntigravitySmoke(cliResult.path, { spawnSyncFn })
    ) {
      return { ok: true, path: cliResult.path, reason: "ready" };
    }
    return { ok: false, path: cliResult.path, reason: credential.reason };
  }

  return { ok: true, path: cliResult.path, reason: "ready" };
}

async function runPreflight({
  homeDir = homedir(),
  probeClisFn = probeClis,
  checkHubFn = checkHub,
  checkRouteFn = checkRoute,
  detectCodexPlanFn = detectCodexPlan,
  existsSyncFn = existsSync,
  readFileSyncFn = readFileSync,
  spawnSyncFn = spawnSync,
} = {}) {
  const cliChecks = await probeClisFn(["codex", "gemini", "agy"]);
  const antigravity = checkAntigravityReadiness(cliChecks.agy, {
    homeDir,
    existsSyncFn,
    readFileSyncFn,
    spawnSyncFn,
  });
  const result = {
    timestamp: Date.now(),
    hub: checkHubFn({ pkgRoot: PKG_ROOT }),
    route: checkRouteFn({ homeDir, existsSyncFn }),
    codex: cliChecks.codex || { ok: false },
    gemini: cliChecks.gemini || { ok: false },
    antigravity,
    codex_plan: detectCodexPlanFn({ homeDir }),
    ok: false,
  };
  result.ok = result.hub.ok && result.route.ok;

  const agents = [];
  if (result.codex.ok) agents.push("codex");
  if (result.gemini.ok) agents.push("gemini");
  if (result.antigravity.ok) agents.push("antigravity");
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

export {
  CACHE_FILE,
  CACHE_TTL_MS,
  checkAntigravityReadiness,
  checkRoute,
  runPreflight,
};
