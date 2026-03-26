// tests/unit/pipeline-gates-integration.test.mjs
// pipeline/index.mjs gate 메서드 통합 테스트
// runConfidenceGate / runSelfCheckGate / runDeslopGate

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { createPipeline, ensurePipelineTable } from '../../hub/pipeline/index.mjs';
import { initPipelineState, readPipelineState } from '../../hub/pipeline/state.mjs';

// ── 헬퍼 ───────────────────────────────────────────────────────────────────

/**
 * plan → prd → confidence 단계까지 전이한 파이프라인을 반환한다.
 */
function pipelineAtConfidence(db, teamName) {
  const pipeline = createPipeline(db, teamName);
  pipeline.advance('prd');
  pipeline.advance('confidence');
  return pipeline;
}

/**
 * plan → ... → selfcheck 단계까지 전이한 파이프라인을 반환한다.
 */
function pipelineAtSelfcheck(db, teamName) {
  const pipeline = createPipeline(db, teamName);
  pipeline.advance('prd');
  pipeline.advance('confidence');
  pipeline.advance('exec');
  pipeline.advance('deslop');
  pipeline.advance('verify');
  pipeline.advance('selfcheck');
  return pipeline;
}

/**
 * plan → ... → deslop 단계까지 전이한 파이프라인을 반환한다.
 */
function pipelineAtDeslop(db, teamName) {
  const pipeline = createPipeline(db, teamName);
  pipeline.advance('prd');
  pipeline.advance('confidence');
  pipeline.advance('exec');
  pipeline.advance('deslop');
  return pipeline;
}

// ── runConfidenceGate ───────────────────────────────────────────────────────

