// hub/pipeline/gates/confidence.mjs — Pre-Execution Confidence Gate
//
// plan → prd → [confidence] → exec
// 5단계 확신도 검증: >=90% proceed / 70-89% alternative / <70% abort

export const CRITERIA = [
  { id: 'no_duplicate',  label: '중복 구현 없는지?', weight: 0.25 },
  { id: 'architecture',  label: '아키텍처 준수?',    weight: 0.25 },
  { id: 'docs_verified', label: '공식 문서 확인?',   weight: 0.20 },
  { id: 'oss_reference', label: 'OSS 레퍼런스?',    weight: 0.15 },
  { id: 'root_cause',    label: '근본 원인 파악?',   weight: 0.15 },
];

/**
 * 확신도 검증 실행
 * @param {string|object} planArtifact - plan 단계에서 생성된 구현 계획
 * @param {object} context - { checks?, codebaseFiles?, existingTests? }
 * @param {object} [context.checks] - 각 기준별 점수 (boolean 또는 0-1 숫자)
 * @returns {{ score: number, breakdown: Array, decision: string, reasoning: string }}
 */
export function runConfidenceCheck(planArtifact, context = {}) {
  if (!planArtifact) {
    return {
      score: 0,
      breakdown: CRITERIA.map(c => ({ id: c.id, label: c.label, weight: c.weight, score: 0, passed: false })),
      decision: 'abort',
      reasoning: 'planArtifact가 제공되지 않았습니다.',
    };
  }

  const checks = context.checks || {};

  const breakdown = CRITERIA.map(c => {
    const raw = checks[c.id];
    const score = typeof raw === 'number' ? Math.max(0, Math.min(1, raw)) : (raw ? 1 : 0);
    return { id: c.id, label: c.label, weight: c.weight, score, passed: score >= 0.7 };
  });

  const totalScore = Math.round(
    breakdown.reduce((sum, b) => sum + b.score * b.weight, 0) * 100,
  );

  let decision, reasoning;
  if (totalScore >= 90) {
    decision = 'proceed';
    reasoning = `확신도 ${totalScore}%: 모든 기준 충족. 실행 진행.`;
  } else if (totalScore >= 70) {
    decision = 'alternative';
    reasoning = `확신도 ${totalScore}%: 일부 기준 미달. 대안 검토 필요.`;
  } else {
    decision = 'abort';
    reasoning = `확신도 ${totalScore}%: 기준 미달. 실행 중단.`;
  }

  return { score: totalScore, breakdown, decision, reasoning, needsReview: decision === 'alternative' };
}
