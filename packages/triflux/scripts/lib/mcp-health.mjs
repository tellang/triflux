#!/usr/bin/env node
// scripts/lib/mcp-health.mjs
// Dead MCP preflight — session 18 checkpoint의 P3 root-cause fix.
// Codex config.toml 의 각 mcp_servers.* 정의를 probe 해서 응답 안하면 dead 판정.
// 결과는 ~/.codex/mcp-health-cache.json 에 TTL 기반으로 캐시.
// tfx-route.sh 가 swap 전에 이 결과를 읽어 dead 서버를 enabled=false 로 override.

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_CONFIG_PATH = path.join(homedir(), ".codex", "config.toml");
const DEFAULT_CACHE_PATH = path.join(
  homedir(),
  ".codex",
  "mcp-health-cache.json",
);
const DEFAULT_TTL_MS = 300_000; // 5 min
const DEFAULT_PROBE_TIMEOUT_MS = 3_000;

// ────────── TOML (mcp_servers 한정 단순 파서) ──────────

function parseTomlArrayLiteral(literal) {
  const inner = literal.trim().slice(1, -1).trim();
  if (!inner) return [];
  const items = [];
  let i = 0;
  while (i < inner.length) {
    while (i < inner.length && /[\s,]/.test(inner[i])) i++;
    if (i >= inner.length) break;
    const ch = inner[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < inner.length) {
        if (inner[j] === "\\" && ch === '"') {
          j += 2;
          continue;
        }
        if (inner[j] === ch) break;
        j++;
      }
      if (ch === '"') items.push(JSON.parse(inner.slice(i, j + 1)));
      else items.push(inner.slice(i + 1, j));
      i = j + 1;
    } else {
      let j = i;
      while (j < inner.length && inner[j] !== ",") j++;
      items.push(inner.slice(i, j).trim());
      i = j;
    }
  }
  return items;
}

function parseTomlScalar(raw) {
  const v = raw.replace(/\s+#.*$/, "").trim();
  if (/^".*"$/.test(v)) return JSON.parse(v);
  if (/^'.*'$/.test(v)) return v.slice(1, -1);
  if (v.startsWith("[") && v.endsWith("]")) return parseTomlArrayLiteral(v);
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === "true") return true;
  if (v === "false") return false;
  return v;
}

export function parseMcpServersFromToml(content = "") {
  const servers = {};
  const lines = content.split(/\r?\n/);
  let name = null;
  let scope = null; // "root" | "env"

  for (const rawLine of lines) {
    const line = rawLine.replace(/^\uFEFF/, "").trim();
    if (!line || line.startsWith("#")) continue;

    const rootSection = line.match(/^\[mcp_servers\.([a-zA-Z0-9_.-]+)\]$/);
    const envSection = line.match(
      /^\[mcp_servers\.([a-zA-Z0-9_.-]+)\.env\]$/,
    );
    const anySection = line.startsWith("[");

    if (envSection) {
      name = envSection[1];
      scope = "env";
      if (!servers[name]) servers[name] = {};
      if (!servers[name].env) servers[name].env = {};
      continue;
    }
    if (rootSection) {
      name = rootSection[1];
      scope = "root";
      if (!servers[name]) servers[name] = {};
      continue;
    }
    if (anySection) {
      name = null;
      scope = null;
      continue;
    }
    if (!name) continue;

    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+)$/);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    const value = parseTomlScalar(rawValue);

    if (scope === "env") servers[name].env[key] = String(value);
    else servers[name][key] = value;
  }

  return servers;
}

export function readMcpServers(configPath = DEFAULT_CONFIG_PATH) {
  if (!existsSync(configPath)) return {};
  try {
    const content = readFileSync(configPath, "utf8");
    return parseMcpServersFromToml(content);
  } catch {
    return {};
  }
}

// ────────── Probe ──────────

function makeInitializeRequest() {
  return (
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "tfx-mcp-probe", version: "1.0.0" },
      },
    }) + "\n"
  );
}

function isValidInitResponse(line) {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("{")) return false;
  try {
    const msg = JSON.parse(trimmed);
    if (msg.jsonrpc !== "2.0") return false;
    if (msg.id !== 1 && msg.id !== "1") return false;
    return msg.result !== undefined || msg.error !== undefined;
  } catch {
    return false;
  }
}

