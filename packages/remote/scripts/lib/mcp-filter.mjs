#!/usr/bin/env node
// scripts/lib/mcp-filter.mjs
// 역할/컨텍스트 기반 MCP 도구 노출 정책의 단일 소스.

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  DOMAIN_TAG_KEYWORDS,
  MCP_SERVER_TOOL_CATALOG,
  SEARCH_SERVER_ORDER,
  SERVER_EXPLICIT_KEYWORDS,
  normalizeServerMetadata,
  uniqueStrings,
} from './mcp-server-catalog.mjs';
import { readManifest, CORE_SERVERS } from './mcp-manifest.mjs';

export const KNOWN_MCP_SERVERS = Object.freeze(Object.keys(MCP_SERVER_TOOL_CATALOG));

const SEARCH_INTENT_PATTERNS = Object.freeze([
  /\b(search|web|browse|look ?up|find|latest|recent|news|current|today|release(?: note)?s?|changelog|announcement|pricing|status|verify|fact[- ]?check)\b/i,
  /(검색|웹|브라우즈|찾아|조회|최신|최근|뉴스|현재|오늘|릴리즈|배포|변경사항|공지|가격|상태|검증)/u,
]);

const PROFILE_DEFINITIONS = Object.freeze({
  default: Object.freeze({
    description: '보수적 기본 프로필. 문서 조회 + 최소 검색만 허용',
    allowedServers: Object.freeze(['context7', 'brave-search']),
    alwaysOnServers: Object.freeze(['context7']),
    maxSearchServers: 1,
    allowedToolsByServer: Object.freeze({
      context7: Object.freeze(['resolve-library-id', 'query-docs']),
      'brave-search': Object.freeze(['brave_web_search', 'brave_news_search']),
    }),
  }),
  executor: Object.freeze({
    description: '구현 워커용. 문서/검색/브라우징 보조 MCP 허용',
    allowedServers: Object.freeze(['context7', 'playwright', 'brave-search', 'tavily', 'exa']),
    alwaysOnServers: Object.freeze(['context7']),
    maxSearchServers: 2,
    allowedToolsByServer: Object.freeze({
      context7: Object.freeze(['resolve-library-id', 'query-docs']),
      'brave-search': Object.freeze(['brave_web_search', 'brave_news_search']),
      exa: Object.freeze(['web_search_exa', 'get_code_context_exa']),
      tavily: Object.freeze(['tavily_search', 'tavily_extract']),
      playwright: Object.freeze([
        'browser_navigate',
        'browser_navigate_back',
        'browser_snapshot',
        'browser_take_screenshot',
        'browser_wait_for',
      ]),
    }),
  }),
  designer: Object.freeze({
    description: '디자인/UI 워커용. 브라우저 관찰 + 문서 조회 중심 MCP 허용',
    allowedServers: Object.freeze(['context7', 'playwright', 'tavily', 'exa', 'brave-search']),
    alwaysOnServers: Object.freeze(['context7']),
    maxSearchServers: 2,
    allowedToolsByServer: Object.freeze({
      context7: Object.freeze(['resolve-library-id', 'query-docs']),
      'brave-search': Object.freeze(['brave_web_search', 'brave_news_search']),
      exa: Object.freeze(['web_search_exa', 'get_code_context_exa']),
      tavily: Object.freeze(['tavily_search', 'tavily_extract']),
      playwright: Object.freeze([
        'browser_navigate',
        'browser_navigate_back',
        'browser_snapshot',
        'browser_take_screenshot',
        'browser_wait_for',
      ]),
    }),
  }),
  analyze: Object.freeze({
    description: '분석/설계 워커용. 추론 + 검색 MCP 허용',
    allowedServers: Object.freeze(['context7', 'brave-search', 'tavily', 'exa', 'sequential-thinking']),
    alwaysOnServers: Object.freeze(['context7', 'sequential-thinking']),
    maxSearchServers: 2,
    allowedToolsByServer: Object.freeze({
      context7: Object.freeze(['resolve-library-id', 'query-docs']),
      'brave-search': Object.freeze(['brave_web_search', 'brave_news_search']),
      exa: Object.freeze(['web_search_exa', 'get_code_context_exa']),
      tavily: Object.freeze(['tavily_search', 'tavily_extract']),
      'sequential-thinking': Object.freeze(['sequentialthinking']),
    }),
  }),
  explore: Object.freeze({
    description: '탐색/리서치 워커용. 읽기/검색 중심 MCP만 허용',
    allowedServers: Object.freeze(['context7', 'brave-search', 'tavily', 'exa']),
    alwaysOnServers: Object.freeze(['context7']),
    maxSearchServers: 2,
    allowedToolsByServer: Object.freeze({
      context7: Object.freeze(['resolve-library-id', 'query-docs']),
      'brave-search': Object.freeze(['brave_web_search', 'brave_news_search']),
      exa: Object.freeze(['web_search_exa', 'get_code_context_exa']),
      tavily: Object.freeze(['tavily_search', 'tavily_extract']),
    }),
  }),
  reviewer: Object.freeze({
    description: '리뷰 워커용. 문서 조회 + 분석 전용 MCP만 허용',
    allowedServers: Object.freeze(['context7', 'brave-search', 'sequential-thinking']),
    alwaysOnServers: Object.freeze(['context7', 'sequential-thinking']),
    maxSearchServers: 1,
    allowedToolsByServer: Object.freeze({
      context7: Object.freeze(['resolve-library-id', 'query-docs']),
      'brave-search': Object.freeze(['brave_web_search']),
      'sequential-thinking': Object.freeze(['sequentialthinking']),
    }),
  }),
  writer: Object.freeze({
    description: '문서/작성 워커용. 공식 문서와 최소 검색 MCP만 허용',
    allowedServers: Object.freeze(['context7', 'brave-search', 'exa']),
    alwaysOnServers: Object.freeze(['context7']),
    maxSearchServers: 2,
    allowedToolsByServer: Object.freeze({
      context7: Object.freeze(['resolve-library-id', 'query-docs']),
      'brave-search': Object.freeze(['brave_web_search', 'brave_news_search']),
      exa: Object.freeze(['web_search_exa']),
    }),
  }),
  none: Object.freeze({
    description: '모든 선택적 MCP 서버 비활성화',
    allowedServers: Object.freeze([]),
    alwaysOnServers: Object.freeze([]),
    maxSearchServers: 0,
    allowedToolsByServer: Object.freeze({}),
  }),
});

