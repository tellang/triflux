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
  renameSync,
  statSync,
  unlinkSync,
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

// 문자열 리터럴 밖의 `# ...` 은 라인 끝 주석. multiline buffer 에 누적하기
// 전에 line 단위로 제거해야 parseTomlArrayLiteral 이 scalar 분기에서 주석 문자열을
// item 으로 잘못 포함하지 않는다.
function stripInlineComment(line) {
  let inString = false;
  let stringChar = null;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === "\\" && stringChar === '"') {
        escaped = true;
        continue;
      }
      if (ch === stringChar) {
        inString = false;
        stringChar = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      continue;
    }
    if (ch === "#") return line.slice(0, i).trimEnd();
  }
  return line;
}

// 문자열 리터럴 내부를 제외한 bracket depth. 음수는 over-close.
// Review finding A1 (commit 9298fd6 cross-review): 멀티라인 array 값
// (예: `args = [\n  "run",\n  "server.js"\n]`) 을 single-line 파서가 `"["`
// 문자열로 오인해 probeStdio 가 args=[] 로 실행 → 정상 서버를 dead 로 오탐.
// Inline comment 는 newline 전까지만 무시 — 멀티라인 buffer 에서 첫 `#` 이후
// 전체가 drop 되면 안 됨.
function countBracketDelta(str) {
  let depth = 0;
  let inString = false;
  let stringChar = null;
  let escaped = false;
  let inComment = false;
  for (const ch of str) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inComment) {
      if (ch === "\n") inComment = false;
      continue;
    }
    if (inString) {
      if (ch === "\\" && stringChar === '"') {
        escaped = true;
        continue;
      }
      if (ch === stringChar) {
        inString = false;
        stringChar = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      continue;
    }
    if (ch === "#") {
      inComment = true;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
  }
  return depth;
}

export function parseMcpServersFromToml(content = "") {
  const servers = {};
  const lines = content.split(/\r?\n/);
  let name = null;
  let scope = null; // "root" | "env"
  let pendingKey = null;
  let pendingBuffer = "";

  function assign(key, value) {
    if (scope === "env") servers[name].env[key] = String(value);
    else servers[name][key] = value;
  }

  for (const rawLine of lines) {
    const line = rawLine.replace(/^\uFEFF/, "").trim();

    if (pendingKey !== null) {
      pendingBuffer += " " + stripInlineComment(line);
      if (countBracketDelta(pendingBuffer) <= 0) {
        assign(pendingKey, parseTomlScalar(pendingBuffer));
        pendingKey = null;
        pendingBuffer = "";
      }
      continue;
    }

    if (!line || line.startsWith("#")) continue;

    const rootSection = line.match(/^\[mcp_servers\.([a-zA-Z0-9_.-]+)\]$/);
    const envSection = line.match(/^\[mcp_servers\.([a-zA-Z0-9_.-]+)\.env\]$/);
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
    const cleanValue = stripInlineComment(rawValue);

    if (countBracketDelta(cleanValue) > 0) {
      pendingKey = key;
      pendingBuffer = cleanValue;
      continue;
    }

    assign(key, parseTomlScalar(cleanValue));
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

// ────────── Binary Fingerprint (Issue #149) ──────────
// Cache staleness 방지: config.toml mtime 만 보면 `npm i -g <mcp-bin>` 설치/제거
// 를 감지 못해 5분간 stale dead 판정이 유지된다. 서버별 fingerprint (command,
// args, 해석된 binary path+mtime+size 또는 url) 을 cache 에 저장하고 일치할
// 때만 hit 으로 판정한다.

function statBinary(filePath) {
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return null;
    return { path: filePath, mtime: Math.floor(st.mtimeMs), size: st.size };
  } catch {
    return null;
  }
}

export function resolveBinaryPath(command) {
  if (!command || typeof command !== "string") return null;
  if (path.isAbsolute(command)) return statBinary(command);

  const pathEntries = (process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
  const pathExts =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .filter(Boolean)
      : [""];
  // command 에 이미 확장자가 있을 수도 있으니 빈 확장자도 시도.
  const exts = pathExts.includes("") ? pathExts : ["", ...pathExts];

  for (const dir of pathEntries) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      const result = statBinary(candidate);
      if (result) return result;
    }
  }
  return null;
}

export function computeFingerprint(def) {
  if (!def || typeof def !== "object") return { type: "none" };
  if (typeof def.url === "string" && def.url) {
    return { type: "http", url: def.url };
  }
  if (typeof def.command === "string" && def.command) {
    return {
      type: "stdio",
      command: def.command,
      args: Array.isArray(def.args) ? [...def.args] : [],
      binary: resolveBinaryPath(def.command),
    };
  }
  return { type: "unknown" };
}

