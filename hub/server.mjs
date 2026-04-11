// hub/server.mjs — HTTP MCP + REST bridge + Named Pipe 서버 진입점

import { execSync as execSyncHub } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { homedir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createModuleLogger } from "../scripts/lib/logger.mjs";
import { broker as brokerInstance, reloadBroker } from "./account-broker.mjs";
import { createAdaptiveEngine } from "./adaptive.mjs";
import { createAssignCallbackServer } from "./assign-callbacks.mjs";
import { DelegatorService } from "./delegator/index.mjs";
import { createHitlManager } from "./hitl.mjs";
import { cleanupOrphanNodeProcesses } from "./lib/process-utils.mjs";
import { wrapRequestHandler } from "./middleware/request-logger.mjs";
import { createPipeServer } from "./pipe.mjs";
import { createRouter } from "./router.mjs";
import { createAdaptiveFingerprintService } from "./session-fingerprint.mjs";
import {
  acquireLock,
  getVersionHash,
  isServerHealthy,
  readState,
  releaseLock,
  writeState,
} from "./state.mjs";
import { createStoreAdapter } from "./store-adapter.mjs";
import { createGitPreflight } from "./team/git-preflight.mjs";
import { nativeProxy } from "./team/nativeProxy.mjs";
import { createSwarmLocks } from "./team/swarm-locks.mjs";
import { createSynapseRegistry } from "./team/synapse-registry.mjs";
import { registerTeamBridge } from "./team-bridge.mjs";
import { createTools } from "./tools.mjs";
import { createDelegatorMcpWorker } from "./workers/delegator-mcp.mjs";

registerTeamBridge(nativeProxy);

const hubLog = createModuleLogger("hub");

const MAX_BODY_SIZE = 1024 * 1024;
const PUBLIC_PATHS = new Set(["/", "/status", "/health", "/healthz"]);
const RATE_LIMIT_MAX = 100; // requests per window
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute sliding window
const LOOPBACK_REMOTE_ADDRESSES = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
]);
const ALLOWED_ORIGIN_RE =
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC_DIR = resolve(join(PROJECT_ROOT, "hub", "public"));
const CACHE_DIR = join(homedir(), ".claude", "cache");
const BATCH_EVENTS_PATH = join(CACHE_DIR, "batch-events.jsonl");
const SV_ACCUMULATOR_PATH = join(CACHE_DIR, "sv-accumulator.json");
const CODEX_RATE_LIMITS_CACHE_PATH = join(
  CACHE_DIR,
  "codex-rate-limits-cache.json",
);
const GEMINI_QUOTA_CACHE_PATH = join(CACHE_DIR, "gemini-quota-cache.json");
const CLAUDE_USAGE_CACHE_PATH = join(CACHE_DIR, "claude-usage-cache.json");
const AIMD_WINDOW_MS = 30 * 60 * 1000;
const AIMD_INITIAL_BATCH_SIZE = 3;
const AIMD_MIN_BATCH_SIZE = 1;
const AIMD_MAX_BATCH_SIZE = 10;
const HUB_IDLE_TIMEOUT_DEFAULT_MS = 10 * 60 * 1000;
const HUB_IDLE_SWEEP_DEFAULT_MS = 60 * 1000;
const STATIC_CONTENT_TYPES = Object.freeze({
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".png": "image/png",
});

// IP-based sliding window rate limiter (in-memory, no external deps)
// Each entry is an array of request timestamps within the current window.
const rateLimitMap = new Map();

function formatHostForUrl(host = "127.0.0.1") {
  return String(host).includes(":") ? `[${host}]` : host;
}

function buildHubUrl(host, port) {
  return `http://${formatHostForUrl(host || "127.0.0.1")}:${port}/mcp`;
}

function isPidAlive(pid, killFn = process.kill) {
  const resolvedPid = Number(pid);
  if (!Number.isFinite(resolvedPid) || resolvedPid <= 0) return false;
  try {
    killFn(resolvedPid, 0);
    return true;
  } catch {
    return false;
  }
}

async function tryReuseExistingHub({
  port,
  host = "127.0.0.1",
  readCurrentState = readState,
  readInfo = getHubInfo,
  checkHealth = isServerHealthy,
  killFn = process.kill,
} = {}) {
  const existing = readCurrentState();
  const existingPort = Number(existing?.port);
  if (
    !isPidAlive(existing?.pid, killFn) ||
    !Number.isFinite(existingPort) ||
    existingPort <= 0
  ) {
    return null;
  }
  if (Number.isFinite(Number(port)) && existingPort !== Number(port))
    return null;
  if (!(await checkHealth(existingPort))) return null;

  const info = readInfo() ?? existing;
  const infoHost = typeof info?.host === "string" ? info.host : host;
  return {
    reused: true,
    external: true,
    port: existingPort,
    pid: Number(existing.pid),
    url: info?.url ?? buildHubUrl(infoHost, existingPort),
    stop: async () => false,
  };
}

function checkRateLimit(ip) {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const timestamps = (rateLimitMap.get(ip) || []).filter((t) => t >= cutoff);
  if (timestamps.length >= RATE_LIMIT_MAX) {
    // Oldest timestamp in window tells us when a slot frees up
    const retryAfterMs = timestamps[0] + RATE_LIMIT_WINDOW_MS - now;
    rateLimitMap.set(ip, timestamps);
    return { allowed: false, retryAfterSec: Math.ceil(retryAfterMs / 1000) };
  }
  rateLimitMap.set(ip, [...timestamps, now]);
  return { allowed: true, retryAfterSec: 0 };
}

function isInitializeRequest(body) {
  if (body?.method === "initialize") return true;
  if (Array.isArray(body))
    return body.some((message) => message.method === "initialize");
  return false;
}

