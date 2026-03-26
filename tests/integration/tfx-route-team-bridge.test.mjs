import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { toBashPath, BASH_EXE } from '../helpers/bash-path.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..', '..');
const ROUTE_SCRIPT = toBashPath(resolve(PROJECT_ROOT, 'scripts', 'tfx-route.sh'));
const FIXTURE_BIN = toBashPath(resolve(PROJECT_ROOT, 'tests', 'fixtures', 'bin'));
const FAKE_BRIDGE = toBashPath(resolve(PROJECT_ROOT, 'tests', 'fixtures', 'fake-bridge.mjs'));

function runBash(command, extraEnv = {}) {
  return spawnSync(BASH_EXE, ['-c', command], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${FIXTURE_BIN}:${process.env.PATH || ''}`,
      TFX_CODEX_TRANSPORT: 'exec',
      ...extraEnv,
    },
  });
}

function output(result) {
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

describe('tfx-route.sh — team bridge integration', () => {
  it('team claim/start-message/result를 bridge CLI 단일 경로로 호출하고 완료는 backup 파일로 남겨야 한다', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tfx-route-team-bridge-'));
    const logPath = join(tempDir, 'bridge.log');
    const resultDir = join(tempDir, 'results');
    mkdirSync(tempDir, { recursive: true });

    try {
      const result = runBash(
        `bash "${ROUTE_SCRIPT}" executor 'bridge-team-flow' minimal 5`,
        {
          FAKE_CODEX_MODE: 'exec',
          TFX_TEAM_NAME: 'team-bridge-test',
          TFX_TEAM_TASK_ID: 'task-001',
          TFX_TEAM_AGENT_NAME: 'executor-worker-test',
          TFX_TEAM_LEAD_NAME: 'team-lead',
          TFX_BRIDGE_SCRIPT: FAKE_BRIDGE,
          FAKE_BRIDGE_LOG: logPath,
          TFX_RESULT_DIR: resultDir,
        },
      );

      assert.equal(result.status, 0, output(result));

      const calls = readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line).argv);

      assert.equal(calls.length, 3, JSON.stringify(calls, null, 2));
      assert.equal(calls[0][0], 'team-task-update');
      assert.ok(calls[0].includes('--claim'));
      assert.equal(calls[1][0], 'team-send-message');
      assert.match(calls[1][calls[1].indexOf('--text') + 1], /작업 시작: executor-worker-test/);
      assert.equal(calls[2][0], 'result');

      const resultPayload = calls[2][calls[2].indexOf('--payload') + 1];
      assert.deepEqual(JSON.parse(resultPayload), {
        task_id: 'task-001',
        result: 'success',
      });

      const backup = JSON.parse(readFileSync(join(resultDir, 'task-001.json'), 'utf8'));
      assert.deepEqual(
        {
          taskId: backup.taskId,
          agent: backup.agent,
          team: backup.team,
          result: backup.result,
        },
        {
          taskId: 'task-001',
          agent: 'executor-worker-test',
          team: 'team-bridge-test',
          result: 'success',
        },
      );
      assert.match(backup.summary, /^EXEC:bridge-team-flow/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('same-owner claim conflict는 idempotent하게 계속 실행해야 한다', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tfx-route-team-bridge-'));
    const logPath = join(tempDir, 'bridge.log');
    const resultDir = join(tempDir, 'results');
    mkdirSync(tempDir, { recursive: true });

    try {
      const result = runBash(
        `bash "${ROUTE_SCRIPT}" executor 'bridge-team-flow' minimal 5`,
        {
          FAKE_CODEX_MODE: 'exec',
          TFX_TEAM_NAME: 'team-bridge-test',
          TFX_TEAM_TASK_ID: 'task-002',
          TFX_TEAM_AGENT_NAME: 'executor-worker-test',
          TFX_TEAM_LEAD_NAME: 'team-lead',
          TFX_BRIDGE_SCRIPT: FAKE_BRIDGE,
          FAKE_BRIDGE_LOG: logPath,
          FAKE_BRIDGE_CLAIM_MODE: 'same-owner',
          TFX_RESULT_DIR: resultDir,
        },
      );

      assert.equal(result.status, 0, output(result));
      assert.match(output(result), /동일 owner\(executor-worker-test\)가 이미 claim한 task task-002/);

      const calls = readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line).argv);

      assert.equal(calls.length, 3, JSON.stringify(calls, null, 2));
      assert.equal(calls[0][0], 'team-task-update');
      assert.equal(calls[1][0], 'team-send-message');
      assert.equal(calls[2][0], 'result');

      const backup = JSON.parse(readFileSync(join(resultDir, 'task-002.json'), 'utf8'));
      assert.equal(backup.result, 'success');
      assert.match(backup.summary, /^EXEC:bridge-team-flow/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
