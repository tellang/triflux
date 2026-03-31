import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toBashPath, BASH_EXE } from '../helpers/bash-path.mjs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(TEST_DIR, '..', '..');
const SERVER_FILE = resolve(PROJECT_ROOT, 'hub', 'workers', 'delegator-mcp.mjs');
const FAKE_CODEX = resolve(PROJECT_ROOT, 'tests', 'fixtures', 'fake-codex.mjs');
const FAKE_GEMINI = resolve(PROJECT_ROOT, 'tests', 'fixtures', 'fake-gemini-cli.mjs');
const FAKE_ROUTE = resolve(PROJECT_ROOT, 'tests', 'fixtures', 'fake-route.sh');
const SEARCH_ENGINE_CACHE_FILE = resolve(PROJECT_ROOT, '.omc', 'state', 'search-engines.json');

function writeSearchEngineCache(payload) {
  mkdirSync(dirname(SEARCH_ENGINE_CACHE_FILE), { recursive: true });
  writeFileSync(SEARCH_ENGINE_CACHE_FILE, JSON.stringify(payload, null, 2));
}

function readSearchEngineCacheBackup() {
  return existsSync(SEARCH_ENGINE_CACHE_FILE)
    ? readFileSync(SEARCH_ENGINE_CACHE_FILE, 'utf8')
    : null;
}

function restoreSearchEngineCacheBackup(original) {
  if (typeof original === 'string') {
    writeFileSync(SEARCH_ENGINE_CACHE_FILE, original);
    return;
  }
  rmSync(SEARCH_ENGINE_CACHE_FILE, { force: true });
}

async function createClient(env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_FILE],
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      ...env,
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'delegator-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

async function closeClient(client, transport) {
  const pid = transport.pid;
  const settled = Promise.allSettled([
    client.close().catch(() => {}),
    transport.close().catch(() => {}),
  ]);
  await Promise.race([
    settled,
    new Promise((resolve) => setTimeout(resolve, 250)),
  ]);
  if (pid) {
    try { process.kill(pid); } catch {}
  }
}

async function waitForCompletion(client, jobId) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await client.callTool({
      name: 'triflux-delegate-status',
      arguments: { jobId },
    });
    const payload = result.structuredContent;
    if (payload?.status === 'completed' || payload?.status === 'failed') {
      return payload;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`job ${jobId} did not complete in time`);
}

