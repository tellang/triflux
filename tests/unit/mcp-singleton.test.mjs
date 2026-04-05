import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getOrCreateServer } from '../../hub/server.mjs';
import { writeState, releaseLock } from '../../hub/state.mjs';

const TEMP_DIRS = [];

function makeTempStateDir() {
  const dir = mkdtempSync(join(tmpdir(), 'tfx-singleton-test-'));
  TEMP_DIRS.push(dir);
  process.env.TFX_HUB_STATE_DIR = dir;
  return dir;
}

afterEach(() => {
  releaseLock();
  delete process.env.TFX_HUB_STATE_DIR;
  while (TEMP_DIRS.length > 0) {
    try { rmSync(TEMP_DIRS.pop(), { recursive: true, force: true }); } catch {}
  }
});

describe('getOrCreateServer()', () => {
  it('기존 서버 없음 → startHub 호출, reused: false', async () => {
    makeTempStateDir();

    let bootCalled = false;
    const fakeBoot = async () => {
      bootCalled = true;
      return { port: 29999, pid: 12345, url: 'http://127.0.0.1:29999/mcp' };
    };

    const result = await getOrCreateServer({
      _deps: {
        isHealthy: async () => true,
        getInfo: () => null,
        startHub: fakeBoot,
      },
    });

    assert.equal(result.reused, false);
    assert.equal(bootCalled, true);
    assert.equal(result.port, 29999);
  });

  it('기존 서버 healthy → 재사용, reused: true', async () => {
    makeTempStateDir();
    writeState({
      pid: process.pid,
      port: 29998,
      version: '1.0.0',
      sessionId: 'test-session',
      startedAt: new Date().toISOString(),
    });

    const result = await getOrCreateServer({
      _deps: {
        isHealthy: async () => true,
        getInfo: () => ({ url: 'http://127.0.0.1:29998/mcp', pid: process.pid, port: 29998 }),
        startHub: async () => { throw new Error('startHub이 호출되면 안 됨'); },
      },
    });

    assert.equal(result.reused, true);
    assert.equal(result.port, 29998);
    assert.equal(result.pid, process.pid);
    assert.ok(result.url.includes('29998'));
  });

  it('PID 생존 + health 실패 → startHub 호출, reused: false', async () => {
    makeTempStateDir();
    writeState({
      pid: process.pid,
      port: 29997,
      version: '1.0.0',
      sessionId: 'test-session',
      startedAt: new Date().toISOString(),
    });

    let bootCalled = false;
    const fakeBoot = async () => {
      bootCalled = true;
      return { port: 29997, pid: process.pid, url: 'http://127.0.0.1:29997/mcp' };
    };

    const result = await getOrCreateServer({
      _deps: {
        isHealthy: async () => false,
        getInfo: () => null,
        startHub: fakeBoot,
      },
    });

    assert.equal(result.reused, false);
    assert.equal(bootCalled, true);
  });

  it('state에 pid/port 불완전 → startHub 호출, reused: false', async () => {
    makeTempStateDir();
    writeState({
      pid: null,
      port: 29996,
      version: '1.0.0',
      sessionId: 'test-session',
      startedAt: new Date().toISOString(),
    });

    let bootCalled = false;
    const fakeBoot = async () => {
      bootCalled = true;
      return { port: 29996, pid: 77777, url: 'http://127.0.0.1:29996/mcp' };
    };

    const result = await getOrCreateServer({
      _deps: {
        isHealthy: async () => true,
        getInfo: () => null,
        startHub: fakeBoot,
      },
    });

    assert.equal(result.reused, false);
    assert.equal(bootCalled, true);
  });

  it('getInfo가 url 미반환 → 기본 url 폴백', async () => {
    makeTempStateDir();
    writeState({
      pid: process.pid,
      port: 29995,
      version: '1.0.0',
      sessionId: 'test-session',
      startedAt: new Date().toISOString(),
    });

    const result = await getOrCreateServer({
      _deps: {
        isHealthy: async () => true,
        getInfo: () => null,
        startHub: async () => { throw new Error('startHub이 호출되면 안 됨'); },
      },
    });

    assert.equal(result.reused, true);
    assert.equal(result.url, 'http://127.0.0.1:29995/mcp');
  });
});
