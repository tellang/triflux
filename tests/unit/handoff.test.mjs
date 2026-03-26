// tests/unit/handoff.test.mjs — hub/team/handoff.mjs 단위 테스트
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseHandoff,
  validateHandoff,
  buildFallbackHandoff,
  formatHandoffForLead,
  processHandoff,
} from '../../hub/team/handoff.mjs';

// ── 테스트 데이터 ──

const HANDOFF_OK = `
Some worker output here...
--- HANDOFF ---
status: ok
lead_action: accept
task: code review
files_changed: src/app.mjs, src/util.mjs
verdict: All tests pass and code looks clean
confidence: high
risk: low
detail: /tmp/result.json
`.trim();

const HANDOFF_FAILED = `
Worker encountered an error.
--- HANDOFF ---
status: failed
lead_action: retry
task: lint fix
files_changed: none
verdict: ESLint failed with 3 errors
confidence: medium
risk: med
detail: none
error_stage: execution
retryable: yes
partial_output: no
`.trim();

const NO_HANDOFF = `
This is just regular output without any handoff block.
Done processing files.
`;

// ── parseHandoff ──

describe('parseHandoff()', () => {
  it('1. 정상 성공 HANDOFF 블록을 파싱해야 한다', () => {
    const result = parseHandoff(HANDOFF_OK);
    assert.ok(result);
    assert.equal(result.status, 'ok');
    assert.equal(result.lead_action, 'accept');
    assert.equal(result.task, 'code review');
    assert.equal(result.verdict, 'All tests pass and code looks clean');
    assert.equal(result.confidence, 'high');
    assert.equal(result.risk, 'low');
    assert.equal(result.detail, '/tmp/result.json');
  });

  it('2. 정상 실패 HANDOFF 블록을 파싱해야 한다 (error_stage, retryable 포함)', () => {
    const result = parseHandoff(HANDOFF_FAILED);
    assert.ok(result);
    assert.equal(result.status, 'failed');
    assert.equal(result.lead_action, 'retry');
    assert.equal(result.error_stage, 'execution');
    assert.equal(result.retryable, 'yes');
    assert.equal(result.partial_output, 'no');
  });

  it('3. HANDOFF 블록 없는 텍스트에서 null을 반환해야 한다', () => {
    assert.equal(parseHandoff(NO_HANDOFF), null);
  });

  it('4. files_changed가 "none"인 경우 빈 배열로 변환해야 한다', () => {
    const result = parseHandoff(HANDOFF_FAILED);
    assert.ok(result);
    assert.ok(Array.isArray(result.files_changed));
    assert.equal(result.files_changed.length, 0);
  });

  it('5. files_changed가 여러 파일인 경우 배열로 변환해야 한다', () => {
    const result = parseHandoff(HANDOFF_OK);
    assert.ok(result);
    assert.ok(Array.isArray(result.files_changed));
    assert.deepEqual(result.files_changed, ['src/app.mjs', 'src/util.mjs']);
  });

  it('null/undefined/비문자열 입력 시 null을 반환해야 한다', () => {
    assert.equal(parseHandoff(null), null);
    assert.equal(parseHandoff(undefined), null);
    assert.equal(parseHandoff(42), null);
    assert.equal(parseHandoff(''), null);
  });

  it('P1: 프롬프트 에코로 두 개의 HANDOFF 블록이 있을 때 마지막 블록을 파싱해야 한다', () => {
    const echoed = `
--- HANDOFF ---
status: ok | partial | failed
lead_action: accept | needs_read | retry | reassign
task: <1-3 word task type>

... worker output ...

--- HANDOFF ---
status: ok
lead_action: accept
task: implement auth
files_changed: src/auth.mjs
verdict: Auth module implemented successfully
confidence: high
risk: low
detail: /tmp/result.txt
`.trim();
    const result = parseHandoff(echoed);
    assert.ok(result);
    assert.equal(result.status, 'ok');
    assert.equal(result.task, 'implement auth');
    assert.equal(result.verdict, 'Auth module implemented successfully');
  });
});

// ── validateHandoff ──