/**
 * 파이프라인 단계별 MCP 서버/도구 제한 (post-filter).
 * role-based 프로필 위에 추가 적용. 빈 배열 = 전체 차단, 미정의 = 제한 없음.
 */
export const PHASE_OVERRIDES = Object.freeze({
  plan: Object.freeze({
    description: '계획 단계: 읽기 전용 탐색만 허용',
    allowedServers: Object.freeze(['context7']),
    blockedServers: Object.freeze(['playwright', 'tavily', 'exa']),
  }),
  prd: Object.freeze({
    description: 'PRD 단계: 읽기 전용 탐색 + 문서 조회',
    allowedServers: Object.freeze(['context7', 'brave-search']),
    blockedServers: Object.freeze(['playwright']),
  }),
  exec: Object.freeze({
    description: '실행 단계: 프로필 기반 전체 허용 (제한 없음)',
  }),
  verify: Object.freeze({
    description: '검증 단계: 읽기 전용 + 분석 도구',
    allowedServers: Object.freeze(['context7', 'brave-search', 'exa']),
    blockedServers: Object.freeze(['playwright']),
  }),
});

export const LEGACY_PROFILE_ALIASES = Object.freeze({
  implement: 'executor',
  analyze: 'analyze',
  review: 'reviewer',
  docs: 'writer',
  minimal: 'default',
});

export const SUPPORTED_MCP_PROFILES = Object.freeze([
  'auto',
  ...Object.keys(PROFILE_DEFINITIONS),
  ...Object.keys(LEGACY_PROFILE_ALIASES),
]);

function normalizeTaskText(taskText = '') {
  if (typeof taskText !== 'string') return '';
  return taskText.replace(/\s+/g, ' ').trim();
}