async function parseBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_SIZE) {
      throw Object.assign(new Error("Body too large"), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

const PID_DIR = join(homedir(), ".claude", "cache", "tfx-hub");
const PID_FILE = join(PID_DIR, "hub.pid");
const TOKEN_FILE = join(homedir(), ".claude", ".tfx-hub-token");

function isPublicPath(path) {
  return (
    PUBLIC_PATHS.has(path) ||
    path === "/dashboard" ||
    path === "/api/qos-stats" ||
    path.startsWith("/public/")
  );
}

function isAllowedOrigin(origin) {
  return origin && ALLOWED_ORIGIN_RE.test(origin);
}

function getRequestPath(url = "/") {
  try {
    return new URL(url, "http://127.0.0.1").pathname;
  } catch {
    return String(url).replace(/\?.*/, "") || "/";
  }
}

function isLoopbackRemoteAddress(remoteAddress) {
  return (
    typeof remoteAddress === "string" &&
    LOOPBACK_REMOTE_ADDRESSES.has(remoteAddress)
  );
}

function extractBearerToken(req) {
  const authHeader =
    typeof req.headers.authorization === "string"
      ? req.headers.authorization
      : "";
  return authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
}

function writeJson(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function applyCorsHeaders(req, res) {
  const origin =
    typeof req.headers.origin === "string" ? req.headers.origin : "";
  if (origin) {
    res.setHeader("Vary", "Origin");
  }
  if (!isAllowedOrigin(origin)) return false;

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, mcp-session-id, Last-Event-ID",
  );
  return true;
}

function safeTokenCompare(a, b) {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function isAuthorizedRequest(req, path, hubToken) {
  if (!hubToken) {
    return isLoopbackRemoteAddress(req.socket.remoteAddress);
  }
  if (isPublicPath(path)) return true;
  const supplied = extractBearerToken(req);
  if (!supplied) return false;
  return safeTokenCompare(supplied, hubToken);
}

function resolveTeamStatusCode(result) {
  if (result?.ok) return 200;
  const code = result?.error?.code;
  if (
    code === "TEAM_NOT_FOUND" ||
    code === "TASK_NOT_FOUND" ||
    code === "TASKS_DIR_NOT_FOUND"
  )
    return 404;
  if (code === "CLAIM_CONFLICT" || code === "MTIME_CONFLICT") return 409;
  if (
    code === "INVALID_TEAM_NAME" ||
    code === "INVALID_TASK_ID" ||
    code === "INVALID_TEXT" ||
    code === "INVALID_FROM" ||
    code === "INVALID_STATUS"
  )
    return 400;
  return 500;
}

function resolvePipelineStatusCode(result) {
  if (result?.ok) return 200;
  if (result?.error === "pipeline_not_found") return 404;
  if (result?.error === "hub_db_not_found") return 503;
  return 400;
}

function resolveSendInputStatusCode(result) {
  if (result?.ok) return 200;
  const code = result?.error?.code;
  if (code === "CONDUCTOR_REGISTRY_NOT_AVAILABLE") return 503;
  if (code === "CONDUCTOR_SESSION_NOT_FOUND") return 404;
  if (code === "SEND_INPUT_FAILED") return 409;
  return 400;
}

function normalizeBridgePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  return payload;
}

function normalizeHandoffBody(body) {
  const payload = normalizeBridgePayload(body?.payload);
  return {
    ...payload,
    ...body,
    from: body?.from,
    to: body?.to,
    payload,
  };
}

function normalizePublishBody(body) {
  const payload = normalizeBridgePayload(body?.payload);
  const type = body?.type || body?.message_type || "event";
  return {
    ...payload,
    ...body,
    from: body?.from,
    to: body?.to,
    type,
    message_type: type,
    payload,
  };
}

function safeReadJsonFile(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readRecentAimdEvents(now = Date.now()) {
  try {
    if (!existsSync(BATCH_EVENTS_PATH)) return [];
    const cutoff = now - AIMD_WINDOW_MS;
    return readFileSync(BATCH_EVENTS_PATH, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((event) => {
        const timestamp = Number(event?.ts ?? event?.timestamp ?? 0);
        return event && Number.isFinite(timestamp) && timestamp >= cutoff;
      });
  } catch {
    return [];
  }
}

function calculateAimdBatchSize(events) {
  let batchSize = AIMD_INITIAL_BATCH_SIZE;

  for (const event of events) {
    const result = event?.result;
    if (result === "success" || result === "success_with_warnings") {
      batchSize = Math.min(AIMD_MAX_BATCH_SIZE, batchSize + 1);
    } else if (result === "failed" || result === "timeout") {
      batchSize = Math.max(AIMD_MIN_BATCH_SIZE, batchSize * 0.5);
    }
  }

  return batchSize;
}

function getQosStatsPayload() {
  const events = readRecentAimdEvents();
  return {
    aimd: {
      batchSize: calculateAimdBatchSize(events),
      events,
    },
    accumulator: safeReadJsonFile(SV_ACCUMULATOR_PATH),
    codex: safeReadJsonFile(CODEX_RATE_LIMITS_CACHE_PATH),
    gemini: safeReadJsonFile(GEMINI_QUOTA_CACHE_PATH),
    claude: safeReadJsonFile(CLAUDE_USAGE_CACHE_PATH),
  };
}

function resolvePublicFilePath(path) {
  let relativePath = null;
  if (path === "/dashboard") {
    relativePath = "dashboard.html";
  } else if (path.startsWith("/public/")) {
    relativePath = path.slice("/public/".length);
  }

  if (!relativePath) return null;

  try {
    relativePath = decodeURIComponent(relativePath).replace(/^[/\\]+/, "");
  } catch {
    return null;
  }

  const filePath = resolve(PUBLIC_DIR, relativePath);
  const publicPrefix = `${PUBLIC_DIR}${sep}`;
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(publicPrefix)) {
    return null;
  }
  return filePath;
}

function servePublicFile(res, path) {
  const filePath = resolvePublicFilePath(path);
  if (!filePath) return false;

  mkdirSync(PUBLIC_DIR, { recursive: true });
  if (!existsSync(filePath)) {
    hubLog.warn({ filePath }, "static.not_found");
    res.writeHead(404);
    res.end("Not Found (static file missing)");
    return true;
  }

  try {
    const body = readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type":
        STATIC_CONTENT_TYPES[extname(filePath).toLowerCase()] ||
        "application/octet-stream",
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not Found");
  }
  return true;
}

/**
 * tfx-hub 시작
 * @param {object} opts
 * @param {number} [opts.port]
 * @param {string} [opts.dbPath]
 * @param {string} [opts.host]
 * @param {string|number} [opts.sessionId]
 * @param {(options: { cwd: string }) => object} [opts.createDelegatorWorker]
 */
export async function startHub({
  port: portOpt,
  dbPath,
  host = "127.0.0.1",
  sessionId = process.pid,
  createDelegatorWorker = createDelegatorMcpWorker,
} = {}) {
  const port = portOpt ?? parseInt(process.env.TFX_HUB_PORT || "27888", 10);

  const existingHub = await tryReuseExistingHub({ port, host });
  if (existingHub) return existingHub;

  const hubIdleTimeoutMs = parsePositiveInt(
    process.env.TFX_HUB_IDLE_TIMEOUT_MS,
    HUB_IDLE_TIMEOUT_DEFAULT_MS,
  );
  const hubIdleSweepMs = parsePositiveInt(
    process.env.TFX_HUB_IDLE_SWEEP_MS,
    Math.min(HUB_IDLE_SWEEP_DEFAULT_MS, hubIdleTimeoutMs),
  );
  let lastRequestAt = Date.now();
  const markRequestActivity = () => {
    lastRequestAt = Date.now();
  };

  if (!dbPath) {
    // DB를 npm 패키지 밖에 저장하여 npm update 시 EBUSY 방지
    // 기존: PROJECT_ROOT/.tfx/state/state.db (패키지 내부 → 락 충돌)
    // 변경: ~/.claude/cache/tfx-hub/state.db (패키지 외부 → 안전)
    const hubCacheDir = join(homedir(), ".claude", "cache", "tfx-hub");
    mkdirSync(hubCacheDir, { recursive: true });
    dbPath = join(hubCacheDir, "state.db");
  }

  mkdirSync(PUBLIC_DIR, { recursive: true });

  const version = getVersionHash();
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  await acquireLock();
  let lockHeld = true;
  const releaseStartupLock = () => {
    if (!lockHeld) return;
    releaseLock();
    lockHeld = false;
  };

  const lockedExistingHub = await tryReuseExistingHub({ port, host });
  if (lockedExistingHub) {
    releaseStartupLock();
    return lockedExistingHub;
  }

  const HUB_TOKEN = process.env.TFX_HUB_TOKEN?.trim() || null;
  if (HUB_TOKEN) {
    mkdirSync(join(homedir(), ".claude"), { recursive: true });
    writeFileSync(TOKEN_FILE, HUB_TOKEN, { mode: 0o600 });
  } else {
    try {
      unlinkSync(TOKEN_FILE);
    } catch {}
  }

  const store = await createStoreAdapter(dbPath);
  const router = createRouter(store);
  const fingerprintService = createAdaptiveFingerprintService({ store });

  // Neural Memory adaptive engine 초기화
  const adaptiveEngine = createAdaptiveEngine({
    repoRoot: PROJECT_ROOT,
    fingerprintService,
  });
  adaptiveEngine.startSession();

  // safety-guard → reflexion 패널티 승격 + 적응형 규칙 유지보수
  const projectSlug = PROJECT_ROOT.split(/[\\/]/).pop();
  try {
    const { promotePenalties } = await import("./promote-penalties.mjs");
    const result = promotePenalties(store, { projectSlug });
    if (result.promoted > 0) {
      console.log(
        `[reflexion] ${result.promoted} penalties promoted to adaptive rules`,
      );
    }
  } catch {
    /* promote-penalties 실패는 Hub 시작을 막지 않음 */
  }

  // stale adaptive_rules 정리 (30일 초과 + confidence 0.2 미만)
  try {
    const pruned = store.pruneStaleRules();
    if (pruned > 0)
      console.log(`[reflexion] ${pruned} stale adaptive rules pruned`);
  } catch {
    /* prune 실패 무시 */
  }

  // adaptive rule confidence decay (7일 이상 미관측 규칙 -0.1 감소)
  try {
    const { decayRules } = await import("./reflexion.mjs");
    const decay = decayRules(
      store,
      adaptiveEngine.sessionCount?.() || 1,
      projectSlug,
    );
    if (decay.deleted.length > 0)
      console.log(
        `[reflexion] ${decay.deleted.length} low-confidence rules removed`,
      );
  } catch {
    /* decay 실패 무시 */
  }

  // Delegator MCP resident service 초기화
  const delegatorWorker = createDelegatorWorker({ cwd: PROJECT_ROOT });
  try {
    await delegatorWorker.start();
  } catch (error) {
    releaseStartupLock();
    throw error;
  }
  const delegatorService = new DelegatorService({ worker: delegatorWorker });

  // Synapse Layer 4: session registry + git preflight + swarm locks
  const synapseRegistry = createSynapseRegistry({
    persistPath: join(CACHE_DIR, "tfx-hub", "synapse-sessions.json"),
    emitter: router.deliveryEmitter,
  });
  const swarmLocks = createSwarmLocks({
    repoRoot: PROJECT_ROOT,
    persistPath: join(CACHE_DIR, "tfx-hub", "swarm-locks.json"),
  });
  const gitPreflight = createGitPreflight({
    registry: synapseRegistry,
    locks: swarmLocks,
  });

  const hitl = createHitlManager(store, router);
  const pipe = createPipeServer({
    router,
    store,
    sessionId,
    delegatorService,
    hitlManager: hitl,
    onActivity: markRequestActivity,
  });
  const assignCallbacks = createAssignCallbackServer({ store, sessionId });
  const tools = createTools(store, router, hitl, pipe);
  const transports = new Map();

  function createMcpForSession() {
    const mcp = new Server(
      { name: "tfx-hub", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );

    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    }));

    mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                error: { code: "UNKNOWN_TOOL", message: `도구 없음: ${name}` },
              }),
            },
          ],
          isError: true,
        };
      }
      return tool.handler(args || {});
    });

    return mcp;
  }

  const httpServer = createHttpServer(
    wrapRequestHandler(async (req, res) => {
      markRequestActivity();
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "DENY");
      const path = getRequestPath(req.url);
      const corsAllowed = applyCorsHeaders(req, res);

      if (req.method === "OPTIONS") {
        const localOnlyMode = !HUB_TOKEN;
        const isLoopbackRequest = isLoopbackRemoteAddress(
          req.socket.remoteAddress,
        );
        res.writeHead(
          corsAllowed && (!localOnlyMode || isLoopbackRequest) ? 204 : 403,
        );
        return res.end();
      }

      const clientIp = req.socket.remoteAddress || "unknown";
      if (!isLoopbackRemoteAddress(clientIp)) {
        const rateCheck = checkRateLimit(clientIp);
        if (!rateCheck.allowed) {
          return writeJson(
            res,
            429,
            { ok: false, error: "Too Many Requests" },
            { "Retry-After": String(rateCheck.retryAfterSec) },
          );
        }
      }

      if (!isAuthorizedRequest(req, path, HUB_TOKEN)) {
        if (!HUB_TOKEN) {
          return writeJson(res, 403, {
            ok: false,
            error: "Forbidden: localhost only",
          });
        }
        return writeJson(
          res,
          401,
          { ok: false, error: "Unauthorized" },
          { "WWW-Authenticate": 'Bearer realm="tfx-hub"' },
        );
      }

      if (path === "/" || path === "/status") {
        const status = router.getStatus("hub").data;
        return writeJson(res, 200, {
          ...status,
          sessions: transports.size,
          pid: process.pid,
          port,
          auth_mode: HUB_TOKEN ? "token-required" : "localhost-only",
          idle_timeout_ms: hubIdleTimeoutMs,
          last_request_at: new Date(lastRequestAt).toISOString(),
          pipe_path: pipe.path,
          pipe: pipe.getStatus(),
          assign_callback_pipe_path: assignCallbacks.path,
          assign_callback_pipe: assignCallbacks.getStatus(),
        });
      }

      if (path === "/health" || path === "/healthz") {
        const status = router.getStatus("hub").data;
        const healthy = status?.hub?.state === "healthy";
        return writeJson(res, healthy ? 200 : 503, {
          ok: healthy,
          version,
          platform: process.platform,
          uptime_s: Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)),
          node: process.version,
          sessions: transports.size,
          store: store.type || "sqlite",
          idle_timeout_ms: hubIdleTimeoutMs,
          idle_ms: Math.max(0, Date.now() - lastRequestAt),
          fingerprint: fingerprintService.getHealth(),
        });
      }

      if (path === "/api/qos-stats" && req.method === "GET") {
        return writeJson(res, 200, getQosStatsPayload());
      }

      if (path === "/broker/snapshot" && req.method === "GET") {
        const snap = brokerInstance?.snapshot() || [];
        return writeJson(res, 200, { ok: true, accounts: snap, ts: Date.now() });
      }

      if (path === "/broker/dashboard" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderBrokerDashboard());
        return;
      }

      if (path === "/broker/quota-refresh" && (req.method === "POST" || req.method === "GET")) {
        try {
          const results = await refreshAllAccountQuotas();
          return writeJson(res, 200, { ok: true, results, ts: Date.now() });
        } catch (err) {
          hubLog.error({ err: String(err?.message || err) }, "broker.quota_refresh_error");
          return writeJson(res, 200, { ok: false, error: String(err?.message || err) });
        }
      }

      if (path === "/broker/reload" && req.method === "POST") {
        const result = reloadBroker();
        if (!result.ok) {
          return writeJson(res, 200, { ok: false, error: result.error });
        }
        const accounts = result.broker
          ? [...result.broker.snapshot()].length
          : 0;
        return writeJson(res, 200, { ok: true, accounts });
      }

      if (path.startsWith("/bridge")) {
        const isBridgeStatusGet =
          path === "/bridge/status" && req.method === "GET";
        const isBridgeHitlPendingGet =
          path === "/bridge/hitl/pending" && req.method === "GET";
        if (
          req.method !== "POST" &&
          req.method !== "DELETE" &&
          !isBridgeStatusGet &&
          !isBridgeHitlPendingGet
        ) {
          return writeJson(res, 405, {
            ok: false,
            error: "Method Not Allowed",
          });
        }

        try {
          const body = req.method === "POST" ? await parseBody(req) : {};
          const requestUrl = new URL(req.url || path, "http://127.0.0.1");

          if (path === "/bridge/status" && req.method === "GET") {
            const scope = requestUrl.searchParams.get("scope") || "hub";
            const include_metrics =
              requestUrl.searchParams.get("include_metrics") !== "0";
            const agent_id =
              requestUrl.searchParams.get("agent_id") || undefined;
            const trace_id =
              requestUrl.searchParams.get("trace_id") || undefined;
            const result = await pipe.executeQuery("status", {
              scope,
              include_metrics,
              agent_id,
              trace_id,
            });
            return writeJson(res, 200, result);
          }

          if (path === "/bridge/hitl/pending" && req.method === "GET") {
            const result = { ok: true, data: hitl.getPendingRequests() };
            return writeJson(res, result.ok ? 200 : 400, result);
          }

          if (path === "/bridge/register" && req.method === "POST") {
            const {
              agent_id,
              cli,
              timeout_sec = 600,
              topics = [],
              capabilities = [],
              metadata = {},
            } = body;
            if (!agent_id || !cli) {
              return writeJson(res, 400, {
                ok: false,
                error: "agent_id, cli 필수",
              });
            }

            const heartbeat_ttl_ms = (timeout_sec + 120) * 1000;
            const result = await pipe.executeCommand("register", {
              agent_id,
              cli,
              capabilities,
              topics,
              heartbeat_ttl_ms,
              metadata,
            });
            return writeJson(res, 200, result);
          }

          if (path === "/bridge/result" && req.method === "POST") {
            const {
              agent_id,
              topic = "task.result",
              payload = {},
              trace_id,
              correlation_id,
            } = body;
            if (!agent_id) {
              return writeJson(res, 400, { ok: false, error: "agent_id 필수" });
            }

            const result = await pipe.executeCommand("result", {
              agent_id,
              topic,
              payload,
              trace_id,
              correlation_id,
            });
            return writeJson(res, 200, result);
          }

          if (path === "/bridge/control" && req.method === "POST") {
            const {
              from_agent = "lead",
              to_agent,
              command,
              reason = "",
              payload = {},
              trace_id,
              correlation_id,
              ttl_ms = 3600000,
            } = body;

            if (!to_agent || !command) {
              return writeJson(res, 400, {
                ok: false,
                error: "to_agent, command 필수",
              });
            }

            const result = await pipe.executeCommand("control", {
              from_agent,
              to_agent,
              command,
              reason,
              payload,
              ttl_ms,
              trace_id,
              correlation_id,
            });

            return writeJson(res, 200, result);
          }

          if (path === "/bridge/handoff" && req.method === "POST") {
            const result = router.handleHandoff(normalizeHandoffBody(body));
            return writeJson(res, result.ok ? 200 : 400, result);
          }

          if (path === "/bridge/publish" && req.method === "POST") {
            const result = router.handlePublish(normalizePublishBody(body));
            return writeJson(res, result.ok ? 200 : 400, result);
          }

          if (path === "/bridge/send-input" && req.method === "POST") {
            const { session_id, text } = body;
            if (!session_id || typeof text !== "string" || text.length === 0) {
              return writeJson(res, 400, {
                ok: false,
                error: "session_id, text 필수",
              });
            }

            const result = await pipe.executeCommand("send_input", {
              session_id,
              text,
            });
            return writeJson(res, resolveSendInputStatusCode(result), result);
          }

          if (path === "/bridge/status" && req.method === "POST") {
            const {
              scope = "hub",
              agent_id,
              status,
              include_metrics = true,
              trace_id,
            } = body;

            if (agent_id && status) {
              const normalizedAgentId = String(agent_id || "").trim();
              const normalizedStatus = String(status || "")
                .trim()
                .toLowerCase();
              if (!normalizedAgentId || !normalizedStatus) {
                return writeJson(res, 400, {
                  ok: false,
                  error: "agent_id, status 필수",
                });
              }
              const statusForStore = new Set([
                "online",
                "stale",
                "offline",
              ]).has(normalizedStatus)
                ? normalizedStatus
                : "online";
              router.updateAgentStatus(normalizedAgentId, statusForStore);
              const snapshot = await pipe.executeQuery("status", {
                scope: "agent",
                agent_id: normalizedAgentId,
                include_metrics: false,
              });
              return writeJson(res, 200, {
                ok: true,
                data: {
                  agent_id: normalizedAgentId,
                  status: statusForStore,
                  reported_status: normalizedStatus,
                  reported_at_ms: Date.now(),
                  snapshot: snapshot?.data?.agent || null,
                },
              });
            }

            const result = await pipe.executeQuery("status", {
              scope,
              agent_id,
              include_metrics,
              trace_id,
            });
            return writeJson(res, 200, result);
          }

          if (path === "/bridge/assign/async" && req.method === "POST") {
            const {
              supervisor_agent,
              worker_agent,
              task,
              topic = "assign.job",
              payload = {},
              priority = 5,
              ttl_ms = 600000,
              timeout_ms = 600000,
              max_retries = 0,
              trace_id,
              correlation_id,
            } = body;

            if (!supervisor_agent || !worker_agent || !task) {
              return writeJson(res, 400, {
                ok: false,
                error: "supervisor_agent, worker_agent, task 필수",
              });
            }

            const result = await pipe.executeCommand("assign", {
              supervisor_agent,
              worker_agent,
              task,
              topic,
              payload,
              priority,
              ttl_ms,
              timeout_ms,
              max_retries,
              trace_id,
              correlation_id,
            });
            return writeJson(res, result.ok ? 200 : 400, result);
          }

          if (path === "/bridge/assign/result" && req.method === "POST") {
            const {
              job_id,
              worker_agent,
              status,
              attempt,
              result: assignResult,
              error: assignError,
              payload = {},
              metadata = {},
            } = body;

            if (!job_id || !status) {
              return writeJson(res, 400, {
                ok: false,
                error: "job_id, status 필수",
              });
            }

            const result = await pipe.executeCommand("assign_result", {
              job_id,
              worker_agent,
              status,
              attempt,
              result: assignResult,
              error: assignError,
              payload,
              metadata,
            });
            return writeJson(res, result.ok ? 200 : 409, result);
          }

          if (path === "/bridge/assign/status" && req.method === "POST") {
            const result = await pipe.executeQuery("assign_status", body);
            const statusCode = result.ok
              ? 200
              : result.error?.code === "ASSIGN_NOT_FOUND"
                ? 404
                : 400;
            return writeJson(res, statusCode, result);
          }

          if (path === "/bridge/assign/retry" && req.method === "POST") {
            const { job_id, reason, requested_by } = body;
            if (!job_id) {
              return writeJson(res, 400, { ok: false, error: "job_id 필수" });
            }

            const result = await pipe.executeCommand("assign_retry", {
              job_id,
              reason,
              requested_by,
            });
            const statusCode = result.ok
              ? 200
              : result.error?.code === "ASSIGN_NOT_FOUND"
                ? 404
                : result.error?.code === "ASSIGN_RETRY_EXHAUSTED"
                  ? 409
                  : 400;
            return writeJson(res, statusCode, result);
          }

          if (req.method === "POST") {
            let teamResult = null;
            if (path === "/bridge/team/info" || path === "/bridge/team-info") {
              teamResult = await pipe.executeQuery("team_info", body);
            } else if (
              path === "/bridge/team/task-list" ||
              path === "/bridge/team-task-list"
            ) {
              teamResult = await pipe.executeQuery("team_task_list", body);
            } else if (
              path === "/bridge/team/task-update" ||
              path === "/bridge/team-task-update"
            ) {
              teamResult = await pipe.executeCommand("team_task_update", body);
            } else if (
              path === "/bridge/team/send-message" ||
              path === "/bridge/team-send-message"
            ) {
              teamResult = await pipe.executeCommand("team_send_message", body);
            }

            if (teamResult) {
              return writeJson(
                res,
                resolveTeamStatusCode(teamResult),
                teamResult,
              );
            }

            if (path.startsWith("/bridge/team")) {
              return writeJson(res, 404, {
                ok: false,
                error: `Unknown team endpoint: ${path}`,
              });
            }

            // ── 파이프라인 엔드포인트 ──
            if (path === "/bridge/pipeline/state" && req.method === "POST") {
              const result = await pipe.executeQuery("pipeline_state", body);
              return writeJson(res, resolvePipelineStatusCode(result), result);
            }

            if (path === "/bridge/pipeline/advance" && req.method === "POST") {
              const result = await pipe.executeCommand(
                "pipeline_advance",
                body,
              );
              return writeJson(res, resolvePipelineStatusCode(result), result);
            }

            if (path === "/bridge/pipeline/init" && req.method === "POST") {
              const result = await pipe.executeCommand("pipeline_init", body);
              return writeJson(res, resolvePipelineStatusCode(result), result);
            }

            if (path === "/bridge/pipeline/list" && req.method === "POST") {
              const result = await pipe.executeQuery("pipeline_list", body);
              return writeJson(res, resolvePipelineStatusCode(result), result);
            }

            // ── Delegator 엔드포인트 ──
            if (
              path === "/bridge/delegator/delegate" &&
              req.method === "POST"
            ) {
              const result = await pipe.executeCommand(
                "delegator_delegate",
                body,
              );
              return writeJson(res, result.ok ? 200 : 400, result);
            }

            if (path === "/bridge/delegator/reply" && req.method === "POST") {
              const result = await pipe.executeCommand("delegator_reply", body);
              return writeJson(res, result.ok ? 200 : 400, result);
            }

            if (path === "/bridge/delegator/status" && req.method === "POST") {
              const result = await pipe.executeQuery("delegator_status", body);
              return writeJson(res, result.ok ? 200 : 400, result);
            }

            if (path === "/bridge/hitl/request" && req.method === "POST") {
              const result = hitl.requestHumanInput(body);
              return writeJson(res, result.ok ? 200 : 400, result);
            }

            if (path === "/bridge/hitl/submit" && req.method === "POST") {
              const result = hitl.submitHumanInput(body);
              return writeJson(res, result.ok ? 200 : 400, result);
            }
          }

          if (path === "/bridge/context" && req.method === "POST") {
            const {
              agent_id,
              topics,
              max_messages = 10,
              auto_ack = true,
            } = body;
            if (!agent_id) {
              return writeJson(res, 400, { ok: false, error: "agent_id 필수" });
            }

            const result = await pipe.executeQuery("drain", {
              agent_id,
              topics,
              max_messages,
              auto_ack,
            });
            return writeJson(res, 200, result);
          }

          if (path === "/bridge/deregister" && req.method === "POST") {
            const { agent_id } = body;
            if (!agent_id) {
              return writeJson(res, 400, { ok: false, error: "agent_id 필수" });
            }
            const result = await pipe.executeCommand("deregister", {
              agent_id,
            });
            return writeJson(res, 200, result);
          }

          return writeJson(res, 404, {
            ok: false,
            error: "Unknown bridge endpoint",
          });
        } catch (error) {
          if (!res.headersSent) {
            console.error("[tfx-hub] bridge error:", error);
            writeJson(res, 500, { ok: false, error: "Internal server error" });
          }
          return;
        }
      }

      if (req.method === "GET" && servePublicFile(res, path)) {
        return;
      }

      if (path !== "/mcp") {
        res.writeHead(404);
        return res.end("Not Found");
      }

      try {
        const sessionIdHeader = req.headers["mcp-session-id"];

        if (req.method === "POST") {
          const body = await parseBody(req);

          if (sessionIdHeader && transports.has(sessionIdHeader)) {
            const session = transports.get(sessionIdHeader);
            session.transport._lastActivity = Date.now();
            await session.transport.handleRequest(req, res, body);
          } else if (!sessionIdHeader && isInitializeRequest(body)) {
            const transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (sid) => {
                transport._lastActivity = Date.now();
                transports.set(sid, { transport, mcp });
              },
            });
            transport.onclose = () => {
              if (transport.sessionId) {
                const session = transports.get(transport.sessionId);
                if (session) {
                  try {
                    session.mcp.close();
                  } catch {}
                }
                transports.delete(transport.sessionId);
              }
            };
            const mcp = createMcpForSession();
            await mcp.connect(transport);
            await transport.handleRequest(req, res, body);
          } else {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                error: {
                  code: -32000,
                  message: "Bad Request: No valid session ID",
                },
                id: null,
              }),
            );
          }
        } else if (req.method === "GET") {
          if (sessionIdHeader && transports.has(sessionIdHeader)) {
            await transports
              .get(sessionIdHeader)
              .transport.handleRequest(req, res);
          } else {
            res.writeHead(400);
            res.end("Invalid or missing session ID");
          }
        } else if (req.method === "DELETE") {
          if (sessionIdHeader && transports.has(sessionIdHeader)) {
            await transports
              .get(sessionIdHeader)
              .transport.handleRequest(req, res);
          } else {
            res.writeHead(400);
            res.end("Invalid or missing session ID");
          }
        } else {
          res.writeHead(405);
          res.end("Method Not Allowed");
        }
      } catch (error) {
        hubLog.error({ err: error }, "http.error");
        if (!res.headersSent) {
          const code =
            error.statusCode === 413
              ? 413
              : error instanceof SyntaxError
                ? 400
                : 500;
          const message =
            code === 413
              ? "Body too large"
              : code === 400
                ? "Invalid JSON"
                : "Internal server error";
          res.writeHead(code, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: code === 500 ? -32603 : -32700, message },
              id: null,
            }),
          );
        }
      }
    }),
  );

  httpServer.requestTimeout = 30000;
  httpServer.headersTimeout = 10000;

  router.startSweeper();

  const hitlTimer = setInterval(() => {
    try {
      hitl.checkTimeouts();
    } catch (err) {
      hubLog.warn({ err }, "hitl.timeout_check_failed");
    }
  }, 10000);
  hitlTimer.unref();

  // MCP session TTL: sessions idle for SESSION_TTL_MS are closed automatically.
  // Configurable via SESSION_TTL_MS (default 30 minutes). The sweep runs every 60 s.
  const SESSION_TTL_MS =
    parseInt(process.env.TFX_SESSION_TTL_MS || "", 10) || 30 * 60 * 1000;
  const sessionTimer = setInterval(() => {
    const now = Date.now();
    for (const [sid, session] of transports) {
      if (now - (session.transport._lastActivity || 0) <= SESSION_TTL_MS)
        continue;
      try {
        session.mcp.close();
      } catch {}
      try {
        session.transport.close();
      } catch {}
      transports.delete(sid);
    }
  }, 60000);
  sessionTimer.unref();

  // 고아 node.exe 프로세스 + stale spawn 세션 주기적 정리 (5분마다)
  const orphanCleanupTimer = setInterval(
    () => {
      try {
        const { killed } = cleanupOrphanNodeProcesses();
        if (killed > 0) {
          hubLog.info({ killed }, "hub.orphan_cleanup");
        }
      } catch {}

      // stale tfx-spawn-* psmux 세션 정리 (30분 이상 idle)
      try {
        const staleKilled = cleanupStaleSpawnSessions(hubLog);
        if (staleKilled > 0) {
          hubLog.info({ killed: staleKilled }, "hub.stale_spawn_cleanup");
        }
      } catch {}
    },
    5 * 60 * 1000,
  );
  orphanCleanupTimer.unref();

  // Evict stale rate-limit buckets once per minute to bound memory usage.
  const rateLimitTimer = setInterval(() => {
    const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
    for (const [ip, timestamps] of rateLimitMap) {
      const fresh = timestamps.filter((t) => t >= cutoff);
      if (fresh.length === 0) {
        rateLimitMap.delete(ip);
      } else {
        rateLimitMap.set(ip, fresh);
      }
    }
  }, RATE_LIMIT_WINDOW_MS);
  rateLimitTimer.unref();

  mkdirSync(PID_DIR, { recursive: true });

  // Stale PID 파일 정리 — 이전 Hub 프로세스가 비정상 종료된 경우
  if (existsSync(PID_FILE)) {
    try {
      const prevInfo = JSON.parse(readFileSync(PID_FILE, "utf8"));
      const prevPid = Number(prevInfo?.pid);
      if (Number.isFinite(prevPid) && prevPid > 0) {
        try {
          process.kill(prevPid, 0); // alive 체크만
          // 프로세스가 살아있으면 포트 충돌 가능성 — 기존 Hub 재사용 안내
          if (Number(prevInfo.port) === Number(port)) {
            hubLog.warn(
              { prevPid, port },
              "hub.stale_pid: previous hub still alive on same port",
            );
          }
        } catch {
          // 프로세스 죽음 → stale PID 파일 삭제
          try {
            unlinkSync(PID_FILE);
          } catch {}
          hubLog.info({ prevPid }, "hub.stale_pid_cleaned");
        }
      } else {
        try {
          unlinkSync(PID_FILE);
        } catch {}
      }
    } catch {
      try {
        unlinkSync(PID_FILE);
      } catch {}
    }
  }

  const cleanupStartupFailure = async () => {
    try {
      router.stopSweeper();
    } catch {}
    try {
      await pipe.stop();
    } catch {}
    try {
      await assignCallbacks.stop();
    } catch {}
    try {
      await delegatorWorker.stop();
    } catch {}
    try {
      store.close();
    } catch {}
    try {
      unlinkSync(TOKEN_FILE);
    } catch {}
    releaseStartupLock();
  };

  try {
    await pipe.start();
    await assignCallbacks.start();
  } catch (error) {
    await cleanupStartupFailure();
    throw error;
  }

  return await new Promise((resolveHub, reject) => {
    httpServer.listen(port, host, () => {
      try {
        let idleTimer = null;
        let stopPromise = null;

        const info = {
          port,
          host,
          dbPath,
          pid: process.pid,
          hubToken: HUB_TOKEN,
          authMode: HUB_TOKEN ? "token-required" : "localhost-only",
          url: buildHubUrl(host, port),
          pipe_path: pipe.path,
          pipePath: pipe.path,
          assign_callback_pipe_path: assignCallbacks.path,
          assignCallbackPipePath: assignCallbacks.path,
          version,
          storeType: store.type || "sqlite",
          idleTimeoutMs: hubIdleTimeoutMs,
        };

        writeState({
          pid: process.pid,
          port,
          host,
          auth_mode: HUB_TOKEN ? "token-required" : "localhost-only",
          url: info.url,
          pipe_path: pipe.path,
          pipePath: pipe.path,
          assign_callback_pipe_path: assignCallbacks.path,
          assignCallbackPipePath: assignCallbacks.path,
          authMode: HUB_TOKEN ? "token-required" : "localhost-only",
          startedAt,
          started: startedAtMs,
          version,
          sessionId,
          session_id: sessionId,
        });
        releaseStartupLock();

        hubLog.info(
          {
            url: info.url,
            pipePath: pipe.path,
            assignCallbackPath: assignCallbacks.path,
            pid: process.pid,
            storeType: info.storeType,
            version,
          },
          "hub.started",
        );
        hubLog.debug(
          {
            publicDir: PUBLIC_DIR,
            exists: existsSync(PUBLIC_DIR),
            hasDashboard: existsSync(resolve(PUBLIC_DIR, "dashboard.html")),
          },
          "hub.public_dir",
        );

        /**
         * Hub 서버 정지 함수.
         *
         * Trade-off (F01 — 영구 poisoning 허용):
         * 첫 정지 호출에서 cleanup 파이프라인이 실패하면 stopPromise는 실패 상태로
         * 고정되고, 이후 모든 호출은 동일한 실패 promise를 반환합니다. stopPromise를
         * null로 리셋하면 재시도가 가능하지만, router sweeper / transports / pipe 등이
         * 이미 부분 해제된 상태에서 두 번째 close가 실행되면 use-after-close 및
         * race condition을 유발합니다. 실패한 stopFn은 프로세스 전체 재시작으로 복구해야
         * 하며, 이 동작은 의도된 설계입니다.
         */
        const stopFn = async () => {
          if (stopPromise) return stopPromise;

          stopPromise = (async () => {
            router.stopSweeper();
            clearInterval(hitlTimer);
            clearInterval(sessionTimer);
            clearInterval(rateLimitTimer);
            clearInterval(orphanCleanupTimer);
            if (idleTimer) {
              clearInterval(idleTimer);
            }
            for (const [, session] of transports) {
              try {
                await session.mcp.close();
              } catch {}
              try {
                await session.transport.close();
              } catch {}
            }
            transports.clear();
            await pipe.stop();
            await assignCallbacks.stop();
            await delegatorWorker.stop().catch(() => {});
            try { synapseRegistry.destroy(); } catch {}
            store.close();
            try {
              unlinkSync(PID_FILE);
            } catch {}
            try {
              unlinkSync(TOKEN_FILE);
            } catch {}
            httpServer.closeAllConnections();
            await new Promise((resolveClose) => httpServer.close(resolveClose));
          })().catch((error) => {
            hubLog.error({ err: String(error?.message || error) }, "hub.stop_error");
            // stopPromise를 null로 리셋하지 않음 — double-close 방지
          });

          return stopPromise;
        };

        idleTimer = setInterval(() => {
          const idleMs = Date.now() - lastRequestAt;
          if (idleMs < hubIdleTimeoutMs) return;
          hubLog.warn(
            { idleMs, idleTimeoutMs: hubIdleTimeoutMs, port },
            "hub.idle_timeout_shutdown",
          );
          void stopFn().catch((error) => {
            hubLog.error(
              { err: error, idleMs, idleTimeoutMs: hubIdleTimeoutMs, port },
              "hub.idle_timeout_shutdown_failed",
            );
          });
        }, hubIdleSweepMs);
        idleTimer.unref();

        resolveHub({
          reused: false,
          external: false,
          ...info,
          httpServer,
          store,
          router,
          hitl,
          pipe,
          assignCallbacks,
          delegatorService,
          delegatorWorker,
          stop: stopFn,
        });
      } catch (error) {
        void cleanupStartupFailure().finally(() => reject(error));
      }
    });
    httpServer.on("error", (err) => {
      void cleanupStartupFailure();
      if (err.code === "EADDRINUSE") {
        hubLog.error(
          { port, host },
          "hub.port_in_use: port already occupied — check for existing hub or other service",
        );
        const wrapped = new Error(
          `Hub 포트 ${port}이(가) 이미 사용 중입니다. 기존 Hub 프로세스를 확인하세요. (PID file: ${PID_FILE})`,
        );
        wrapped.code = "EADDRINUSE";
        reject(wrapped);
      } else {
        reject(err);
      }
    });
  });
}

