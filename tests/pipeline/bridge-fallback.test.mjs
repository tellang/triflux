// tests/pipeline/bridge-fallback.test.mjs — nativeProxy fallback 테스트
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { main } from '../../hub/bridge.mjs';

// Hub 미실행 상태에서 bridge CLI가 nativeProxy fallback으로 동작하는지 검증.
// 이 테스트는 Hub 서버가 꺼진 상태를 전제로 한다.

// console.log 캡처 헬퍼
function captureLog(fn) {
  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  return fn().finally(() => { console.log = original; }).then(() => logs);
}

describe('bridge team 커맨드 nativeProxy fallback', () => {
  it('team-info: 존재하지 않는 팀 → TEAM_NOT_FOUND (nativeProxy 경유)', async () => {
    const logs = await captureLog(() => main(['team-info', '--team', 'fallback-test-nonexistent']));
    const result = JSON.parse(logs[0]);
    // Hub 미실행 → nativeProxy fallback → 팀 없음 에러
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'TEAM_NOT_FOUND');
  });

  it('team-task-list: 존재하지 않는 팀 → TASKS_DIR_NOT_FOUND', async () => {
    const logs = await captureLog(() => main(['team-task-list', '--team', 'fallback-test-nonexistent']));
    const result = JSON.parse(logs[0]);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'TASKS_DIR_NOT_FOUND');
  });

  it('team-task-update: 존재하지 않는 팀 → TASKS_DIR_NOT_FOUND', async () => {
    const logs = await captureLog(() =>
      main(['team-task-update', '--team', 'fallback-test-nonexistent', '--task-id', 'fake-task'])
    );
    const result = JSON.parse(logs[0]);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'TASKS_DIR_NOT_FOUND');
  });

  it('team-send-message: 존재하지 않는 팀 → TEAM_NOT_FOUND', async () => {
    const logs = await captureLog(() =>
      main(['team-send-message', '--team', 'fallback-test-nonexistent', '--from', 'tester', '--text', 'hello'])
    );
    const result = JSON.parse(logs[0]);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'TEAM_NOT_FOUND');
  });
});

describe('bridge pipeline 커맨드', () => {
  it('pipeline-state: Hub DB 없으면 에러', async () => {
    // TFX_HUB_URL을 잘못된 포트로 설정하여 HTTP 실패 유도
    const origUrl = process.env.TFX_HUB_URL;
    process.env.TFX_HUB_URL = 'http://127.0.0.1:1';
    try {
      const logs = await captureLog(() => main(['pipeline-state', '--team', 'test']));
      const result = JSON.parse(logs[0]);
      // Hub DB가 있으면 pipeline_not_found, 없으면 hub_db_not_found
      assert.equal(result.ok, false);
    } finally {
      if (origUrl) process.env.TFX_HUB_URL = origUrl;
      else delete process.env.TFX_HUB_URL;
    }
  });
});
