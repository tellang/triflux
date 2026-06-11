#!/usr/bin/env node
// scripts/preflight-cache.mjs — 세션 시작 시 preflight 점검 캐싱

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANTIGRAVITY_KEYCHAIN_ACCOUNT,
  ANTIGRAVITY_KEYCHAIN_SERVICE,
} from "../hud/constants.mjs";
import { checkHub, detectCodexPlan, probeClis } from "./lib/env-probe.mjs";

const __filename = fileURLToPath(import.meta.url);
const PKG_ROOT = join(dirname(__filename), "..");

const CACHE_DIR = join(homedir(), ".claude", "cache");
const CACHE_FILE = join(CACHE_DIR, "tfx-preflight.json");
const CACHE_TTL_MS = 3_600_000; // 1시간 (세션당 1회, SessionStart 훅에서 갱신)
const ANTIGRAVITY_AUTH_READY_SKEW_MS = CACHE_TTL_MS + 60_000;
const ANTIGRAVITY_OAUTH_PATHS = (homeDir) => [
  join(homeDir, ".gemini", "antigravity-cli", "oauth_creds.json"),
  join(homeDir, ".gemini", "antigravity-cli", "credentials.json"),
  join(homeDir, ".gemini", "oauth_creds.json"),
];

function checkRoute({ homeDir = homedir(), existsSyncFn = existsSync } = {}) {
  const routePath = join(homeDir, ".claude", "scripts", "tfx-route.sh");
  return { ok: existsSyncFn(routePath), path: routePath };
}

function firstPresent(...values) {
  for (const value of values) {
    if (value != null && value !== "") return value;
  }
  return null;
}