export function getHubInfo() {
  return readState();
}

/**
 * MCP 서버 싱글톤 팩토리 — 이미 실행 중인 서버가 있으면 재사용하고,
 * 없거나 응답하지 않으면 새로 startHub()를 호출합니다.
 *
 * @param {object} [opts] - startHub()에 전달할 옵션 (port, dbPath, host, sessionId 등)
 * @param {object} [opts._deps] - 테스트용 의존성 주입 (isHealthy, getInfo, readState, startHub)
 * @returns {Promise<{reused: boolean, port: number, pid: number, url: string, stop?: Function}>}
 */
export async function getOrCreateServer(opts = {}) {
  const { _deps, ...startOpts } = opts;
  const existingHub = await tryReuseExistingHub({
    port: startOpts.port,
    host: startOpts.host,
    checkHealth: _deps?.isHealthy ?? isServerHealthy,
    readInfo: _deps?.getInfo ?? getHubInfo,
    readCurrentState: _deps?.readState ?? readState,
  });
  const boot = _deps?.startHub ?? startHub;

  if (existingHub) return existingHub;

  const server = await boot(startOpts);
  return server.reused === true ? server : { reused: false, ...server };
}

/**
 * stale tfx-spawn-* psmux 세션을 감지하고 정리한다.
 * 30분 이상 경과 + pane이 idle 쉘 프롬프트만 표시 → kill.
 * @param {object} [log] logger (optional)
 * @returns {number} killed session count
 */
