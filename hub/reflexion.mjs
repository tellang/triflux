// hub/reflexion.mjs — Cross-Session Error Learning Engine
// 에러를 구조화 저장 → 다음 세션에서 유사 에러 패턴 매칭 → 자동 솔루션 적용

const DEFAULT_REFLEXION_TYPE = "reflexion";
export const ADAPTIVE_RULE_TYPE = "adaptive";
const DEFAULT_CONFIDENCE = 0.5;
const ACTIVE_RULE_CONFIDENCE = 0.5;
const ADAPTIVE_PROMOTION_STEP = 0.1;
const ADAPTIVE_DECAY_STEP = 0.1;
const ADAPTIVE_DECAY_WINDOW = 5;
const ADAPTIVE_DELETE_THRESHOLD = 0.3;

function clampConfidence(value) {
  const next = Number(value);
  if (!Number.isFinite(next)) return DEFAULT_CONFIDENCE;
  return Math.max(0, Math.min(1, next));
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function pickString(...values) {
  return (
    values.find((value) => typeof value === "string" && value.trim())?.trim() ||
    ""
  );
}

function pickSessionCount(...values) {
  const raw = values.find((value) => Number.isFinite(Number(value)));
  return raw == null ? 0 : Math.max(0, Math.trunc(Number(raw)));
}

function pickSessionId(errorContext = {}) {
  return pickString(
    errorContext.session_id,
    errorContext.sessionId,
    errorContext.context?.session_id,
    errorContext.context?.sessionId,
  );
}

function pickProjectSlug(errorContext = {}) {
  return pickString(
    errorContext.projectSlug,
    errorContext.project_slug,
    errorContext.context?.projectSlug,
    errorContext.context?.project_slug,
  );
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry != null && entry !== ""),
  );
}

function buildErrorText(errorContext = {}) {
  const parts = [
    pickString(errorContext.tool_output),
    pickString(errorContext.error),
    pickString(errorContext.tool_input?.command),
    errorContext.tool_result == null ? "" : safeJson(errorContext.tool_result),
  ].filter(Boolean);
  return parts.join("\n").trim();
}

function buildAdaptiveContext(errorContext = {}) {
  return compactObject({
    source: "PostToolUseFailure",
    tool_name: pickString(errorContext.tool_name),
    agent: pickString(errorContext.agent, errorContext.context?.agent),
    cli: pickString(errorContext.cli, errorContext.context?.cli),
    command: pickString(errorContext.tool_input?.command),
    file: pickString(
      errorContext.tool_input?.file_path,
      errorContext.context?.file,
    ),
    project_slug: pickProjectSlug(errorContext),
  });
}

function buildAdaptiveSolution(errorContext = {}, errorText = "") {
  const explicit = pickString(
    errorContext.systemMessage,
    errorContext.additionalContext,
    errorContext.hint,
  );
  if (explicit) return explicit;
  const toolName = pickString(errorContext.tool_name) || "tool";
  const command = pickString(errorContext.tool_input?.command);
  const summary = errorText.split("\n")[0]?.trim() || "반복 실패 패턴";
  if (command)
    return `${toolName} 재시도 전 입력을 검증하세요: ${command}\n원인: ${summary}`;
  return `${toolName} 재시도 전 실패 원인을 검증하세요: ${summary}`;
}

function normalizeSessionIds(sessionIds) {
  if (!Array.isArray(sessionIds)) return [];
  return [
    ...new Set(
      sessionIds.filter((value) => typeof value === "string" && value.trim()),
    ),
  ];
}

function getAdaptiveState(rule = {}) {
  const state = rule.adaptive_state || {};
  const session_ids = normalizeSessionIds(state.session_ids);
  return {
    ...state,
    project_slug: pickString(state.project_slug, rule.context?.project_slug),
    session_ids,
    session_occurrences: Math.max(
      state.session_occurrences || 0,
      session_ids.length,
    ),
    last_seen_session: pickSessionCount(state.last_seen_session),
    last_decay_session: pickSessionCount(state.last_decay_session),
  };
}