function normalizeProfileName(profile) {
  const raw = typeof profile === 'string' && profile.trim() ? profile.trim() : 'auto';
  if (raw === 'auto') return raw;
  if (PROFILE_DEFINITIONS[raw]) return raw;
  if (LEGACY_PROFILE_ALIASES[raw]) return LEGACY_PROFILE_ALIASES[raw];
  // graceful fallback: --flag나 잘못된 프로필 → 'auto'로 폴백 (hard crash 방지)
  if (raw.startsWith('-') || raw.startsWith('/')) return 'auto';
  console.error(`[mcp-filter] 경고: 알 수 없는 프로필 '${raw}', 'auto'로 폴백`);
  return 'auto';
}

function resolveAutoProfile(agentType = '') {
  switch (agentType) {
    case 'executor':
    case 'build-fixer':
    case 'debugger':
    case 'deep-executor':
      return 'executor';
    case 'test-engineer':
    case 'qa-tester':
      return 'none';
    case 'designer':
      return 'designer';
    case 'architect':
    case 'planner':
    case 'critic':
    case 'analyst':
      return 'analyze';
    case 'scientist':
    case 'scientist-deep':
    case 'document-specialist':
    case 'explore':
      return 'explore';
    case 'code-reviewer':
    case 'security-reviewer':
    case 'quality-reviewer':
    case 'verifier':
      return 'reviewer';
    case 'writer':
      return 'writer';
    default:
      return 'default';
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countKeywordMatches(text, keywords = []) {
  let matches = 0;
  for (const keyword of keywords) {
    const source = String(keyword || '').trim();
    if (!source) continue;
    const pattern = /^[a-z0-9- ]+$/i.test(source)
      ? new RegExp(`\\b${escapeRegExp(source)}\\b`, 'i')
      : new RegExp(escapeRegExp(source), 'iu');
    if (pattern.test(text)) matches += 1;
  }
  return matches;
}

function loadInventory(inventoryFile = '') {
  if (typeof inventoryFile !== 'string' || !inventoryFile.trim()) return null;
  try {
    return JSON.parse(readFileSync(inventoryFile, 'utf8'));
  } catch {
    return null;
  }
}

function buildInventoryIndex(inventory = null) {
  const index = new Map();
  if (!inventory || typeof inventory !== 'object') return index;

  for (const client of ['codex', 'gemini']) {
    const servers = Array.isArray(inventory[client]?.servers) ? inventory[client].servers : [];
    for (const server of servers) {
      if (!server || typeof server.name !== 'string' || !server.name.trim()) continue;
      const name = server.name.trim();
      const previous = index.get(name) || {};
      index.set(name, {
        ...previous,
        tool_count: Number.isFinite(server.tool_count)
          ? Math.max(previous.tool_count ?? 0, Math.trunc(server.tool_count))
          : previous.tool_count,
        domain_tags: uniqueStrings([
          ...(Array.isArray(previous.domain_tags) ? previous.domain_tags : []),
          ...(Array.isArray(server.domain_tags) ? server.domain_tags : []),
        ]),
      });
    }
  }

  return index;
}

function getServerMetadata(server, inventoryIndex) {
  const inventoryMetadata = inventoryIndex.get(server) || {};
  return normalizeServerMetadata(server, {
    // Inventory tool_count is useful for tie-breaks, but dynamic domain tags
    // can over-broaden role policies compared to the static catalog.
    tool_count: inventoryMetadata.tool_count,
  });
}

function scoreServer(server, taskText = '', inventoryIndex = new Map()) {
  const normalized = normalizeTaskText(taskText);
  const metadata = getServerMetadata(server, inventoryIndex);
  if (!normalized) {
    return {
      server,
      score: 0,
      toolCount: metadata.tool_count,
      matchedTags: [],
      explicitMatch: false,
    };
  }

  let score = 0;
  const matchedTags = [];
  for (const tag of metadata.domain_tags) {
    const matches = countKeywordMatches(normalized, DOMAIN_TAG_KEYWORDS[tag] || []);
    if (matches > 0) {
      matchedTags.push(tag);
      score += matches * 2;
    }
  }

  const explicitMatches = countKeywordMatches(normalized, SERVER_EXPLICIT_KEYWORDS[server] || []);
  if (explicitMatches > 0) {
    score += explicitMatches * 4;
  }

  const toolKeywords = (MCP_SERVER_TOOL_CATALOG[server] || [])
    .flatMap((toolName) => String(toolName).split(/[_-]+/))
    .filter((token) => token.length >= 4);
  score += countKeywordMatches(normalized, toolKeywords);

  return {
    server,
    score,
    toolCount: metadata.tool_count,
    matchedTags,
    explicitMatch: explicitMatches > 0,
  };
}

function compareRankedServers(left, right, workerIndex, availableOrder = []) {
  if (right.explicitMatch !== left.explicitMatch) {
    return Number(right.explicitMatch) - Number(left.explicitMatch);
  }
  if (right.score !== left.score) return right.score - left.score;
  if (left.toolCount !== right.toolCount) return left.toolCount - right.toolCount;

  if (Number.isInteger(workerIndex) && workerIndex > 0 && availableOrder.length > 1) {
    const offset = (workerIndex - 1) % availableOrder.length;
    const rotated = availableOrder.slice(offset).concat(availableOrder.slice(0, offset));
    return rotated.indexOf(left.server) - rotated.indexOf(right.server);
  }

  return availableOrder.indexOf(left.server) - availableOrder.indexOf(right.server);
}

function rankServers(servers = [], options = {}) {
  const inventoryIndex = options.inventoryIndex instanceof Map
    ? options.inventoryIndex
    : buildInventoryIndex(options.inventory);
  return servers
    .map((server) => scoreServer(server, options.taskText, inventoryIndex))
    .sort((left, right) => compareRankedServers(left, right, options.workerIndex, servers));
}

function hasContextSignals(servers = [], options = {}) {
  return rankServers(servers, options).some((server) => server.score > 0);
}

function inferPreferredSearchTool(taskText = '', inventoryIndex = new Map(), allowedServers = SEARCH_SERVER_ORDER) {
  const ranked = rankServers(
    SEARCH_SERVER_ORDER.filter((server) => allowedServers.includes(server)),
    { taskText, inventoryIndex },
  );
  return ranked.find((server) => server.score > 0)?.server || '';
}

function selectContextualServers(baseServers, profile, options = {}) {
  const taskText = normalizeTaskText(options.taskText);
  if (!taskText || !baseServers.length) return [...baseServers];

  const inventoryIndex = options.inventoryIndex instanceof Map
    ? options.inventoryIndex
    : buildInventoryIndex(options.inventory);
  if (!hasContextSignals(baseServers, { ...options, inventoryIndex })) return [...baseServers];

  const selected = new Set(
    (profile.alwaysOnServers || []).filter((server) => baseServers.includes(server)),
  );
  const wantsBrowserObservation = (
    baseServers.includes('playwright')
    && /(?:browser|screenshot|layout|responsive|visual|screen|page|ui|ux|regression|캡처|스크린샷|레이아웃|반응형|화면|브라우저)/iu.test(taskText)
  );
  if (wantsBrowserObservation) {
    selected.add('playwright');
  }
  const requestedSearchTool = typeof options.searchTool === 'string' ? options.searchTool : '';

  const rankedServers = rankServers(
    baseServers.filter((server) => !SEARCH_SERVER_ORDER.includes(server) && !selected.has(server)),
    { ...options, inventoryIndex },
  );
  for (const ranked of rankedServers) {
    if (ranked.score > 0 || ranked.explicitMatch) {
      selected.add(ranked.server);
    }
  }

  const wantsSearchFallback = SEARCH_INTENT_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(taskText);
  });
  const orderedSearchServers = resolveSearchToolOrder(
    requestedSearchTool,
    Number.isInteger(options.workerIndex) ? options.workerIndex : undefined,
    baseServers.filter((server) => SEARCH_SERVER_ORDER.includes(server)),
    taskText,
    { inventoryIndex },
  );
  const rankedSearchSet = new Set(orderedSearchServers.filter((server) => {
    if (requestedSearchTool === server) return true;
    const ranked = scoreServer(server, taskText, inventoryIndex);
    return ranked.score > 0 || ranked.explicitMatch;
  }));
  const maxSearchServers = Number.isInteger(profile.maxSearchServers)
    ? profile.maxSearchServers
    : orderedSearchServers.length;
  const chosenSearchServers = (
    rankedSearchSet.size
      ? orderedSearchServers.filter((server) => rankedSearchSet.has(server))
      : wantsSearchFallback
        ? orderedSearchServers.slice(0, 1)
        : []
  ).slice(0, maxSearchServers);

  for (const server of chosenSearchServers) {
    selected.add(server);
  }

  const alwaysOnServers = baseServers.filter((server) => selected.has(server) && (profile.alwaysOnServers || []).includes(server));
  const contextualNonSearch = rankServers(
    baseServers.filter((server) => selected.has(server) && !SEARCH_SERVER_ORDER.includes(server) && !alwaysOnServers.includes(server)),
    { ...options, inventoryIndex },
  ).map((entry) => entry.server);
  const contextualSearch = orderedSearchServers.filter((server) => selected.has(server));
  const contextualServers = uniqueStrings([
    ...alwaysOnServers,
    ...contextualNonSearch,
    ...contextualSearch,
  ]);
  return contextualServers.length ? contextualServers : [...baseServers];
}