function cleanupStaleSpawnSessions(log) {
  const MAX_AGE_MS = 30 * 60 * 1000;
  const IDLE_PROMPT_RE =
    /^(PS\s|[$%>#]\s*$|\w+@[\w.-]+[:\s]|╰─|╭─|[fb]wd-i-search:|client_loop:\s|Connection\s+(reset|closed))/;
  const execOpts = {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };

  let killed = 0;
  let raw;
  try {
    raw = execSyncHub("psmux list-sessions", execOpts);
  } catch {
    return 0; // psmux 없거나 실패
  }

  const now = Date.now();
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(
      /^(tfx-spawn-[^:]+):\s+\d+\s+windows?\s+\(created\s+(.+)\)/,
    );
    if (!match) continue;

    const [, sessionName, createdStr] = match;
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionName)) continue; // shell injection 방지
    const created = new Date(createdStr).getTime();
    if (!Number.isFinite(created) || now - created < MAX_AGE_MS) continue;

    // pane 내용 확인 — 마지막 3줄 중 idle 쉘 프롬프트가 있는지
    try {
      const pane = execSyncHub(
        `psmux capture-pane -t "${sessionName}:0.0" -p`,
        execOpts,
      );
      const tailLines = pane
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .slice(-3);
      const hasIdleLine = tailLines.some((l) => IDLE_PROMPT_RE.test(l.trim()));
      if (!hasIdleLine) continue; // 아직 활성 — 건드리지 않음
    } catch {
      continue; // pane 접근 실패 — 건드리지 않음
    }

    // stale + idle → 정리
    try {
      execSyncHub(`psmux kill-session -t "${sessionName}"`, execOpts);
      killed++;
      if (log)
        log.info(
          { session: sessionName, ageMin: Math.round((now - created) / 60000) },
          "hub.stale_spawn_killed",
        );
    } catch {}
  }

  return killed;
}