function mergeAdaptiveState(rule, errorContext = {}) {
  const current = getAdaptiveState(rule);
  const sessionId = pickSessionId(errorContext);
  const sessionCount = pickSessionCount(
    errorContext.sessionCount,
    errorContext.session_count,
    errorContext.context?.sessionCount,
    errorContext.context?.session_count,
  );
  const session_ids = normalizeSessionIds(
    sessionId ? [...current.session_ids, sessionId] : current.session_ids,
  );
  return {
    ...current,
    project_slug: pickString(
      pickProjectSlug(errorContext),
      current.project_slug,
    ),
    session_ids,
    session_occurrences: Math.max(
      current.session_occurrences,
      session_ids.length,
    ),
    last_seen_session: Math.max(current.last_seen_session, sessionCount),
    last_decay_session: current.last_decay_session || sessionCount,
  };
}

function filterEntriesByType(entries, type) {
  return entries.filter(
    (entry) => (entry.type || DEFAULT_REFLEXION_TYPE) === type,
  );
}

/**
 * 에러 메시지를 정규화된 패턴 시그니처로 변환
 * 파일 경로, 줄 번호, 타임스탬프, UUID, 숫자 리터럴을 플레이스홀더로 치환
 * @param {string} errorMessage
 * @returns {string}
 */
export function normalizeError(errorMessage) {
  if (!errorMessage || typeof errorMessage !== "string") return "";
  let p = errorMessage;
  p = p.replace(/[A-Za-z]:\\[\w\\.\-/]+/g, "<FILE>");
  p = p.replace(/(?:\/[\w.-]+){2,}/g, "<FILE>");
  p = p.replace(/:(\d+)(:\d+)?(?=[\s,)\]]|$)/g, ":<LINE>");
  p = p.replace(/\b[Ll]ine\s+\d+/g, "line <LINE>");
  p = p.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[\w.+-]*/g, "<TIME>");
  p = p.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    "<ID>",
  );
  p = p.replace(/\b[0-9a-f]{32,}\b/gi, "<ID>");
  p = p.replace(/\b\d{10,13}\b/g, "<TIME>");
  p = p.replace(/\b\d{4,}\b/g, "<NUM>");
  return p.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * 에러에 대한 기존 솔루션 검색
 * @deprecated reflexion_entries 기반. adaptive_rules로 통합 예정. 현재 런타임 호출 없음.
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
  return { found: true, entries, bestMatch: entries[0] };
}

/**
 * 에러 해결 후 학습 저장
 * @deprecated reflexion_entries 기반. adaptive_rules로 통합 예정. 현재 런타임 호출 없음.
 * 동일 패턴이 존재하면 hit 업데이트, 없으면 새로 생성
 * @param {object} store
 * @param {{ error: string, solution: string, context?: object, success?: boolean }} opts
 * @returns {object|null}
 */
export function learnFromError(
  store,
  { error, solution, context = {}, success = false },
) {
  const pattern = normalizeError(error);
  if (!pattern || !solution) return null;
  const existing = filterEntriesByType(
    store.findReflexion(pattern, context),
    DEFAULT_REFLEXION_TYPE,
  );
  if (existing.length && existing[0].error_pattern === pattern) {
    return store.updateReflexionHit(existing[0].id, success);
  }
  const newEntry = store.addReflexion({
    type: DEFAULT_REFLEXION_TYPE,
    error_pattern: pattern,
    error_message: error,
    context,
    solution,
    solution_code: null,
  });
  return success && newEntry
    ? store.updateReflexionHit(newEntry.id, true)
    : newEntry;
}

/**
 * 솔루션 적용 결과 피드백
 * @deprecated reflexion_entries 기반. adaptive_rules로 통합 예정. 현재 런타임 호출 없음.
 * @param {object} store
 * @param {string} entryId
 * @param {boolean} success
 * @returns {object|null}
 */
export function reportOutcome(store, entryId, success) {
  return store.updateReflexionHit(entryId, success);
}

/**
 * PostToolUseFailure 컨텍스트에서 adaptive rule payload 생성
 * @param {object} errorContext
 * @returns {object|null}
 */
