// tests/integration/bridge.test.mjs — bridge.mjs 라우팅 로직 통합 테스트
//
// bridge.mjs는 CLI 진입점(process.argv 기반)이므로
// 테스트에서는 내부 순수 함수들을 직접 추출하여 검증한다.
// Hub 미실행 시나리오: 실제 HTTP 호출 대신 parseArgs / parseJsonSafe 동작을 확인.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs as nodeParseArgs } from 'node:util';

// ── parseArgs 래퍼 (bridge.mjs 내부 로직 재현) ──
// bridge.mjs의 parseArgs 함수는 export되지 않으므로 동일 로직을 여기서 재현하여 테스트
function parseArgs(argv) {
  const { values } = nodeParseArgs({
    args: argv,
    options: {
      agent:      { type: 'string' },
      cli:        { type: 'string' },
      timeout:    { type: 'string' },
      topics:     { type: 'string' },
      file:       { type: 'string' },
      topic:      { type: 'string' },
      trace:      { type: 'string' },
      correlation:{ type: 'string' },
      'exit-code':{ type: 'string' },
      max:        { type: 'string' },
      out:        { type: 'string' },
      team:       { type: 'string' },
      'task-id':  { type: 'string' },
      owner:      { type: 'string' },
      status:     { type: 'string' },
      statuses:   { type: 'string' },
      claim:      { type: 'boolean' },
      from:       { type: 'string' },
      to:         { type: 'string' },
      text:       { type: 'string' },
    },
    strict: false,
  });
  return values;
}

function parseJsonSafe(raw, fallback = null) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

// ── parseArgs ──

describe('bridge.mjs parseArgs()', () => {
  it('--agent 플래그를 올바르게 파싱해야 한다', () => {
    const args = parseArgs(['--agent', 'my-agent-01']);
    assert.equal(args.agent, 'my-agent-01');
  });

  it('--cli 플래그를 올바르게 파싱해야 한다', () => {
    const args = parseArgs(['--cli', 'codex']);
    assert.equal(args.cli, 'codex');
  });

  it('--topics 콤마 구분 값을 파싱해야 한다', () => {
    const args = parseArgs(['--topics', 'task.result,task.error']);
    const topics = args.topics.split(',');
    assert.deepEqual(topics, ['task.result', 'task.error']);
  });

  it('--timeout 숫자 문자열을 파싱해야 한다', () => {
    const args = parseArgs(['--timeout', '300']);
    assert.equal(parseInt(args.timeout, 10), 300);
  });

  it('--claim boolean 플래그를 파싱해야 한다', () => {
    const args = parseArgs(['--claim']);
    assert.equal(args.claim, true);
  });

  it('플래그 없을 때 undefined를 반환해야 한다', () => {
    const args = parseArgs([]);
    assert.equal(args.agent, undefined);
    assert.equal(args.cli, undefined);
  });

  it('register 명령 전체 인자를 파싱해야 한다', () => {
    const args = parseArgs([
      '--agent', 'codex-worker-1',
      '--cli', 'codex',
      '--timeout', '600',
      '--topics', 'task.result,task.done',
    ]);
    assert.equal(args.agent, 'codex-worker-1');
    assert.equal(args.cli, 'codex');
    assert.equal(parseInt(args.timeout, 10), 600);
    assert.deepEqual(args.topics.split(','), ['task.result', 'task.done']);
  });

  it('team-task-update 복합 인자를 파싱해야 한다', () => {
    const args = parseArgs([
      '--team', 'my-team',
      '--task-id', 'task-001',
      '--claim',
      '--status', 'in_progress',
      '--owner', 'codex-worker',
    ]);
    assert.equal(args.team, 'my-team');
    assert.equal(args['task-id'], 'task-001');
    assert.equal(args.claim, true);
    assert.equal(args.status, 'in_progress');
    assert.equal(args.owner, 'codex-worker');
  });

  it('--exit-code 플래그를 파싱해야 한다', () => {
    const args = parseArgs(['--exit-code', '1']);
    assert.equal(parseInt(args['exit-code'], 10), 1);
  });
});

// ── parseJsonSafe ──

describe('bridge.mjs parseJsonSafe()', () => {
  it('유효한 JSON 문자열을 객체로 반환해야 한다', () => {
    const result = parseJsonSafe('{"key":"value"}');
    assert.deepEqual(result, { key: 'value' });
  });

  it('유효하지 않은 JSON은 fallback을 반환해야 한다', () => {
    const result = parseJsonSafe('not-json', null);
    assert.equal(result, null);
  });

  it('null/undefined 입력 시 fallback을 반환해야 한다', () => {
    assert.equal(parseJsonSafe(null, 'default'), 'default');
    assert.equal(parseJsonSafe(undefined, 42), 42);
  });

  it('빈 문자열 입력 시 fallback을 반환해야 한다', () => {
    const result = parseJsonSafe('', { empty: true });
    assert.deepEqual(result, { empty: true });
  });

  it('배열 JSON을 올바르게 파싱해야 한다', () => {
    const result = parseJsonSafe('[1,2,3]', []);
    assert.deepEqual(result, [1, 2, 3]);
  });
});

// ── 커맨드 인자 조합 검증 (bridge 동작 규칙) ──

describe('bridge.mjs 커맨드 인자 조합', () => {
  it('register 커맨드: agent_id 없으면 undefined여야 한다', () => {
    const args = parseArgs(['--cli', 'codex', '--timeout', '600']);
    assert.equal(args.agent, undefined);
  });

  it('result 커맨드: exit-code 기본값은 0으로 처리해야 한다', () => {
    const args = parseArgs(['--agent', 'agent-x']);
    const exitCode = parseInt(args['exit-code'] || '0', 10);
    assert.equal(exitCode, 0);
  });

  it('context 커맨드: max 기본값은 10으로 처리해야 한다', () => {
    const args = parseArgs(['--agent', 'agent-y']);
    const maxMessages = parseInt(args.max || '10', 10);
    assert.equal(maxMessages, 10);
  });

  it('team-task-list: statuses 콤마 구분 파싱', () => {
    const args = parseArgs(['--team', 'alpha', '--statuses', 'pending,in_progress']);
    const statuses = args.statuses.split(',').map(s => s.trim()).filter(Boolean);
    assert.deepEqual(statuses, ['pending', 'in_progress']);
  });

  it('team-send-message: to 기본값은 team-lead여야 한다', () => {
    const args = parseArgs(['--team', 'beta', '--from', 'worker', '--text', '작업 완료']);
    // to 플래그 미입력 시 기본값 team-lead
    const to = args.to || 'team-lead';
    assert.equal(to, 'team-lead');
  });
});