export function probeStdio(def, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;
    let child = null;

    const done = (result) => {
      if (settled) return;
      settled = true;
      try {
        child?.kill("SIGKILL");
      } catch {
        /* best effort */
      }
      resolve({ ...result, ms: Date.now() - start });
    };

    const timer = setTimeout(
      () => done({ alive: false, reason: "timeout" }),
      timeoutMs,
    );

    try {
      child = spawn(def.command, Array.isArray(def.args) ? def.args : [], {
        env: { ...process.env, ...(def.env || {}) },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      clearTimeout(timer);
      done({ alive: false, reason: `spawn:${err.code || err.message}` });
      return;
    }

    child.on("error", (err) => {
      clearTimeout(timer);
      done({ alive: false, reason: `error:${err.code || err.message}` });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      done({
        alive: false,
        reason: signal ? `signal:${signal}` : `exit:${code}`,
      });
    });

    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (isValidInitResponse(line)) {
          clearTimeout(timer);
          done({ alive: true });
          return;
        }
      }
    });
    child.stderr.on("data", () => {
      /* drain */
    });

    try {
      child.stdin.write(makeInitializeRequest(), (err) => {
        if (err) done({ alive: false, reason: `stdin:${err.code || err.message}` });
      });
    } catch (err) {
      done({ alive: false, reason: `write:${err.code || err.message}` });
    }
  });
}

export async function probeHttp(url, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: makeInitializeRequest().trim(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = Date.now() - start;
    if (res.status >= 200 && res.status < 500) {
      return { alive: true, ms };
    }
    return { alive: false, reason: `http:${res.status}`, ms };
  } catch (err) {
    const ms = Date.now() - start;
    const reason =
      err?.name === "AbortError" || err?.name === "TimeoutError"
        ? "timeout"
        : `fetch:${err?.code || err?.message || "unknown"}`;
    return { alive: false, reason, ms };
  }
}

export async function probeServer(def, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
  if (!def || typeof def !== "object") {
    return { alive: false, reason: "no-definition", ms: 0 };
  }
  if (typeof def.url === "string" && def.url) {
    return probeHttp(def.url, timeoutMs);
  }
  if (typeof def.command === "string" && def.command) {
    return probeStdio(def, timeoutMs);
  }
  return { alive: false, reason: "no-transport", ms: 0 };
}

// ────────── Cache ──────────

export function readCache(cachePath = DEFAULT_CACHE_PATH) {
  if (!existsSync(cachePath)) return null;
  try {
    return JSON.parse(readFileSync(cachePath, "utf8"));
  } catch {
    return null;
  }
}

