// hub/server.mjs — HTTP MCP + REST bridge + Named Pipe 서버 진입점
import { createServer as createHttpServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { extname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { writeFileSync, unlinkSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execSync as execSyncHub } from 'node:child_process';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { createStoreAdapter } from './store-adapter.mjs';
import { createRouter } from './router.mjs';
import { createHitlManager } from './hitl.mjs';
import { createPipeServer } from './pipe.mjs';
import { createAssignCallbackServer } from './assign-callbacks.mjs';
import { createTools } from './tools.mjs';
import { DelegatorService } from './delegator/index.mjs';
import { createDelegatorMcpWorker } from './workers/delegator-mcp.mjs';
import { cleanupOrphanNodeProcesses } from './lib/process-utils.mjs';
import { createModuleLogger } from '../scripts/lib/logger.mjs';
import { wrapRequestHandler } from './middleware/request-logger.mjs';
import { acquireLock, getVersionHash, releaseLock, writeState } from './state.mjs';

const hubLog = createModuleLogger('hub');

const MAX_BODY_SIZE = 1024 * 1024;
const PUBLIC_PATHS = new Set(['/', '/status', '/health', '/healthz']);
const RATE_LIMIT_MAX = 100;       // requests per window
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute sliding window
const LOOPBACK_REMOTE_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const ALLOWED_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_DIR = resolve(join(PROJECT_ROOT, 'hub', 'public'));
const CACHE_DIR = join(homedir(), '.claude', 'cache');
const BATCH_EVENTS_PATH = join(CACHE_DIR, 'batch-events.jsonl');
const SV_ACCUMULATOR_PATH = join(CACHE_DIR, 'sv-accumulator.json');
const CODEX_RATE_LIMITS_CACHE_PATH = join(CACHE_DIR, 'codex-rate-limits-cache.json');
const GEMINI_QUOTA_CACHE_PATH = join(CACHE_DIR, 'gemini-quota-cache.json');
const CLAUDE_USAGE_CACHE_PATH = join(CACHE_DIR, 'claude-usage-cache.json');
const AIMD_WINDOW_MS = 30 * 60 * 1000;
const AIMD_INITIAL_BATCH_SIZE = 3;
const AIMD_MIN_BATCH_SIZE = 1;
const AIMD_MAX_BATCH_SIZE = 10;
const HUB_IDLE_TIMEOUT_DEFAULT_MS = 10 * 60 * 1000;
const HUB_IDLE_SWEEP_DEFAULT_MS = 60 * 1000;
const STATIC_CONTENT_TYPES = Object.freeze({
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.png': 'image/png',
});

// IP-based sliding window rate limiter (in-memory, no external deps)
// Each entry is an array of request timestamps within the current window.
const rateLimitMap = new Map();

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
  if (body?.method === 'initialize') return true;
  if (Array.isArray(body)) return body.some((message) => message.method === 'initialize');
  return false;
}

async function parseBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_SIZE) {
      throw Object.assign(new Error('Body too large'), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

const PID_DIR = join(homedir(), '.claude', 'cache', 'tfx-hub');
const PID_FILE = join(PID_DIR, 'hub.pid');
const TOKEN_FILE = join(homedir(), '.claude', '.tfx-hub-token');

function isPublicPath(path) {
  return PUBLIC_PATHS.has(path)
    || path === '/dashboard'
    || path === '/api/qos-stats'
    || path.startsWith('/public/');
}

function isAllowedOrigin(origin) {
  return origin && ALLOWED_ORIGIN_RE.test(origin);
}

function getRequestPath(url = '/') {
  try {
    return new URL(url, 'http://127.0.0.1').pathname;
  } catch {
    return String(url).replace(/\?.*/, '') || '/';
  }
}

function isLoopbackRemoteAddress(remoteAddress) {
  return typeof remoteAddress === 'string' && LOOPBACK_REMOTE_ADDRESSES.has(remoteAddress);
}

function extractBearerToken(req) {
  const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
}

function writeJson(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function applyCorsHeaders(req, res) {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  if (origin) {
    res.setHeader('Vary', 'Origin');
  }
  if (!isAllowedOrigin(origin)) return false;

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id, Last-Event-ID');
  return true;
}

function safeTokenCompare(a, b) {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
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
  if (code === 'TEAM_NOT_FOUND' || code === 'TASK_NOT_FOUND' || code === 'TASKS_DIR_NOT_FOUND') return 404;
  if (code === 'CLAIM_CONFLICT' || code === 'MTIME_CONFLICT') return 409;
  if (code === 'INVALID_TEAM_NAME' || code === 'INVALID_TASK_ID' || code === 'INVALID_TEXT' || code === 'INVALID_FROM' || code === 'INVALID_STATUS') return 400;
  return 500;
}

function resolvePipelineStatusCode(result) {
  if (result?.ok) return 200;
  if (result?.error === 'pipeline_not_found') return 404;
  if (result?.error === 'hub_db_not_found') return 503;
  return 400;
}

function safeReadJsonFile(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readRecentAimdEvents(now = Date.now()) {
  try {
    if (!existsSync(BATCH_EVENTS_PATH)) return [];
    const cutoff = now - AIMD_WINDOW_MS;
    return readFileSync(BATCH_EVENTS_PATH, 'utf8')
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
    if (result === 'success' || result === 'success_with_warnings') {
      batchSize = Math.min(AIMD_MAX_BATCH_SIZE, batchSize + 1);
    } else if (result === 'failed' || result === 'timeout') {
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
  if (path === '/dashboard') {
    relativePath = 'dashboard.html';
  } else if (path.startsWith('/public/')) {
    relativePath = path.slice('/public/'.length);
  }

  if (!relativePath) return null;

  try {
    relativePath = decodeURIComponent(relativePath).replace(/^[/\\]+/, '');
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
    hubLog.warn({ filePath }, 'static.not_found');
    res.writeHead(404);
    res.end('Not Found (static file missing)');
    return true;
  }

  try {
    const body = readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': STATIC_CONTENT_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream',
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
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
  port = 27888,
  dbPath,
  host = '127.0.0.1',
  sessionId = process.pid,
  createDelegatorWorker = createDelegatorMcpWorker,
} = {}) {
  const hubIdleTimeoutMs = parsePositiveInt(process.env.TFX_HUB_IDLE_TIMEOUT_MS, HUB_IDLE_TIMEOUT_DEFAULT_MS);
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
    const hubCacheDir = join(homedir(), '.claude', 'cache', 'tfx-hub');
    mkdirSync(hubCacheDir, { recursive: true });
    dbPath = join(hubCacheDir, 'state.db');
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

  const HUB_TOKEN = process.env.TFX_HUB_TOKEN?.trim() || null;
  if (HUB_TOKEN) {
    mkdirSync(join(homedir(), '.claude'), { recursive: true });
    writeFileSync(TOKEN_FILE, HUB_TOKEN, { mode: 0o600 });
  } else {
    try { unlinkSync(TOKEN_FILE); } catch {}
  }

  const store = await createStoreAdapter(dbPath);
  const router = createRouter(store);

  // Delegator MCP resident service 초기화
  const delegatorWorker = createDelegatorWorker({ cwd: PROJECT_ROOT });
  try {
    await delegatorWorker.start();
  } catch (error) {
    releaseStartupLock();
    throw error;
  }
  const delegatorService = new DelegatorService({ worker: delegatorWorker });

  const pipe = createPipeServer({ router, store, sessionId, delegatorService });
  const assignCallbacks = createAssignCallbackServer({ store, sessionId });
  const hitl = createHitlManager(store, router);
  const tools = createTools(store, router, hitl, pipe);
  const transports = new Map();

  function createMcpForSession() {
    const mcp = new Server(
      { name: 'tfx-hub', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );

    mcp.setRequestHandler(
      ListToolsRequestSchema,
      async () => ({
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      }),
    );

    mcp.setRequestHandler(
      CallToolRequestSchema,
      async (request) => {
        const { name, arguments: args } = request.params;
        const tool = tools.find((candidate) => candidate.name === name);
        if (!tool) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code: 'UNKNOWN_TOOL', message: `도구 없음: ${name}` } }) }],
            isError: true,
          };
        }
        return tool.handler(args || {});
      },
    );

    return mcp;
  }

  const httpServer = createHttpServer(wrapRequestHandler(async (req, res) => {
    markRequestActivity();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    const path = getRequestPath(req.url);
    const corsAllowed = applyCorsHeaders(req, res);

    if (req.method === 'OPTIONS') {
      const localOnlyMode = !HUB_TOKEN;
      const isLoopbackRequest = isLoopbackRemoteAddress(req.socket.remoteAddress);
      res.writeHead(corsAllowed && (!localOnlyMode || isLoopbackRequest) ? 204 : 403);
      return res.end();
    }

    const clientIp = req.socket.remoteAddress || 'unknown';
    if (!isLoopbackRemoteAddress(clientIp)) {
      const rateCheck = checkRateLimit(clientIp);
      if (!rateCheck.allowed) {
        return writeJson(
          res,
          429,
          { ok: false, error: 'Too Many Requests' },
          { 'Retry-After': String(rateCheck.retryAfterSec) },
        );
      }
    }

    if (!isAuthorizedRequest(req, path, HUB_TOKEN)) {
      if (!HUB_TOKEN) {
        return writeJson(res, 403, { ok: false, error: 'Forbidden: localhost only' });
      }
      return writeJson(
        res,
        401,
        { ok: false, error: 'Unauthorized' },
        { 'WWW-Authenticate': 'Bearer realm="tfx-hub"' },
      );
    }

    if (path === '/' || path === '/status') {
      const status = router.getStatus('hub').data;
      return writeJson(res, 200, {
        ...status,
        sessions: transports.size,
        pid: process.pid,
        port,
        auth_mode: HUB_TOKEN ? 'token-required' : 'localhost-only',
        idle_timeout_ms: hubIdleTimeoutMs,
        last_request_at: new Date(lastRequestAt).toISOString(),
        pipe_path: pipe.path,
        pipe: pipe.getStatus(),
        assign_callback_pipe_path: assignCallbacks.path,
        assign_callback_pipe: assignCallbacks.getStatus(),
      });
    }

    if (path === '/health' || path === '/healthz') {
      const status = router.getStatus('hub').data;
      const healthy = status?.hub?.state === 'healthy';
      return writeJson(res, healthy ? 200 : 503, {
        ok: healthy,
        version,
        platform: process.platform,
        uptime_s: Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)),
        node: process.version,
        sessions: transports.size,
        store: store.type || 'sqlite',
        idle_timeout_ms: hubIdleTimeoutMs,
        idle_ms: Math.max(0, Date.now() - lastRequestAt),
      });
    }

    if (path === '/api/qos-stats' && req.method === 'GET') {
      return writeJson(res, 200, getQosStatsPayload());
    }

    if (path.startsWith('/bridge')) {
      if (req.method !== 'POST' && req.method !== 'DELETE') {
        return writeJson(res, 405, { ok: false, error: 'Method Not Allowed' });
      }

      try {
        const body = req.method === 'POST' ? await parseBody(req) : {};

        if (path === '/bridge/register' && req.method === 'POST') {
          const { agent_id, cli, timeout_sec = 600, topics = [], capabilities = [], metadata = {} } = body;
          if (!agent_id || !cli) {
            return writeJson(res, 400, { ok: false, error: 'agent_id, cli 필수' });
          }

          const heartbeat_ttl_ms = (timeout_sec + 120) * 1000;
          const result = await pipe.executeCommand('register', {
            agent_id,
            cli,
            capabilities,
            topics,
            heartbeat_ttl_ms,
            metadata,
          });
          return writeJson(res, 200, result);
        }

        if (path === '/bridge/result' && req.method === 'POST') {
          const { agent_id, topic = 'task.result', payload = {}, trace_id, correlation_id } = body;
          if (!agent_id) {
            return writeJson(res, 400, { ok: false, error: 'agent_id 필수' });
          }

          const result = await pipe.executeCommand('result', {
            agent_id,
            topic,
            payload,
            trace_id,
            correlation_id,
          });
          return writeJson(res, 200, result);
        }

        if (path === '/bridge/control' && req.method === 'POST') {
          const {
            from_agent = 'lead',
            to_agent,
            command,
            reason = '',
            payload = {},
            trace_id,
            correlation_id,
            ttl_ms = 3600000,
          } = body;

          if (!to_agent || !command) {
            return writeJson(res, 400, { ok: false, error: 'to_agent, command 필수' });
          }

          const result = await pipe.executeCommand('control', {
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

        if (path === '/bridge/assign/async' && req.method === 'POST') {
          const {
            supervisor_agent,
            worker_agent,
            task,
            topic = 'assign.job',
            payload = {},
            priority = 5,
            ttl_ms = 600000,
            timeout_ms = 600000,
            max_retries = 0,
            trace_id,
            correlation_id,
          } = body;

          if (!supervisor_agent || !worker_agent || !task) {
            return writeJson(res, 400, { ok: false, error: 'supervisor_agent, worker_agent, task 필수' });
          }

          const result = await pipe.executeCommand('assign', {
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

        if (path === '/bridge/assign/result' && req.method === 'POST') {
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
            return writeJson(res, 400, { ok: false, error: 'job_id, status 필수' });
          }

          const result = await pipe.executeCommand('assign_result', {
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

        if (path === '/bridge/assign/status' && req.method === 'POST') {
          const result = await pipe.executeQuery('assign_status', body);
          const statusCode = result.ok ? 200 : (result.error?.code === 'ASSIGN_NOT_FOUND' ? 404 : 400);
          return writeJson(res, statusCode, result);
        }

        if (path === '/bridge/assign/retry' && req.method === 'POST') {
          const { job_id, reason, requested_by } = body;
          if (!job_id) {
            return writeJson(res, 400, { ok: false, error: 'job_id 필수' });
          }

          const result = await pipe.executeCommand('assign_retry', {
            job_id,
            reason,
            requested_by,
          });
          const statusCode = result.ok ? 200
            : result.error?.code === 'ASSIGN_NOT_FOUND' ? 404
              : result.error?.code === 'ASSIGN_RETRY_EXHAUSTED' ? 409
                : 400;
          return writeJson(res, statusCode, result);
        }

        if (req.method === 'POST') {
          let teamResult = null;
          if (path === '/bridge/team/info' || path === '/bridge/team-info') {
            teamResult = await pipe.executeQuery('team_info', body);
          } else if (path === '/bridge/team/task-list' || path === '/bridge/team-task-list') {
            teamResult = await pipe.executeQuery('team_task_list', body);
          } else if (path === '/bridge/team/task-update' || path === '/bridge/team-task-update') {
            teamResult = await pipe.executeCommand('team_task_update', body);
          } else if (path === '/bridge/team/send-message' || path === '/bridge/team-send-message') {
            teamResult = await pipe.executeCommand('team_send_message', body);
          }

          if (teamResult) {
            return writeJson(res, resolveTeamStatusCode(teamResult), teamResult);
          }

          if (path.startsWith('/bridge/team')) {
            return writeJson(res, 404, { ok: false, error: `Unknown team endpoint: ${path}` });
          }

          // ── 파이프라인 엔드포인트 ──
          if (path === '/bridge/pipeline/state' && req.method === 'POST') {
            const result = await pipe.executeQuery('pipeline_state', body);
            return writeJson(res, resolvePipelineStatusCode(result), result);
          }

          if (path === '/bridge/pipeline/advance' && req.method === 'POST') {
            const result = await pipe.executeCommand('pipeline_advance', body);
            return writeJson(res, resolvePipelineStatusCode(result), result);
          }

          if (path === '/bridge/pipeline/init' && req.method === 'POST') {
            const result = await pipe.executeCommand('pipeline_init', body);
            return writeJson(res, resolvePipelineStatusCode(result), result);
          }

          if (path === '/bridge/pipeline/list' && req.method === 'POST') {
            const result = await pipe.executeQuery('pipeline_list', body);
            return writeJson(res, resolvePipelineStatusCode(result), result);
          }

          // ── Delegator 엔드포인트 ──
          if (path === '/bridge/delegator/delegate' && req.method === 'POST') {
            const result = await pipe.executeCommand('delegator_delegate', body);
            return writeJson(res, result.ok ? 200 : 400, result);
          }

          if (path === '/bridge/delegator/reply' && req.method === 'POST') {
            const result = await pipe.executeCommand('delegator_reply', body);
            return writeJson(res, result.ok ? 200 : 400, result);
          }

          if (path === '/bridge/delegator/status' && req.method === 'POST') {
            const result = await pipe.executeQuery('delegator_status', body);
            return writeJson(res, result.ok ? 200 : 400, result);
          }
        }

        if (path === '/bridge/context' && req.method === 'POST') {
          const { agent_id, topics, max_messages = 10, auto_ack = true } = body;
          if (!agent_id) {
            return writeJson(res, 400, { ok: false, error: 'agent_id 필수' });
          }

          const result = await pipe.executeQuery('drain', {
            agent_id,
            topics,
            max_messages,
            auto_ack,
          });
          return writeJson(res, 200, result);
        }

        if (path === '/bridge/deregister' && req.method === 'POST') {
          const { agent_id } = body;
          if (!agent_id) {
            return writeJson(res, 400, { ok: false, error: 'agent_id 필수' });
          }
          const result = await pipe.executeCommand('deregister', { agent_id });
          return writeJson(res, 200, result);
        }

        return writeJson(res, 404, { ok: false, error: 'Unknown bridge endpoint' });
      } catch (error) {
        if (!res.headersSent) {
          console.error('[tfx-hub] bridge error:', error);
          writeJson(res, 500, { ok: false, error: 'Internal server error' });
        }
        return;
      }
    }

    if (req.method === 'GET' && servePublicFile(res, path)) {
      return;
    }

    if (path !== '/mcp') {
      res.writeHead(404);
      return res.end('Not Found');
    }

    try {
      const sessionIdHeader = req.headers['mcp-session-id'];

      if (req.method === 'POST') {
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
                try { session.mcp.close(); } catch {}
              }
              transports.delete(transport.sessionId);
            }
          };
          const mcp = createMcpForSession();
          await mcp.connect(transport);
          await transport.handleRequest(req, res, body);
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: No valid session ID' },
            id: null,
          }));
        }
      } else if (req.method === 'GET') {
        if (sessionIdHeader && transports.has(sessionIdHeader)) {
          await transports.get(sessionIdHeader).transport.handleRequest(req, res);
        } else {
          res.writeHead(400);
          res.end('Invalid or missing session ID');
        }
      } else if (req.method === 'DELETE') {
        if (sessionIdHeader && transports.has(sessionIdHeader)) {
          await transports.get(sessionIdHeader).transport.handleRequest(req, res);
        } else {
          res.writeHead(400);
          res.end('Invalid or missing session ID');
        }
      } else {
        res.writeHead(405);
        res.end('Method Not Allowed');
      }
    } catch (error) {
      hubLog.error({ err: error }, 'http.error');
      if (!res.headersSent) {
        const code = error.statusCode === 413 ? 413
          : error instanceof SyntaxError ? 400 : 500;
        const message = code === 413 ? 'Body too large'
          : code === 400 ? 'Invalid JSON' : 'Internal server error';
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: code === 500 ? -32603 : -32700, message },
          id: null,
        }));
      }
    }
  }));

  httpServer.requestTimeout = 30000;
  httpServer.headersTimeout = 10000;

  router.startSweeper();

  const hitlTimer = setInterval(() => {
    try { hitl.checkTimeouts(); } catch (err) { hubLog.warn({ err }, 'hitl.timeout_check_failed'); }
  }, 10000);
  hitlTimer.unref();

  // MCP session TTL: sessions idle for SESSION_TTL_MS are closed automatically.
  // Configurable via SESSION_TTL_MS (default 30 minutes). The sweep runs every 60 s.
  const SESSION_TTL_MS = parseInt(process.env.TFX_SESSION_TTL_MS || '', 10) || 30 * 60 * 1000;
  const sessionTimer = setInterval(() => {
    const now = Date.now();
    for (const [sid, session] of transports) {
      if (now - (session.transport._lastActivity || 0) <= SESSION_TTL_MS) continue;
      try { session.mcp.close(); } catch {}
      try { session.transport.close(); } catch {}
      transports.delete(sid);
    }
  }, 60000);
  sessionTimer.unref();

  // 고아 node.exe 프로세스 + stale spawn 세션 주기적 정리 (5분마다)
  const orphanCleanupTimer = setInterval(() => {
    try {
      const { killed } = cleanupOrphanNodeProcesses();
      if (killed > 0) {
        hubLog.info({ killed }, 'hub.orphan_cleanup');
      }
    } catch {}

    // stale tfx-spawn-* psmux 세션 정리 (30분 이상 idle)
    try {
      const staleKilled = cleanupStaleSpawnSessions(hubLog);
      if (staleKilled > 0) {
        hubLog.info({ killed: staleKilled }, 'hub.stale_spawn_cleanup');
      }
    } catch {}
  }, 5 * 60 * 1000);
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
      const prevInfo = JSON.parse(readFileSync(PID_FILE, 'utf8'));
      const prevPid = Number(prevInfo?.pid);
      if (Number.isFinite(prevPid) && prevPid > 0) {
        try {
          process.kill(prevPid, 0); // alive 체크만
          // 프로세스가 살아있으면 포트 충돌 가능성 — 기존 Hub 재사용 안내
          if (Number(prevInfo.port) === Number(port)) {
            hubLog.warn({ prevPid, port }, 'hub.stale_pid: previous hub still alive on same port');
          }
        } catch {
          // 프로세스 죽음 → stale PID 파일 삭제
          try { unlinkSync(PID_FILE); } catch {}
          hubLog.info({ prevPid }, 'hub.stale_pid_cleaned');
        }
      } else {
        try { unlinkSync(PID_FILE); } catch {}
      }
    } catch {
      try { unlinkSync(PID_FILE); } catch {}
    }
  }

  const cleanupStartupFailure = async () => {
    try { router.stopSweeper(); } catch {}
    try { await pipe.stop(); } catch {}
    try { await assignCallbacks.stop(); } catch {}
    try { await delegatorWorker.stop(); } catch {}
    try { store.close(); } catch {}
    try { unlinkSync(TOKEN_FILE); } catch {}
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
          authMode: HUB_TOKEN ? 'token-required' : 'localhost-only',
          url: `http://${host}:${port}/mcp`,
          pipe_path: pipe.path,
          pipePath: pipe.path,
          assign_callback_pipe_path: assignCallbacks.path,
          assignCallbackPipePath: assignCallbacks.path,
          version,
          storeType: store.type || 'sqlite',
          idleTimeoutMs: hubIdleTimeoutMs,
        };

        writeFileSync(PID_FILE, JSON.stringify({
          pid: process.pid,
          port,
          host,
          auth_mode: HUB_TOKEN ? 'token-required' : 'localhost-only',
          url: info.url,
          pipe_path: pipe.path,
          pipePath: pipe.path,
          assign_callback_pipe_path: assignCallbacks.path,
          started: startedAtMs,
          version,
          session_id: sessionId,
        }));
        writeState({
          pid: process.pid,
          port,
          version,
          sessionId,
          startedAt,
        });
        releaseStartupLock();

        hubLog.info({ url: info.url, pipePath: pipe.path, assignCallbackPath: assignCallbacks.path, pid: process.pid, storeType: info.storeType, version }, 'hub.started');
        hubLog.debug({ publicDir: PUBLIC_DIR, exists: existsSync(PUBLIC_DIR), hasDashboard: existsSync(resolve(PUBLIC_DIR, 'dashboard.html')) }, 'hub.public_dir');

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
              try { await session.mcp.close(); } catch {}
              try { await session.transport.close(); } catch {}
            }
            transports.clear();
            await pipe.stop();
            await assignCallbacks.stop();
            await delegatorWorker.stop().catch(() => {});
            store.close();
            try { unlinkSync(PID_FILE); } catch {}
            try { unlinkSync(TOKEN_FILE); } catch {}
            httpServer.closeAllConnections();
            await new Promise((resolveClose) => httpServer.close(resolveClose));
          })().catch((error) => {
            stopPromise = null;
            throw error;
          });

          return stopPromise;
        };

        idleTimer = setInterval(() => {
          const idleMs = Date.now() - lastRequestAt;
          if (idleMs < hubIdleTimeoutMs) return;
          hubLog.warn({ idleMs, idleTimeoutMs: hubIdleTimeoutMs, port }, 'hub.idle_timeout_shutdown');
          void stopFn().catch((error) => {
            hubLog.error({ err: error, idleMs, idleTimeoutMs: hubIdleTimeoutMs, port }, 'hub.idle_timeout_shutdown_failed');
          });
        }, hubIdleSweepMs);
        idleTimer.unref();

        resolveHub({
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
    httpServer.on('error', (err) => {
      void cleanupStartupFailure();
      if (err.code === 'EADDRINUSE') {
        hubLog.error({ port, host }, 'hub.port_in_use: port already occupied — check for existing hub or other service');
        reject(new Error(`Hub 포트 ${port}이(가) 이미 사용 중입니다. 기존 Hub 프로세스를 확인하세요. (PID file: ${PID_FILE})`));
      } else {
        reject(err);
      }
    });
  });
}

