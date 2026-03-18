// tests/integration/bridge-pipe.test.mjs — bridge.mjs pipe 우선 / HTTP fallback 테스트
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { startHub } from '../../hub/server.mjs';

const execFileAsync = promisify(execFile);

function tempDbPath() {
  const dir = join(tmpdir(), `tfx-bridge-pipe-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, 'test.db');
}

const TEST_PORT = 28200 + Math.floor(Math.random() * 100);

describe('bridge.mjs pipe-first', () => {
  let hub;
  let dbPath;
  let baseUrl;

  before(async () => {
    dbPath = tempDbPath();
    hub = await startHub({ port: TEST_PORT, dbPath, host: '127.0.0.1' });
    baseUrl = `http://127.0.0.1:${TEST_PORT}`;
  });

  after(async () => {
    if (hub?.stop) await hub.stop();
    try { rmSync(join(dbPath, '..'), { recursive: true, force: true }); } catch {}
  });

  async function execBridge(args, env = {}) {
    const { stdout } = await execFileAsync(process.execPath, ['hub/bridge.mjs', ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TFX_HUB_URL: baseUrl,
        TFX_HUB_PIPE: hub?.pipe_path || hub?.pipePath,
        ...env,
      },
    });
    return JSON.parse(stdout.trim());
  }

  it('ping은 pipe 연결이 가능하면 pipe transport를 사용해야 한다', async () => {
    const result = await execBridge(['ping'], {
      TFX_HUB_PIPE: hub.pipePath,
      TFX_HUB_URL: baseUrl,
    });
    assert.equal(result.ok, true);
    assert.equal(result.transport, 'pipe');
  });

  it('pipe 실패 시 HTTP로 fallback 해야 한다', async () => {
    const result = await execBridge(['ping'], {
      TFX_HUB_PIPE: process.platform === 'win32' ? '\\.\\pipe\\missing-triflux-test' : '/tmp/missing-triflux-test.sock',
      TFX_HUB_URL: baseUrl,
    });
    assert.equal(result.ok, true);
    assert.equal(result.transport, 'http');
  });
});
