// tests/unit/intent.test.mjs — intent 의도 분류 엔진 테스트
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  INTENT_CATEGORIES,
  quickClassify,
  classifyIntent,
  refineClassification,
} from '../../hub/intent.mjs';

describe('intent', () => {
  // 1. quickClassify: "JWT 인증 구현해" → implement, 고신뢰
  it('quickClassify: "JWT 인증 구현해" → implement with high confidence', () => {
    const r = quickClassify('JWT 인증 구현해');
    assert.equal(r.category, 'implement');
    assert.ok(r.confidence >= 0.5, `Expected ≥0.5, got ${r.confidence}`);
  });

  // 2. quickClassify: "이 버그 고쳐" → debug, 고신뢰
  it('quickClassify: "이 버그 고쳐" → debug with high confidence', () => {
    const r = quickClassify('이 버그 고쳐');
    assert.equal(r.category, 'debug');
    assert.ok(r.confidence >= 0.5, `Expected ≥0.5, got ${r.confidence}`);
  });

  // 3. quickClassify: "코드 리뷰해줘" → review, 고신뢰
  it('quickClassify: "코드 리뷰해줘" → review with high confidence', () => {
    const r = quickClassify('코드 리뷰해줘');
    assert.equal(r.category, 'review');
    assert.ok(r.confidence >= 0.5, `Expected ≥0.5, got ${r.confidence}`);
  });

  // 4. quickClassify: "이게 뭐야 설명해" → explain, 고신뢰
  it('quickClassify: "이게 뭐야 설명해" → explain with high confidence', () => {
    const r = quickClassify('이게 뭐야 설명해');
    assert.equal(r.category, 'explain');
    assert.ok(r.confidence >= 0.5, `Expected ≥0.5, got ${r.confidence}`);
  });

  // 5. quickClassify: 모호한 프롬프트 → 저신뢰 (<0.8)
  it('quickClassify: ambiguous prompt yields low confidence', () => {
    const r = quickClassify('프로젝트를 좀 개선하고 싶은데');
    assert.ok(r.confidence < 0.8, `Expected <0.8, got ${r.confidence}`);
  });

  // 6. classifyIntent: routing 필드에 agent/mcp/effort 포함
  it('classifyIntent returns routing with agent, mcp, effort', () => {
    const r = classifyIntent('이 코드 리뷰해줘');
    assert.ok(r.routing, 'Should have routing');
    assert.ok(r.routing.agent, 'routing.agent should exist');
    assert.ok(typeof r.routing.mcp === 'string' || r.routing.mcp === null, 'routing.mcp should be string or null');
    assert.ok(typeof r.routing.effort === 'string' || r.routing.effort === null, 'routing.effort should be string or null');
    assert.ok(r.reasoning, 'Should have reasoning');
  });

  // 7. classifyIntent: implement → executor/implement/high
  it('classifyIntent: implement routes to executor/implement/high', () => {
    const r = classifyIntent('새로운 API 엔드포인트 구현해줘');
    assert.equal(r.category, 'implement');
    assert.equal(r.routing.agent, 'executor');
    assert.equal(r.routing.mcp, 'implement');
    assert.equal(r.routing.effort, 'high');
  });

  // 8. classifyIntent: document → writer/docs/pro
  it('classifyIntent: document routes to writer/docs/pro', () => {
    const r = classifyIntent('이 모듈 문서화해줘');
    assert.equal(r.category, 'document');
    assert.equal(r.routing.agent, 'writer');
    assert.equal(r.routing.mcp, 'docs');
    assert.equal(r.routing.effort, 'pro');
  });

  // 9. quickClassify: 한국어 + 영어 혼용 프롬프트
  it('quickClassify handles mixed Korean/English prompts', () => {
    const r1 = quickClassify('implement JWT 인증 추가해줘');
    assert.equal(r1.category, 'implement');

    const r2 = quickClassify('debug this error 에러 고쳐줘');
    assert.equal(r2.category, 'debug');

    const r3 = quickClassify('unit test 작성해줘 테스트 추가');
    assert.equal(r3.category, 'test');
  });

  // 10. quickClassify: 빈 프롬프트 → 기본 카테고리 + 저신뢰
  it('quickClassify: empty prompt returns default category with low confidence', () => {
    const r1 = quickClassify('');
    assert.equal(r1.category, 'implement');
    assert.ok(r1.confidence <= 0.3, `Expected ≤0.3, got ${r1.confidence}`);

    const r2 = quickClassify(null);
    assert.equal(r2.category, 'implement');
    assert.ok(r2.confidence <= 0.3);

    const r3 = quickClassify(undefined);
    assert.equal(r3.category, 'implement');
    assert.ok(r3.confidence <= 0.3);
  });

  // 11. INTENT_CATEGORIES has exactly 10 categories
  it('INTENT_CATEGORIES has 10 categories', () => {
    assert.equal(Object.keys(INTENT_CATEGORIES).length, 10);
  });

  // 12. All categories have agent, mcp, effort fields
  it('all categories have agent, mcp, effort fields', () => {
    for (const [name, cat] of Object.entries(INTENT_CATEGORIES)) {
      assert.ok(typeof cat.agent === 'string', `${name}.agent should be string`);
      assert.ok(cat.mcp === null || typeof cat.mcp === 'string', `${name}.mcp should be string|null`);
      assert.ok(cat.effort === null || typeof cat.effort === 'string', `${name}.effort should be string|null`);
    }
  });

  // 13. refineClassification does not throw
  it('refineClassification does not throw', () => {
    assert.doesNotThrow(() => refineClassification('test prompt', 'debug'));
  });

  // 14. quickClassify: test category
  it('quickClassify: "테스트 작성" → test', () => {
    const r = quickClassify('유닛 테스트 작성해줘');
    assert.equal(r.category, 'test');
  });
});