export function resolveMcpProfile(agentType = '', requestedProfile = 'auto') {
  const normalized = normalizeProfileName(requestedProfile);
  return normalized === 'auto' ? resolveAutoProfile(agentType) : normalized;
}

export function parseAvailableServers(rawAvailableServers = '') {
  if (Array.isArray(rawAvailableServers)) return uniqueStrings(rawAvailableServers);
  if (typeof rawAvailableServers !== 'string' || !rawAvailableServers.trim()) return [];
  return uniqueStrings(rawAvailableServers.split(/[,\s]+/));
}

export function resolveSearchToolOrder(searchTool = '', workerIndex, allowedServers = SEARCH_SERVER_ORDER, taskText = '', options = {}) {
  const available = SEARCH_SERVER_ORDER.filter((tool) => allowedServers.includes(tool));
  if (!available.length) return [];

  const inventoryIndex = options.inventoryIndex instanceof Map
    ? options.inventoryIndex
    : buildInventoryIndex(options.inventory);
  const preferredSearchTool = searchTool && available.includes(searchTool)
    ? searchTool
    : inferPreferredSearchTool(taskText, inventoryIndex, available);

  const ranked = rankServers(available, { taskText, workerIndex, inventoryIndex }).map((entry) => entry.server);
  if (!preferredSearchTool || !available.includes(preferredSearchTool)) {
    return ranked;
  }

  return [preferredSearchTool, ...ranked.filter((tool) => tool !== preferredSearchTool)];
}

