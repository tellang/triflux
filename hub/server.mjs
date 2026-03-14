// hub/server.mjs — HTTP MCP + REST bridge + Named Pipe 서버 진입점
import { createServer as createHttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { extname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { writeFileSync, unlinkSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { createStore } from './store.mjs';
import { createRouter } from './router.mjs';
import { createHitlManager } from './hitl.mjs';
import { createPipeServer } from './pipe.mjs';
import { createAssignCallbackServer } from './assign-callbacks.mjs';
import { createTools } from './tools.mjs';
import { ensurePipelineStateDbPath } from './pipeline/state.mjs';
import { DelegatorService } from './delegator/index.mjs';
import { createDelegatorMcpWorker } from './workers/delegator-mcp.mjs';

const MAX_BODY_SIZE = 1024 * 1024;
const PUBLIC_PATHS = new Set(['/', '/status', '/health', '/healthz']);
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
const STATIC_CONTENT_TYPES = Object.freeze({
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.png': 'image/png',
});

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

function isAuthorizedRequest(req, path, hubToken) {
  if (!hubToken) {
    return isLoopbackRemoteAddress(req.socket.remoteAddress);
  }
  if (isPublicPath(path)) return true;
  return extractBearerToken(req) === hubToken;
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
    res.writeHead(404);
    res.end('Not Found');
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
 */
export async function startHub({ port = 27888, dbPath, host = '127.0.0.1', sessionId = process.pid } = {}) {
  if (!dbPath) {
    dbPath = ensurePipelineStateDbPath(PROJECT_ROOT);
  }

  mkdirSync(PUBLIC_DIR, { recursive: true });

  const HUB_TOKEN = process.env.TFX_HUB_TOKEN?.trim() || null;
  if (HUB_TOKEN) {
    mkdirSync(join(homedir(), '.claude'), { recursive: true });
    writeFileSync(TOKEN_FILE, HUB_TOKEN, { mode: 0o600 });
  } else {
    try { unlinkSync(TOKEN_FILE); } catch {}
  }

  const store = createStore(dbPath);
  const router = createRouter(store);

  // Delegator MCP resident service 초기화
  const delegatorWorker = createDelegatorMcpWorker({ cwd: PROJECT_ROOT });
  await delegatorWorker.start();
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

  const httpServer = createHttpServer(async (req, res) => {
    const path = getRequestPath(req.url);
    const corsAllowed = applyCorsHeaders(req, res);

    if (req.method === 'OPTIONS') {
      const localOnlyMode = !HUB_TOKEN;
      const isLoopbackRequest = isLoopbackRemoteAddress(req.socket.remoteAddress);
      res.writeHead(corsAllowed && (!localOnlyMode || isLoopbackRequest) ? 204 : 403);
      return res.end();
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
        pipe_path: pipe.path,
        pipe: pipe.getStatus(),
        assign_callback_pipe_path: assignCallbacks.path,
        assign_callback_pipe: assignCallbacks.getStatus(),
      });
    }

    if (path === '/health' || path === '/healthz') {
      const status = router.getStatus('hub').data;
      const healthy = status?.hub?.state === 'healthy';
      return writeJson(res, healthy ? 200 : 503, { ok: healthy });
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
          writeJson(res, 500, { ok: false, error: error.message });
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
          const transport = transports.get(sessionIdHeader);
          transport._lastActivity = Date.now();
          await transport.handleRequest(req, res, body);
        } else if (!sessionIdHeader && isInitializeRequest(body)) {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              transport._lastActivity = Date.now();
              transports.set(sid, transport);
            },
          });
          transport.onclose = () => {
            if (transport.sessionId) transports.delete(transport.sessionId);
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
          await transports.get(sessionIdHeader).handleRequest(req, res);
        } else {
          res.writeHead(400);
          res.end('Invalid or missing session ID');
        }
      } else if (req.method === 'DELETE') {
        if (sessionIdHeader && transports.has(sessionIdHeader)) {
          await transports.get(sessionIdHeader).handleRequest(req, res);
        } else {
          res.writeHead(400);
          res.end('Invalid or missing session ID');
        }
      } else {
        res.writeHead(405);
        res.end('Method Not Allowed');
      }
    } catch (error) {
      console.error('[tfx-hub] 요청 처리 에러:', error.message);
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
  });

  router.startSweeper();

  const hitlTimer = setInterval(() => {
    try { hitl.checkTimeouts(); } catch {}
  }, 10000);
  hitlTimer.unref();

  const SESSION_TTL_MS = 30 * 60 * 1000;
  const sessionTimer = setInterval(() => {
    const now = Date.now();
    for (const [sid, transport] of transports) {
      if (now - (transport._lastActivity || 0) <= SESSION_TTL_MS) continue;
      try { transport.close(); } catch {}
      transports.delete(sid);
    }
  }, 60000);
  sessionTimer.unref();

  mkdirSync(PID_DIR, { recursive: true });
  await pipe.start();
  await assignCallbacks.start();

  return new Promise((resolve, reject) => {
    httpServer.listen(port, host, () => {
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
        started: Date.now(),
      }));

      console.log(`[tfx-hub] MCP 서버 시작: ${info.url} / pipe ${pipe.path} / assign-callback ${assignCallbacks.path} (PID ${process.pid})`);

      const stopFn = async () => {
        router.stopSweeper();
        clearInterval(hitlTimer);
        clearInterval(sessionTimer);
        for (const [, transport] of transports) {
          try { await transport.close(); } catch {}
        }
        transports.clear();
        await pipe.stop();
        await assignCallbacks.stop();
        await delegatorWorker.stop().catch(() => {});
        store.close();
        try { unlinkSync(PID_FILE); } catch {}
        try { unlinkSync(TOKEN_FILE); } catch {}
        await new Promise((resolveClose) => httpServer.close(resolveClose));
      };

      resolve({
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
    });
    httpServer.on('error', reject);
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

const selfRun = process.argv[1]?.replace(/\\/g, '/').endsWith('hub/server.mjs');
if (selfRun) {
  const port = parseInt(process.env.TFX_HUB_PORT || '27888', 10);
  const dbPath = process.env.TFX_HUB_DB || undefined;

  startHub({ port, dbPath }).then((info) => {
    const shutdown = async (signal) => {
      console.log(`\n[tfx-hub] ${signal} 수신, 종료 중...`);
      await info.stop();
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }).catch((error) => {
    console.error('[tfx-hub] 시작 실패:', error.message);
    process.exit(1);
  });
}
