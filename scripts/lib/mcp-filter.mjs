#!/usr/bin/env node
// scripts/lib/mcp-filter.mjs
// 역할/컨텍스트 기반 MCP 도구 노출 정책의 단일 소스.

import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const SEARCH_SERVER_ORDER = Object.freeze(['brave-search', 'tavily', 'exa']);

export const MCP_SERVER_TOOL_CATALOG = Object.freeze({
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
  'sequential-thinking': Object.freeze(['sequentialthinking']),
});

export const KNOWN_MCP_SERVERS = Object.freeze(Object.keys(MCP_SERVER_TOOL_CATALOG));

const SEARCH_INTENT_PATTERNS = Object.freeze([
  /\b(search|web|browse|look ?up|find|latest|recent|news|current|today|release(?: note)?s?|changelog|announcement|pricing|status|verify|fact[- ]?check)\b/i,
  /(검색|웹|브라우즈|찾아|조회|최신|최근|뉴스|현재|오늘|릴리즈|배포|변경사항|공지|가격|상태|검증)/u,
]);

const SERVER_CONTEXT_PATTERNS = Object.freeze({
  context7: Object.freeze([
    /\b(context7|docs?|documentation|official docs?|reference|api|sdk|library|package|framework|spec|schema|manual|guide)\b/i,
    /(문서|공식|레퍼런스|API|SDK|라이브러리|패키지|프레임워크|스펙|스키마|매뉴얼|가이드)/u,
  ]),
  'brave-search': Object.freeze([
    /\b(search|browse|web|site|article|forum|reddit|blog|lookup|find)\b/i,
    /(검색|웹|사이트|기사|포럼|레딧|블로그|조회|탐색)/u,
  ]),
  tavily: Object.freeze([
    /\b(tavily|latest|recent|news|current|today|release(?: note)?s?|changelog|announcement|pricing|status|up-to-date|verify|fact[- ]?check)\b/i,
    /(tavily|최신|최근|뉴스|현재|오늘|릴리즈|배포|변경사항|공지|가격|상태|최신화|검증)/u,
  ]),
  exa: Object.freeze([
    /\b(exa|code|repo|repository|source|implementation|stack ?trace|error|bug|fix|unit test|integration test|test case|failing test|snippet|example|cli|script|module|package)\b/i,
    /(exa|코드|리포|저장소|소스|구현|오류|버그|수정|단위 테스트|통합 테스트|테스트 케이스|예제|CLI|스크립트|모듈|패키지)/u,
  ]),
  playwright: Object.freeze([
    /\b(playwright|browser|page|dom|screenshot|visual|render|layout|responsive|css|html|click|navigate|ux|ui|e2e)\b/i,
    /(playwright|브라우저|페이지|DOM|스크린샷|화면|시각|렌더|레이아웃|반응형|CSS|HTML|클릭|이동|UI|UX|E2E)/u,
  ]),
  'sequential-thinking': Object.freeze([
    /\b(review|analysis|analyze|audit|reason|plan|compare|root cause|security|risk|threat|critique)\b/i,
    /(리뷰|분석|검토|감사|추론|계획|비교|원인|보안|위험|위협|비평)/u,
  ]),
});

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
  explore: Object.freeze({
    description: '탐색 워커용. 읽기/검색 중심 MCP만 허용',
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

export const LEGACY_PROFILE_ALIASES = Object.freeze({
  implement: 'executor',
  analyze: 'explore',
  review: 'reviewer',
  docs: 'writer',
  minimal: 'default',
});

export const SUPPORTED_MCP_PROFILES = Object.freeze([
  'auto',
  ...Object.keys(PROFILE_DEFINITIONS),
  ...Object.keys(LEGACY_PROFILE_ALIASES),
]);

function uniqueStrings(values = []) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))];
}

function normalizeTaskText(taskText = '') {
  if (typeof taskText !== 'string') return '';
  return taskText.replace(/\s+/g, ' ').trim();
}

function normalizeProfileName(profile) {
  const raw = typeof profile === 'string' && profile.trim() ? profile.trim() : 'auto';
  if (raw === 'auto') return raw;
  if (PROFILE_DEFINITIONS[raw]) return raw;
  if (LEGACY_PROFILE_ALIASES[raw]) return LEGACY_PROFILE_ALIASES[raw];
  throw new Error(`지원하지 않는 MCP 프로필: ${raw}`);
}

function resolveAutoProfile(agentType = '') {
  switch (agentType) {
    case 'executor':
    case 'build-fixer':
    case 'debugger':
    case 'deep-executor':
    case 'test-engineer':
    case 'qa-tester':
      return 'executor';
    case 'designer':
      return 'designer';
    case 'architect':
    case 'planner':
    case 'critic':
    case 'analyst':
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

function countMatches(text, patterns = []) {
  let matches = 0;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) matches += 1;
  }
  return matches;
}