export function getHubInfo() {
  if (!existsSync(PID_FILE)) return null;
  try {
    return JSON.parse(readFileSync(PID_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * stale tfx-spawn-* psmux 세션을 감지하고 정리한다.
 * 30분 이상 경과 + pane이 idle 쉘 프롬프트만 표시 → kill.
 * @param {object} [log] logger (optional)
 * @returns {number} killed session count
 */
function cleanupStaleSpawnSessions(log) {
  const MAX_AGE_MS = 30 * 60 * 1000;
  const IDLE_PROMPT_RE = /^(PS\s|[$%>#]\s*$|\w+@[\w.-]+[:\s]|╰─|╭─|[fb]wd-i-search:|client_loop:\s|Connection\s+(reset|closed))/;
  const execOpts = { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"], windowsHide: true };

  let killed = 0;
  let raw;
  try {
    raw = execSyncHub("psmux list-sessions", execOpts);
  } catch {
    return 0; // psmux 없거나 실패
  }

  const now = Date.now();
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^(tfx-spawn-[^:]+):\s+\d+\s+windows?\s+\(created\s+(.+)\)/);
    if (!match) continue;

    const [, sessionName, createdStr] = match;
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionName)) continue; // shell injection 방지
    const created = new Date(createdStr).getTime();
    if (!Number.isFinite(created) || now - created < MAX_AGE_MS) continue;

    // pane 내용 확인 — 마지막 3줄 중 idle 쉘 프롬프트가 있는지
    try {
      const pane = execSyncHub(`psmux capture-pane -t "${sessionName}:0.0" -p`, execOpts);
      const tailLines = pane.split(/\r?\n/).filter((l) => l.trim()).slice(-3);
      const hasIdleLine = tailLines.some((l) => IDLE_PROMPT_RE.test(l.trim()));
      if (!hasIdleLine) continue; // 아직 활성 — 건드리지 않음
    } catch {
      continue; // pane 접근 실패 — 건드리지 않음
    }

    // stale + idle → 정리
    try {
      execSyncHub(`psmux kill-session -t "${sessionName}"`, execOpts);
      killed++;
      if (log) log.info({ session: sessionName, ageMin: Math.round((now - created) / 60000) }, "hub.stale_spawn_killed");
    } catch {}
  }

  return killed;
}

const selfRun = process.argv[1]?.replace(/\\/g, '/').endsWith('hub/server.mjs');
if (selfRun) {
  const port = parseInt(process.env.TFX_HUB_PORT || '27888', 10);
  const dbPath = process.env.TFX_HUB_DB || undefined;

  startHub({ port, dbPath }).then((info) => {
    const shutdown = async (signal) => {
      hubLog.info({ signal }, 'hub.stopping');
      try { cleanupOrphanNodeProcesses(); } catch {}
      try { cleanupStaleSpawnSessions(hubLog); } catch {}
      await info.stop();
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }).catch((error) => {
    hubLog.fatal({ err: error }, 'hub.start_failed');
    process.exit(1);
  });
}