describe('validateHandoff()', () => {
  it('6. 유효한 handoff에서 valid: true, warnings 비어있음을 반환해야 한다', () => {
    const parsed = parseHandoff(HANDOFF_OK);
    const { handoff, valid, warnings } = validateHandoff(parsed);
    assert.equal(valid, true);
    assert.equal(warnings.length, 0);
    assert.equal(handoff.status, 'ok');
    assert.equal(handoff.lead_action, 'accept');
  });

  it('7. 누락 필드를 context로 자동 삽입하고 warnings에 추론 내역을 기록해야 한다', () => {
    const parsed = { lead_action: 'accept', verdict: 'done', task: 'test', confidence: 'high', risk: 'low' };
    const context = {
      exitCode: 0,
      resultFile: '/tmp/out.json',
      gitDiffFiles: ['a.mjs', 'b.mjs'],
    };
    const { handoff, valid, warnings } = validateHandoff(parsed, context);

    assert.equal(valid, true);
    assert.equal(handoff.status, 'ok');
    assert.equal(handoff.detail, '/tmp/out.json');
    assert.deepEqual(handoff.files_changed, ['a.mjs', 'b.mjs']);
    assert.ok(warnings.some(w => w.includes('context.exitCode')));
    assert.ok(warnings.some(w => w.includes('context.resultFile')));
    assert.ok(warnings.some(w => w.includes('context.gitDiffFiles')));
  });

  it('8. 잘못된 enum 값을 fallback으로 교체하고 warning을 추가해야 한다', () => {
    const parsed = {
      status: 'INVALID_STATUS',
      lead_action: 'bad_action',
      confidence: 'super',
      risk: 'extreme',
      verdict: 'test verdict',
    };
    const { handoff, warnings } = validateHandoff(parsed);

    assert.equal(handoff.status, 'ok');           // fallback
    assert.equal(handoff.lead_action, 'needs_read'); // fallback
    assert.equal(handoff.confidence, 'low');       // fallback
    assert.equal(handoff.risk, 'low');             // fallback
    assert.ok(warnings.some(w => w.includes('status') && w.includes('fallback')));
    assert.ok(warnings.some(w => w.includes('lead_action') && w.includes('fallback')));
    assert.ok(warnings.some(w => w.includes('confidence') && w.includes('fallback')));
    assert.ok(warnings.some(w => w.includes('risk') && w.includes('fallback')));
  });

  it('9. 150 토큰 초과 시 lead_action이 "needs_read"로 강제되어야 한다', () => {
    const parsed = {
      status: 'ok',
      lead_action: 'accept',
      verdict: 'x'.repeat(700),   // ~175 tokens just for verdict
      task: 'big task',
      detail: 'none',
    };
    const { handoff, warnings } = validateHandoff(parsed);

    assert.equal(handoff.lead_action, 'needs_read');
    assert.ok(warnings.some(w => w.includes('token cap exceeded')));
  });

  it('실패 상태에서 잘못된 error_stage/retryable/partial_output를 제거해야 한다', () => {
    const parsed = {
      status: 'failed',
      lead_action: 'retry',
      verdict: 'failed task',
      error_stage: 'invalid_stage',
      retryable: 'maybe',
      partial_output: 'dunno',
    };
    const { handoff, warnings } = validateHandoff(parsed);

    assert.equal(handoff.error_stage, undefined);
    assert.equal(handoff.retryable, undefined);
    assert.equal(handoff.partial_output, undefined);
    assert.ok(warnings.some(w => w.includes('error_stage')));
    assert.ok(warnings.some(w => w.includes('retryable')));
    assert.ok(warnings.some(w => w.includes('partial_output')));
  });

  it('필수 필드 누락 시 valid: false를 반환해야 한다', () => {
    const parsed = { task: 'something' };
    const { valid, warnings } = validateHandoff(parsed);

    assert.equal(valid, false);
    assert.ok(warnings.some(w => w.includes('missing required: status')));
    assert.ok(warnings.some(w => w.includes('missing required: lead_action')));
    assert.ok(warnings.some(w => w.includes('missing required: verdict')));
  });

  it('P2a: 라우팅 필드(task, confidence, risk, detail) 누락 시 valid: false를 반환해야 한다', () => {
    const parsed = { status: 'ok', lead_action: 'accept', verdict: 'done' };
    const { valid, warnings } = validateHandoff(parsed);
    assert.equal(valid, false);
    assert.ok(warnings.some(w => w.includes('missing routing field: task')));
    assert.ok(warnings.some(w => w.includes('missing routing field: confidence')));
    assert.ok(warnings.some(w => w.includes('missing routing field: risk')));
    assert.ok(warnings.some(w => w.includes('missing routing field: detail')));
  });

  it('P2b: 토큰 초과 시 verdict를 80자로 트림해야 한다', () => {
    const parsed = {
      status: 'ok',
      lead_action: 'accept',
      verdict: 'A'.repeat(600),   // ~150+ tokens with other fields
      task: 'big task',
      confidence: 'high',
      risk: 'low',
      detail: '/tmp/r.txt',
      files_changed: ['a', 'b', 'c', 'd', 'e'],
    };
    const { handoff, warnings } = validateHandoff(parsed);
    assert.equal(handoff.lead_action, 'needs_read');
    assert.ok(handoff.verdict.length <= 80);
    assert.ok(handoff.verdict.endsWith('...'));
    assert.ok(warnings.some(w => w.includes('trimmed')));
    // files_changed도 3개 + "+N more"로 트림
    assert.equal(handoff.files_changed.length, 4);
    assert.ok(handoff.files_changed[3].includes('+2 more'));
  });
});

