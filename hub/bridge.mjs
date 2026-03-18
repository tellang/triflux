#!/usr/bin/env node
// hub/bridge.mjs — tfx-route.sh ↔ tfx-hub 브릿지 CLI
//
// tfx-route.sh에서 CLI 에이전트 실행 전후로 호출하여
// Hub에 자동 등록/결과 발행/컨텍스트 수신/해제를 수행한다.
//
// 사용법:
//   node bridge.mjs register  --agent <id> --cli <type> --timeout <sec> [--topics t1,t2]
//   node bridge.mjs result    --agent <id> --file <path> [--topic task.result] [--trace <id>]
//   node bridge.mjs context   --agent <id> [--topics t1,t2] [--max 10] [--out <path>]
//   node bridge.mjs deregister --agent <id>
//   node bridge.mjs ping
//
// Hub 미실행 시 모든 커맨드는 조용히 실패 (exit 0).
// tfx-route.sh 흐름을 절대 차단하지 않는다.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs as nodeParseArgs } from 'node:util';

const HUB_PID_FILE = join(homedir(), '.claude', 'cache', 'tfx-hub', 'hub.pid');

// ── Hub URL 해석 ──

function getHubUrl() {
  // 환경변수 우선
  if (process.env.TFX_HUB_URL) return process.env.TFX_HUB_URL.replace(/\/mcp$/, '');

  // PID 파일에서 읽기
  if (existsSync(HUB_PID_FILE)) {
    try {
      const info = JSON.parse(readFileSync(HUB_PID_FILE, 'utf8'));
      return `http://${info.host || '127.0.0.1'}:${info.port || 27888}`;
    } catch { /* 무시 */ }
  }

  // 기본값
  const port = process.env.TFX_HUB_PORT || '27888';
  return `http://127.0.0.1:${port}`;
}

const _cachedHubUrl = getHubUrl();

// ── HTTP 요청 ──

async function post(path, body, timeoutMs = 5000) {
  const url = `${_cachedHubUrl}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return await res.json();
  } catch {
    clearTimeout(timer);
    return null; // Hub 미실행 — 조용히 실패
  }
}

// ── 인자 파싱 ──

function parseArgs(argv) {
  const { values } = nodeParseArgs({
    args: argv,
    options: {
      agent: { type: 'string' },
      cli: { type: 'string' },
      timeout: { type: 'string' },
      topics: { type: 'string' },
      capabilities: { type: 'string' },
      file: { type: 'string' },
      topic: { type: 'string' },
      trace: { type: 'string' },
      correlation: { type: 'string' },
      'exit-code': { type: 'string' },
      max: { type: 'string' },
      out: { type: 'string' },
    },
    strict: false,
  });
  return values;
}

// ── 커맨드 ──

async function cmdRegister(args) {
  const agentId = args.agent;
  const cli = args.cli || 'other';
  const timeoutSec = parseInt(args.timeout || '600', 10);
  const topics = args.topics ? args.topics.split(',') : [];
  const capabilities = args.capabilities ? args.capabilities.split(',') : ['code'];

  const result = await post('/bridge/register', {
    agent_id: agentId,
    cli,
    timeout_sec: timeoutSec,
    topics,
    capabilities,
    metadata: {
      pid: process.ppid, // 부모 프로세스 (tfx-route.sh)
      registered_at: Date.now(),
    },
  });

  if (result?.ok) {
    // 에이전트 ID를 stdout으로 출력 (tfx-route.sh에서 캡처)
    console.log(JSON.stringify({ ok: true, agent_id: agentId, lease_expires_ms: result.data?.lease_expires_ms }));
  } else {
    // Hub 미실행 — 조용히 패스
    console.log(JSON.stringify({ ok: false, reason: 'hub_unavailable' }));
  }
}

async function cmdResult(args) {
  const agentId = args.agent;
  const filePath = args.file;
  const topic = args.topic || 'task.result';
  const traceId = args.trace || undefined;
  const correlationId = args.correlation || undefined;
  const exitCode = parseInt(args['exit-code'] || '0', 10);

  // 결과 파일 읽기 (최대 48KB — Hub 메시지 크기 제한)
  let output = '';
  if (filePath && existsSync(filePath)) {
    output = readFileSync(filePath, 'utf8').slice(0, 49152);
  }

  const result = await post('/bridge/result', {
    agent_id: agentId,
    topic,
    payload: {
      agent_id: agentId,
      exit_code: exitCode,
      output_length: output.length,
      output_preview: output.slice(0, 4096), // 미리보기 4KB
      output_file: filePath || null,
      completed_at: Date.now(),
    },
    trace_id: traceId,
    correlation_id: correlationId,
  });

  if (result?.ok) {
    console.log(JSON.stringify({ ok: true, message_id: result.data?.message_id }));
  } else {
    console.log(JSON.stringify({ ok: false, reason: 'hub_unavailable' }));
  }
}

async function cmdContext(args) {
  const agentId = args.agent;
  const topics = args.topics ? args.topics.split(',') : undefined;
  const maxMessages = parseInt(args.max || '10', 10);
  const outPath = args.out;

  const result = await post('/bridge/context', {
    agent_id: agentId,
    topics,
    max_messages: maxMessages,
  });

  if (result?.ok && result.data?.messages?.length) {
    // 컨텍스트 조합
    const parts = result.data.messages.map((m, i) => {
      const from = m.from_agent || 'unknown';
      const topic = m.topic || 'unknown';
      const payload = typeof m.payload === 'string' ? m.payload : JSON.stringify(m.payload, null, 2);
      return `=== Context ${i + 1}: ${from} (${topic}) ===\n${payload}`;
    });
    const combined = parts.join('\n\n');

    if (outPath) {
      writeFileSync(outPath, combined, 'utf8');
      console.log(JSON.stringify({ ok: true, count: result.data.messages.length, file: outPath }));
    } else {
      console.log(combined);
    }
  } else {
    if (outPath) {
      console.log(JSON.stringify({ ok: true, count: 0 }));
    }
    // 메시지 없으면 빈 출력
  }
}

async function cmdDeregister(args) {
  const agentId = args.agent;
  const result = await post('/bridge/deregister', { agent_id: agentId });

  if (result?.ok) {
    console.log(JSON.stringify({ ok: true, agent_id: agentId, status: 'offline' }));
  } else {
    console.log(JSON.stringify({ ok: false, reason: 'hub_unavailable' }));
  }
}

async function cmdPing() {
  try {
    const url = `${_cachedHubUrl}/status`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    const data = await res.json();
    console.log(JSON.stringify({ ok: true, hub: data.hub?.state, sessions: data.sessions }));
  } catch {
    console.log(JSON.stringify({ ok: false, reason: 'hub_unavailable' }));
  }
}

// ── 메인 ──

const cmd = process.argv[2];
const args = parseArgs(process.argv.slice(3));

switch (cmd) {
  case 'register':   await cmdRegister(args); break;
  case 'result':     await cmdResult(args); break;
  case 'context':    await cmdContext(args); break;
  case 'deregister': await cmdDeregister(args); break;
  case 'ping':       await cmdPing(); break;
  default:
    console.error('사용법: bridge.mjs <register|result|context|deregister|ping> [--옵션]');
    process.exit(1);
}
