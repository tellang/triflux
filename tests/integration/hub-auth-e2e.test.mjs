import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { toBashPath, BASH_EXE } from '../helpers/bash-path.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..', '..');
const ROUTE_SCRIPT = toBashPath(resolve(PROJECT_ROOT, 'scripts', 'tfx-route.sh'));
const FIXTURE_BIN = toBashPath(resolve(PROJECT_ROOT, 'tests', 'fixtures', 'bin'));
const HUB_SERVER_URL = pathToFileURL(resolve(PROJECT_ROOT, 'hub', 'server.mjs')).href;
const HUB_BRIDGE_URL = pathToFileURL(resolve(PROJECT_ROOT, 'hub', 'bridge.mjs')).href;
const SHARED_HOME_DIR = mkdtempSync(join(tmpdir(), 'hub-auth-e2e-shared-'));

process.on('exit', () => {
  try {
    rmSync(SHARED_HOME_DIR, { recursive: true, force: true });
  } catch {}
});

function tempDbPath(rootDir) {
  const dbDir = join(rootDir, '.claude', 'cache', 'tfx-hub');
  mkdirSync(dbDir, { recursive: true });
  return join(dbDir, `hub-auth-${randomUUID()}.db`);
}

function randomPort() {
  return 28400 + Math.floor(Math.random() * 1000);
}

function withEnv(overrides, fn) {
  const previous = new Map();

  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of previous) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

async function createHubHarness({ token } = {}) {
  const homeDir = SHARED_HOME_DIR;
  let hub = null;
  let port = 0;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    port = randomPort();
    const dbPath = tempDbPath(homeDir);

    try {
      hub = await withEnv({
        HOME: homeDir,
        USERPROFILE: homeDir,
        TFX_HUB_TOKEN: token ?? null,
      }, async () => {
        const { startHub } = await import(`${HUB_SERVER_URL}?nonce=${Date.now()}-${Math.random()}`);
        return await startHub({
          port,
          dbPath,
          host: '127.0.0.1',
          sessionId: `hub-auth-e2e-${randomUUID()}`,
        });
      });
      break;
    } catch (error) {
      if (attempt === 4 || (error?.code !== 'EADDRINUSE' && error?.code !== 'EACCES')) {
        throw error;
      }
    }
  }

  return {
    homeDir,
    baseUrl: `http://127.0.0.1:${port}`,
    hub,
    cleanup: async () => {
      await withEnv({
        HOME: homeDir,
        USERPROFILE: homeDir,
      }, async () => {
        if (hub?.stop) await hub.stop();
      });
    },
  };
}

async function loadBridge(homeDir, env = {}) {
  return await withEnv({
    HOME: homeDir,
    USERPROFILE: homeDir,
    ...env,
  }, async () => {
    return await import(`${HUB_BRIDGE_URL}?nonce=${Date.now()}-${Math.random()}`);
  });
}

async function bridgeRequestJson({ homeDir, baseUrl, tokenEnv, path, body }) {
  const bridge = await loadBridge(homeDir, {
    TFX_HUB_URL: baseUrl,
    TFX_HUB_TOKEN: tokenEnv ?? null,
  });

  return await withEnv({
    HOME: homeDir,
    USERPROFILE: homeDir,
    TFX_HUB_URL: baseUrl,
    TFX_HUB_TOKEN: tokenEnv ?? null,
  }, async () => {
    return await bridge.requestJson(path, { body, timeoutMs: 5000 });
  });
}

