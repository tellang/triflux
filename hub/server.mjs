// hub/server.mjs — HTTP MCP + REST bridge + Named Pipe 서버 진입점
import { createServer as createHttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { writeFileSync, unlinkSync, existsSync, mkdirSync, readFileSync } from 'node:fs';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { createStore } from './store.mjs';
import { createRouter } from './router.mjs';
import { createHitlManager } from './hitl.mjs';
import { createPipeServer } from './pipe.mjs';
import { createTools } from './tools.mjs';
import {
  ensurePipelineTable,
  createPipeline,
} from './pipeline/index.mjs';
import {
  readPipelineState,
  initPipelineState,
  listPipelineStates,
} from './pipeline/state.mjs';
import {
  teamInfo,
  teamTaskList,
  teamTaskUpdate,
  teamSendMessage,
} from './team/nativeProxy.mjs';

function isInitializeRequest(body) {
  if (body?.method === 'initialize') return true;
  if (Array.isArray(body)) return body.some((message) => message.method === 'initialize');
  return false;
}

const MAX_BODY_SIZE = 1024 * 1024;
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
    dbPath = join(PID_DIR, 'state.db');
  }

  const store = createStore(dbPath);
  const router = createRouter(store);
  const pipe = createPipeServer({ router, store, sessionId });
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
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id, Last-Event-ID');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    if (req.url === '/' || req.url === '/status') {
      const status = router.getStatus('hub').data;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ...status,
        sessions: transports.size,
        pid: process.pid,
        port,
        pipe_path: pipe.path,
        pipe: pipe.getStatus(),
      }));
    }

    if (req.url === '/health' || req.url === '/healthz') {
      const status = router.getStatus('hub').data;
      const healthy = status?.hub?.state === 'healthy';
      res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: healthy }));
    }

    if (req.url.startsWith('/bridge')) {
      res.setHeader('Content-Type', 'application/json');

      if (req.method !== 'POST' && req.method !== 'DELETE') {
        res.writeHead(405);
        return res.end(JSON.stringify({ ok: false, error: 'Method Not Allowed' }));
      }

      try {
        const body = req.method === 'POST' ? await parseBody(req) : {};
        const path = req.url.replace(/\?.*/, '');

        if (path === '/bridge/register' && req.method === 'POST') {
          const { agent_id, cli, timeout_sec = 600, topics = [], capabilities = [], metadata = {} } = body;
          if (!agent_id || !cli) {
            res.writeHead(400);
            return res.end(JSON.stringify({ ok: false, error: 'agent_id, cli 필수' }));
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
          res.writeHead(200);
          return res.end(JSON.stringify(result));
        }

        if (path === '/bridge/result' && req.method === 'POST') {
          const { agent_id, topic = 'task.result', payload = {}, trace_id, correlation_id } = body;
          if (!agent_id) {
            res.writeHead(400);
            return res.end(JSON.stringify({ ok: false, error: 'agent_id 필수' }));
          }

          const result = await pipe.executeCommand('result', {
            agent_id,
            topic,
            payload,
            trace_id,
            correlation_id,
          });
          res.writeHead(200);
          return res.end(JSON.stringify(result));
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
            res.writeHead(400);
            return res.end(JSON.stringify({ ok: false, error: 'to_agent, command 필수' }));
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

          res.writeHead(200);
          return res.end(JSON.stringify(result));
        }

        if (req.method === 'POST') {
          let teamResult = null;
          if (path === '/bridge/team/info' || path === '/bridge/team-info') {
            teamResult = teamInfo(body);
          } else if (path === '/bridge/team/task-list' || path === '/bridge/team-task-list') {
            teamResult = teamTaskList(body);
          } else if (path === '/bridge/team/task-update' || path === '/bridge/team-task-update') {
            teamResult = teamTaskUpdate(body);
          } else if (path === '/bridge/team/send-message' || path === '/bridge/team-send-message') {
            teamResult = teamSendMessage(body);
          }

          if (teamResult) {
            let status = 200;
            const code = teamResult?.error?.code;
            if (!teamResult.ok) {
              if (code === 'TEAM_NOT_FOUND' || code === 'TASK_NOT_FOUND' || code === 'TASKS_DIR_NOT_FOUND') status = 404;
              else if (code === 'CLAIM_CONFLICT' || code === 'MTIME_CONFLICT') status = 409;
              else if (code === 'INVALID_TEAM_NAME' || code === 'INVALID_TASK_ID' || code === 'INVALID_TEXT' || code === 'INVALID_FROM' || code === 'INVALID_STATUS') status = 400;
              else status = 500;
            }
            res.writeHead(status);
            return res.end(JSON.stringify(teamResult));
          }

          if (path.startsWith('/bridge/team')) {
            res.writeHead(404);
            return res.end(JSON.stringify({ ok: false, error: `Unknown team endpoint: ${path}` }));
          }

          // ── 파이프라인 엔드포인트 ──
          if (path === '/bridge/pipeline/state' && req.method === 'POST') {
            ensurePipelineTable(store.db);
            const { team_name } = body;
            const state = readPipelineState(store.db, team_name);
            res.writeHead(state ? 200 : 404);
            return res.end(JSON.stringify(state
              ? { ok: true, data: state }
              : { ok: false, error: 'pipeline_not_found' }));
          }

          if (path === '/bridge/pipeline/advance' && req.method === 'POST') {
            ensurePipelineTable(store.db);
            const { team_name, phase } = body;
            const pipeline = createPipeline(store.db, team_name);
            const result = pipeline.advance(phase);
            res.writeHead(result.ok ? 200 : 400);
            return res.end(JSON.stringify(result));
          }

          if (path === '/bridge/pipeline/init' && req.method === 'POST') {
            ensurePipelineTable(store.db);
            const { team_name, fix_max, ralph_max } = body;
            const state = initPipelineState(store.db, team_name, { fix_max, ralph_max });
            res.writeHead(200);
            return res.end(JSON.stringify({ ok: true, data: state }));
          }

          if (path === '/bridge/pipeline/list' && req.method === 'POST') {
            ensurePipelineTable(store.db);
            const states = listPipelineStates(store.db);
            res.writeHead(200);
            return res.end(JSON.stringify({ ok: true, data: states }));
          }
        }

        if (path === '/bridge/context' && req.method === 'POST') {
          const { agent_id, topics, max_messages = 10 } = body;
          if (!agent_id) {
            res.writeHead(400);
            return res.end(JSON.stringify({ ok: false, error: 'agent_id 필수' }));
          }

          const result = await pipe.executeQuery('context', {
            agent_id,
            topics,
            max_messages,
          });
          res.writeHead(200);
          return res.end(JSON.stringify(result));
        }

        if (path === '/bridge/deregister' && req.method === 'POST') {
          const { agent_id } = body;
          if (!agent_id) {
            res.writeHead(400);
            return res.end(JSON.stringify({ ok: false, error: 'agent_id 필수' }));
          }
          const result = await pipe.executeCommand('deregister', { agent_id });
          res.writeHead(200);
          return res.end(JSON.stringify(result));
        }

        res.writeHead(404);
        return res.end(JSON.stringify({ ok: false, error: 'Unknown bridge endpoint' }));
      } catch (error) {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end(JSON.stringify({ ok: false, error: error.message }));
        }
        return;
      }
    }

    if (req.url !== '/mcp') {
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

  return new Promise((resolve, reject) => {
    httpServer.listen(port, host, () => {
      const info = {
        port,
        host,
        dbPath,
        pid: process.pid,
        url: `http://${host}:${port}/mcp`,
        pipe_path: pipe.path,
        pipePath: pipe.path,
      };

      writeFileSync(PID_FILE, JSON.stringify({
        pid: process.pid,
        port,
        host,
        url: info.url,
        pipe_path: pipe.path,
        pipePath: pipe.path,
        started: Date.now(),
      }));

      console.log(`[tfx-hub] MCP 서버 시작: ${info.url} / pipe ${pipe.path} (PID ${process.pid})`);

      const stopFn = async () => {
        router.stopSweeper();
        clearInterval(hitlTimer);
        clearInterval(sessionTimer);
        for (const [, transport] of transports) {
          try { await transport.close(); } catch {}
        }
        transports.clear();
        await pipe.stop();
        store.close();
        try { unlinkSync(PID_FILE); } catch {}
        await new Promise((resolveClose) => httpServer.close(resolveClose));
      };

      resolve({ ...info, httpServer, store, router, hitl, pipe, stop: stopFn });
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