describe('runConfidenceGate — decision별 상태 전이', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    ensurePipelineTable(db);
  });

  afterEach(() => {
    db.close();
  });

  it('decision: proceed → exec 단계로 전이한다', () => {
    const pipeline = pipelineAtConfidence(db, 'gate-proceed');

    const result = pipeline.runConfidenceGate('plan content', {
      checks: {
        no_duplicate: 1,
        architecture: 1,
        docs_verified: 1,
        oss_reference: 1,
        root_cause: 1,
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.gate.decision, 'proceed');
    assert.equal(result.state.phase, 'exec');
  });

  it('decision: alternative → exec 단계로 전이한다', () => {
    const pipeline = pipelineAtConfidence(db, 'gate-alternative');

    // no_duplicate(0.25) + architecture(0.25) + docs_verified(0.20) = 70% → alternative
    const result = pipeline.runConfidenceGate('plan content', {
      checks: {
        no_duplicate: 1,
        architecture: 1,
        docs_verified: 1,
        oss_reference: 0,
        root_cause: 0,
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.gate.decision, 'alternative');
    assert.equal(result.state.phase, 'exec');
  });

  it('decision: abort → failed 단계로 전이한다', () => {
    const pipeline = pipelineAtConfidence(db, 'gate-abort');

    // no_duplicate(0.25)만 통과 → 25% → abort
    const result = pipeline.runConfidenceGate('plan content', {
      checks: {
        no_duplicate: 1,
        architecture: 0,
        docs_verified: 0,
        oss_reference: 0,
        root_cause: 0,
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.gate.decision, 'abort');
    assert.equal(result.state.phase, 'failed');
  });

  it('abort 전이 후 DB 상태도 failed로 갱신된다', () => {
    const pipeline = pipelineAtConfidence(db, 'gate-abort-db');

    pipeline.runConfidenceGate('plan content', {
      checks: {
        no_duplicate: 0,
        architecture: 0,
        docs_verified: 0,
        oss_reference: 0,
        root_cause: 0,
      },
    });

    const state = readPipelineState(db, 'gate-abort-db');
    assert.equal(state.phase, 'failed');
  });

  it('proceed 전이 후 confidence_result artifact가 저장된다', () => {
    const pipeline = pipelineAtConfidence(db, 'gate-artifact');

    pipeline.runConfidenceGate('plan content', {
      checks: {
        no_duplicate: 1,
        architecture: 1,
        docs_verified: 1,
        oss_reference: 1,
        root_cause: 1,
      },
    });

    const state = pipeline.getState();
    assert.ok(state.artifacts.confidence_result, 'confidence_result artifact 누락');
    assert.equal(state.artifacts.confidence_result.decision, 'proceed');
  });

  it('잘못된 phase(plan)에서 호출 시 ok: false와 에러 메시지를 반환한다', () => {
    initPipelineState(db, 'gate-wrong-phase');
    const pipeline = createPipeline(db, 'gate-wrong-phase');
    // 현재 phase: plan

    const result = pipeline.runConfidenceGate('plan content', { checks: {} });

    assert.equal(result.ok, false);
    assert.ok(result.error, 'error 메시지가 있어야 한다');
    assert.match(result.error, /confidence/);
  });
});

// ── runSelfCheckGate ────────────────────────────────────────────────────────

describe('runSelfCheckGate — pass/fail별 상태 전이', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    ensurePipelineTable(db);
  });

  afterEach(() => {
    db.close();
  });

  it('gate.passed: true → complete 단계로 전이한다', () => {
    const pipeline = pipelineAtSelfcheck(db, 'sc-pass');

    const result = pipeline.runSelfCheckGate(
      '구현 완료',
      '검증 완료',
      {
        evidence: {
          testOutput: 'PASS 10/10',
          requirementChecklist: ['req1', 'req2'],
          references: 'official docs',
          artifacts: 'git diff +50 -10',
        },
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.gate.passed, true);
    assert.equal(result.state.phase, 'complete');
  });

  it('gate.passed: false → fix 단계로 전이한다', () => {
    const pipeline = pipelineAtSelfcheck(db, 'sc-fail');

    // 필수 질문 미통과 → passed: false
    const result = pipeline.runSelfCheckGate(
      '완료',
      '완료',
      { evidence: {} },
    );

    assert.equal(result.ok, true);
    assert.equal(result.gate.passed, false);
    assert.equal(result.state.phase, 'fix');
  });

  it('Red Flag 탐지 시 fix 단계로 전이한다', () => {
    const pipeline = pipelineAtSelfcheck(db, 'sc-redflag');

    const result = pipeline.runSelfCheckGate(
      '테스트 통과했습니다',
      '검증 완료',
      { evidence: {} },
    );

    assert.equal(result.gate.passed, false);
    assert.ok(result.gate.flags.length > 0, 'Red Flag가 탐지되어야 한다');
    assert.equal(result.state.phase, 'fix');
  });

  it('complete 전이 후 DB 상태도 complete로 갱신된다', () => {
    const pipeline = pipelineAtSelfcheck(db, 'sc-complete-db');

    pipeline.runSelfCheckGate(
      '구현 완료',
      '검증 완료',
      {
        evidence: {
          testOutput: 'PASS 5/5',
          requirementChecklist: ['done'],
          references: 'docs',
          artifacts: 'diff',
        },
      },
    );

    const state = readPipelineState(db, 'sc-complete-db');
    assert.equal(state.phase, 'complete');
  });

  it('selfcheck_result artifact가 저장된다', () => {
    const pipeline = pipelineAtSelfcheck(db, 'sc-artifact');

    pipeline.runSelfCheckGate(
      '구현 완료',
      '검증 완료',
      {
        evidence: {
          testOutput: 'PASS',
          requirementChecklist: ['done'],
          references: 'docs',
          artifacts: 'diff',
        },
      },
    );

    const state = pipeline.getState();
    assert.ok(state.artifacts.selfcheck_result, 'selfcheck_result artifact 누락');
    assert.ok('passed' in state.artifacts.selfcheck_result);
  });

  it('잘못된 phase(plan)에서 호출 시 ok: false와 에러 메시지를 반환한다', () => {
    initPipelineState(db, 'sc-wrong-phase');
    const pipeline = createPipeline(db, 'sc-wrong-phase');
    // 현재 phase: plan

    const result = pipeline.runSelfCheckGate('result', 'verify', {});

    assert.equal(result.ok, false);
    assert.ok(result.error, 'error 메시지가 있어야 한다');
    assert.match(result.error, /selfcheck/);
  });

  it('잘못된 phase(exec)에서 호출 시 ok: false를 반환한다', () => {
    const pipeline = createPipeline(db, 'sc-exec-phase');
    pipeline.advance('prd');
    pipeline.advance('confidence');
    pipeline.advance('exec');
    // 현재 phase: exec

    const result = pipeline.runSelfCheckGate('result', 'verify', {});

    assert.equal(result.ok, false);
    assert.match(result.error, /selfcheck/);
  });
});

// ── runDeslopGate ───────────────────────────────────────────────────────────

describe('runDeslopGate — unconditional verify 전이', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    ensurePipelineTable(db);
  });

  afterEach(() => {
    db.close();
  });

  it('deslopResult 전달 시 항상 verify 단계로 전이한다', () => {
    const pipeline = pipelineAtDeslop(db, 'deslop-with-result');

    const result = pipeline.runDeslopGate({
      files: [{ path: 'src/foo.mjs', issues: [] }],
      summary: { total: 1, clean: 1 },
    });

    assert.equal(result.ok, true);
    assert.equal(result.state.phase, 'verify');
  });

  it('deslopResult 없이(null) 호출해도 verify 단계로 전이한다', () => {
    const pipeline = pipelineAtDeslop(db, 'deslop-null');

    const result = pipeline.runDeslopGate(null);

    assert.equal(result.ok, true);
    assert.equal(result.state.phase, 'verify');
  });

  it('deslopResult 인수 생략 시 기본값으로 verify 전이한다', () => {
    const pipeline = pipelineAtDeslop(db, 'deslop-default');

    const result = pipeline.runDeslopGate();

    assert.equal(result.ok, true);
    assert.equal(result.state.phase, 'verify');
    assert.deepEqual(result.gate, { files: [], summary: { total: 0, clean: 0 } });
  });

  it('slop이 검출된 결과여도 verify 전이가 차단되지 않는다', () => {
    const pipeline = pipelineAtDeslop(db, 'deslop-with-slop');

    const result = pipeline.runDeslopGate({
      files: [{ path: 'src/bar.mjs', issues: ['hardcoded string'] }],
      summary: { total: 1, clean: 0, slop: 1 },
    });

    assert.equal(result.ok, true);
    assert.equal(result.state.phase, 'verify');
  });

  it('verify 전이 후 DB 상태도 verify로 갱신된다', () => {
    const pipeline = pipelineAtDeslop(db, 'deslop-db');

    pipeline.runDeslopGate({ files: [], summary: { total: 0, clean: 0 } });

    const state = readPipelineState(db, 'deslop-db');
    assert.equal(state.phase, 'verify');
  });

  it('deslop_result artifact가 저장된다', () => {
    const deslopResult = { files: [], summary: { total: 0, clean: 0 } };
    const pipeline = pipelineAtDeslop(db, 'deslop-artifact');

    pipeline.runDeslopGate(deslopResult);

    const state = pipeline.getState();
    assert.ok(state.artifacts.deslop_result, 'deslop_result artifact 누락');
    assert.deepEqual(state.artifacts.deslop_result, deslopResult);
  });

  it('잘못된 phase(exec)에서 호출 시 ok: false와 에러 메시지를 반환한다', () => {
    const pipeline = createPipeline(db, 'deslop-wrong-phase');
    pipeline.advance('prd');
    pipeline.advance('confidence');
    pipeline.advance('exec');
    // 현재 phase: exec (deslop 아님)

    const result = pipeline.runDeslopGate({ files: [], summary: {} });

    assert.equal(result.ok, false);
    assert.ok(result.error, 'error 메시지가 있어야 한다');
    assert.match(result.error, /deslop/);
  });

  it('잘못된 phase(plan)에서 호출 시 ok: false를 반환한다', () => {
    initPipelineState(db, 'deslop-plan-phase');
    const pipeline = createPipeline(db, 'deslop-plan-phase');
    // 현재 phase: plan

    const result = pipeline.runDeslopGate();

    assert.equal(result.ok, false);
    assert.match(result.error, /deslop/);
  });
});