// ── Quota check for all accounts ───────────────────────────────

const QUOTA_CACHE_PATH = join(CACHE_DIR, "broker-quota-cache.json");

async function checkSingleAccountQuota(acct) {
  try {
    const authPath = join(PID_DIR, acct.authFile);
    if (!existsSync(authPath)) return { id: acct.id, status: "no_auth" };
    const auth = JSON.parse(readFileSync(authPath, "utf8"));
    if (acct.provider === "codex") {
      const token = auth.tokens?.access_token || auth.OPENAI_API_KEY || "";
      if (!token) return { id: acct.id, status: "no_token" };
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST", signal: AbortSignal.timeout(8000),
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4.1-nano", messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
      });
      const hdrs = Object.fromEntries([...r.headers.entries()].filter(([k]) => /ratelimit/i.test(k)));
      if (r.status === 429) return { id: acct.id, status: "quota_hit", http: 429, headers: hdrs };
      if (r.status === 401) {
        // 401이어도 ratelimit 헤더가 있으면 쿼터 정보 추출 가능
        return { id: acct.id, status: "auth_error", http: 401, headers: hdrs };
      }
      return { id: acct.id, status: r.ok ? "ok" : "error", http: r.status, headers: hdrs };
    }
    // gemini — OAuth token refresh needed for accurate check
    return { id: acct.id, status: "oauth_check_needed" };
  } catch (e) {
    return { id: acct.id, status: "error", message: e.message?.substring(0, 60) };
  }
}