function collectServerScores(taskText = '') {
  const normalized = normalizeTaskText(taskText);
  const scores = new Map(KNOWN_MCP_SERVERS.map((server) => [server, 0]));
  if (!normalized) return scores;

  for (const [server, patterns] of Object.entries(SERVER_CONTEXT_PATTERNS)) {
    scores.set(server, countMatches(normalized, patterns));
  }
  return scores;
}

function hasContextSignals(taskText = '') {
  const scores = collectServerScores(taskText);
  return [...scores.values()].some((score) => score > 0);
}

function inferPreferredSearchTool(taskText = '') {
  const normalized = normalizeTaskText(taskText);
  if (!normalized) return '';

  if (/\btavily\b/i.test(normalized)) return 'tavily';
  if (/\bexa\b/i.test(normalized)) return 'exa';
  if (/\bbrave(?:-search)?\b/i.test(normalized)) return 'brave-search';

  const searchScores = {
    'brave-search': countMatches(normalized, SERVER_CONTEXT_PATTERNS['brave-search']),
    tavily: countMatches(normalized, SERVER_CONTEXT_PATTERNS.tavily),
    exa: countMatches(normalized, SERVER_CONTEXT_PATTERNS.exa),
  };

  if (searchScores.tavily > Math.max(searchScores.exa, searchScores['brave-search'])) {
    return 'tavily';
  }
  if (searchScores.exa > Math.max(searchScores.tavily, searchScores['brave-search'])) {
    return 'exa';
  }
  if (searchScores['brave-search'] > 0) {
    return 'brave-search';
  }
  return '';
}