function getProfileDefinition(resolvedProfile) {
  return PROFILE_DEFINITIONS[resolvedProfile] || PROFILE_DEFINITIONS.default;
}

/** 매니페스트 기반 필터. 매니페스트 없으면 전체 허용 (레거시). */
function applyManifestFilter(servers) {
  const manifest = readManifest();
  if (!manifest) return servers;
  const enabled = new Set([...(manifest.enabled || []), ...CORE_SERVERS]);
  return servers.filter((s) => enabled.has(s));
}

export function resolveAllowedServers(options = {}) {
  const resolvedProfile = resolveMcpProfile(options.agentType, options.requestedProfile);
  const profile = getProfileDefinition(resolvedProfile);
  const availableServers = parseAvailableServers(options.availableServers);
  const inventory = options.inventory || loadInventory(options.inventoryFile);
  const inventoryIndex = buildInventoryIndex(inventory);
  const baseServers = availableServers.length
    ? profile.allowedServers.filter((server) => availableServers.includes(server))
    : [...profile.allowedServers];
  const manifestFiltered = availableServers.length
    ? baseServers
    : applyManifestFilter(baseServers);
  return selectContextualServers(manifestFiltered, profile, { ...options, inventory, inventoryIndex });
}

export function buildPromptHint(options = {}) {
  const resolvedProfile = resolveMcpProfile(options.agentType, options.requestedProfile);
  if (resolvedProfile === 'none') return '';

  const inventory = options.inventory || loadInventory(options.inventoryFile);
  const inventoryIndex = buildInventoryIndex(inventory);
  const allowedServers = resolveAllowedServers({ ...options, inventory, inventoryIndex });
  const orderedTools = resolveSearchToolOrder(
    options.searchTool,
    Number.isInteger(options.workerIndex) ? options.workerIndex : undefined,
    allowedServers,
    options.taskText,
    { inventory, inventoryIndex },
  );
  const has = (server) => allowedServers.includes(server);
  const orderedSearchHint = orderedTools.length > 1
    ? `웹 검색 우선순위: ${orderedTools.join(', ')}.`
    : orderedTools[0]
      ? `웹 검색은 ${orderedTools[0]}를 사용하세요.`
      : '';
  const searchFallbackHint = orderedTools.length > 1
    ? '검색 도구 실패 시 402, 429, 432, 433, quota 에러에서 재시도하지 말고 다음 도구로 전환하세요.'
    : '';
  return [
    has('context7') ? 'context7으로 관련 문서를 조회하세요.' : '',
    has('playwright')
      ? resolvedProfile === 'designer'
        ? '화면/레이아웃 확인은 playwright를 우선 사용하세요.'
        : '브라우저/UI 검증이 필요하면 playwright를 사용하세요.'
      : '',
    has('sequential-thinking') ? 'sequential-thinking으로 체계적으로 분석하세요.' : '',
    resolvedProfile === 'reviewer' && orderedTools[0] ? `외부 근거가 더 필요하면 ${orderedTools[0]}를 사용하세요.` : '',
    resolvedProfile !== 'reviewer' ? orderedSearchHint : '',
    resolvedProfile !== 'reviewer' ? searchFallbackHint : '',
    resolvedProfile === 'explore' ? '검색 깊이를 제한하고 읽기 전용 조사에 집중하세요.' : '',
    resolvedProfile === 'writer' ? '검색 결과의 출처 URL을 함께 제시하세요.' : '',
  ].filter(Boolean).join(' ');
}

