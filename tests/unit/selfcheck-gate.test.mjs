// tests/unit/selfcheck-gate.test.mjs — Self-Check Gate 단위 테스트
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { RED_FLAGS, QUESTIONS, runSelfCheck } from '../../hub/pipeline/gates/selfcheck.mjs';
import { canTransition, PHASES } from '../../hub/pipeline/transitions.mjs';

describe('selfcheck gate — Red Flag 탐지', () => {
  it('Red Flag 없는 결과 + 모든 질문 통과 → passed: true', () => {
    const result = runSelfCheck('구현 완료', '검증 완료', {
      evidence: {
        testOutput: 'PASS 8/8',
        requirementChecklist: ['auth module done'],
        references: 'MDN docs',
        artifacts: 'diff +50 -10',
      },
    });
    assert.ok(result.passed);
    assert.equal(result.score, 100);
    assert.equal(result.flags.length, 0);
  });

  it('"테스트 통과" 텍스트 + 출력 없음 → Red Flag 탐지', () => {
    const result = runSelfCheck('테스트 통과했습니다', '확인 완료', {
      evidence: {},
    });
    const flag = result.flags.find(f => f.id === 'test_pass_no_output');
    assert.ok(flag, 'test_pass_no_output Red Flag 미탐지');
    assert.ok(!result.passed);
  });

  it('"테스트 통과" + testOutput 증거 있음 → Red Flag 아님', () => {
    const result = runSelfCheck('테스트가 통과', '검증', {
      evidence: {
        testOutput: 'PASS 5/5',
        requirementChecklist: ['done'],
        references: 'docs',
        artifacts: 'code',
      },
    });
    const flag = result.flags.find(f => f.id === 'test_pass_no_output');
    assert.ok(!flag, 'testOutput 증거가 있으면 Red Flag 아님');
  });

  it('diff 있는데 "변경 없음" → Red Flag 탐지', () => {
    const result = runSelfCheck('변경사항 없습니다', '확인', {
      hasDiff: true,
      evidence: {},
    });
    const flag = result.flags.find(f => f.id === 'no_changes_with_diff');
    assert.ok(flag, 'no_changes_with_diff Red Flag 미탐지');
  });

  it('"변경 없음" + hasDiff=false → Red Flag 아님', () => {
    const result = runSelfCheck('변경사항 없습니다', '확인', {
      hasDiff: false,
      evidence: { testOutput: 'ok', requirementChecklist: ['ok'], references: 'ok', artifacts: 'ok' },
    });
    const flag = result.flags.find(f => f.id === 'no_changes_with_diff');
    assert.ok(!flag, 'hasDiff=false면 Red Flag 아님');
  });

  it('복수 Red Flag 누적', () => {
    const result = runSelfCheck(
      '테스트 통과. 모든게 작동합니다. 성능이 개선되었습니다.',
      '보안 강화 완료. 에러 처리 완료.',
      { evidence: {} },
    );
    assert.ok(result.flags.length >= 3, `flags=${result.flags.length}`);
    assert.ok(!result.passed);
  });
});

describe('selfcheck gate — 4대 필수 질문', () => {
  it('4대 질문 모두 통과 → checklist 전부 passed', () => {
    const result = runSelfCheck('완료', '완료', {
      evidence: {
        testOutput: 'PASS 10/10',
        requirementChecklist: ['req1 done', 'req2 done'],
        references: 'official docs link',
        artifacts: 'git diff output',
      },
    });
    assert.ok(result.checklist.every(q => q.passed));
    assert.ok(result.passed);
  });

  it('필수 질문 실패 → passed: false', () => {
    const result = runSelfCheck('완료', '완료', {
      evidence: { testOutput: 'PASS' },
      // requirementChecklist, references, artifacts 누락
    });
    const failedQuestions = result.checklist.filter(q => !q.passed);
    assert.ok(failedQuestions.length >= 3);
    assert.ok(!result.passed);
  });

  it('빈 문자열 evidence는 실패로 처리', () => {
    const result = runSelfCheck('완료', '완료', {
      evidence: { testOutput: '', requirementChecklist: 'ok', references: '  ', artifacts: 'ok' },
    });
    // testOutput='', references='  ' → 빈 문자열 → 실패
    assert.ok(!result.checklist.find(q => q.id === 'tests_passing').passed);
    assert.ok(!result.checklist.find(q => q.id === 'no_assumptions').passed);
  });
});

describe('selfcheck gate — 점수 계산', () => {
  it('점수: Red Flag당 -15, 실패 질문당 -20', () => {
    // 1 Red Flag + 4 failed questions = 100 - 15 - 80 = 5
    const result = runSelfCheck('테스트 통과', '검증', { evidence: {} });
    const expectedPenalty = result.flags.length * 15 + result.checklist.filter(q => !q.passed).length * 20;
    assert.equal(result.score, Math.max(0, 100 - expectedPenalty));
  });
});

describe('selfcheck gate — 파이프라인 전이', () => {
  it('verify → selfcheck 허용', () => {
    assert.ok(canTransition('verify', 'selfcheck'));
  });

  it('selfcheck → complete 허용', () => {
    assert.ok(canTransition('selfcheck', 'complete'));
  });

  it('selfcheck → fix 허용', () => {
    assert.ok(canTransition('selfcheck', 'fix'));
  });

  it('selfcheck가 PHASES에 포함', () => {
    assert.ok(PHASES.includes('selfcheck'));
  });
});