async function refreshAllAccountQuotas() {
  const snap = brokerInstance?.snapshot() || [];
  const checks = snap.filter(a => a.authFile).map(a => checkSingleAccountQuota(a));
  const settled = await Promise.allSettled(checks);
  const results = settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : { id: snap.filter(a => a.authFile)[i]?.id ?? "unknown", status: "error", message: String(s.reason?.message || s.reason).substring(0, 60) },
  );
  // 캐시 저장
  try {
    writeFileSync(QUOTA_CACHE_PATH, JSON.stringify({ ts: Date.now(), results }));
  } catch { /* best-effort */ }
  return results;
}

function loadQuotaCache() {
  try {
    if (!existsSync(QUOTA_CACHE_PATH)) return null;
    return JSON.parse(readFileSync(QUOTA_CACHE_PATH, "utf8"));
  } catch { return null; }
}

// ── Broker Dashboard HTML ──────────────────────────────────────

function renderBrokerDashboard() {
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">
<title>Account Broker Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0b;color:#e8e8ec;font:14px/1.6 'SF Mono',Consolas,monospace;padding:24px}
h1{font-size:18px;color:#a8b1ff;margin-bottom:8px}
.toolbar{margin-bottom:16px;display:flex;gap:8px;align-items:center}
.toolbar button{background:#1a1a2e;color:#a8b1ff;border:1px solid rgba(255,255,255,0.1);border-radius:4px;padding:4px 12px;cursor:pointer;font:12px inherit}
.toolbar button:hover{background:#252547}
.toolbar .status-text{font-size:11px;color:#555}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:12px}
.card{background:#141416;border:1px solid rgba(255,255,255,0.06);border-radius:8px;padding:16px}
.card.available{border-left:3px solid #34d399}
.card.busy{border-left:3px solid #fbbf24}
.card.cooldown{border-left:3px solid #f87171}
.card.circuit-open{border-left:3px solid #ef4444;opacity:0.7}
.provider{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#888}
.id{font-size:13px;color:#c8c8d0;margin:4px 0}
.status{font-size:12px;font-weight:600;padding:2px 8px;border-radius:4px;display:inline-block}
.status.available{background:#064e3b;color:#34d399}
.status.busy{background:#451a03;color:#fbbf24}
.status.cooldown{background:#450a0a;color:#f87171}
.status.circuit-open{background:#450a0a;color:#ef4444}
.gauge{margin-top:8px}
.gauge-row{display:flex;align-items:center;gap:8px;margin:3px 0}
.gauge-label{font-size:10px;color:#888;width:28px;text-align:right}
.gauge-bar{flex:1;height:8px;background:#1a1a1e;border-radius:4px;overflow:hidden}
.gauge-fill{height:100%;border-radius:4px;transition:width .3s}
.gauge-fill.green{background:linear-gradient(90deg,#34d399,#059669)}
.gauge-fill.yellow{background:linear-gradient(90deg,#fbbf24,#d97706)}
.gauge-fill.red{background:linear-gradient(90deg,#f87171,#dc2626)}
.gauge-pct{font-size:10px;color:#999;width:32px}
.gauge-reset{font-size:9px;color:#555}
.meta{margin-top:6px;font-size:11px;color:#666;line-height:1.8}
.meta b{color:#999}
.timer{color:#f87171;font-weight:600}
.refresh-bar{color:#555;font-size:11px;margin-top:16px}
</style></head><body>
<h1>Account Broker Dashboard</h1>
<div class="toolbar">
  <button onclick="checkQuotas()">Check All Quotas</button>
  <button onclick="reloadBroker()">Reload Broker</button>
  <span id="toolbar-status" class="status-text"></span>
</div>
<div id="grid" class="grid"></div>
<p class="refresh-bar">auto-refresh: 10s | <a href="/broker/snapshot" style="color:#666">JSON</a> | <a href="/broker/quota-refresh" style="color:#666">Quota API</a></p>
<script>
let quotaData={};
function fmt(ms){if(ms<=0)return'-';const s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60),d=Math.floor(h/24);if(d>0)return d+'d '+h%24+'h';if(h>0)return h+'h '+m%60+'m';if(m>0)return m+'m '+s%60+'s';return s+'s'}

function gaugeColor(pct){return pct<60?'green':pct<85?'yellow':'red'}

function renderGauge(label,pct,resetTs){
  if(pct==null)return '';
  const now=Date.now()/1000;
  const resetIn=resetTs>now?fmt((resetTs-now)*1000):'';
  return '<div class="gauge-row"><span class="gauge-label">'+label+'</span>'+
    '<div class="gauge-bar"><div class="gauge-fill '+gaugeColor(pct)+'" style="width:'+pct+'%"></div></div>'+
    '<span class="gauge-pct">'+pct+'%</span>'+
    (resetIn?'<span class="gauge-reset">reset '+resetIn+'</span>':'')+
    '</div>';
}

function renderQuotaGauges(acctId){
  const q=quotaData[acctId];
  if(!q)return '<div class="gauge"><div class="gauge-row"><span style="font-size:10px;color:#444">quota: click Check All Quotas</span></div></div>';
  if(q.status==='quota_hit')return '<div class="gauge"><div class="gauge-row"><span style="font-size:10px;color:#f87171">QUOTA EXHAUSTED</span></div></div>';
  if(q.status==='auth_error'||q.status==='no_token'||q.status==='oauth_check_needed'){
    // 401이어도 ratelimit 헤더가 있으면 표시
    const h=q.headers||{};
    const limReq=h['x-ratelimit-limit-requests'],remReq=h['x-ratelimit-remaining-requests'];
    const limTok=h['x-ratelimit-limit-tokens'],remTok=h['x-ratelimit-remaining-tokens'];
    if(limReq){
      const pctReq=Math.round((1-remReq/limReq)*100);
      const pctTok=limTok?Math.round((1-remTok/limTok)*100):null;
      return '<div class="gauge">'+renderGauge('req',pctReq,0)+(pctTok!=null?renderGauge('tok',pctTok,0):'')+'</div>';
    }
    return '<div class="gauge"><div class="gauge-row"><span style="font-size:10px;color:#fbbf24">'+(q.status==='oauth_check_needed'?'OAuth refresh needed':'auth: token refresh needed')+'</span></div></div>';
  }
  if(q.status==='ok'||q.status==='error'){
    const h=q.headers||{};
    const limReq=h['x-ratelimit-limit-requests'],remReq=h['x-ratelimit-remaining-requests'];
    const limTok=h['x-ratelimit-limit-tokens'],remTok=h['x-ratelimit-remaining-tokens'];
    const resetReq=h['x-ratelimit-reset-requests'],resetTok=h['x-ratelimit-reset-tokens'];
    if(!limReq)return '';
    const pctReq=Math.round((1-remReq/limReq)*100);
    const pctTok=limTok?Math.round((1-remTok/limTok)*100):null;
    return '<div class="gauge">'+renderGauge('req',pctReq,0)+(pctTok!=null?renderGauge('tok',pctTok,0):'')+'</div>';
  }
  return '';
}

async function refresh(){
  try{
    const r=await fetch('/broker/snapshot');
    const d=await r.json();
    if(!d.ok)return;
    const now=d.ts;
    const grid=document.getElementById('grid');
    grid.innerHTML=d.accounts.map(a=>{
      const cd=a.cooldownUntil>now?a.cooldownUntil-now:0;
      const rm=a.remainingMs||0;
      let st='available',sl='Available';
      if(a.circuitState==='open'){st='circuit-open';sl='Circuit Open'}
      else if(cd>0){st='cooldown';sl='Cooldown'}
      else if(a.busy){st='busy';sl='Busy ('+fmt(rm)+')'}
      return '<div class="card '+st+'">'+
        '<div class="provider">'+a.provider+' / '+(a.tier||'unknown')+'</div>'+
        '<div class="id">'+a.id+'</div>'+
        '<span class="status '+st+'">'+sl+'</span>'+
        (cd>0?'<span class="timer" style="margin-left:8px">'+fmt(cd)+' remaining</span>':'')+
        renderQuotaGauges(a.id)+
        '<div class="meta">'+
        '<b>Sessions:</b> '+a.totalSessions+
        (a.lastUsedAt?' | <b>Last:</b> '+new Date(a.lastUsedAt).toLocaleTimeString():'')+
        (a.failureTimestamps?.length?' | <b>Failures:</b> '+a.failureTimestamps.length:'')+
        (a.circuitState!=='closed'?' | <b>Circuit:</b> '+a.circuitState:'')+
        '</div></div>'
    }).join('');
  }catch(e){console.error('refresh failed',e)}
}

async function checkQuotas(){
  const el=document.getElementById('toolbar-status');
  el.textContent='checking quotas...';
  try{
    const r=await fetch('/broker/quota-refresh',{method:'POST'});
    const d=await r.json();
    if(d.ok){
      d.results.forEach(q=>{quotaData[q.id]=q});
      el.textContent='updated '+d.results.length+' accounts ('+new Date().toLocaleTimeString()+')';
      refresh();
    }else{el.textContent='error';}
  }catch(e){el.textContent='failed: '+e.message;}
}

async function reloadBroker(){
  await fetch('/broker/reload',{method:'POST'});
  document.getElementById('toolbar-status').textContent='broker reloaded';
  refresh();
}

// 캐시에서 초기 로드
fetch('/broker/quota-refresh').catch(()=>{});
refresh();setInterval(refresh,10000);
</script></body></html>`;
}

const selfRun = process.argv[1]?.replace(/\\/g, "/").endsWith("hub/server.mjs");
if (selfRun) {
  const port = parseInt(process.env.TFX_HUB_PORT || "27888", 10);
  const dbPath = process.env.TFX_HUB_DB || undefined;

  const cleanupPidFile = () => {
    try {
      unlinkSync(PID_FILE);
    } catch {}
  };

  process.on("unhandledRejection", (err) => {
    hubLog.fatal({ err }, "hub.unhandledRejection");
    cleanupPidFile();
    process.exit(1);
  });
  process.on("uncaughtException", (err) => {
    hubLog.fatal({ err }, "hub.uncaughtException");
    cleanupPidFile();
    process.exit(1);
  });

  startHub({ port, dbPath })
    .then((info) => {
      const shutdown = async (signal) => {
        hubLog.info({ signal }, "hub.stopping");
        try {
          cleanupOrphanNodeProcesses();
        } catch {}
        try {
          cleanupStaleSpawnSessions(hubLog);
        } catch {}
        await info.stop();
        process.exit(0);
      };
      process.on("SIGINT", () => shutdown("SIGINT"));
      process.on("SIGTERM", () => shutdown("SIGTERM"));
    })
    .catch((error) => {
      hubLog.fatal({ err: error }, "hub.start_failed");
      cleanupPidFile();
      process.exit(1);
    });
}

export { startHub as createServer };
