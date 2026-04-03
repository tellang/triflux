// tests/helpers/session-runner.test.mjs — session-runner.mjs 단위 테스트
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseNDJSON, sanitizeTestName } from './session-runner.mjs';

// ── parseNDJSON ──
describe('parseNDJSON', () => {
  it('빈 입력: 빈 결과 반환', () => {
    const result = parseNDJSON([]);
    assert.deepEqual(result.transcript, []);
    assert.equal(result.resultLine, null);
    assert.equal(result.turnCount, 0);
    assert.equal(result.toolCallCount, 0);
    assert.deepEqual(result.toolCalls, []);
  });

  it('공백만 있는 줄 무시', () => {
    const result = parseNDJSON(['', '   ', '\t']);
    assert.deepEqual(result.transcript, []);
    assert.equal(result.resultLine, null);
  });

  it('잘못된 JSON 줄 무시 (no throw)', () => {
    const result = parseNDJSON(['{not json', 'also bad', '{"type":"result"}']);
    assert.equal(result.transcript.length, 1);
    assert.equal(result.resultLine?.type, 'result');
  });

  it('유효한 NDJSON: transcript에 모든 이벤트 수집', () => {
    const lines = [
      JSON.stringify({ type: 'system', message: 'init' }),
      JSON.stringify({ type: 'assistant', message: { content: [] } }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }),
    ];
    const result = parseNDJSON(lines);
    assert.equal(result.transcript.length, 3);
    assert.equal(result.resultLine.subtype, 'success');
  });

  it('assistant 이벤트: turnCount 증가', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [] } }),
      JSON.stringify({ type: 'assistant', message: { content: [] } }),
    ];
    const result = parseNDJSON(lines);
    assert.equal(result.turnCount, 2);
  });

  it('tool_use 항목: toolCallCount + toolCalls 배열에 추가', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
            { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/x' } },
          ],
        },
      }),
    ];
    const result = parseNDJSON(lines);
    assert.equal(result.toolCallCount, 2);
    assert.equal(result.toolCalls.length, 2);
    assert.equal(result.toolCalls[0].tool, 'Bash');
    assert.deepEqual(result.toolCalls[0].input, { command: 'ls' });
    assert.equal(result.toolCalls[0].output, '');
    assert.equal(result.toolCalls[1].tool, 'Read');
  });

  it('tool_use name 없으면 "unknown" 사용', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', input: {} }] },
      }),
    ];
    const result = parseNDJSON(lines);
    assert.equal(result.toolCalls[0].tool, 'unknown');
  });

  it('tool_use input 없으면 빈 객체 사용', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Write' }] },
      }),
    ];
    const result = parseNDJSON(lines);
    assert.deepEqual(result.toolCalls[0].input, {});
  });

  it('result 이벤트: resultLine에 저장', () => {
    const lines = [
      JSON.stringify({ type: 'result', subtype: 'error_api', is_error: true }),
    ];
    const result = parseNDJSON(lines);
    assert.equal(result.resultLine.subtype, 'error_api');
    assert.equal(result.resultLine.is_error, true);
  });

  it('result 이벤트 여러 개: 마지막 것으로 덮어씀', () => {
    const lines = [
      JSON.stringify({ type: 'result', subtype: 'first' }),
      JSON.stringify({ type: 'result', subtype: 'second' }),
    ];
    const result = parseNDJSON(lines);
    assert.equal(result.resultLine.subtype, 'second');
  });

  it('혼합: 유효 + 잘못된 줄 섞임', () => {
    const lines = [
      JSON.stringify({ type: 'system' }),
      'bad json here',
      JSON.stringify({ type: 'result', subtype: 'success' }),
      '',
    ];
    const result = parseNDJSON(lines);
    assert.equal(result.transcript.length, 2);
    assert.equal(result.resultLine.subtype, 'success');
  });
});

// ── sanitizeTestName ──
describe('sanitizeTestName', () => {
  it('앞의 슬래시 제거', () => {
    assert.equal(sanitizeTestName('/foo/bar'), 'foo-bar');
    assert.equal(sanitizeTestName('///triple'), 'triple');
  });

  it('중간 슬래시를 하이픈으로 변환', () => {
    assert.equal(sanitizeTestName('a/b/c'), 'a-b-c');
  });

  it('슬래시 없는 이름은 그대로', () => {
    assert.equal(sanitizeTestName('plain-name'), 'plain-name');
  });

  it('빈 문자열 처리', () => {
    assert.equal(sanitizeTestName(''), '');
  });

  it('앞 슬래시 + 중간 슬래시 복합', () => {
    assert.equal(sanitizeTestName('/skill/tfx-auto/basic'), 'skill-tfx-auto-basic');
  });
});