// ── buildFallbackHandoff ──

describe('buildFallbackHandoff()', () => {
  it('10. exitCode=0 일 때 status: "ok", lead_action: "accept"를 반환해야 한다', () => {
    const fb = buildFallbackHandoff(0, '/tmp/result.json', 'codex');
    assert.equal(fb.status, 'ok');
    assert.equal(fb.lead_action, 'accept');
    assert.equal(fb.confidence, 'low');
    assert.equal(fb.risk, 'low');
    assert.equal(fb.detail, '/tmp/result.json');
    assert.equal(fb._fallback, true);
    assert.equal(fb.task, 'unknown');
    assert.deepEqual(fb.files_changed, []);
    assert.ok(fb.verdict.includes('codex'));
    assert.ok(fb.verdict.includes('exit 0'));
    // 성공 시 error 관련 필드 없음
    assert.equal(fb.error_stage, undefined);
    assert.equal(fb.retryable, undefined);
  });

  it('11. exitCode=1 일 때 status: "failed", lead_action: "retry"를 반환해야 한다', () => {
    const fb = buildFallbackHandoff(1, '/tmp/err.json', 'claude');
    assert.equal(fb.status, 'failed');
    assert.equal(fb.lead_action, 'retry');
    assert.equal(fb.error_stage, 'execution');
    assert.equal(fb.retryable, 'yes');
    assert.ok(fb.verdict.includes('exit 1'));
  });

  it('12. exitCode=124 (timeout) 일 때 retryable: "no"를 반환해야 한다', () => {
    const fb = buildFallbackHandoff(124, 'none');
    assert.equal(fb.status, 'failed');
    assert.equal(fb.lead_action, 'retry');
    assert.equal(fb.retryable, 'no');
    assert.ok(fb.verdict.includes('exit 124'));
  });

  it('P3: exitCode=124 (timeout) 일 때 error_stage가 "timeout"이어야 한다', () => {
    const fb = buildFallbackHandoff(124, 'none');
    assert.equal(fb.error_stage, 'timeout');
  });

  it('P3: exitCode=1 (일반 실패) 일 때 error_stage가 "execution"이어야 한다', () => {
    const fb = buildFallbackHandoff(1, 'none');
    assert.equal(fb.error_stage, 'execution');
  });

  it('cli 미지정 시 verdict에 "worker"를 포함해야 한다', () => {
    const fb = buildFallbackHandoff(0, 'none');
    assert.ok(fb.verdict.includes('worker'));
  });

  it('resultFile 미지정 시 detail이 "none"이어야 한다', () => {
    const fb = buildFallbackHandoff(0, undefined);
    assert.equal(fb.detail, 'none');
  });
});

// ── processHandoff ──