export function getGeminiAllowedServers(options = {}) {
  return resolveAllowedServers(options);
}

export function getCodexMcpConfig(options = {}) {
  const allowedServers = new Set(resolveAllowedServers(options));
  const resolvedProfile = resolveMcpProfile(options.agentType, options.requestedProfile);
  // Codex에 실제 등록된 서버만 대상으로 config override 생성.
  // 미등록 서버에 enabled=false를 보내면 "invalid transport" 에러 발생.
  const registeredServers = parseAvailableServers(options.availableServers);
  // Codex 0.115+: 미등록 서버에 config override를 보내면 "invalid transport" 에러.
  // 등록 서버 정보가 없으면 override를 생성하지 않는다 (안전 기본값).
  if (registeredServers.length === 0) {
    return { mcp_servers: {} };
  }
  const targetServers = registeredServers;

  if (resolvedProfile === 'none') {
    // Codex 0.115+: transport 없는 서버에 enabled=false를 보내면 "invalid transport" 에러.
    // 비허용 서버는 override에서 제외하고, 허용 서버만 명시적으로 설정한다.
    return { mcp_servers: {} };
  }

  const config = { mcp_servers: {} };
  const allowedToolsByServer = getProfileDefinition(resolvedProfile).allowedToolsByServer;
  for (const server of targetServers) {
    // Codex 0.115+: transport 없는 서버에 enabled=false를 보내면 "invalid transport" 에러.
    // 비허용 서버는 override에서 제외한다 (Codex 기본 설정이 유지됨).
    if (!allowedServers.has(server)) {
      continue;
    }

    config.mcp_servers[server] = {
      enabled: true,
      enabled_tools: [...(allowedToolsByServer[server] || [])],
    };
  }
  return config;
}

