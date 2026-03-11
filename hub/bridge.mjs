#!/usr/bin/env node
// hub/bridge.mjs — tfx-route.sh ↔ tfx-hub 브릿지 CLI
//
// Named Pipe/Unix Socket 제어 채널을 우선 사용하고,
// 연결이 없을 때만 HTTP /bridge/* 엔드포인트로 내려간다.

import net from 'node:net';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs as nodeParseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';

const HUB_PID_FILE = join(homedir(), '.claude', 'cache', 'tfx-hub', 'hub.pid');

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

export async function post(path, body, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${getHubUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return await res.json();
  } catch {
    clearTimeout(timer);
    return null;
  }
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
    const timer = setTimeout(() => {
      try { socket.destroy(); } catch {}
      resolve(null);
    }, timeoutMs);

    const finish = (result) => {
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
      topic: { type: 'string' },
      trace: { type: 'string' },
      correlation: { type: 'string' },
      'exit-code': { type: 'string' },
      max: { type: 'string' },
      out: { type: 'string' },
      team: { type: 'string' },
      'task-id': { type: 'string' },
      owner: { type: 'string' },
      status: { type: 'string' },
      statuses: { type: 'string' },
      claim: { type: 'boolean' },
      actor: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      text: { type: 'string' },
      summary: { type: 'string' },
      color: { type: 'string' },
      limit: { type: 'string' },
      'include-internal': { type: 'boolean' },
      subject: { type: 'string' },
      description: { type: 'string' },
      'active-form': { type: 'string' },
      'add-blocks': { type: 'string' },
      'add-blocked-by': { type: 'string' },
      'metadata-patch': { type: 'string' },
      'if-match-mtime-ms': { type: 'string' },
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

async function runPipeFirst(commandName, queryName, httpPath, body, timeoutMs = 3000) {
  const viaPipe = commandName
    ? await pipeCommand(commandName, body, timeoutMs)
    : await pipeQuery(queryName, body, timeoutMs);
  if (viaPipe) return viaPipe;
  return await post(httpPath, body, Math.max(timeoutMs, 5000));
}

async function cmdRegister(args) {
  const agentId = args.agent;
  const timeoutSec = parseInt(args.timeout || '600', 10);
  const result = await runPipeFirst('register', null, '/bridge/register', {
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

  if (result?.ok) {
    console.log(JSON.stringify({
      ok: true,
      agent_id: agentId,
      lease_expires_ms: result.data?.lease_expires_ms,
      pipe_path: result.data?.pipe_path || getHubPipePath(),
    }));
  } else {
    console.log(JSON.stringify({ ok: false, reason: 'hub_unavailable' }));
  }
}

async function cmdResult(args) {
  let output = '';
  if (args.file && existsSync(args.file)) {
    output = readFileSync(args.file, 'utf8').slice(0, 49152);
  }

  const result = await runPipeFirst('result', null, '/bridge/result', {
    agent_id: args.agent,
    topic: args.topic || 'task.result',
    payload: {
      agent_id: args.agent,
      exit_code: parseInt(args['exit-code'] || '0', 10),
      output_length: output.length,
      output_preview: output.slice(0, 4096),
      output_file: args.file || null,
      completed_at: Date.now(),
    },
    trace_id: args.trace || undefined,
    correlation_id: args.correlation || undefined,
  });

  if (result?.ok) {
    console.log(JSON.stringify({ ok: true, message_id: result.data?.message_id }));
  } else {
    console.log(JSON.stringify({ ok: false, reason: 'hub_unavailable' }));
  }
}

async function cmdContext(args) {
  const result = await runPipeFirst(null, 'drain', '/bridge/context', {
    agent_id: args.agent,
    topics: args.topics ? args.topics.split(',') : undefined,
    max_messages: parseInt(args.max || '10', 10),
    auto_ack: true,
  });

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
      console.log(JSON.stringify({ ok: true, count: result.data.messages.length, file: args.out }));
    } else {
      console.log(combined);
    }
    return;
  }

  if (args.out) console.log(JSON.stringify({ ok: true, count: 0 }));
}

async function cmdDeregister(args) {
  const result = await runPipeFirst('deregister', null, '/bridge/deregister', {
    agent_id: args.agent,
  });

  if (result?.ok) {
    console.log(JSON.stringify({ ok: true, agent_id: args.agent, status: 'offline' }));
  } else {
    console.log(JSON.stringify({ ok: false, reason: 'hub_unavailable' }));
  }
}

async function cmdTeamInfo(args) {
  const result = await post('/bridge/team/info', {
    team_name: args.team,
    include_members: true,
    include_paths: true,
  });
  console.log(JSON.stringify(result || { ok: false, reason: 'hub_unavailable' }));
}

async function cmdTeamTaskList(args) {
  const result = await post('/bridge/team/task-list', {
    team_name: args.team,
    owner: args.owner,
    statuses: args.statuses ? args.statuses.split(',').map((status) => status.trim()).filter(Boolean) : [],
    include_internal: !!args['include-internal'],
    limit: parseInt(args.limit || '200', 10),
  });
  console.log(JSON.stringify(result || { ok: false, reason: 'hub_unavailable' }));
}

async function cmdTeamTaskUpdate(args) {
  const result = await post('/bridge/team/task-update', {
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
  });
  console.log(JSON.stringify(result || { ok: false, reason: 'hub_unavailable' }));
}

async function cmdTeamSendMessage(args) {
  const result = await post('/bridge/team/send-message', {
    team_name: args.team,
    from: args.from,
    to: args.to || 'team-lead',
    text: args.text,
    summary: args.summary,
    color: args.color || 'blue',
  });
  console.log(JSON.stringify(result || { ok: false, reason: 'hub_unavailable' }));
}

async function cmdPing() {
  const viaPipe = await pipeQuery('status', { scope: 'hub' }, 2000);
  if (viaPipe?.ok) {
    console.log(JSON.stringify({
      ok: true,
      hub: viaPipe.data?.hub?.state || 'healthy',
      pipe_path: getHubPipePath(),
      transport: 'pipe',
    }));
    return;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${getHubUrl()}/status`, { signal: controller.signal });
    clearTimeout(timer);
    const data = await res.json();
    console.log(JSON.stringify({
      ok: true,
      hub: data.hub?.state,
      sessions: data.sessions,
      pipe_path: data.pipe?.path || data.pipe_path || null,
      transport: 'http',
    }));
  } catch {
    console.log(JSON.stringify({ ok: false, reason: 'hub_unavailable' }));
  }
}

export async function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  switch (cmd) {
    case 'register': await cmdRegister(args); break;
    case 'result': await cmdResult(args); break;
    case 'context': await cmdContext(args); break;
    case 'deregister': await cmdDeregister(args); break;
    case 'team-info': await cmdTeamInfo(args); break;
    case 'team-task-list': await cmdTeamTaskList(args); break;
    case 'team-task-update': await cmdTeamTaskUpdate(args); break;
    case 'team-send-message': await cmdTeamSendMessage(args); break;
    case 'ping': await cmdPing(args); break;
    default:
      console.error('사용법: bridge.mjs <register|result|context|deregister|team-info|team-task-list|team-task-update|team-send-message|ping> [--옵션]');
      process.exit(1);
  }
}

const selfRun = process.argv[1]?.replace(/\\/g, '/').endsWith('hub/bridge.mjs');
if (selfRun) {
  await main();
}