describe('processHandoff()', () => {
  it('13. HANDOFF 블록이 있는 경우 fallback: false를 반환해야 한다', () => {
    const result = processHandoff(HANDOFF_OK, { exitCode: 0 });
    assert.equal(result.fallback, false);
    assert.equal(result.handoff.status, 'ok');
    assert.equal(typeof result.formatted, 'string');
    assert.ok(result.formatted.includes('[HANDOFF]'));
  });

  it('14. HANDOFF 블록이 없는 경우 fallback: true를 반환해야 한다', () => {
    const result = processHandoff(NO_HANDOFF, { exitCode: 1, resultFile: '/tmp/r.json', cli: 'codex' });
    assert.equal(result.fallback, true);
    assert.equal(result.valid, false);
    assert.equal(result.handoff._fallback, true);
    assert.equal(result.handoff.status, 'failed');
    assert.ok(result.warnings.some(w => w.includes('fallback')));
  });

  it('HANDOFF 블록 없고 context도 없으면 exitCode=1 기본값을 사용해야 한다', () => {
    const result = processHandoff(NO_HANDOFF);
    assert.equal(result.fallback, true);
    assert.equal(result.handoff.status, 'failed');
    assert.equal(result.handoff.lead_action, 'retry');
  });

  it('context 정보가 validate 단계로 전달되어야 한다', () => {
    const raw = `
--- HANDOFF ---
lead_action: accept
verdict: done
`.trim();
    const result = processHandoff(raw, { exitCode: 0, resultFile: '/tmp/x.json' });
    assert.equal(result.fallback, false);
    assert.equal(result.handoff.status, 'ok');
    assert.equal(result.handoff.detail, '/tmp/x.json');
  });
});

// ── formatHandoffForLead ──

describe('formatHandoffForLead()', () => {
  it('15. 성공 handoff 포맷에 [HANDOFF] 라인을 포함해야 한다', () => {
    const handoff = {
      status: 'ok',
      lead_action: 'accept',
      confidence: 'high',
      verdict: 'All good',
      files_changed: ['a.mjs', 'b.mjs'],
      detail: '/tmp/result.json',
    };
    const formatted = formatHandoffForLead(handoff);
    assert.ok(formatted.includes('[HANDOFF]'));
    assert.ok(formatted.includes('status=ok'));
    assert.ok(formatted.includes('action=accept'));
    assert.ok(formatted.includes('confidence=high'));
    assert.ok(formatted.includes('verdict: All good'));
    assert.ok(formatted.includes('files: a.mjs, b.mjs'));
    assert.ok(formatted.includes('detail: /tmp/result.json'));
    // 성공 시 error 라인 없음
    assert.ok(!formatted.includes('error:'));
  });

  it('16. 실패 handoff 포맷에 error 라인을 포함해야 한다', () => {
    const handoff = {
      status: 'failed',
      lead_action: 'retry',
      confidence: 'low',
      verdict: 'ESLint errors',
      files_changed: [],
      detail: 'none',
      error_stage: 'execution',
      retryable: 'yes',
    };
    const formatted = formatHandoffForLead(handoff);
    assert.ok(formatted.includes('[HANDOFF]'));
    assert.ok(formatted.includes('status=failed'));
    assert.ok(formatted.includes('error:'));
    assert.ok(formatted.includes('stage=execution'));
    assert.ok(formatted.includes('retryable=yes'));
  });

  it('files_changed가 빈 배열이면 "none"으로 표시해야 한다', () => {
    const formatted = formatHandoffForLead({
      status: 'ok',
      lead_action: 'accept',
      verdict: 'ok',
      files_changed: [],
    });
    assert.ok(formatted.includes('files: none'));
  });

  it('partial 상태에서도 error 라인을 포함해야 한다', () => {
    const formatted = formatHandoffForLead({
      status: 'partial',
      lead_action: 'needs_read',
      verdict: 'partial done',
      error_stage: 'timeout',
    });
    assert.ok(formatted.includes('error:'));
    assert.ok(formatted.includes('stage=timeout'));
  });

  it('필드가 누락된 경우 안전하게 "?" 또는 기본값을 표시해야 한다', () => {
    const formatted = formatHandoffForLead({});
    assert.ok(formatted.includes('status=?'));
    assert.ok(formatted.includes('action=?'));
    assert.ok(formatted.includes('(no verdict)'));
    assert.ok(formatted.includes('files: none'));
    assert.ok(formatted.includes('detail: none'));
  });
});
