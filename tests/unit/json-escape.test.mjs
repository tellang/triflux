// tests/unit/json-escape.test.mjs — json_escape 로직 단위 테스트
//
// tfx-route.sh의 json_escape 함수는 node를 사용할 때
//   node -e 'process.stdout.write(JSON.stringify(process.argv[1]).slice(1,-1))' -- "$s"
// 위 명령과 동일한 결과를 기대한다.
//
// 이 테스트는 동일한 로직을 순수 JS로 재현하여:
//   1) 이스케이프 결과가 JSON.parse로 복원 가능한지
//   2) 특수문자(쌍따옴표, 백슬래시, 개행, 탭, CR, NUL, 유니코드)가 올바르게 이스케이프되는지
//   3) 이스케이프된 문자열을 JSON 값으로 조립했을 때 파싱이 성공하는지
// 를 검증한다.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// tfx-route.sh 내 json_escape(node 경로)와 동일한 로직
// JSON.stringify로 인코딩한 뒤 앞뒤 따옴표를 제거한다
function jsonEscape(s) {
  return JSON.stringify(s).slice(1, -1);
}

// node 프로세스를 직접 실행하여 실제 셸 명령과 동일한 결과인지 검증
function nodeJsonEscape(s) {
  const result = spawnSync(
    process.execPath,
    ['-e', 'process.stdout.write(JSON.stringify(process.argv[1]).slice(1,-1))', '--', s],
    { encoding: 'utf8' },
  );
  return result.stdout;
}

describe('json_escape — 기본 이스케이프', () => {
  it('빈 문자열은 빈 문자열을 반환해야 한다', () => {
    assert.equal(jsonEscape(''), '');
  });

  it('ASCII 일반 문자는 변경 없이 반환해야 한다', () => {
    assert.equal(jsonEscape('hello world'), 'hello world');
  });

  it('쌍따옴표를 \\" 로 이스케이프해야 한다', () => {
    assert.equal(jsonEscape('"quoted"'), '\\"quoted\\"');
  });

  it('백슬래시를 \\\\ 로 이스케이프해야 한다', () => {
    assert.equal(jsonEscape('a\\b'), 'a\\\\b');
  });

  it('개행(\\n)을 \\\\n 으로 이스케이프해야 한다', () => {
    assert.equal(jsonEscape('line1\nline2'), 'line1\\nline2');
  });

  it('탭(\\t)을 \\\\t 로 이스케이프해야 한다', () => {
    assert.equal(jsonEscape('col1\tcol2'), 'col1\\tcol2');
  });

  it('캐리지 리턴(\\r)을 \\\\r 로 이스케이프해야 한다', () => {
    assert.equal(jsonEscape('line\r\n'), 'line\\r\\n');
  });
});

describe('json_escape — 복원 가능성 검증', () => {
  it('이스케이프 후 JSON 값으로 조립하면 원본 복원이 가능해야 한다', () => {
    const original = 'He said "hello" and ran away';
    const escaped = jsonEscape(original);
    const restored = JSON.parse(`"${escaped}"`);
    assert.equal(restored, original);
  });

  it('개행+탭+따옴표 혼합 문자열이 복원 가능해야 한다', () => {
    const original = 'line1\n\t"quoted"\r\nline2';
    const escaped = jsonEscape(original);
    const restored = JSON.parse(`"${escaped}"`);
    assert.equal(restored, original);
  });

  it('백슬래시+쌍따옴표 혼합이 복원 가능해야 한다', () => {
    const original = 'path: C:\\Users\\SSAFY\\"name"';
    const escaped = jsonEscape(original);
    const restored = JSON.parse(`"${escaped}"`);
    assert.equal(restored, original);
  });

  it('한국어 멀티바이트 문자열이 복원 가능해야 한다', () => {
    const original = '안녕하세요 triflux! 테스트 중입니다.';
    const escaped = jsonEscape(original);
    const restored = JSON.parse(`"${escaped}"`);
    assert.equal(restored, original);
  });

  it('이모지(4바이트 UTF-8)가 복원 가능해야 한다', () => {
    const original = '완료 ✅ 오류 ❌ 경고 ⚠️';
    const escaped = jsonEscape(original);
    const restored = JSON.parse(`"${escaped}"`);
    assert.equal(restored, original);
  });
});

describe('json_escape — JSON 객체 조립 검증', () => {
  it('이스케이프된 값을 포함한 JSON 객체가 파싱 가능해야 한다', () => {
    const teamName = 'my-team "alpha"';
    const taskId = 'task\n001';
    const summary = 'line1\nline2\ttab\\slash';

    const json = `{"team_name":"${jsonEscape(teamName)}","task_id":"${jsonEscape(taskId)}","summary":"${jsonEscape(summary)}"}`;
    const parsed = JSON.parse(json);

    assert.equal(parsed.team_name, teamName);
    assert.equal(parsed.task_id, taskId);
    assert.equal(parsed.summary, summary);
  });

  it('빈 문자열 값을 포함한 JSON 객체가 파싱 가능해야 한다', () => {
    const json = `{"key":"${jsonEscape('')}"}`;
    const parsed = JSON.parse(json);
    assert.equal(parsed.key, '');
  });
});

describe('json_escape — node 프로세스 실행 결과 일치 검증', () => {
  it('순수 JS 구현이 실제 node 프로세스 실행 결과와 동일해야 한다 (일반 문자열)', () => {
    const input = 'hello "world" test';
    assert.equal(jsonEscape(input), nodeJsonEscape(input));
  });

  it('순수 JS 구현이 실제 node 프로세스 실행 결과와 동일해야 한다 (특수문자)', () => {
    const input = 'line1\nline2\t"tab-quote"\\backslash';
    assert.equal(jsonEscape(input), nodeJsonEscape(input));
  });

  it('순수 JS 구현이 실제 node 프로세스 실행 결과와 동일해야 한다 (한국어)', () => {
    const input = '팀 이름: "alpha 팀"';
    assert.equal(jsonEscape(input), nodeJsonEscape(input));
  });
});
