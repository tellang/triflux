// hub/server.mjs — Streamable HTTP MCP 서버 진입점
// Express 없이 Node.js http 모듈 + MCP SDK로 구현
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
import { createTools } from './tools.mjs';

/** initialize 요청 판별 */
function isInitializeRequest(body) {
  if (body?.method === 'initialize') return true;
  if (Array.isArray(body)) return body.some(m => m.method === 'initialize');
  return false;
}

/** HTTP 요청 body JSON 파싱 (1MB 제한) */
const MAX_BODY_SIZE = 1024 * 1024;
async function parseBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_SIZE) throw Object.assign(new Error('Body too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

/** PID 파일 경로 */
const PID_DIR = join(homedir(), '.claude', 'cache', 'tfx-hub');
const PID_FILE = join(PID_DIR, 'hub.pid');

/**
 * tfx-hub 데몬 시작
 * @param {object} opts
 * @param {number} opts.port — 리스닝 포트 (기본 27888)
 * @param {string} opts.dbPath — SQLite DB 경로
 * @param {string} opts.host — 바인드 주소 (기본 127.0.0.1)
 */
export async function startHub({ port = 27888, dbPath, host = '127.0.0.1' } = {}) {
  if (!dbPath) {
    dbPath = join(PID_DIR, 'state.db');
  }

  // 코어 모듈 초기화
  const store = createStore(dbPath);
  const router = createRouter(store);
  const hitl = createHitlManager(store);
  const tools = createTools(store, router, hitl);

  // 세션별 transport 맵
  const transports = new Map();

  /** 세션당 MCP 서버 생성 (low-level Server — plain JSON Schema 호환) */
  function createMcpForSession() {
    const mcp = new Server(
      { name: 'tfx-hub', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );

    // tools/list 핸들러
    mcp.setRequestHandler(
      ListToolsRequestSchema,
      async () => ({
        tools: tools.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      }),
    );

    // tools/call 핸들러
    mcp.setRequestHandler(
      CallToolRequestSchema,
      async (request) => {
        const { name, arguments: args } = request.params;
        const tool = tools.find(t => t.name === name);
        if (!tool) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code: 'UNKNOWN_TOOL', message: `도구 없음: ${name}` } }) }],
            isError: true,
          };
        }
        return await tool.handler(args || {});
      },
    );

    return mcp;
  }

  // HTTP 서버
  const httpServer = createHttpServer(async (req, res) => {
    // CORS (로컬 전용이지만 CLI 클라이언트 호환)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id, Last-Event-ID');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    // /status — 허브 상태 (브라우저/curl 용)
    if (req.url === '/' || req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ...router.getStatus('hub').data,
        sessions: transports.size,
        pid: process.pid,
        port,
      }));
    }

    // /bridge/* — 경량 REST 엔드포인트 (tfx-route.sh 브릿지용)
    if (req.url.startsWith('/bridge')) {
      res.setHeader('Content-Type', 'application/json');

      if (req.method !== 'POST' && req.method !== 'DELETE') {
        res.writeHead(405);
        return res.end(JSON.stringify({ ok: false, error: 'Method Not Allowed' }));
      }

      try {
        const body = (req.method === 'POST') ? await parseBody(req) : {};
        const path = req.url.replace(/\?.*/, '');

        // POST /bridge/register — 에이전트 등록 (프로세스 수명 기반)
        if (path === '/bridge/register' && req.method === 'POST') {
          const { agent_id, cli, timeout_sec = 600, topics = [], capabilities = [], metadata = {} } = body;
          if (!agent_id || !cli) {
            res.writeHead(400);
            return res.end(JSON.stringify({ ok: false, error: 'agent_id, cli 필수' }));
          }
          // heartbeat = 프로세스 타임아웃 + 여유 120초
          const heartbeat_ttl_ms = (timeout_sec + 120) * 1000;
          const data = store.registerAgent({ agent_id, cli, capabilities, topics, heartbeat_ttl_ms, metadata });
          res.writeHead(200);
          return res.end(JSON.stringify({ ok: true, data }));
        }

        // POST /bridge/result — 결과 발행
        if (path === '/bridge/result' && req.method === 'POST') {
          const { agent_id, topic = 'task.result', payload = {}, trace_id, correlation_id } = body;
          if (!agent_id) {
            res.writeHead(400);
            return res.end(JSON.stringify({ ok: false, error: 'agent_id 필수' }));
          }
          const result = router.handlePublish({
            from: agent_id, to: 'topic:' + topic, topic, payload,
            priority: 5, ttl_ms: 3600000, trace_id, correlation_id,
          });
          res.writeHead(200);
          return res.end(JSON.stringify(result));
        }

        // POST /bridge/context — 선행 컨텍스트 폴링
        if (path === '/bridge/context' && req.method === 'POST') {
          const { agent_id, topics, max_messages = 10 } = body;
          if (!agent_id) {
            res.writeHead(400);
            return res.end(JSON.stringify({ ok: false, error: 'agent_id 필수' }));
          }
          const messages = store.pollForAgent(agent_id, {
            max_messages,
            include_topics: topics,
            auto_ack: true,
          });
          res.writeHead(200);
          return res.end(JSON.stringify({ ok: true, data: { messages, count: messages.length } }));
        }

        // POST /bridge/deregister — 에이전트 해제
        if (path === '/bridge/deregister' && req.method === 'POST') {
          const { agent_id } = body;
          if (!agent_id) {
            res.writeHead(400);
            return res.end(JSON.stringify({ ok: false, error: 'agent_id 필수' }));
          }
          store.db.prepare("UPDATE agents SET status='offline' WHERE agent_id=?").run(agent_id);
          res.writeHead(200);
          return res.end(JSON.stringify({ ok: true, data: { agent_id, status: 'offline' } }));
        }

        res.writeHead(404);
        return res.end(JSON.stringify({ ok: false, error: 'Unknown bridge endpoint' }));
      } catch (e) {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }
    }

    // /mcp — MCP Streamable HTTP 엔드포인트
    if (req.url !== '/mcp') {
      res.writeHead(404);
      return res.end('Not Found');
    }

    try {
      const sessionId = req.headers['mcp-session-id'];

      if (req.method === 'POST') {
        const body = await parseBody(req);

        if (sessionId && transports.has(sessionId)) {
          // 기존 세션
          const t = transports.get(sessionId);
          t._lastActivity = Date.now();
          await t.handleRequest(req, res, body);
        } else if (!sessionId && isInitializeRequest(body)) {
          // 새 세션 초기화
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
        // SSE 스트림 연결
        if (sessionId && transports.has(sessionId)) {
          await transports.get(sessionId).handleRequest(req, res);
        } else {
          res.writeHead(400);
          res.end('Invalid or missing session ID');
        }
      } else if (req.method === 'DELETE') {
        // 세션 종료
        if (sessionId && transports.has(sessionId)) {
          await transports.get(sessionId).handleRequest(req, res);
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
        const msg = code === 413 ? 'Body too large'
          : code === 400 ? 'Invalid JSON' : 'Internal server error';
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: code === 500 ? -32603 : -32700, message: msg },
          id: null,
        }));
      }
    }
  });

  // 스위퍼 시작
  router.startSweeper();

  // HITL 타임아웃 체크 (10초 주기)
  const hitlTimer = setInterval(() => {
    try { hitl.checkTimeouts(); } catch {}
  }, 10000);
  hitlTimer.unref();

  // 비활성 세션 정리 (60초 주기, 30분 TTL)
  const SESSION_TTL_MS = 30 * 60 * 1000;
  const sessionTimer = setInterval(() => {
    const now = Date.now();
    for (const [sid, transport] of transports) {
      if (now - (transport._lastActivity || 0) > SESSION_TTL_MS) {
        try { transport.close(); } catch {}
        transports.delete(sid);
      }
    }
  }, 60000);
  sessionTimer.unref();

  // PID 파일 기록
  mkdirSync(PID_DIR, { recursive: true });

  return new Promise((resolve, reject) => {
    httpServer.listen(port, host, () => {
      const info = { port, host, dbPath, pid: process.pid, url: `http://${host}:${port}/mcp` };

      // PID + 포트 기록 (stop/status 용)
      writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, port, host, url: info.url, started: Date.now() }));

      console.log(`[tfx-hub] MCP 서버 시작: ${info.url} (PID ${process.pid})`);

      const stopFn = async () => {
        router.stopSweeper();
        clearInterval(hitlTimer);
        clearInterval(sessionTimer);
        for (const [, transport] of transports) {
          try { await transport.close(); } catch {}
        }
        transports.clear();
        store.close();
        try { unlinkSync(PID_FILE); } catch {}
        await new Promise(r => httpServer.close(r));
      };

      resolve({ ...info, httpServer, store, router, hitl, stop: stopFn });
    });
    httpServer.on('error', reject);
  });
}

/** 실행 중인 허브 정보 읽기 */
export function getHubInfo() {
  if (!existsSync(PID_FILE)) return null;
  try {
    return JSON.parse(readFileSync(PID_FILE, 'utf8'));
  } catch { return null; }
}

// CLI 직접 실행
const selfRun = process.argv[1]?.replace(/\\/g, '/').endsWith('hub/server.mjs');
if (selfRun) {
  const port = parseInt(process.env.TFX_HUB_PORT || '27888', 10);
  const dbPath = process.env.TFX_HUB_DB || undefined;

  startHub({ port, dbPath }).then((info) => {
    const shutdown = async (sig) => {
      console.log(`\n[tfx-hub] ${sig} 수신, 종료 중...`);
      await info.stop();
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }).catch((err) => {
    console.error('[tfx-hub] 시작 실패:', err.message);
    process.exit(1);
  });
}
