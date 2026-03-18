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

export const MCP_SERVER_DOMAIN_TAGS = Object.freeze({
  context7: Object.freeze(['docs', 'reference', 'api', 'sdk', 'library']),
  'brave-search': Object.freeze(['web', 'search', 'news', 'current']),
  exa: Object.freeze(['code', 'repository', 'examples', 'search']),
  tavily: Object.freeze(['research', 'search', 'news', 'verification', 'current']),
  playwright: Object.freeze(['browser', 'ui', 'visual', 'e2e']),
  'sequential-thinking': Object.freeze(['analysis', 'planning', 'reasoning', 'security', 'review']),
});

export const DOMAIN_TAG_KEYWORDS = Object.freeze({
  docs: Object.freeze(['docs', 'documentation', 'manual', 'guide', '문서', '가이드', '매뉴얼']),
  reference: Object.freeze(['reference', 'spec', 'schema', 'official', '레퍼런스', '공식', '스펙', '스키마']),
  api: Object.freeze(['api', 'endpoint', 'interface', 'sdk', '호출', '엔드포인트']),
  sdk: Object.freeze(['sdk', 'library', 'package', 'framework', '라이브러리', '패키지', '프레임워크']),
  library: Object.freeze(['library', 'package', 'framework', 'module', '라이브러리', '패키지', '모듈']),
  web: Object.freeze(['web', 'site', 'article', 'forum', 'blog', 'reddit', '웹', '사이트', '기사', '포럼', '블로그']),
  search: Object.freeze(['search', 'browse', 'lookup', 'find', '검색', '조회', '탐색', '찾아']),
  news: Object.freeze(['latest', 'recent', 'news', 'today', 'release', 'announcement', '최신', '최근', '뉴스', '오늘', '릴리즈', '공지']),
  current: Object.freeze(['current', 'status', 'pricing', 'changelog', 'up-to-date', '현재', '상태', '가격', '변경사항']),
  research: Object.freeze(['research', 'verify', 'fact-check', 'investigate', '리서치', '검증', '조사']),
  verification: Object.freeze(['verify', 'validation', 'fact-check', 'audit', '검증', '확인', '감사']),
  code: Object.freeze(['code', 'repo', 'repository', 'source', 'implementation', 'bug', 'fix', 'test', 'snippet', 'cli', '코드', '리포', '저장소', '구현', '버그', '테스트', '예제', '스크립트']),
  repository: Object.freeze(['repo', 'repository', 'source', 'git', 'github', '리포', '저장소', '소스']),
  examples: Object.freeze(['example', 'examples', 'snippet', 'sample', '예제', '샘플']),
  browser: Object.freeze(['browser', 'page', 'dom', 'screenshot', 'render', '브라우저', '페이지', '스크린샷', '렌더']),
  ui: Object.freeze(['ui', 'ux', 'layout', 'responsive', 'css', 'html', '디자인', '레이아웃', '반응형']),
  visual: Object.freeze(['visual', 'screenshot', 'layout', 'render', 'screen', '화면', '시각', '스크린샷']),
  e2e: Object.freeze(['playwright', 'e2e', 'click', 'navigate', 'automation', 'playwright', '클릭', '이동', '자동화']),
  analysis: Object.freeze(['analysis', 'analyze', 'audit', 'compare', 'root cause', '분석', '검토', '비교', '원인']),
  planning: Object.freeze(['plan', 'planning', 'strategy', 'design', '계획', '전략', '설계']),
  reasoning: Object.freeze(['reason', 'reasoning', 'think', 'critique', '추론', '사고', '비평']),
  security: Object.freeze(['security', 'risk', 'threat', 'vulnerability', '보안', '위험', '취약점']),
  review: Object.freeze(['review', 'reviewer', 'inspect', '리뷰', '검수']),
});

export const SERVER_EXPLICIT_KEYWORDS = Object.freeze({
  context7: Object.freeze(['context7']),
  'brave-search': Object.freeze(['brave', 'brave-search']),
  exa: Object.freeze(['exa']),
  tavily: Object.freeze(['tavily']),
  playwright: Object.freeze(['playwright']),
  'sequential-thinking': Object.freeze(['sequential-thinking', 'sequential thinking']),
});

export function uniqueStrings(values = []) {
  return [...new Set(
    values
      .filter((value) => typeof value === 'string' && value.trim())
      .map((value) => value.trim()),
  )];
}

export function inferDomainTagsFromText(text = '') {
  if (typeof text !== 'string' || !text.trim()) return [];
  const normalized = text.toLocaleLowerCase();
  const matched = [];

  for (const [tag, keywords] of Object.entries(DOMAIN_TAG_KEYWORDS)) {
    if (keywords.some((keyword) => normalized.includes(String(keyword).toLocaleLowerCase()))) {
      matched.push(tag);
    }
  }

  return uniqueStrings(matched);
}

export function getDefaultServerMetadata(serverName = '') {
  const toolCount = MCP_SERVER_TOOL_CATALOG[serverName]?.length || 0;
  const domainTags = uniqueStrings([
    ...(MCP_SERVER_DOMAIN_TAGS[serverName] || []),
    ...inferDomainTagsFromText(serverName),
  ]);

  return {
    tool_count: toolCount,
    domain_tags: domainTags,
  };
}

export function normalizeServerMetadata(serverName = '', metadata = {}) {
  const fallback = getDefaultServerMetadata(serverName);
  const toolCount = Number.isFinite(metadata.tool_count)
    ? Math.max(0, Math.trunc(metadata.tool_count))
    : fallback.tool_count;
  const domainTags = uniqueStrings([
    ...fallback.domain_tags,
    ...(Array.isArray(metadata.domain_tags) ? metadata.domain_tags : []),
    ...inferDomainTagsFromText([
      serverName,
      typeof metadata.command === 'string' ? metadata.command : '',
      typeof metadata.url === 'string' ? metadata.url : '',
      ...(Array.isArray(metadata.args) ? metadata.args : []),
      ...(metadata.env && typeof metadata.env === 'object' ? Object.keys(metadata.env) : []),
    ].join(' ')),
  ]);

  return {
    tool_count: toolCount,
    domain_tags: domainTags,
  };
}