function selectContextualServers(baseServers, profile, options = {}) {
  const taskText = normalizeTaskText(options.taskText);
  if (!taskText || !baseServers.length) return [...baseServers];
  if (!hasContextSignals(taskText)) return [...baseServers];

  const scores = collectServerScores(taskText);
  const selected = new Set(
    (profile.alwaysOnServers || []).filter((server) => baseServers.includes(server)),
  );

  const requestedSearchTool = typeof options.searchTool === 'string' ? options.searchTool : '';
  if (requestedSearchTool && baseServers.includes(requestedSearchTool)) {
    selected.add(requestedSearchTool);
  }

  for (const server of baseServers) {
    if (SEARCH_SERVER_ORDER.includes(server)) continue;
    if ((scores.get(server) || 0) > 0) {
      selected.add(server);
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
  );
  const positiveSearchServers = orderedSearchServers.filter((server) => {
    if (requestedSearchTool === server) return true;
    return (scores.get(server) || 0) > 0;
  });
  const maxSearchServers = Number.isInteger(profile.maxSearchServers)
    ? profile.maxSearchServers
    : orderedSearchServers.length;
  const chosenSearchServers = (positiveSearchServers.length ? positiveSearchServers : wantsSearchFallback ? orderedSearchServers.slice(0, 1) : [])
    .slice(0, maxSearchServers);

  for (const server of chosenSearchServers) {
    selected.add(server);
  }

  const contextualServers = baseServers.filter((server) => selected.has(server));
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

export function resolveSearchToolOrder(searchTool = '', workerIndex, allowedServers = SEARCH_SERVER_ORDER, taskText = '') {
  const available = SEARCH_SERVER_ORDER.filter((tool) => allowedServers.includes(tool));
  if (!available.length) return [];

  const preferredSearchTool = searchTool && available.includes(searchTool)
    ? searchTool
    : inferPreferredSearchTool(taskText);
  if (preferredSearchTool && available.includes(preferredSearchTool)) {
    return [preferredSearchTool, ...available.filter((tool) => tool !== preferredSearchTool)];
  }

  if (Number.isInteger(workerIndex) && workerIndex > 0 && available.length > 1) {
    const offset = (workerIndex - 1) % available.length;
    return available.slice(offset).concat(available.slice(0, offset));
  }

  return available;
}

function getProfileDefinition(resolvedProfile) {
  return PROFILE_DEFINITIONS[resolvedProfile] || PROFILE_DEFINITIONS.default;
}

export function resolveAllowedServers(options = {}) {
  const resolvedProfile = resolveMcpProfile(options.agentType, options.requestedProfile);
  const profile = getProfileDefinition(resolvedProfile);
  const availableServers = parseAvailableServers(options.availableServers);
  const baseServers = availableServers.length
    ? profile.allowedServers.filter((server) => availableServers.includes(server))
    : [...profile.allowedServers];
  return selectContextualServers(baseServers, profile, options);
}

export function buildPromptHint(options = {}) {
  const resolvedProfile = resolveMcpProfile(options.agentType, options.requestedProfile);
  if (resolvedProfile === 'none') return '';

  const allowedServers = resolveAllowedServers(options);
  const orderedTools = resolveSearchToolOrder(
    options.searchTool,
    Number.isInteger(options.workerIndex) ? options.workerIndex : undefined,
    allowedServers,
    options.taskText,
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

  switch (resolvedProfile) {
    case 'executor':
      return [
        has('context7') ? 'context7으로 라이브러리 문서를 조회하세요.' : '',
        orderedSearchHint,
        searchFallbackHint,
        has('playwright') ? '브라우저/UI 검증이 필요하면 playwright를 사용하세요.' : '',
      ].filter(Boolean).join(' ');
    case 'designer':
      return [
        has('context7') ? 'context7으로 관련 프레임워크/라이브러리 문서를 조회하세요.' : '',
        has('playwright') ? '화면/레이아웃 확인은 playwright를 우선 사용하세요.' : '',
        orderedSearchHint,
        searchFallbackHint,
      ].filter(Boolean).join(' ');
    case 'explore':
      return [
        has('context7') ? 'context7으로 관련 문서를 조회하세요.' : '',
        orderedSearchHint,
        searchFallbackHint,
        '검색 깊이를 제한하고 읽기 전용 조사에 집중하세요.',
      ].filter(Boolean).join(' ');
    case 'reviewer':
      return [
        has('context7') ? 'context7으로 관련 공식 문서를 먼저 확인하세요.' : '',
        has('sequential-thinking') ? 'sequential-thinking으로 체계적으로 분석하세요.' : '',
        orderedTools[0] ? `외부 근거가 더 필요하면 ${orderedTools[0]}를 사용하세요.` : '',
      ].filter(Boolean).join(' ');
    case 'writer':
      return [
        has('context7') ? 'context7으로 공식 문서를 참조하세요.' : '',
        orderedSearchHint,
        searchFallbackHint,
        '검색 결과의 출처 URL을 함께 제시하세요.',
      ].filter(Boolean).join(' ');
    case 'default':
    default:
      return [
        has('context7') ? 'context7으로 관련 문서를 조회하세요.' : '',
        orderedSearchHint,
        searchFallbackHint,
      ].filter(Boolean).join(' ');
  }
}

export function getGeminiAllowedServers(options = {}) {
  return resolveAllowedServers(options);
}

export function getCodexMcpConfig(options = {}) {
  const allowedServers = new Set(resolveAllowedServers(options));
  const resolvedProfile = resolveMcpProfile(options.agentType, options.requestedProfile);
  if (resolvedProfile === 'none') {
    return {
      mcp_servers: Object.fromEntries(KNOWN_MCP_SERVERS.map((server) => [server, { enabled: false }])),
    };
  }

  const config = { mcp_servers: {} };
  const allowedToolsByServer = getProfileDefinition(resolvedProfile).allowedToolsByServer;
  for (const server of KNOWN_MCP_SERVERS) {
    if (!allowedServers.has(server)) {
      config.mcp_servers[server] = { enabled: false };
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
  const resolvedProfile = resolveMcpProfile(options.agentType, options.requestedProfile);
  const allowedServers = resolveAllowedServers(options);
  const hint = buildPromptHint(options);
  return {
    requestedProfile: typeof options.requestedProfile === 'string' && options.requestedProfile
      ? options.requestedProfile
      : 'auto',
    resolvedProfile,
    allowedServers,
    hint,
    geminiAllowedServers: getGeminiAllowedServers(options),
    codexConfig: getCodexMcpConfig(options),
    codexConfigOverrides: getCodexConfigOverrides(options),
  };
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function shellArray(name, values) {
  return `${name}=(${values.map((value) => shellEscape(value)).join(' ')})`;
}

export function toShellExports(policy) {
  return [
    `MCP_PROFILE_REQUESTED=${shellEscape(policy.requestedProfile)}`,
    `MCP_RESOLVED_PROFILE=${shellEscape(policy.resolvedProfile)}`,
    `MCP_HINT=${shellEscape(policy.hint)}`,
    shellArray('GEMINI_ALLOWED_SERVERS', policy.geminiAllowedServers),
    shellArray('CODEX_CONFIG_FLAGS', policy.codexConfigOverrides.flatMap((override) => ['-c', override])),
    `CODEX_CONFIG_JSON=${shellEscape(JSON.stringify(policy.codexConfig))}`,
  ].join('\n');
}

function parseCliArgs(argv) {
  const args = {
    command: 'json',
    agentType: '',
    requestedProfile: 'auto',
    availableServers: [],
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
      case '--search-tool':
        args.searchTool = next();
        break;
      case '--task-text':
        args.taskText = next();
        break;
      case '--worker-index':
        args.workerIndex = Number.parseInt(next(), 10);
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

  const policy = buildMcpPolicy(args);
  if (args.command === 'shell') {
    process.stdout.write(`${toShellExports(policy)}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(policy, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await runCli();
}
