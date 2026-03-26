// tests/integration/workers.test.mjs — subprocess worker 통합 테스트

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { toBashPath, BASH_EXE } from '../helpers/bash-path.mjs';

import { GeminiWorker } from '../../hub/workers/gemini-worker.mjs';
import { ClaudeWorker } from '../../hub/workers/claude-worker.mjs';
import { createWorker } from '../../hub/workers/factory.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(TEST_DIR, '..', '..');
const FIXTURE_DIR = resolve(PROJECT_ROOT, 'tests', 'fixtures');
const FIXTURE_BIN = toBashPath(resolve(FIXTURE_DIR, 'bin'));
const GEMINI_FIXTURE = resolve(FIXTURE_DIR, 'fake-gemini-cli.mjs');
const CLAUDE_FIXTURE = resolve(FIXTURE_DIR, 'fake-claude-cli.mjs');
const ROUTE_SCRIPT = toBashPath(resolve(PROJECT_ROOT, 'scripts', 'tfx-route.sh'));

function buildRouteEnv(extraEnv = {}) {
  return {
    ...process.env,
    PATH: `${FIXTURE_BIN}:${process.env.PATH || ''}`,
    TFX_CLI_MODE: 'auto',
    TFX_NO_CLAUDE_NATIVE: '0',
    TFX_CODEX_TRANSPORT: 'exec',
    ...extraEnv,
  };
}

describe('GeminiWorker', { timeout: 15000 }, () => {
  it('stream-json stdout를 파싱해 최종 응답을 반환해야 한다', async () => {
    const worker = new GeminiWorker({
      command: process.execPath,
      commandArgs: [GEMINI_FIXTURE],
      model: 'gemini-test-model',
      timeoutMs: 5000,
    });

    const result = await worker.run('hello gemini');
    assert.match(result.response, /gemini:hello gemini/);
    assert.equal(result.resultEvent?.usage?.totalTokens, 'hello gemini'.length);
    await worker.stop();
  });
});

describe('ClaudeWorker', { timeout: 15000 }, () => {
  it('여러 turn을 같은 세션으로 처리하고 history를 유지해야 한다', async () => {
    const worker = new ClaudeWorker({
      command: process.execPath,
      commandArgs: [CLAUDE_FIXTURE],
      timeoutMs: 5000,
      allowDangerouslySkipPermissions: true,
    });

    const first = await worker.run('first turn');
    const second = await worker.run('second turn');

    assert.equal(first.sessionId, '11111111-1111-1111-1111-111111111111');
    assert.equal(second.sessionId, first.sessionId);
    assert.match(second.response, /claude:second turn/);
    assert.equal(worker.history.length, 4);
    await worker.stop();
  });

  it('control_request를 자동 응답하고 turn을 완료해야 한다', async () => {
    const worker = new ClaudeWorker({
      command: process.execPath,
      commandArgs: [CLAUDE_FIXTURE],
      env: { FAKE_CLAUDE_REQUIRE_CONTROL: '1' },
      timeoutMs: 5000,
      allowDangerouslySkipPermissions: true,
    });

    const result = await worker.run('needs control');
    assert.match(result.response, /claude:needs control/);
    await worker.stop();
  });
});

describe('createWorker()', { timeout: 15000 }, () => {
  it('타입별 worker 인스턴스를 생성해야 한다', () => {
    assert.equal(createWorker('gemini').constructor.name, 'GeminiWorker');
    assert.equal(createWorker('claude').constructor.name, 'ClaudeWorker');
    assert.equal(createWorker('delegator').constructor.name, 'DelegatorMcpWorker');
    assert.throws(() => createWorker('unknown'), /Unknown worker type/);
  });
});

describe('tfx-route.sh wrapper integration', { timeout: 15000 }, () => {
  it('designer는 Gemini wrapper를 통해 실행되어야 한다', () => {
    const result = spawnSync(BASH_EXE, [ROUTE_SCRIPT, 'designer', 'route gemini', 'implement', '5'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      env: buildRouteEnv({
        HOME: resolve(PROJECT_ROOT, '.tmp-home-route-gemini'),
        TFX_TEAM_NAME: 'phase3-team',
        GEMINI_BIN: process.execPath,
        GEMINI_BIN_ARGS_JSON: JSON.stringify([GEMINI_FIXTURE]),
      }),
    });

    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);
    assert.match(output, /gemini:route gemini/);
    assert.match(output, /type=gemini/);
  });

  it('verifier는 기본 route table에서 claude-native 경로를 사용해야 한다', () => {
    const result = spawnSync(BASH_EXE, [ROUTE_SCRIPT, 'verifier', 'route verify', 'analyze', '5'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      env: buildRouteEnv({
        HOME: resolve(PROJECT_ROOT, '.tmp-home-route-codex'),
        TFX_TEAM_NAME: 'phase3-team',
        CODEX_BIN: 'codex',
      }),
    });

    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);
    assert.match(output, /type=claude/);
    assert.match(output, /agent=verifier/);
  });

  it('verifier는 TFX_NO_CLAUDE_NATIVE=1일 때 Codex review 경로를 사용해야 한다', () => {
    const result = spawnSync(BASH_EXE, [ROUTE_SCRIPT, 'verifier', 'route verify', 'analyze', '5'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      env: buildRouteEnv({
        HOME: resolve(PROJECT_ROOT, '.tmp-home-route-codex'),
        TFX_TEAM_NAME: 'phase3-team',
        TFX_NO_CLAUDE_NATIVE: '1',
        CODEX_BIN: 'codex',
      }),
    });

    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);
    assert.match(output, /EXEC:route verify/);
    assert.match(output, /type=codex/);
    assert.match(output, /codex_transport_effective=exec/);
  });
});