describe('delegator-mcp stdio server', () => {
  after(() => setTimeout(() => process.exit(0), 100));

  it('필수 도구를 노출해야 한다', async () => {
    const { client, transport } = await createClient({
      TFX_DELEGATOR_CODEX_COMMAND: process.execPath,
      TFX_DELEGATOR_CODEX_ARGS_JSON: JSON.stringify([FAKE_CODEX, 'mcp-server']),
    });

    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      assert.deepEqual(names.sort(), ['triflux-delegate', 'triflux-delegate-reply', 'triflux-delegate-status']);
    } finally {
      await closeClient(client, transport);
    }
  });

  it('codex direct sync 경로에서 sessionKey로 warm session을 재사용해야 한다', async () => {
    const { client, transport } = await createClient({
      TFX_DELEGATOR_CODEX_COMMAND: process.execPath,
      TFX_DELEGATOR_CODEX_ARGS_JSON: JSON.stringify([FAKE_CODEX, 'mcp-server']),
    });

    try {
      const first = await client.callTool({
        name: 'triflux-delegate',
        arguments: {
          provider: 'codex',
          mode: 'sync',
          agentType: 'executor',
          sessionKey: 'task-1',
          prompt: 'remember:ORANGE',
        },
      });
      const second = await client.callTool({
        name: 'triflux-delegate',
        arguments: {
          provider: 'codex',
          mode: 'sync',
          agentType: 'executor',
          sessionKey: 'task-1',
          prompt: 'what did i say?',
        },
      });

      assert.equal(first.structuredContent.output, 'ORANGE');
      assert.equal(second.structuredContent.output, 'ORANGE');
      assert.equal(first.structuredContent.thread_id, second.structuredContent.thread_id);
      assert.equal(second.structuredContent.transport, 'codex-mcp');
    } finally {
      await closeClient(client, transport);
    }
  });

  it('codex direct async 경로는 status polling으로 완료 결과를 돌려줘야 한다', async () => {
    const { client, transport } = await createClient({
      TFX_DELEGATOR_CODEX_COMMAND: process.execPath,
      TFX_DELEGATOR_CODEX_ARGS_JSON: JSON.stringify([FAKE_CODEX, 'mcp-server']),
    });

    try {
      const kickoff = await client.callTool({
        name: 'triflux-delegate',
        arguments: {
          provider: 'codex',
          mode: 'async',
          agentType: 'executor',
          sessionKey: 'task-async',
          prompt: 'remember:BLUE',
        },
      });

      const status = await waitForCompletion(client, kickoff.structuredContent.job_id);
      assert.equal(status.status, 'completed');
      assert.equal(status.output, 'BLUE');
      assert.equal(status.provider_resolved, 'codex');
    } finally {
      await closeClient(client, transport);
    }
  });

  it('codex direct 경로는 프롬프트/컨텍스트에 따라 MCP config를 축소해야 한다', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'triflux-delegator-'));
    const contextFile = join(tempDir, 'context.md');
    writeFileSync(contextFile, 'Capture a browser screenshot and inspect responsive UI layout.');

    const { client, transport } = await createClient({
      TFX_DELEGATOR_CODEX_COMMAND: process.execPath,
      TFX_DELEGATOR_CODEX_ARGS_JSON: JSON.stringify([FAKE_CODEX, 'mcp-server']),
    });

    try {
      const result = await client.callTool({
        name: 'triflux-delegate',
        arguments: {
          provider: 'codex',
          mode: 'sync',
          agentType: 'designer',
          prompt: 'SHOW_CONFIG',
          contextFile,
          availableServers: ['context7', 'playwright', 'brave-search', 'exa', 'tavily'],
        },
      });

      const config = JSON.parse(result.structuredContent.output);
      const allowedMcpServers = Object.keys(config.mcp_servers).sort();
      assert.deepEqual(allowedMcpServers, ['context7', 'playwright']);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      await closeClient(client, transport);
    }
  });

  it('availableServers 미지정 시 search-engines 캐시가 있어도 부분 리스트를 주입하지 않아야 한다', async () => {
    const originalCache = readSearchEngineCacheBackup();
    writeSearchEngineCache({
      checked_at: '2026-03-31T00:00:00.000Z',
      engines: [
        { name: 'context7', status: 'available' },
        { name: 'playwright', status: 'unavailable' },
        { name: 'brave-search', status: 'unavailable' },
      ],
    });

    const { client, transport } = await createClient({
      TFX_DELEGATOR_CODEX_COMMAND: process.execPath,
      TFX_DELEGATOR_CODEX_ARGS_JSON: JSON.stringify([FAKE_CODEX, 'mcp-server']),
    });

    try {
      const result = await client.callTool({
        name: 'triflux-delegate',
        arguments: {
          provider: 'codex',
          mode: 'sync',
          agentType: 'designer',
          prompt: 'SHOW_CONFIG',
        },
      });

      // 캐시의 부분 리스트가 availableServers로 주입되면 안 됨 — 교집합 필터로 MCP 서버 탈락 버그 유발
      const config = JSON.parse(result.structuredContent.output);
      assert.deepEqual(config, { mcp_servers: {} });
    } finally {
      restoreSearchEngineCacheBackup(originalCache);
      await closeClient(client, transport);
    }
  });

  it('search-engines 캐시가 없으면 기존 fallback을 유지해야 한다', async () => {
    const originalCache = readSearchEngineCacheBackup();
    rmSync(SEARCH_ENGINE_CACHE_FILE, { force: true });

    const { client, transport } = await createClient({
      TFX_DELEGATOR_CODEX_COMMAND: process.execPath,
      TFX_DELEGATOR_CODEX_ARGS_JSON: JSON.stringify([FAKE_CODEX, 'mcp-server']),
      GEMINI_BIN: process.execPath,
      GEMINI_BIN_ARGS_JSON: JSON.stringify([FAKE_GEMINI]),
      FAKE_GEMINI_ECHO_ALLOWED_MCP: '1',
    });

    try {
      const codexResult = await client.callTool({
        name: 'triflux-delegate',
        arguments: {
          provider: 'codex',
          mode: 'sync',
          agentType: 'designer',
          prompt: 'SHOW_CONFIG',
        },
      });
      const codexConfig = JSON.parse(codexResult.structuredContent.output);
      assert.deepEqual(codexConfig, { mcp_servers: {} });

      const geminiResult = await client.callTool({
        name: 'triflux-delegate',
        arguments: {
          provider: 'gemini',
          mode: 'sync',
          agentType: 'writer',
          prompt: 'cache fallback',
        },
      });
      assert.match(geminiResult.structuredContent.output, /allowed:context7,brave-search,exa/);
    } finally {
      restoreSearchEngineCacheBackup(originalCache);
      await closeClient(client, transport);
    }
  });

  it('gemini direct job은 delegate-reply로 multi-turn 대화를 이어가고 done=true 시 종료해야 한다', async () => {
    const { client, transport } = await createClient({
      GEMINI_BIN: process.execPath,
      GEMINI_BIN_ARGS_JSON: JSON.stringify([FAKE_GEMINI]),
      TFX_DELEGATOR_CODEX_COMMAND: process.execPath,
      TFX_DELEGATOR_CODEX_ARGS_JSON: JSON.stringify([FAKE_CODEX, 'mcp-server']),
    });

    try {
      const first = await client.callTool({
        name: 'triflux-delegate',
        arguments: {
          provider: 'gemini',
          mode: 'sync',
          agentType: 'writer',
          prompt: 'first turn',
        },
      });

      const jobId = first.structuredContent.job_id;
      assert.equal(typeof jobId, 'string');
      assert.equal(first.structuredContent.conversation_open, true);

      const second = await client.callTool({
        name: 'triflux-delegate-reply',
        arguments: {
          job_id: jobId,
          reply: 'second turn',
        },
      });

      assert.equal(second.structuredContent.job_id, jobId);
      assert.equal(second.structuredContent.conversation_open, true);
      assert.match(second.structuredContent.output, /first turn/);
      assert.match(second.structuredContent.output, /second turn/);

      const finalTurn = await client.callTool({
        name: 'triflux-delegate-reply',
        arguments: {
          job_id: jobId,
          reply: 'wrap up',
          done: true,
        },
      });

      assert.equal(finalTurn.structuredContent.conversation_open, false);

      const afterDone = await client.callTool({
        name: 'triflux-delegate-reply',
        arguments: {
          job_id: jobId,
          reply: 'one more',
        },
      });

      assert.equal(afterDone.isError, true);
      assert.match(afterDone.structuredContent.error, /종료된 대화|대화 컨텍스트가 없습니다/);
    } finally {
      await closeClient(client, transport);
    }
  });

  it('팀 환경이 주어지면 tfx-route.sh 경로로 위임하고 TFX_TEAM_* 를 전달해야 한다', async () => {
    const { client, transport } = await createClient({
      TFX_DELEGATOR_CODEX_COMMAND: process.execPath,
      TFX_DELEGATOR_CODEX_ARGS_JSON: JSON.stringify([FAKE_CODEX, 'mcp-server']),
      TFX_DELEGATOR_ROUTE_SCRIPT: FAKE_ROUTE,
      TFX_DELEGATOR_BASH_COMMAND: BASH_EXE,
    });

    try {
      const result = await client.callTool({
        name: 'triflux-delegate',
        arguments: {
          provider: 'gemini',
          mode: 'sync',
          agentType: 'designer',
          prompt: 'route me',
          teamName: 'alpha-team',
          teamTaskId: 'TASK-1',
          teamAgentName: 'delegator-worker',
          teamLeadName: 'team-lead',
        },
      });

      const payload = result.structuredContent;
      assert.equal(payload.transport, 'route-script');
      assert.match(payload.output, /route:designer:auto:900:route me/);
      assert.match(payload.stderr, /team=alpha-team/);
      assert.match(payload.stderr, /task=TASK-1/);
      assert.match(payload.stderr, /agent=delegator-worker/);
      assert.match(payload.stderr, /lead=team-lead/);
      assert.match(payload.stderr, /cli=gemini/);
    } finally {
      await closeClient(client, transport);
    }
  });
});
