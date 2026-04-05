// hub/pipeline/gates/selfcheck.mjs — Post-Execution Self-Check (Hallucination Detection)
//
// exec → verify → [selfcheck] → complete/fix
// 4대 필수 질문 + 7대 할루시네이션 Red Flag 탐지

export const RED_FLAGS = [
  { id: 'test_pass_no_output',  pattern: /테스트\s*(?:가\s*)?통과/,  label: '"테스트 통과" (출력 없이)' },
  { id: 'everything_works',     pattern: /모든\s*게?\s*작동/,        label: '"모든게 작동" (증거 없이)' },
  { id: 'no_changes_with_diff', pattern: /변경\s*(?:사항\s*)?없/,    label: '"변경 없음" (diff 있는데)' },
  { id: 'backward_compatible',  pattern: /호환성\s*(?:이\s*)?유지/,  label: '"호환성 유지" (검증 없이)' },
  { id: 'performance_improved', pattern: /성능\s*(?:이\s*)?개선/,    label: '"성능 개선" (벤치마크 없이)' },
  { id: 'security_enhanced',    pattern: /보안\s*(?:이\s*)?강화/,    label: '"보안 강화" (증거 없이)' },
  { id: 'error_handling_done',  pattern: /에러\s*처리\s*(?:가\s*)?완료/, label: '"에러 처리 완료" (catch 블록만)' },
];

export const QUESTIONS = [
  { id: 'tests_passing',    label: '모든 테스트 통과?',   evidenceKey: 'testOutput' },
  { id: 'requirements_met', label: '모든 요구사항 충족?', evidenceKey: 'requirementChecklist' },
  { id: 'no_assumptions',   label: '검증 없는 가정?',    evidenceKey: 'references' },
  { id: 'evidence_provided', label: '증거 있는가?',       evidenceKey: 'artifacts' },
];

/**
 * Red Flag 스캔 — 텍스트에서 할루시네이션 패턴 탐지
 * @param {string} text - 스캔 대상 텍스트
 * @param {object} context - { hasDiff?, evidence? }
 * @returns {Array<{ id: string, label: string }>}
 */
function detectRedFlags(text, context = {}) {
  const flags = [];
  const evidence = context.evidence || {};

  for (const rf of RED_FLAGS) {
    if (!rf.pattern.test(text)) continue;

    // "변경 없음"은 실제 diff가 있을 때만 Red Flag
    if (rf.id === 'no_changes_with_diff' && !context.hasDiff) continue;

    // "테스트 통과"는 testOutput 증거가 없을 때만 Red Flag
    if (rf.id === 'test_pass_no_output' && evidence.testOutput) continue;

    // 기타 Red Flag는 해당 id의 반증이 있으면 스킵
    if (evidence[rf.id]) continue;

    flags.push({ id: rf.id, label: rf.label });
  }

  return flags;
}

/**
 * Self-Check 실행
 * @param {string|object} execResult - 실행 결과 (텍스트 또는 객체)
 * @param {string|object} verifyResult - 검증 결과 (텍스트 또는 객체)
 * @param {object} requirements - { hasDiff?, evidence? }
 * @param {boolean} [requirements.hasDiff] - diff 존재 여부
 * @param {object} [requirements.evidence] - { testOutput, requirementChecklist, references, artifacts }
 * @returns {{ passed: boolean, score: number, flags: Array, checklist: Array }}
 */
export function runSelfCheck(execResult, verifyResult, requirements = {}) {
  const normalize = (v) => typeof v === 'string' ? v : (v != null ? JSON.stringify(v) : '');
  const text = [normalize(execResult), normalize(verifyResult)].join('\n');

  const flags = detectRedFlags(text, requirements);

  const evidence = requirements.evidence || {};
  const checklist = QUESTIONS.map(q => {
    const ev = evidence[q.evidenceKey];
    const passed = ev != null && (typeof ev === 'string' ? ev.trim().length > 0 : true);
    return { id: q.id, label: q.label, passed, evidence: ev || null };
  });

  const allQuestionsPassed = checklist.every(q => q.passed);
  const passed = flags.length === 0 && allQuestionsPassed;

  // 점수: 기본 100, Red Flag당 -15, 실패 질문당 -20
  const flagPenalty = flags.length * 15;
  const questionPenalty = checklist.filter(q => !q.passed).length * 20;
  const score = Math.max(0, 100 - flagPenalty - questionPenalty);

  return { passed, score, flags, checklist };
}