export function writeCache(cache, cachePath = DEFAULT_CACHE_PATH) {
  try {
    mkdirSync(path.dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

export function isCacheFresh(cache, { now = Date.now(), configMtime = 0 } = {}) {
  if (!cache || typeof cache !== "object") return false;
  if (typeof cache.checkedAt !== "number") return false;
  if (typeof cache.ttlMs !== "number") return false;
  if (configMtime && cache.configMtime !== configMtime) return false;
  return now - cache.checkedAt < cache.ttlMs;
}

// ────────── Orchestration ──────────

export async function probeAll({
  configPath = DEFAULT_CONFIG_PATH,
  cachePath = DEFAULT_CACHE_PATH,
  names = null,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  ttlMs = DEFAULT_TTL_MS,
  useCache = true,
  writeCacheFile = true,
  now = Date.now(),
} = {}) {
  const configMtime = existsSync(configPath)
    ? Math.floor(statSync(configPath).mtimeMs)
    : 0;

  const servers = readMcpServers(configPath);
  const allNames = Object.keys(servers);
  const targets =
    Array.isArray(names) && names.length
      ? names.filter((n) => allNames.includes(n))
      : allNames;

  const existingCache = useCache ? readCache(cachePath) : null;
  const cacheFresh = isCacheFresh(existingCache, { now, configMtime });

  if (
    cacheFresh &&
    existingCache &&
    targets.every((n) => existingCache.results?.[n])
  ) {
    return {
      results: Object.fromEntries(
        targets.map((n) => [n, existingCache.results[n]]),
      ),
      source: "cache",
      configMtime,
    };
  }

  const probes = targets.map(async (name) => {
    const def = servers[name] || {};
    const result = await probeServer(def, timeoutMs);
    return [name, result];
  });
  const settled = await Promise.all(probes);
  const results = Object.fromEntries(settled);

  if (writeCacheFile) {
    const merged = cacheFresh
      ? { ...(existingCache?.results || {}), ...results }
      : results;
    writeCache(
      {
        configMtime,
        checkedAt: now,
        ttlMs,
        results: merged,
      },
      cachePath,
    );
  }

  return { results, source: "probe", configMtime };
}

export function splitHealthy(results) {
  const healthy = [];
  const dead = [];
  for (const [name, result] of Object.entries(results || {})) {
    if (result?.alive) healthy.push(name);
    else dead.push(name);
  }
  return { healthy, dead };
}

// ────────── CLI ──────────

function parseCliArgs(argv) {
  const args = {
    command: "probe",
    names: null,
    configPath: DEFAULT_CONFIG_PATH,
    cachePath: DEFAULT_CACHE_PATH,
    timeoutMs: Number(process.env.TFX_MCP_PROBE_TIMEOUT_MS) || DEFAULT_PROBE_TIMEOUT_MS,
    ttlMs: Number(process.env.TFX_MCP_HEALTH_TTL_MS) || DEFAULT_TTL_MS,
    useCache: true,
    format: "json",
  };

  const [first] = argv;
  if (first && !first.startsWith("-")) {
    args.command = first;
    argv = argv.slice(1);
  }

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => {
      const val = argv[i + 1];
      if (val === undefined) throw new Error(`${token} needs a value`);
      i += 1;
      return val;
    };
    switch (token) {
      case "--names":
        args.names = next()
          .split(/[,\s]+/)
          .filter(Boolean);
        break;
      case "--config":
        args.configPath = next();
        break;
      case "--cache":
        args.cachePath = next();
        break;
      case "--timeout-ms":
        args.timeoutMs = Number(next());
        break;
      case "--ttl-ms":
        args.ttlMs = Number(next());
        break;
      case "--no-cache":
        args.useCache = false;
        break;
      case "--format":
        args.format = next();
        break;
      case "--help":
      case "-h":
        args.command = "help";
        break;
      default:
        throw new Error(`unknown flag: ${token}`);
    }
  }
  return args;
}

function renderHelp() {
  return `mcp-health — dead MCP preflight probe

Usage:
  node scripts/lib/mcp-health.mjs probe [--names a,b,c] [--no-cache]
                                        [--timeout-ms 3000] [--ttl-ms 300000]
                                        [--format json|shell|disable-flags]
  node scripts/lib/mcp-health.mjs list

Env:
  TFX_MCP_PROBE_TIMEOUT_MS  default 3000
  TFX_MCP_HEALTH_TTL_MS     default 300000

Output formats:
  json           full results with ms/reason
  shell          HEALTHY=a,b DEAD=c,d
  disable-flags  -c mcp_servers.c.enabled=false -c mcp_servers.d.enabled=false
`;
}

function renderOutput(results, source, format) {
  const { healthy, dead } = splitHealthy(results);
  if (format === "shell") {
    return [
      `MCP_HEALTH_SOURCE=${JSON.stringify(source)}`,
      `MCP_HEALTHY=${JSON.stringify(healthy.join(","))}`,
      `MCP_DEAD=${JSON.stringify(dead.join(","))}`,
    ].join("\n");
  }
  if (format === "disable-flags") {
    return dead
      .map((name) => `-c mcp_servers.${name}.enabled=false`)
      .join(" ");
  }
  return JSON.stringify(
    { source, healthy, dead, results },
    null,
    2,
  );
}

export async function runCli(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    process.stderr.write(`[mcp-health] ${err.message}\n`);
    process.exitCode = 64;
    return;
  }

  if (args.command === "help") {
    process.stdout.write(renderHelp());
    return;
  }

  if (args.command === "list") {
    const servers = readMcpServers(args.configPath);
    process.stdout.write(
      JSON.stringify(Object.keys(servers).sort(), null, 2) + "\n",
    );
    return;
  }

  if (args.command !== "probe") {
    process.stderr.write(`[mcp-health] unknown command: ${args.command}\n`);
    process.exitCode = 64;
    return;
  }

  const { results, source } = await probeAll({
    configPath: args.configPath,
    cachePath: args.cachePath,
    names: args.names,
    timeoutMs: args.timeoutMs,
    ttlMs: args.ttlMs,
    useCache: args.useCache,
  });
  process.stdout.write(renderOutput(results, source, args.format) + "\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await runCli();
}