function normalizeExpiryDate(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return normalizeExpiryDate(numeric);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeAntigravityCredential(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const accessToken = firstPresent(
    parsed.access_token,
    parsed.accessToken,
    parsed.access?.token,
    parsed.token,
  );
  const normalized = { ...parsed };
  if (accessToken) normalized.access_token = accessToken;
  const expiryDate = normalizeExpiryDate(
    firstPresent(
      parsed.expiry_date,
      parsed.expiryDate,
      parsed.expiry,
      parsed.expires_at,
      parsed.expiresAt,
    ),
  );
  if (expiryDate != null) normalized.expiry_date = expiryDate;
  return normalized;
}

function credentialReadiness(parsed, { source, path, now }) {
  const credential = normalizeAntigravityCredential(parsed);
  if (!credential) {
    return {
      ok: false,
      status: "not_ready",
      reason: "auth_invalid",
      auth_source: source,
      ...(path ? { path } : {}),
    };
  }
  if (!Number.isFinite(credential.expiry_date)) {
    return {
      ok: false,
      status: "unknown",
      reason: "auth_expiry_unknown",
      auth_source: source,
      ...(path ? { path } : {}),
    };
  }
  if (credential.expiry_date > now + ANTIGRAVITY_AUTH_READY_SKEW_MS) {
    return {
      ok: true,
      status: "ready",
      reason: "ready",
      auth_source: source,
      ...(path ? { path } : {}),
    };
  }
  return {
    ok: false,
    status: "not_ready",
    reason: "auth_expired",
    auth_source: source,
    ...(path ? { path } : {}),
  };
}

function readAntigravityKeychainCredential({ spawnSyncFn, platformFn }) {
  if (platformFn() !== "darwin") return { status: "skipped" };
  try {
    const result = spawnSyncFn(
      "security",
      [
        "find-generic-password",
        "-s",
        ANTIGRAVITY_KEYCHAIN_SERVICE,
        "-a",
        ANTIGRAVITY_KEYCHAIN_ACCOUNT,
        "-w",
      ],
      { encoding: "utf8", timeout: 2000, windowsHide: true },
    );
    if (result.error || result.signal) {
      return { status: "unavailable", reason: "keychain_unavailable" };
    }
    if (result.status !== 0) {
      return { status: "missing", reason: "keychain_missing" };
    }
    const stdout = String(result.stdout || "").trim();
    if (!stdout) return { status: "missing", reason: "keychain_missing" };
    try {
      return { status: "found", credential: JSON.parse(stdout) };
    } catch {
      return { status: "found", credential: { access_token: stdout } };
    }
  } catch {
    return { status: "unavailable", reason: "keychain_unavailable" };
  }
}

function checkAntigravityFileCredential({
  homeDir,
  existsSyncFn,
  readFileSyncFn,
  now,
}) {
  let fallback = {
    ok: false,
    status: "not_ready",
    reason: "auth_missing",
    auth_source: "file",
  };
  for (const path of ANTIGRAVITY_OAUTH_PATHS(homeDir)) {
    if (!existsSyncFn(path)) continue;

    try {
      const parsed = JSON.parse(readFileSyncFn(path, "utf8"));
      const readiness = credentialReadiness(parsed, {
        source: "file",
        path,
        now,
      });
      if (readiness.ok) return readiness;
      fallback = readiness;
    } catch {
      fallback = {
        ok: false,
        status: "not_ready",
        reason: "auth_invalid",
        auth_source: "file",
        path,
      };
    }
  }

  return fallback;
}

function checkAntigravityCredential({
  homeDir,
  existsSyncFn,
  readFileSyncFn,
  spawnSyncFn,
  platformFn,
  now = Date.now(),
}) {
  const keychain = readAntigravityKeychainCredential({
    spawnSyncFn,
    platformFn,
  });
  if (keychain.status === "found") {
    return credentialReadiness(keychain.credential, {
      source: "keychain",
      now,
    });
  }
  if (keychain.status === "unavailable") {
    return {
      ok: false,
      status: "unknown",
      reason: keychain.reason,
      auth_source: "keychain",
    };
  }

  const file = checkAntigravityFileCredential({
    homeDir,
    existsSyncFn,
    readFileSyncFn,
    now,
  });

  if (keychain.status === "missing" && file.ok && platformFn() === "darwin") {
    return {
      ok: false,
      status: "unknown",
      reason: "keychain_missing",
      auth_source: "file",
      path: file.path,
    };
  }

  return file;
}

function checkAntigravityReadiness(
  cliResult,
  {
    homeDir = homedir(),
    existsSyncFn = existsSync,
    readFileSyncFn = readFileSync,
    spawnSyncFn = spawnSync,
    platformFn = () => process.platform,
    timeout = 2000,
  } = {},
) {
  if (!cliResult?.ok || !cliResult.path)
    return { ok: false, status: "not_ready", reason: "missing" };

  let helpText = "";
  try {
    const help = spawnSyncFn(cliResult.path, ["--help"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      windowsHide: true,
    });
    if (help.error || (help.status != null && help.status !== 0)) {
      return {
        ok: false,
        status: "not_ready",
        path: cliResult.path,
        reason: "help_failed",
      };
    }
    helpText = [help.stdout, help.stderr].filter(Boolean).join("\n");
  } catch {
    return {
      ok: false,
      status: "not_ready",
      path: cliResult.path,
      reason: "help_failed",
    };
  }

  const hasHeadlessFlags =
    helpText.includes("--print") &&
    helpText.includes("--dangerously-skip-permissions");
  if (!hasHeadlessFlags) {
    return {
      ok: false,
      status: "not_ready",
      path: cliResult.path,
      reason: "headless_unsupported",
    };
  }

  const credential = checkAntigravityCredential({
    homeDir,
    existsSyncFn,
    readFileSyncFn,
    spawnSyncFn,
    platformFn,
  });
  if (!credential.ok) {
    return { ...credential, path: credential.path || cliResult.path };
  }

  return { ...credential, path: cliResult.path };
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
  platformFn = () => process.platform,
} = {}) {
  const cliChecks = await probeClisFn(["codex", "gemini", "agy"]);
  const antigravity = checkAntigravityReadiness(cliChecks.agy, {
    homeDir,
    existsSyncFn,
    readFileSyncFn,
    spawnSyncFn,
    platformFn,
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
  if (result.antigravity.ok) {
    agents.push("antigravity");
  } else if (result.gemini.ok) {
    agents.push("gemini");
  }
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