export function adaptiveRuleFromError(errorContext = {}) {
  const errorText = buildErrorText(errorContext);
  const pattern = normalizeError(errorText);
  if (!pattern) return null;
  return {
    type: ADAPTIVE_RULE_TYPE,
    error_pattern: pattern,
    error_message: errorText,
    context: buildAdaptiveContext(errorContext),
    solution: buildAdaptiveSolution(errorContext, errorText),
    solution_code: null,
    adaptive_state: (() => {
      const sessionId = pickSessionId(errorContext);
      const sessionCount = pickSessionCount(
        errorContext.sessionCount,
        errorContext.session_count,
      );
      return {
        project_slug: pickProjectSlug(errorContext),
        session_ids: sessionId ? [sessionId] : [],
        session_occurrences: sessionId ? 1 : 0,
        last_seen_session: sessionCount,
        last_decay_session: sessionCount,
      };
    })(),
    confidence: DEFAULT_CONFIDENCE,
    hit_count: 1,
    success_count: 0,
  };
}

/**
 * 동일 패턴이 여러 세션에서 재발하면 adaptive rule confidence를 승격
 * @param {object} store — store-adapter 인스턴스 (findAdaptiveRule, updateRuleConfidence 필요)
 * @param {string} projectSlug
 * @param {string} pattern
 * @returns {object|null}
 */
export function promoteRule(store, projectSlug, pattern) {
  if (!store.findAdaptiveRule || !store.updateRuleConfidence) return null;
  const rule = store.findAdaptiveRule(projectSlug, pattern);
  if (!rule) return null;
  const promoted = clampConfidence(rule.confidence + ADAPTIVE_PROMOTION_STEP);
  return store.updateRuleConfidence(projectSlug, pattern, promoted, { hit_count_increment: 1 });
}

/**
 * confidence가 낮은 adaptive rules 정리
 * @param {object} store — store-adapter 인스턴스 (listAdaptiveRules, updateRuleConfidence, deleteAdaptiveRule 필요)
 * @param {number} _sessionCount — 하위 호환용 (현재 미사용, pruneStaleRules가 시간 기반으로 대체)
 * @returns {{ updated: Array, deleted: string[] }}
 */
export function decayRules(store, _sessionCount) {
  if (!store.listAdaptiveRules) return { updated: [], deleted: [] };
  const result = { updated: [], deleted: [] };
  const rules = store.listAdaptiveRules();
  for (const rule of rules) {
    // 30일 이상 미관측 + confidence < 0.5 → decay
    const ageDays = (Date.now() - (rule.last_seen_ms || 0)) / (24 * 3600 * 1000);
    if (ageDays < 7) continue; // 7일 미만은 건너뜀
    const decayed = clampConfidence(rule.confidence - ADAPTIVE_DECAY_STEP);
    if (decayed <= ADAPTIVE_DELETE_THRESHOLD) {
      if (store.deleteAdaptiveRule(rule.project_slug, rule.pattern)) {
        result.deleted.push(`${rule.project_slug}:${rule.pattern}`);
      }
      continue;
    }
    if (decayed < rule.confidence) {
      const updated = store.updateRuleConfidence(rule.project_slug, rule.pattern, decayed);
      if (updated) result.updated.push(updated);
    }
  }
  return result;
}

/**
 * 현재 활성화된 adaptive rules 조회
 * @param {object} store — store-adapter 인스턴스 (listAdaptiveRules 필요)
 * @param {string} projectSlug
 * @returns {Array}
 */
export function getActiveAdaptiveRules(store, projectSlug) {
  if (!store.listAdaptiveRules) return [];
  return store.listAdaptiveRules(projectSlug)
    .filter((rule) => rule.confidence > ACTIVE_RULE_CONFIDENCE);
}

/**
 * 신뢰도 자동 조정 (success_count / hit_count, 샘플 크기 기반 감쇠)
 * hit_count가 작으면 0.5(기본값)쪽으로 보수적으로 수렴
 * @param {object} entry - { hit_count, success_count }
 * @returns {number} 0~1 사이 신뢰도
 */
export function recalcConfidence(entry) {
  if (!entry?.hit_count || entry.hit_count <= 0) return DEFAULT_CONFIDENCE;
  const ratio = entry.success_count / entry.hit_count;
  const decay = Math.min(1, entry.hit_count / 10);
  return ratio * decay + DEFAULT_CONFIDENCE * (1 - decay);
}