export function fingerprintsEqual(a, b) {
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  if (a.type === "http") return a.url === b.url;
  if (a.type === "stdio") {
    if (a.command !== b.command) return false;
    const ax = Array.isArray(a.args) ? a.args : [];
    const bx = Array.isArray(b.args) ? b.args : [];
    if (ax.length !== bx.length) return false;
    for (let i = 0; i < ax.length; i++) {
      if (ax[i] !== bx[i]) return false;
    }
    if ((a.binary === null) !== (b.binary === null)) return false;
    if (a.binary && b.binary) {
      if (a.binary.path !== b.binary.path) return false;
      if (a.binary.mtime !== b.binary.mtime) return false;
      if (a.binary.size !== b.binary.size) return false;
    }
    return true;
  }
  return true; // "none"/"unknown" — 같은 type 이면 equal
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
  if (!trimmed?.startsWith("{")) return false;
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
        if (err)
          done({ alive: false, reason: `stdin:${err.code || err.message}` });
      });
    } catch (err) {
      done({ alive: false, reason: `write:${err.code || err.message}` });
    }
  });
}

// Review finding A2 (commit 9298fd6 cross-review): 기존 구현은 status 2xx-4xx
// 전부 alive 로 취급 — 404/401 HTML 오류 페이지를 healthy 로 오판. 실제 MCP
// endpoint 는 200 + JSON-RPC body 를 돌려줘야 살아있는 것. 2xx + JSON-RPC
// envelope (id 일치, result|error 존재) 둘 다 검증한다.
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
    if (res.status < 200 || res.status >= 300) {
      return { alive: false, reason: `http:${res.status}`, ms };
    }
    let body;
    try {
      body = await res.text();
    } catch {
      return { alive: false, reason: "http:body-read-failed", ms };
    }
    // SSE / ndjson 환경 대비 — 첫 JSON-RPC envelope 하나만 찾으면 충분.
    const envelope = body
      .split(/\r?\n/)
      .map((chunk) => chunk.replace(/^data:\s*/, "").trim())
      .find((chunk) => chunk.startsWith("{"));
    if (!envelope) {
      return { alive: false, reason: "http:no-jsonrpc-body", ms };
    }
    try {
      const msg = JSON.parse(envelope);
      if (msg.jsonrpc !== "2.0") {
        return { alive: false, reason: "http:not-jsonrpc", ms };
      }
      if (msg.id !== 1 && msg.id !== "1") {
        return { alive: false, reason: "http:id-mismatch", ms };
      }
      if (msg.result === undefined && msg.error === undefined) {
        return { alive: false, reason: "http:no-result", ms };
      }
      return { alive: true, ms };
    } catch {
      return { alive: false, reason: "http:invalid-json", ms };
    }
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
  // Issue #154: writeFileSync 는 non-atomic 이라 swarm/병렬 tfx-route 가 동시
  // write 하면 reader 가 partial JSON 을 받아 SyntaxError → null 반환. tmp 파일에
  // 쓰고 rename 으로 교체하면 reader 는 항상 완전한 파일을 본다 (POSIX atomic,
  // Windows MoveFileEx 도 target replace 지원). pid+timestamp 가 tmp 이름에
  // 들어가 writer 끼리도 충돌하지 않는다.
  const tmpPath = `${cachePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    mkdirSync(path.dirname(cachePath), { recursive: true });
    writeFileSync(tmpPath, JSON.stringify(cache, null, 2), "utf8");
    renameSync(tmpPath, cachePath);
    return true;
  } catch {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best effort */
    }
    return false;
  }
}

export function isCacheFresh(
  cache,
  { now = Date.now(), configMtime = 0 } = {},
) {
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

  // Issue #149: per-server fingerprint (binary path+mtime+size) 로 cache 를
  // invalidate 한다. configMtime 은 여전히 meta 로 저장하지만 hit 판정에는
  // 쓰지 않는다 — binary 설치/제거가 config.toml mtime 을 바꾸지 않기 때문.
  const fingerprints = Object.fromEntries(
    targets.map((name) => [name, computeFingerprint(servers[name])]),
  );

  const existingCache = useCache ? readCache(cachePath) : null;
  const cachedResults = existingCache?.results || {};
  const cacheWithinTtl =
    existingCache &&
    typeof existingCache.checkedAt === "number" &&
    typeof existingCache.ttlMs === "number" &&
    now - existingCache.checkedAt < existingCache.ttlMs;

  const hits = {};
  const stale = [];
  for (const name of targets) {
    const prior = cachedResults[name];
    if (
      cacheWithinTtl &&
      prior?.fingerprint &&
      fingerprintsEqual(prior.fingerprint, fingerprints[name])
    ) {
      hits[name] = prior;
    } else {
      stale.push(name);
    }
  }

  if (stale.length === 0) {
    return { results: hits, source: "cache", configMtime };
  }

  const probes = stale.map(async (name) => {
    const def = servers[name] || {};
    const result = await probeServer(def, timeoutMs);
    return [name, { ...result, fingerprint: fingerprints[name] }];
  });
  const settled = await Promise.all(probes);
  const freshResults = Object.fromEntries(settled);

  const allResults = { ...hits, ...freshResults };

  if (writeCacheFile) {
    // 이번에 probe 한 서버만 결과 갱신; 이전 cache 의 다른 서버 결과는 보존.
    const merged = { ...cachedResults, ...freshResults };
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

  return { results: allResults, source: "probe", configMtime };
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
    timeoutMs:
      Number(process.env.TFX_MCP_PROBE_TIMEOUT_MS) || DEFAULT_PROBE_TIMEOUT_MS,
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
    return dead.map((name) => `-c mcp_servers.${name}.enabled=false`).join(" ");
  }
  return JSON.stringify({ source, healthy, dead, results }, null, 2);
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
