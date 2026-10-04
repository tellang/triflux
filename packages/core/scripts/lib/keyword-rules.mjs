import { readFileSync } from "node:fs";

const VALID_MCP_ROUTES = new Set(["codex", "antigravity", "gemini", "claude"]);

// 주입 강도. explicit = 스킬명 직접 언급(명시 토큰) → MUST 호출 문구,
// suggest = 자연어 매칭 → "실행 요청이면 고려하라" 수준의 제안 문구 (ADR-0021).
const VALID_STRENGTHS = new Set(["explicit", "suggest"]);
const DEFAULT_STRENGTH = "explicit";

function logRuleError(message, error) {
  if (error) {
    console.error(`[triflux-keyword-rules] ${message}: ${error.message}`);
    return;
  }
  console.error(`[triflux-keyword-rules] ${message}`);
}

function normalizePattern(pattern) {
  if (!pattern || typeof pattern.source !== "string") return null;
  if (typeof pattern.flags !== "string") return null;
  if (pattern.strength != null && !VALID_STRENGTHS.has(pattern.strength))
    return null;
  const normalized = { source: pattern.source, flags: pattern.flags };
  if (pattern.strength != null) normalized.strength = pattern.strength;
  return normalized;
}

function normalizeState(state) {
  if (state == null) return null;
  if (typeof state !== "object") return null;
  if (typeof state.activate !== "boolean") return null;
  if (typeof state.name !== "string" || !state.name.trim()) return null;
  return { activate: state.activate, name: state.name.trim() };
}

function normalizeRule(rule) {
  if (!rule || typeof rule !== "object") return null;
  if (rule.disabled === true) return null;
  if (typeof rule.id !== "string" || !rule.id.trim()) return null;
  if (!Array.isArray(rule.patterns) || rule.patterns.length === 0) return null;
  if (typeof rule.priority !== "number" || !Number.isFinite(rule.priority))
    return null;

  // strength: 규칙 기본 주입 강도. 패턴별 strength 가 있으면 그 패턴만 덮어쓴다.
  // 값이 틀리면 규칙 자체를 무효로 본다 (platform 과 같은 규칙).
  if (rule.strength != null && !VALID_STRENGTHS.has(rule.strength)) return null;
  const strength = rule.strength ?? DEFAULT_STRENGTH;

  const patterns = rule.patterns
    .map(normalizePattern)
    .filter(Boolean)
    .map((p) => ({ ...p, strength: p.strength ?? strength }));
  if (patterns.length === 0) return null;

  // exclude_patterns: 하나라도 맞으면 그 규칙의 suggest 매칭을 버린다.
  // 명시 토큰(explicit) 매칭은 사용자가 스킬을 직접 부른 것이라 제외하지 않는다.
  if (rule.exclude_patterns != null && !Array.isArray(rule.exclude_patterns))
    return null;
  const excludePatterns = Array.isArray(rule.exclude_patterns)
    ? rule.exclude_patterns
        .map(normalizePattern)
        .filter(Boolean)
        .map(({ source, flags }) => ({ source, flags }))
    : [];

  // skill_candidates: 머신마다 설치 이름이 다른 외부 스킬(gstack 의 `ship` /
  // `gstack-ship`)의 후보 목록. detector 가 실행 시점에 설치된 첫 이름을 고른다.
  // skill 이 없으면 첫 후보를 대표 이름으로 둔다.
  if (rule.skill_candidates != null && !Array.isArray(rule.skill_candidates))
    return null;
  const skillCandidates = Array.isArray(rule.skill_candidates)
    ? rule.skill_candidates
        .filter((name) => typeof name === "string" && name.trim())
        .map((name) => name.trim())
    : [];

  const skill =
    typeof rule.skill === "string" && rule.skill.trim()
      ? rule.skill.trim()
      : (skillCandidates[0] ?? null);
  const action =
    typeof rule.action === "string" && rule.action.trim()
      ? rule.action.trim()
      : null;
  const mcpRoute =
    typeof rule.mcp_route === "string" && VALID_MCP_ROUTES.has(rule.mcp_route)
      ? rule.mcp_route
      : null;

  if (!skill && !mcpRoute && !action) return null;

  const hint =
    typeof rule.hint === "string" && rule.hint.trim() ? rule.hint.trim() : null;

  // suggest_when: suggest 주입문에서 "…이면 <skill> 을 고려하라"의 조건 문구.
  const suggestWhen =
    typeof rule.suggest_when === "string" && rule.suggest_when.trim()
      ? rule.suggest_when.trim()
      : null;

  const supersedes = Array.isArray(rule.supersedes)
    ? rule.supersedes
        .filter((id) => typeof id === "string" && id.trim())
        .map((id) => id.trim())
    : [];

  const state = normalizeState(rule.state);
  if (rule.state != null && state == null) return null;

  // repo_scope: path segment 화이트리스트 (빈 배열 = 전역). explicit: 종결 라우팅 마커.
  const repoScope = Array.isArray(rule.repo_scope)
    ? rule.repo_scope
        .filter((s) => typeof s === "string" && s.trim())
        .map((s) => s.trim())
    : [];

  // platform: process.platform 화이트리스트 (빈 배열 = 전 플랫폼). Windows 전용
  // 스킬(tfx-wt 등)이 macOS/Linux 프롬프트에 오탐하는 것을 막는다. 배열이 아닌
  // 값은 규칙 자체를 무효로 본다.
  if (rule.platform != null && !Array.isArray(rule.platform)) return null;
  const platform = Array.isArray(rule.platform)
    ? rule.platform
        .filter((s) => typeof s === "string" && s.trim())
        .map((s) => s.trim())
    : [];

  return {
    id: rule.id.trim(),
    patterns,
    exclude_patterns: excludePatterns,
    strength,
    suggest_when: suggestWhen,
    skill,
    skill_candidates: skillCandidates,
    action,
    hint,
    priority: rule.priority,
    supersedes,
    exclusive: rule.exclusive === true,
    state,
    mcp_route: mcpRoute,
    repo_scope: repoScope,
    platform,
    explicit: rule.explicit === true,
  };
}