function createTeamTask(homeDir, { teamName, taskId, status = 'pending' }) {
  const teamDir = join(homeDir, '.claude', 'teams', teamName);
  const inboxesDir = join(teamDir, 'inboxes');
  const tasksDir = join(homeDir, '.claude', 'tasks', teamName);
  const taskPath = join(tasksDir, `${taskId}.json`);

  mkdirSync(inboxesDir, { recursive: true });
  mkdirSync(tasksDir, { recursive: true });

  writeFileSync(
    join(teamDir, 'config.json'),
    JSON.stringify({ description: 'hub auth e2e test team' }, null, 2),
    'utf8',
  );

  writeFileSync(
    taskPath,
    JSON.stringify({
      id: taskId,
      status,
      subject: 'Hub auth e2e task',
      metadata: {},
    }, null, 2),
    'utf8',
  );

  return taskPath;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function createBridgeLoggerScript(homeDir) {
  const scriptPath = join(homeDir, 'bridge-logger.mjs');
  const logPath = join(homeDir, 'bridge-logger.log');

  writeFileSync(scriptPath, `#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const logPath = process.env.BRIDGE_LOG_PATH;
if (logPath) {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, \`\${JSON.stringify({
    argv: process.argv.slice(2),
    token: process.env.TFX_HUB_TOKEN ?? '',
  })}\\n\`, 'utf8');
}

const cmd = process.argv[2] || '';

switch (cmd) {
  case 'team-task-update':
    console.log(JSON.stringify({ ok: true, data: { claimed: process.argv.includes('--claim'), updated: true } }));
    break;
  case 'team-send-message':
    console.log(JSON.stringify({ ok: true, data: { message_id: 'bridge-log-message' } }));
    break;
  case 'result':
    console.log(JSON.stringify({ ok: true, data: { message_id: 'bridge-log-result' } }));
    break;
  default:
    console.log(JSON.stringify({ ok: true, data: {} }));
    break;
}
`, 'utf8');

  return { scriptPath, logPath };
}

function runRouteWithBridgeLogger({ homeDir, tokenEnv = '' }) {
  const workspaceDir = join(homeDir, 'workspace');
  mkdirSync(workspaceDir, { recursive: true });

  const { scriptPath, logPath } = createBridgeLoggerScript(homeDir);

  const result = spawnSync(
    BASH_EXE,
    [ROUTE_SCRIPT, 'executor', 'hub-auth-route', 'minimal', '5'],
    {
      cwd: workspaceDir,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        PATH: `${FIXTURE_BIN}:${process.env.PATH || ''}`,
        NODE_BIN: process.execPath,
        CODEX_BIN: 'codex',
        FAKE_CODEX_MODE: 'exec',
        TFX_CODEX_TRANSPORT: 'exec',
        TFX_CLI_MODE: 'auto',
        TFX_NO_CLAUDE_NATIVE: '0',
        TFX_WORKER_INDEX: '',
        TFX_SEARCH_TOOL: '',
        TFX_TEAM_NAME: `route-auth-${randomUUID().slice(0, 8)}`,
        TFX_TEAM_TASK_ID: 'route-auth-task',
        TFX_TEAM_AGENT_NAME: 'executor-worker-auth',
        TFX_TEAM_LEAD_NAME: 'team-lead',
        TFX_BRIDGE_SCRIPT: scriptPath,
        BRIDGE_LOG_PATH: logPath,
        TFX_HUB_TOKEN: tokenEnv,
        TFX_RESULT_DIR: join(homeDir, '.claude', 'tfx-results'),
      },
    },
  );

  const logLines = existsSync(logPath)
    ? readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    : [];

  return { result, logLines };
}

