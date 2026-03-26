#!/usr/bin/env node
// hub/bridge.mjs — tfx-route.sh ↔ tfx-hub 브릿지 CLI
//
// Named Pipe/Unix Socket 제어 채널을 우선 사용하고,
// 연결이 없을 때만 HTTP /bridge/* 엔드포인트로 내려간다.

import net from 'node:net';
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { parseArgs as nodeParseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { getPipelineStateDbPath } from './pipeline/state.mjs';

const HUB_PID_FILE = join(homedir(), '.claude', 'cache', 'tfx-hub', 'hub.pid');
const HUB_TOKEN_FILE = join(homedir(), '.claude', '.tfx-hub-token');
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

function normalizeToken(raw) {
  if (raw == null) return null;
  const token = String(raw).trim();
  return token || null;
}

// Hub 인증 토큰 읽기 (파일 없으면 null → 하위 호환)
function readHubToken() {
  const envToken = normalizeToken(process.env.TFX_HUB_TOKEN);
  if (envToken) return envToken;
  try {
    return normalizeToken(readFileSync(HUB_TOKEN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function getHubUrl() {
  if (process.env.TFX_HUB_URL) return process.env.TFX_HUB_URL.replace(/\/mcp$/, '');

  if (existsSync(HUB_PID_FILE)) {
    try {
      const info = JSON.parse(readFileSync(HUB_PID_FILE, 'utf8'));
      return `http://${info.host || '127.0.0.1'}:${info.port || 27888}`;
    } catch {
      // 무시
    }
  }

  const port = process.env.TFX_HUB_PORT || '27888';
  return `http://127.0.0.1:${port}`;
}

export function getHubPipePath() {
  if (process.env.TFX_HUB_PIPE) return process.env.TFX_HUB_PIPE;

  if (!existsSync(HUB_PID_FILE)) return null;
  try {
    const info = JSON.parse(readFileSync(HUB_PID_FILE, 'utf8'));
    return info.pipe_path || info.pipePath || null;
  } catch {
    return null;
  }
}

const HUB_OPERATIONS = Object.freeze({
  register: { transport: 'command', action: 'register', httpPath: '/bridge/register' },
  result: { transport: 'command', action: 'result', httpPath: '/bridge/result' },
  control: { transport: 'command', action: 'control', httpPath: '/bridge/control' },
  context: { transport: 'query', action: 'drain', httpPath: '/bridge/context' },
  deregister: { transport: 'command', action: 'deregister', httpPath: '/bridge/deregister' },
  assignAsync: { transport: 'command', action: 'assign', httpPath: '/bridge/assign/async' },
  assignResult: { transport: 'command', action: 'assign_result', httpPath: '/bridge/assign/result' },
  assignStatus: { transport: 'query', action: 'assign_status', httpPath: '/bridge/assign/status' },
  assignRetry: { transport: 'command', action: 'assign_retry', httpPath: '/bridge/assign/retry' },
  teamInfo: { transport: 'query', action: 'team_info', httpPath: '/bridge/team/info' },
  teamTaskList: { transport: 'query', action: 'team_task_list', httpPath: '/bridge/team/task-list' },
  teamTaskUpdate: { transport: 'command', action: 'team_task_update', httpPath: '/bridge/team/task-update' },
  teamSendMessage: { transport: 'command', action: 'team_send_message', httpPath: '/bridge/team/send-message' },
  pipelineState: { transport: 'query', action: 'pipeline_state', httpPath: '/bridge/pipeline/state' },
  pipelineAdvance: { transport: 'command', action: 'pipeline_advance', httpPath: '/bridge/pipeline/advance' },
  pipelineInit: { transport: 'command', action: 'pipeline_init', httpPath: '/bridge/pipeline/init' },
  pipelineList: { transport: 'query', action: 'pipeline_list', httpPath: '/bridge/pipeline/list' },
  hubStatus: { transport: 'query', action: 'status', httpPath: '/status', httpMethod: 'GET' },
  delegatorDelegate: { transport: 'command', action: 'delegator_delegate', httpPath: '/bridge/delegator/delegate' },
  delegatorReply: { transport: 'command', action: 'delegator_reply', httpPath: '/bridge/delegator/reply' },
  delegatorStatus: { transport: 'query', action: 'delegator_status', httpPath: '/bridge/delegator/status' },
});

export async function requestJson(path, { method = 'POST', body, timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = {};
    const token = readHubToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(`${getHubUrl()}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return await res.json();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

export async function post(path, body, timeoutMs = 5000) {
  return await requestJson(path, { method: 'POST', body, timeoutMs });
}

export async function connectPipe(timeoutMs = 1200) {
  const pipePath = getHubPipePath();
  if (!pipePath) return null;

  return await new Promise((resolve) => {
    const socket = net.createConnection(pipePath);
    const timer = setTimeout(() => {
      try { socket.destroy(); } catch {}
      resolve(null);
    }, timeoutMs);

    socket.once('connect', () => {
      clearTimeout(timer);
      socket.setEncoding('utf8');
      resolve(socket);
    });

    socket.once('error', () => {
      clearTimeout(timer);
      try { socket.destroy(); } catch {}
      resolve(null);
    });
  });
}

async function pipeRequest(type, action, payload, timeoutMs = 3000) {
  const socket = await connectPipe(Math.min(timeoutMs, 1500));
  if (!socket) return null;

  return await new Promise((resolve) => {
    const requestId = randomUUID();
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => {
      finish(null);
    }, timeoutMs);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.end(); } catch {}
      resolve(result);
    };

    socket.on('data', (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');
        if (!line) continue;

        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }

        if (frame?.type !== 'response' || frame.request_id !== requestId) continue;
        finish({
          ok: frame.ok,
          error: frame.error,
          data: frame.data,
        });
        return;
      }
    });

    socket.on('error', () => finish(null));
    socket.write(JSON.stringify({
      type,
      request_id: requestId,
      payload: { action, ...payload },
    }) + '\n');
  });
}

async function pipeCommand(action, payload, timeoutMs = 3000) {
  return await pipeRequest('command', action, payload, timeoutMs);
}

async function pipeQuery(action, payload, timeoutMs = 3000) {
  return await pipeRequest('query', action, payload, timeoutMs);
}

export function parseArgs(argv) {
  const { values } = nodeParseArgs({
    args: argv,
    options: {
      agent: { type: 'string' },
      cli: { type: 'string' },
      timeout: { type: 'string' },
      topics: { type: 'string' },
      capabilities: { type: 'string' },
      file: { type: 'string' },
      payload: { type: 'string' },
      topic: { type: 'string' },
      trace: { type: 'string' },
      correlation: { type: 'string' },
      'exit-code': { type: 'string' },
      max: { type: 'string' },
      out: { type: 'string' },
      team: { type: 'string' },
      'task-id': { type: 'string' },
      'job-id': { type: 'string' },
      owner: { type: 'string' },
      status: { type: 'string' },
      statuses: { type: 'string' },
      claim: { type: 'boolean' },
      actor: { type: 'string' },
      command: { type: 'string' },
      reason: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      text: { type: 'string' },
      task: { type: 'string' },
      'supervisor-agent': { type: 'string' },
      'worker-agent': { type: 'string' },
      priority: { type: 'string' },
      'ttl-ms': { type: 'string' },
      'timeout-ms': { type: 'string' },
      'max-retries': { type: 'string' },
      attempt: { type: 'string' },
      result: { type: 'string' },
      error: { type: 'string' },
      metadata: { type: 'string' },
      'requested-by': { type: 'string' },
      summary: { type: 'string' },
      color: { type: 'string' },
      limit: { type: 'string' },
      'include-internal': { type: 'boolean' },
      subject: { type: 'string' },
      description: { type: 'string' },
      'fix-max': { type: 'string' },
      'ralph-max': { type: 'string' },
      'active-form': { type: 'string' },
      'add-blocks': { type: 'string' },
      'add-blocked-by': { type: 'string' },
      'metadata-patch': { type: 'string' },
      'if-match-mtime-ms': { type: 'string' },
      provider: { type: 'string' },
      mode: { type: 'string' },
      prompt: { type: 'string' },
      reply: { type: 'string' },
      done: { type: 'boolean' },
      'mcp-profile': { type: 'string' },
      'session-key': { type: 'string' },
    },
    strict: false,
  });
  return values;
}

export function parseJsonSafe(raw, fallback = null) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// Hub 자동 재시작 (Pipe+HTTP 모두 실패 시 1회 시도, 최대 4초 대기)
async function tryRestartHub() {
  const serverPath = join(PROJECT_ROOT, 'hub', 'server.mjs');
  if (!existsSync(serverPath)) return false;

  if (existsSync(HUB_PID_FILE)) {
    try {
      const info = JSON.parse(readFileSync(HUB_PID_FILE, 'utf8'));
      if (info.pid) {
        try { process.kill(info.pid, 0); return false; } // still alive
        catch (e) { if (e.code === 'EPERM') return false; } // alive, no permission
      }
    } catch {} // corrupt PID file, proceed with restart
  }

  try {
    const logDir = join(process.cwd(), '.tfx', 'logs');
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    const logFile = join(logDir, 'hub-restart.log');
    const logFd = openSync(logFile, 'a');
    const child = spawn(process.execPath, [serverPath], {
      detached: true,
      stdio: ['ignore', 'ignore', logFd],
      windowsHide: true,
    });
    child.unref();
  } catch {
    return false;
  }

  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`${getHubUrl()}/status`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.hub?.state === 'healthy') return true;
      }
    } catch {}
  }
  return false;
}

async function requestHub(operation, body, timeoutMs = 3000, fallback = null) {
  const viaPipe = operation.transport === 'command'
    ? await pipeCommand(operation.action, body, timeoutMs)
    : await pipeQuery(operation.action, body, timeoutMs);
  if (viaPipe) {
    return { transport: 'pipe', result: viaPipe };
  }

  const viaHttp = operation.httpPath
    ? await requestJson(operation.httpPath, {
      method: operation.httpMethod || 'POST',
      body: operation.httpMethod === 'GET' ? undefined : body,
      timeoutMs: Math.max(timeoutMs, 5000),
    })
    : null;
  if (viaHttp) {
    return { transport: 'http', result: viaHttp };
  }

  // Hub 재시작 시도 → Pipe/HTTP 재시도
  if (await tryRestartHub()) {
    const retryPipe = operation.transport === 'command'
      ? await pipeCommand(operation.action, body, timeoutMs)
      : await pipeQuery(operation.action, body, timeoutMs);
    if (retryPipe) {
      return { transport: 'pipe', result: retryPipe };
    }
    const retryHttp = operation.httpPath
      ? await requestJson(operation.httpPath, {
        method: operation.httpMethod || 'POST',
        body: operation.httpMethod === 'GET' ? undefined : body,
        timeoutMs: Math.max(timeoutMs, 5000),
      })
      : null;
    if (retryHttp) {
      return { transport: 'http', result: retryHttp };
    }
  }

  if (!fallback) return null;
  const viaFallback = await fallback();
  if (!viaFallback) return null;
  return { transport: 'fallback', result: viaFallback };
}

function unavailableResult() {
  return { ok: false, reason: 'hub_unavailable' };
}

function emitJson(payload) {
  if (payload !== undefined) {
    console.log(JSON.stringify(payload));
  }
  return payload?.ok !== false;
}

async function cmdRegister(args) {
  const agentId = args.agent;
  const timeoutSec = parseInt(args.timeout || '600', 10);
  const outcome = await requestHub(HUB_OPERATIONS.register, {
    agent_id: agentId,
    cli: args.cli || 'other',
    timeout_sec: timeoutSec,
    heartbeat_ttl_ms: (timeoutSec + 120) * 1000,
    topics: args.topics ? args.topics.split(',') : [],
    capabilities: args.capabilities ? args.capabilities.split(',') : ['code'],
    metadata: {
      pid: process.ppid,
      registered_at: Date.now(),
    },
  });
  const result = outcome?.result;

  if (result?.ok) {
    return emitJson({
      ok: true,
      agent_id: agentId,
      lease_expires_ms: result.data?.lease_expires_ms,
      pipe_path: result.data?.pipe_path || getHubPipePath(),
    });
  }

  return emitJson(result || unavailableResult());
}

async function cmdResult(args) {
  let output = '';
  if (args.file && existsSync(args.file)) {
    output = readFileSync(args.file, 'utf8').slice(0, 49152);
  }

  const defaultPayload = {
    agent_id: args.agent,
    exit_code: parseInt(args['exit-code'] || '0', 10),
    output_length: output.length,
    output_preview: output.slice(0, 4096),
    output_file: args.file || null,
    completed_at: Date.now(),
  };

  const outcome = await requestHub(HUB_OPERATIONS.result, {
    agent_id: args.agent,
    topic: args.topic || 'task.result',
    payload: args.payload ? parseJsonSafe(args.payload, defaultPayload) : defaultPayload,
    trace_id: args.trace || undefined,
    correlation_id: args.correlation || undefined,
  });
  const result = outcome?.result;

  if (result?.ok) {
    return emitJson({ ok: true, message_id: result.data?.message_id });
  }

  return emitJson(result || unavailableResult());
}

async function cmdControl(args) {
  const outcome = await requestHub(HUB_OPERATIONS.control, {
    from_agent: args.from || 'lead',
    to_agent: args.to,
    command: args.command,
    reason: args.reason || '',
    payload: args.payload ? parseJsonSafe(args.payload, {}) : {},
    trace_id: args.trace || undefined,
    correlation_id: args.correlation || undefined,
    ttl_ms: args['ttl-ms'] != null ? Number(args['ttl-ms']) : undefined,
  });
  const result = outcome?.result;
  return emitJson(result || unavailableResult());
}

async function cmdContext(args) {
  const outcome = await requestHub(HUB_OPERATIONS.context, {
    agent_id: args.agent,
    topics: args.topics ? args.topics.split(',') : undefined,
    max_messages: parseInt(args.max || '10', 10),
    auto_ack: true,
  });
  const result = outcome?.result;

  if (result?.ok && result.data?.messages?.length) {
    const parts = result.data.messages.map((message, index) => {
      const payload = typeof message.payload === 'string'
        ? message.payload
        : JSON.stringify(message.payload, null, 2);
      return `=== Context ${index + 1}: ${message.from_agent || 'unknown'} (${message.topic || 'unknown'}) ===\n${payload}`;
    });
    const combined = parts.join('\n\n');

    if (args.out) {
      writeFileSync(args.out, combined, 'utf8');
      return emitJson({ ok: true, count: result.data.messages.length, file: args.out });
    } else {
      return emitJson({ ok: true, count: result.data.messages.length, context: combined });
    }
  }

  if (result?.ok) {
    if (args.out) {
      return emitJson({ ok: true, count: 0 });
    }
    return emitJson({ ok: true, count: 0, context: '' });
  }

  return emitJson(result || unavailableResult());
}

async function cmdDeregister(args) {
  const outcome = await requestHub(HUB_OPERATIONS.deregister, {
    agent_id: args.agent,
  });
  const result = outcome?.result;

  if (result?.ok) {
    return emitJson({ ok: true, agent_id: args.agent, status: 'offline' });
  }

  return emitJson(result || unavailableResult());
}

async function cmdAssignAsync(args) {
  const outcome = await requestHub(HUB_OPERATIONS.assignAsync, {
    supervisor_agent: args['supervisor-agent'],
    worker_agent: args['worker-agent'],
    task: args.task,
    topic: args.topic || 'assign.job',
    payload: args.payload ? parseJsonSafe(args.payload, {}) : {},
    priority: args.priority != null ? Number(args.priority) : undefined,
    ttl_ms: args['ttl-ms'] != null ? Number(args['ttl-ms']) : undefined,
    timeout_ms: args['timeout-ms'] != null ? Number(args['timeout-ms']) : undefined,
    max_retries: args['max-retries'] != null ? Number(args['max-retries']) : undefined,
    trace_id: args.trace || undefined,
    correlation_id: args.correlation || undefined,
  });
  const result = outcome?.result;
  return emitJson(result || unavailableResult());
}

async function cmdAssignResult(args) {
  const outcome = await requestHub(HUB_OPERATIONS.assignResult, {
    job_id: args['job-id'],
    worker_agent: args['worker-agent'],
    status: args.status,
    attempt: args.attempt != null ? Number(args.attempt) : undefined,
    result: args.result ? parseJsonSafe(args.result, null) : undefined,
    error: args.error ? parseJsonSafe(args.error, null) : undefined,
    payload: args.payload ? parseJsonSafe(args.payload, {}) : {},
    metadata: args.metadata ? parseJsonSafe(args.metadata, {}) : {},
  });
  const result = outcome?.result;
  return emitJson(result || unavailableResult());
}

async function cmdAssignStatus(args) {
  const outcome = await requestHub(HUB_OPERATIONS.assignStatus, {
    job_id: args['job-id'],
  });
  const result = outcome?.result;
  return emitJson(result || unavailableResult());
}

async function cmdAssignRetry(args) {
  const outcome = await requestHub(HUB_OPERATIONS.assignRetry, {
    job_id: args['job-id'],
    reason: args.reason,
    requested_by: args['requested-by'],
  });
  const result = outcome?.result;
  return emitJson(result || unavailableResult());
}

async function cmdTeamInfo(args) {
  const body = {
    team_name: args.team,
    include_members: true,
    include_paths: true,
  };
  const outcome = await requestHub(HUB_OPERATIONS.teamInfo, body, 3000, async () => {
    const { teamInfo } = await import('./team/nativeProxy.mjs');
    return await teamInfo(body);
  });
  const result = outcome?.result;
  return emitJson(result || unavailableResult());
}

async function cmdTeamTaskList(args) {
  const body = {
    team_name: args.team,
    owner: args.owner,
    statuses: args.statuses ? args.statuses.split(',').map((status) => status.trim()).filter(Boolean) : [],
    include_internal: !!args['include-internal'],
    limit: parseInt(args.limit || '200', 10),
  };
  const outcome = await requestHub(HUB_OPERATIONS.teamTaskList, body, 3000, async () => {
    const { teamTaskList } = await import('./team/nativeProxy.mjs');
    return await teamTaskList(body);
  });
  const result = outcome?.result;
  return emitJson(result || unavailableResult());
}

async function cmdTeamTaskUpdate(args) {
  const body = {
    team_name: args.team,
    task_id: args['task-id'],
    claim: !!args.claim,
    owner: args.owner,
    status: args.status,
    subject: args.subject,
    description: args.description,
    activeForm: args['active-form'],
    add_blocks: args['add-blocks'] ? args['add-blocks'].split(',').map((value) => value.trim()).filter(Boolean) : undefined,
    add_blocked_by: args['add-blocked-by'] ? args['add-blocked-by'].split(',').map((value) => value.trim()).filter(Boolean) : undefined,
    metadata_patch: args['metadata-patch'] ? parseJsonSafe(args['metadata-patch'], null) : undefined,
    if_match_mtime_ms: args['if-match-mtime-ms'] != null ? Number(args['if-match-mtime-ms']) : undefined,
    actor: args.actor,
  };
  const outcome = await requestHub(HUB_OPERATIONS.teamTaskUpdate, body, 3000, async () => {
    const { teamTaskUpdate } = await import('./team/nativeProxy.mjs');
    return await teamTaskUpdate(body);
  });
  const result = outcome?.result;
  return emitJson(result || unavailableResult());
}

async function cmdTeamSendMessage(args) {
  const body = {
    team_name: args.team,
    from: args.from,
    to: args.to || 'team-lead',
    text: args.text,
    summary: args.summary,
    color: args.color || 'blue',
  };
  const outcome = await requestHub(HUB_OPERATIONS.teamSendMessage, body, 3000, async () => {
    const { teamSendMessage } = await import('./team/nativeProxy.mjs');
    return await teamSendMessage(body);
  });
  const result = outcome?.result;
  return emitJson(result || unavailableResult());
}

function getHubDbPath() {
  return getPipelineStateDbPath(PROJECT_ROOT);
}

async function cmdPipelineState(args) {
  const outcome = await requestHub(HUB_OPERATIONS.pipelineState, { team_name: args.team }, 3000, async () => {
    try {
      const { default: Database } = await import('better-sqlite3');
      const { ensurePipelineTable, readPipelineState } = await import('./pipeline/state.mjs');
      const dbPath = getHubDbPath();
      if (!existsSync(dbPath)) {
        return { ok: false, error: 'hub_db_not_found' };
      }
      const db = new Database(dbPath, { readonly: true });
      ensurePipelineTable(db);
      const state = readPipelineState(db, args.team);
      db.close();
      return state
        ? { ok: true, data: state }
        : { ok: false, error: 'pipeline_not_found' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  const result = outcome?.result;
  return emitJson(result || unavailableResult());
}

async function cmdPipelineAdvance(args) {
  const body = {
    team_name: args.team,
    phase: args.status, // --status를 phase로 재활용
  };
  const outcome = await requestHub(HUB_OPERATIONS.pipelineAdvance, body, 3000, async () => {
    try {
      const { default: Database } = await import('better-sqlite3');
      const { createPipeline } = await import('./pipeline/index.mjs');
      const dbPath = getHubDbPath();
      if (!existsSync(dbPath)) {
        return { ok: false, error: 'hub_db_not_found' };
      }
      const db = new Database(dbPath);
      const pipeline = createPipeline(db, args.team);
      const advanceResult = pipeline.advance(args.status);
      db.close();
      return advanceResult;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  const result = outcome?.result;
  return emitJson(result || unavailableResult());
}

async function cmdPipelineInit(args) {
  const outcome = await requestHub(HUB_OPERATIONS.pipelineInit, {
    team_name: args.team,
    fix_max: args['fix-max'] != null ? Number(args['fix-max']) : undefined,
    ralph_max: args['ralph-max'] != null ? Number(args['ralph-max']) : undefined,
  });
  const result = outcome?.result;
  return emitJson(result || unavailableResult());
}

async function cmdPipelineList() {
  const outcome = await requestHub(HUB_OPERATIONS.pipelineList, {});
  const result = outcome?.result;
  return emitJson(result || unavailableResult());
}

async function cmdPing() {
  const outcome = await requestHub(HUB_OPERATIONS.hubStatus, { scope: 'hub' }, 2000);

  if (outcome?.transport === 'pipe' && outcome.result?.ok) {
    return emitJson({
      ok: true,
      hub: outcome.result.data?.hub?.state || 'healthy',
      pipe_path: getHubPipePath(),
      transport: 'pipe',
    });
  }

  if (outcome?.transport === 'http' && outcome.result) {
    const data = outcome.result;
    return emitJson({
      ok: true,
      hub: data.hub?.state,
      sessions: data.sessions,
      pipe_path: data.pipe?.path || data.pipe_path || null,
      transport: 'http',
    });
  }

  return emitJson(unavailableResult());
}

async function cmdDelegatorDelegate(args) {
  const body = {
    prompt: args.text || args.prompt,
    provider: args.provider || 'auto',
    mode: args.mode || 'sync',
    agent_type: args.agent || 'executor',
    mcp_profile: args['mcp-profile'] || 'auto',
    session_key: args['session-key'] || undefined,
    timeout_ms: args['timeout-ms'] != null ? Number(args['timeout-ms']) : undefined,
  };
  const timeoutMs = body.mode === 'async' ? 10000 : 120000;
  const outcome = await requestHub(HUB_OPERATIONS.delegatorDelegate, body, timeoutMs);
  return emitJson(outcome?.result || unavailableResult());
}

async function cmdDelegatorReply(args) {
  const body = {
    job_id: args['job-id'],
    reply: args.text || args.reply,
    done: !!args.done,
  };
  const outcome = await requestHub(HUB_OPERATIONS.delegatorReply, body, 120000);
  return emitJson(outcome?.result || unavailableResult());
}

async function cmdDelegatorStatus(args) {
  const body = {
    job_id: args['job-id'],
  };
  const outcome = await requestHub(HUB_OPERATIONS.delegatorStatus, body, 5000);
  return emitJson(outcome?.result || unavailableResult());
}

export async function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  switch (cmd) {
    case 'register': return await cmdRegister(args);
    case 'result': return await cmdResult(args);
    case 'control': return await cmdControl(args);
    case 'context': return await cmdContext(args);
    case 'deregister': return await cmdDeregister(args);
    case 'assign-async': return await cmdAssignAsync(args);
    case 'assign-result': return await cmdAssignResult(args);
    case 'assign-status': return await cmdAssignStatus(args);
    case 'assign-retry': return await cmdAssignRetry(args);
    case 'team-info': return await cmdTeamInfo(args);
    case 'team-task-list': return await cmdTeamTaskList(args);
    case 'team-task-update': return await cmdTeamTaskUpdate(args);
    case 'team-send-message': return await cmdTeamSendMessage(args);
    case 'pipeline-state': return await cmdPipelineState(args);
    case 'pipeline-advance': return await cmdPipelineAdvance(args);
    case 'pipeline-init': return await cmdPipelineInit(args);
    case 'pipeline-list': return await cmdPipelineList(args);
    case 'ping': return await cmdPing(args);
    case 'delegator-delegate': return await cmdDelegatorDelegate(args);
    case 'delegator-reply': return await cmdDelegatorReply(args);
    case 'delegator-status': return await cmdDelegatorStatus(args);
    default:
      console.error('사용법: bridge.mjs <register|result|control|context|deregister|assign-async|assign-result|assign-status|assign-retry|team-info|team-task-list|team-task-update|team-send-message|pipeline-state|pipeline-advance|pipeline-init|pipeline-list|ping|delegator-delegate|delegator-reply|delegator-status> [--옵션]');
      process.exit(1);
  }
}

const selfRun = process.argv[1]?.replace(/\\/g, '/').endsWith('hub/bridge.mjs');
if (selfRun) {
  process.exitCode = await main() ? 0 : 1;
}