// 외부 JSON 규칙 로드 + 스키마 검증
export function loadRules(rulesPath) {
  try {
    const raw = readFileSync(rulesPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.rules)) {
      logRuleError(`규칙 형식이 올바르지 않습니다: ${rulesPath}`);
      return [];
    }

    const normalized = parsed.rules.map(normalizeRule).filter(Boolean);
    return normalized;
  } catch (error) {
    logRuleError(`규칙 파일을 읽을 수 없습니다: ${rulesPath}`, error);
    return [];
  }
}

// pattern.source / flags를 RegExp로 컴파일
export function compileRules(rules) {
  return rules
    .map((rule) => {
      try {
        return {
          ...rule,
          compiledPatterns: rule.patterns.map(
            (p) => new RegExp(p.source, p.flags),
          ),
          compiledExcludes: (rule.exclude_patterns || []).map(
            (p) => new RegExp(p.source, p.flags),
          ),
        };
      } catch (error) {
        logRuleError(`정규식 컴파일 실패: ${rule.id}`, error);
        return null;
      }
    })
    .filter(Boolean);
}

// 입력 텍스트에서 매칭된 규칙 목록 반환
export function matchRules(compiledRules, cleanText) {
  if (
    !Array.isArray(compiledRules) ||
    typeof cleanText !== "string" ||
    !cleanText
  ) {
    return [];
  }

  const matches = [];

  for (const rule of compiledRules) {
    if (
      !Array.isArray(rule.compiledPatterns) ||
      rule.compiledPatterns.length === 0
    ) {
      continue;
    }

    // compiledPatterns[i] 와 patterns[i] 는 같은 순서다 — 패턴별 strength 를 읽는다.
    const ruleStrength = rule.strength ?? DEFAULT_STRENGTH;
    let explicitHit = false;
    let suggestHit = false;
    rule.compiledPatterns.forEach((pattern, index) => {
      pattern.lastIndex = 0;
      if (!pattern.test(cleanText)) return;
      const strength = rule.patterns?.[index]?.strength ?? ruleStrength;
      if (strength === "suggest") suggestHit = true;
      else explicitHit = true;
    });

    if (!explicitHit && !suggestHit) continue;

    if (!explicitHit) {
      const excluded = (rule.compiledExcludes || []).some((pattern) => {
        pattern.lastIndex = 0;
        return pattern.test(cleanText);
      });
      if (excluded) continue;
    }

    matches.push({
      id: rule.id,
      skill: rule.skill,
      action: rule.action,
      hint: rule.hint || null,
      priority: rule.priority,
      supersedes: rule.supersedes || [],
      exclusive: rule.exclusive === true,
      state: rule.state || null,
      mcp_route: rule.mcp_route || null,
      repo_scope: rule.repo_scope || [],
      platform: rule.platform || [],
      explicit: rule.explicit === true,
      strength: explicitHit ? "explicit" : "suggest",
      suggest_when: rule.suggest_when || null,
      skill_candidates: rule.skill_candidates || [],
    });
  }

  return matches;
}

// priority 정렬 + supersedes + exclusive 처리
export function resolveConflicts(matches) {
  try {
    if (!Array.isArray(matches) || matches.length === 0) return [];

    const sorted = [...matches].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return String(a.id).localeCompare(String(b.id));
    });

    const deduped = [];
    const seen = new Set();
    for (const match of sorted) {
      if (seen.has(match.id)) continue;
      deduped.push(match);
      seen.add(match.id);
    }

    // strength 우선순위를 충돌 해소에도 적용한다 — suggest 매칭의 supersedes 는
    // 사용자가 직접 부른 explicit 매칭을 지우지 못한다.
    const strengthById = new Map(
      deduped.map((match) => [match.id, match.strength ?? DEFAULT_STRENGTH]),
    );
    const superseded = new Set();
    const resolved = [];

    for (const match of deduped) {
      if (superseded.has(match.id)) continue;
      resolved.push(match);
      const fromSuggest = (match.strength ?? DEFAULT_STRENGTH) === "suggest";
      for (const targetId of match.supersedes || []) {
        if (fromSuggest && strengthById.get(targetId) === "explicit") continue;
        superseded.add(targetId);
      }
    }

    const exclusiveMatch = resolved.find((match) => match.exclusive === true);
    if (exclusiveMatch) return [exclusiveMatch];

    return resolved;
  } catch (error) {
    logRuleError("규칙 충돌 해결 실패", error);
    return [];
  }
}