function combinedOutput(result) {
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

describe('hub auth E2E', () => {
  it('토큰이 없으면 localhost-only hub가 bridge 요청을 인증 없이 허용해야 한다', async () => {
    const harness = await createHubHarness();
    const teamName = `localhost-only-${randomUUID().slice(0, 8)}`;
    const taskId = 'task-localhost-only';
    const taskPath = createTeamTask(harness.homeDir, { teamName, taskId });

    try {
      const body = await bridgeRequestJson({
        homeDir: harness.homeDir,
        baseUrl: harness.baseUrl,
        tokenEnv: null,
        path: '/bridge/team/task-update',
        body: {
          team_name: teamName,
          task_id: taskId,
          claim: true,
          owner: 'executor-worker-auth',
          status: 'in_progress',
        },
      });

      assert.equal(body.ok, true);

      const task = readJson(taskPath);
      assert.equal(task.status, 'in_progress');
      assert.equal(task.owner, 'executor-worker-auth');
    } finally {
      await harness.cleanup();
    }
  });

  it('토큰이 설정되면 보호된 bridge 엔드포인트는 Bearer 없이는 401이어야 한다', async () => {
    const harness = await createHubHarness({ token: 'hub-auth-required-token' });

    try {
      const res = await fetch(`${harness.baseUrl}/bridge/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: 'auth-missing', cli: 'codex' }),
      });

      assert.equal(res.status, 401);
      assert.equal(res.headers.get('www-authenticate'), 'Bearer realm="tfx-hub"');

      const body = await res.json();
      assert.equal(body.ok, false);
      assert.equal(body.error, 'Unauthorized');
    } finally {
      await harness.cleanup();
    }
  });

  it('hub/server가 저장한 토큰 파일을 bridge.mjs가 Authorization 헤더로 전달해야 한다', async () => {
    const token = 'hub-auth-file-token';
    const harness = await createHubHarness({ token });
    const teamName = `token-file-${randomUUID().slice(0, 8)}`;
    const taskId = 'task-token-file';
    const taskPath = createTeamTask(harness.homeDir, { teamName, taskId });
    const tokenFile = join(harness.homeDir, '.claude', '.tfx-hub-token');

    try {
      assert.equal(existsSync(tokenFile), true);
      assert.equal(readFileSync(tokenFile, 'utf8').trim(), token);

      const body = await bridgeRequestJson({
        homeDir: harness.homeDir,
        baseUrl: harness.baseUrl,
        tokenEnv: null,
        path: '/bridge/team/task-update',
        body: {
          team_name: teamName,
          task_id: taskId,
          claim: true,
          owner: 'executor-worker-auth',
          status: 'in_progress',
        },
      });

      assert.equal(body.ok, true);

      const task = readJson(taskPath);
      assert.equal(task.status, 'in_progress');
      assert.equal(task.owner, 'executor-worker-auth');
    } finally {
      await harness.cleanup();
    }
  });

  it('잘못된 토큰은 bridge 경로에서 거부되고 task 상태가 바뀌지 않아야 한다', async () => {
    const harness = await createHubHarness({ token: 'hub-auth-correct-token' });
    const teamName = `wrong-token-${randomUUID().slice(0, 8)}`;
    const taskId = 'task-wrong-token';
    const taskPath = createTeamTask(harness.homeDir, { teamName, taskId });

    try {
      const body = await bridgeRequestJson({
        homeDir: harness.homeDir,
        baseUrl: harness.baseUrl,
        tokenEnv: 'hub-auth-wrong-token',
        path: '/bridge/team/task-update',
        body: {
          team_name: teamName,
          task_id: taskId,
          claim: true,
          owner: 'executor-worker-auth',
          status: 'in_progress',
        },
      });

      assert.deepEqual(body, { ok: false, error: 'Unauthorized' });

      const task = readJson(taskPath);
      assert.equal(task.status, 'pending');
      assert.equal(task.owner, undefined);
      assert.equal(task.metadata?.result, undefined);
    } finally {
      await harness.cleanup();
    }
  });

  it('tfx-route.sh는 bridge 스크립트에 TFX_HUB_TOKEN을 그대로 전달해야 한다', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'hub-auth-route-'));

    try {
      const { result, logLines } = runRouteWithBridgeLogger({
        homeDir,
        tokenEnv: 'route-bridge-token',
      });

      assert.equal(result.status, 0, combinedOutput(result));
      assert.ok(logLines.length >= 3, combinedOutput(result));

      for (const entry of logLines) {
        assert.equal(entry.token, 'route-bridge-token');
      }

      assert.equal(logLines[0].argv[0], 'team-task-update');
      assert.ok(logLines[0].argv.includes('--claim'));
      assert.equal(logLines[1].argv[0], 'team-send-message');
      assert.equal(logLines.at(-1)?.argv[0], 'result');
    } finally {
      try {
        rmSync(homeDir, { recursive: true, force: true });
      } catch {}
    }
  });
});
