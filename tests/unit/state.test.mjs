import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acquireLock,
  getVersionHash,
  isServerHealthy,
  readState,
  releaseLock,
  writeState,
} from '../../hub/state.mjs';

const TEMP_DIRS = [];

function makeTempStateDir() {
  const dir = mkdtempSync(join(tmpdir(), 'tfx-state-test-'));
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

describe('hub/state.mjs', () => {
  it('writeState/readState는 state를 round-trip 한다', () => {
    const stateDir = makeTempStateDir();
    const expected = {
      pid: 12345,
      port: 27888,
      version: '9.8.2-deadbee',
      sessionId: 'session-1',
      startedAt: '2026-04-03T00:00:00.000Z',
    };

    writeState(expected);
    const actual = readState();

    assert.deepEqual(actual, expected);
    assert.deepEqual(
      readdirSync(stateDir).filter((name) => name.includes('.tmp')),
      [],
    );
  });

  it('writeState는 기존 파일을 덮어쓰고 유효한 JSON만 남긴다', () => {
    makeTempStateDir();

    writeState({
      pid: 1,
      port: 27888,
      version: 'first',
      sessionId: 'a',
      startedAt: '2026-04-03T00:00:00.000Z',
    });
    writeState({
      pid: 2,
      port: 27889,
      version: 'second',
      sessionId: 'b',
      startedAt: '2026-04-03T01:00:00.000Z',
    });

    const raw = readFileSync(join(process.env.TFX_HUB_STATE_DIR, 'hub-state.json'), 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw));
    assert.equal(readState()?.version, 'second');
  });

  it('acquireLock는 경합 시 timeout 후 실패하고 release 후 재획득 가능하다', async () => {
    const stateDir = makeTempStateDir();
    const lockPath = join(stateDir, 'hub-start.lock');

    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));

    await assert.rejects(
      acquireLock({ timeoutMs: 120, pollMs: 10, lockPath }),
      /lock busy/i,
    );

    rmSync(lockPath, { force: true });
    await assert.doesNotReject(acquireLock({ timeoutMs: 120, pollMs: 10, lockPath }));
  });

  it('getVersionHash는 package version 기반 문자열을 반환한다', () => {
    const version = getVersionHash({ force: true });
    assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9a-f]+)?$/i);
  });

  it('isServerHealthy는 /health ok 응답을 감지한다', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
      assert.equal(await isServerHealthy(port, { timeoutMs: 500 }), true);
      assert.equal(await isServerHealthy(port + 1, { timeoutMs: 100 }), false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
