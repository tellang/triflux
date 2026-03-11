// tests/integration/workers.test.mjs — subprocess worker 통합 테스트

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { GeminiWorker } from '../../hub/workers/gemini-worker.mjs';
import { ClaudeWorker } from '../../hub/workers/claude-worker.mjs';
import { createWorker } from '../../hub/workers/factory.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(TEST_DIR, '..', '..');
const FIXTURE_DIR = resolve(PROJECT_ROOT, 'tests', 'fixtures');
const GEMINI_FIXTURE = resolve(FIXTURE_DIR, 'fake-gemini-cli.mjs');
const CLAUDE_FIXTURE = resolve(FIXTURE_DIR, 'fake-claude-cli.mjs');
const ROUTE_SCRIPT = resolve(PROJECT_ROOT, 'scripts', 'tfx-route.sh');

describe('GeminiWorker', () => {
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

describe('ClaudeWorker', () => {
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

describe('createWorker()', () => {
  it('타입별 worker 인스턴스를 생성해야 한다', () => {
    assert.equal(createWorker('gemini').constructor.name, 'GeminiWorker');
    assert.equal(createWorker('claude').constructor.name, 'ClaudeWorker');
    assert.throws(() => createWorker('unknown'), /Unknown worker type/);
  });
});

describe('tfx-route.sh wrapper integration', () => {
  it('designer는 Gemini wrapper를 통해 실행되어야 한다', () => {
    const result = spawnSync('bash', [ROUTE_SCRIPT, 'designer', 'route gemini', 'implement', '5'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: resolve(PROJECT_ROOT, '.tmp-home-route-gemini'),
        TFX_TEAM_NAME: 'phase3-team',
        GEMINI_BIN: process.execPath,
        GEMINI_BIN_ARGS_JSON: JSON.stringify([GEMINI_FIXTURE]),
      },
    });

    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);
    assert.match(output, /gemini:route gemini/);
    assert.match(output, /type=gemini/);
  });

  it('verifier는 팀 비-TTY 환경에서 Claude wrapper를 사용해야 한다', () => {
    const result = spawnSync('bash', [ROUTE_SCRIPT, 'verifier', 'route claude', 'analyze', '5'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: resolve(PROJECT_ROOT, '.tmp-home-route-claude'),
        TFX_TEAM_NAME: 'phase3-team',
        CLAUDE_BIN: process.execPath,
        CLAUDE_BIN_ARGS_JSON: JSON.stringify([CLAUDE_FIXTURE]),
      },
    });

    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);
    assert.match(output, /claude:route claude/);
    assert.match(output, /type=claude/);
  });
});
