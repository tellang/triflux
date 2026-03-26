// hub/reflexion.mjs — Cross-Session Error Learning Engine
// 에러를 구조화 저장 → 다음 세션에서 유사 에러 패턴 매칭 → 자동 솔루션 적용

/**
 * 에러 메시지를 정규화된 패턴 시그니처로 변환
 * 파일 경로, 줄 번호, 타임스탬프, UUID, 숫자 리터럴을 플레이스홀더로 치환
 * @param {string} errorMessage
 * @returns {string}
 */
export function normalizeError(errorMessage) {
  if (!errorMessage || typeof errorMessage !== 'string') return '';
  let p = errorMessage;
  // Windows 파일 경로 (C:\Users\...) — Unix 경로보다 먼저 처리
  p = p.replace(/[A-Za-z]:\\[\w\\.\-/]+/g, '<FILE>');
  // Unix 파일 경로 (/home/user/file.js)
  p = p.replace(/(?:\/[\w.\-]+){2,}/g, '<FILE>');
  // 줄:컬럼 (file.js:42:10)
  p = p.replace(/:(\d+)(:\d+)?(?=[\s,)\]]|$)/g, ':<LINE>');
  // "line 42" / "Line 42"
  p = p.replace(/\b[Ll]ine\s+\d+/g, 'line <LINE>');
  // ISO 타임스탬프
  p = p.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[\w.+-]*/g, '<TIME>');
  // UUID (8-4-4-4-12) — Unix 타임스탬프보다 먼저 처리 (UUID 내부 숫자 보호)
  p = p.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<ID>');
  // 긴 hex 해시 (32+자리)
  p = p.replace(/\b[0-9a-f]{32,}\b/gi, '<ID>');
  // Unix 타임스탬프 (10-13자리 숫자)
  p = p.replace(/\b\d{10,13}\b/g, '<TIME>');
  // 4자리 이상 숫자 리터럴
  p = p.replace(/\b\d{4,}\b/g, '<NUM>');
  // 소문자화 + 공백 정규화
  p = p.toLowerCase().replace(/\s+/g, ' ').trim();
  return p;
}

/**
 * 에러에 대한 기존 솔루션 검색
 * @param {object} store - createStore() 반환 객체
 * @param {string} errorMessage - 원본 에러 메시지
 * @param {object} [context={}] - { file, function, cli, agent }
 * @returns {{ found: boolean, entries: Array, bestMatch: object|null }}
 */
export function lookupSolution(store, errorMessage, context = {}) {
  const pattern = normalizeError(errorMessage);
  if (!pattern) return { found: false, entries: [], bestMatch: null };

  const entries = store.findReflexion(pattern, context);
  if (!entries.length) return { found: false, entries: [], bestMatch: null };

  const bestMatch = entries[0]; // confidence DESC 정렬 결과
  return { found: true, entries, bestMatch };
}

/**
 * 에러 해결 후 학습 저장
 * 동일 패턴이 존재하면 hit 업데이트, 없으면 새로 생성
 * @param {object} store
 * @param {{ error: string, solution: string, context?: object, success?: boolean }} opts
 * @returns {object|null}
 */
export function learnFromError(store, { error, solution, context = {}, success = false }) {
  const pattern = normalizeError(error);
  if (!pattern || !solution) return null;

  // 동일 패턴이 이미 존재하는지 확인
  const existing = store.findReflexion(pattern, context);
  if (existing.length && existing[0].error_pattern === pattern) {
    return store.updateReflexionHit(existing[0].id, success);
  }

  const newEntry = store.addReflexion({
    error_pattern: pattern,
    error_message: error,
    context,
    solution,
    solution_code: null,
  });
  if (success && newEntry) {
    return store.updateReflexionHit(newEntry.id, true);
  }
  return newEntry;
}

/**
 * 솔루션 적용 결과 피드백
 * @param {object} store
 * @param {string} entryId
 * @param {boolean} success
 * @returns {object|null}
 */
export function reportOutcome(store, entryId, success) {
  return store.updateReflexionHit(entryId, success);
}

/**
 * 신뢰도 자동 조정 (success_count / hit_count, 샘플 크기 기반 감쇠)
 * hit_count가 작으면 0.5(기본값)쪽으로 보수적으로 수렴
 * @param {object} entry - { hit_count, success_count }
 * @returns {number} 0~1 사이 신뢰도
 */
export function recalcConfidence(entry) {
  if (!entry || !entry.hit_count || entry.hit_count <= 0) return 0.5;
  const ratio = entry.success_count / entry.hit_count;
  // 샘플 크기 기반 감쇠: hit_count가 10 미만이면 기본값(0.5) 방향으로 보정
  const decay = Math.min(1, entry.hit_count / 10);
  return ratio * decay + 0.5 * (1 - decay);
}
