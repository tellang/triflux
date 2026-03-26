import { readFileSync } from "node:fs";

const VALID_MCP_ROUTES = new Set(["codex", "gemini", "claude"]);

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
  return { source: pattern.source, flags: pattern.flags };
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
  if (typeof rule.id !== "string" || !rule.id.trim()) return null;
  if (!Array.isArray(rule.patterns) || rule.patterns.length === 0) return null;
  if (typeof rule.priority !== "number" || !Number.isFinite(rule.priority)) return null;

  const patterns = rule.patterns.map(normalizePattern).filter(Boolean);
  if (patterns.length === 0) return null;

  const skill = typeof rule.skill === "string" && rule.skill.trim() ? rule.skill.trim() : null;
  const action = typeof rule.action === "string" && rule.action.trim() ? rule.action.trim() : null;
  const mcpRoute = typeof rule.mcp_route === "string" && VALID_MCP_ROUTES.has(rule.mcp_route)
    ? rule.mcp_route
    : null;

  if (!skill && !mcpRoute && !action) return null;

  const supersedes = Array.isArray(rule.supersedes)
    ? rule.supersedes.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim())
    : [];

  const state = normalizeState(rule.state);
  if (rule.state != null && state == null) return null;

  return {
    id: rule.id.trim(),
    patterns,
    skill,
    action,
    priority: rule.priority,
    supersedes,
    exclusive: rule.exclusive === true,
    state,
    mcp_route: mcpRoute
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
  return rules.map((rule) => {
    try {
      return { ...rule, compiledPatterns: rule.patterns.map((p) => new RegExp(p.source, p.flags)) };
    } catch (error) {
      logRuleError(`정규식 컴파일 실패: ${rule.id}`, error);
      return null;
    }
  }).filter(Boolean);
}

// 입력 텍스트에서 매칭된 규칙 목록 반환
export function matchRules(compiledRules, cleanText) {
  if (!Array.isArray(compiledRules) || typeof cleanText !== "string" || !cleanText) {
    return [];
  }

  const matches = [];

  for (const rule of compiledRules) {
    if (!Array.isArray(rule.compiledPatterns) || rule.compiledPatterns.length === 0) {
      continue;
    }

    const matched = rule.compiledPatterns.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(cleanText);
    });

    if (!matched) continue;

    matches.push({
      id: rule.id,
      skill: rule.skill,
      action: rule.action,
      priority: rule.priority,
      supersedes: rule.supersedes || [],
      exclusive: rule.exclusive === true,
      state: rule.state || null,
      mcp_route: rule.mcp_route || null
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

    const superseded = new Set();
    const resolved = [];

    for (const match of deduped) {
      if (superseded.has(match.id)) continue;
      resolved.push(match);
      for (const targetId of match.supersedes || []) {
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