function toTomlLiteral(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => toTomlLiteral(item)).join(',')}]`;
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new Error(`지원하지 않는 TOML 값 타입: ${typeof value}`);
}

function flattenConfig(prefix, value, output) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, nestedValue] of Object.entries(value)) {
      flattenConfig(prefix ? `${prefix}.${key}` : key, nestedValue, output);
    }
    return;
  }
  output.push(`${prefix}=${toTomlLiteral(value)}`);
}

export function getCodexConfigOverrides(options = {}) {
  const config = getCodexMcpConfig(options);
  const overrides = [];
  flattenConfig('', config, overrides);
  return overrides;
}

export function buildMcpPolicy(options = {}) {
  const inventory = options.inventory || loadInventory(options.inventoryFile);
  const inventoryIndex = buildInventoryIndex(inventory);
  const resolvedOptions = { ...options, inventory, inventoryIndex };
  const resolvedProfile = resolveMcpProfile(options.agentType, options.requestedProfile);
  let allowedServers = resolveAllowedServers(resolvedOptions);
  const hint = buildPromptHint(resolvedOptions);

  // Phase-aware post-filter: 파이프라인 단계별 서버 제한 적용
  const phase = options.phase;
  const phaseOverride = phase && PHASE_OVERRIDES[phase];
  if (phaseOverride && phaseOverride.blockedServers) {
    const blocked = new Set(phaseOverride.blockedServers);
    allowedServers = allowedServers.filter((s) => !blocked.has(s));
  }

  return {
    requestedProfile: typeof options.requestedProfile === 'string' && options.requestedProfile
      ? options.requestedProfile
      : 'auto',
    resolvedProfile,
    resolvedPhase: phase || null,
    allowedServers,
    hint,
    geminiAllowedServers: getGeminiAllowedServers(resolvedOptions),
    codexConfig: getCodexMcpConfig(resolvedOptions),
    codexConfigOverrides: getCodexConfigOverrides(resolvedOptions),
  };
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function shellArray(name, values) {
  return `${name}=(${values.map((value) => shellEscape(value)).join(' ')})`;
}

export function toShellExports(policy) {
  const lines = [
    `MCP_PROFILE_REQUESTED=${shellEscape(policy.requestedProfile)}`,
    `MCP_RESOLVED_PROFILE=${shellEscape(policy.resolvedProfile)}`,
    `MCP_HINT=${shellEscape(policy.hint)}`,
    shellArray('GEMINI_ALLOWED_SERVERS', policy.geminiAllowedServers),
    shellArray('CODEX_CONFIG_FLAGS', policy.codexConfigOverrides.flatMap((override) => ['-c', override])),
    `CODEX_CONFIG_JSON=${shellEscape(JSON.stringify(policy.codexConfig))}`,
  ];
  if (policy.resolvedPhase) {
    lines.push(`MCP_PIPELINE_PHASE=${shellEscape(policy.resolvedPhase)}`);
  }
  return lines.join('\n');
}

function parseCliArgs(argv) {
  const args = {
    command: 'json',
    agentType: '',
    requestedProfile: 'auto',
    availableServers: [],
    inventoryFile: '',
    searchTool: '',
    taskText: '',
    workerIndex: undefined,
  };

  const [first = 'json'] = argv;
  if (!first.startsWith('--')) {
    args.command = first;
    argv = argv.slice(1);
  }

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${token} 값이 필요합니다.`);
      i += 1;
      return value;
    };

    switch (token) {
      case '--agent':
        args.agentType = next();
        break;
      case '--profile':
        args.requestedProfile = next();
        break;
      case '--available':
        args.availableServers = parseAvailableServers(next());
        break;
      case '--inventory-file':
        args.inventoryFile = next();
        break;
      case '--search-tool':
        args.searchTool = next();
        break;
      case '--task-text':
        args.taskText = next();
        break;
      case '--worker-index':
        args.workerIndex = Number.parseInt(next(), 10);
        break;
      case '--phase':
        args.phase = next();
        break;
      default:
        throw new Error(`알 수 없는 옵션: ${token}`);
    }
  }

  return args;
}

export async function runCli(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    console.error(`[mcp-filter] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 64;
    return;
  }

  let policy;
  try {
    policy = buildMcpPolicy(args);
  } catch (error) {
    console.error(`[mcp-filter] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 65;
    return;
  }
  if (args.command === 'shell') {
    process.stdout.write(`${toShellExports(policy)}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(policy, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await runCli();
}
