// hub/lib/mcp-response-cache.mjs — MCP 응답 캐시 (LRU + TTL)
// Deep 스킬에서 3개 모델이 같은 context7 문서를 요청하면 1번만 호출, 나머지는 캐시 hit.
// 파일 기반 영속 + 메모리 기반 핫캐시 이중 구조.

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

const DEFAULT_CACHE_DIR = join(homedir(), '.triflux', 'mcp-cache');
const DEFAULT_MAX_ENTRIES = 500;

// 서버별 TTL (ms)
const SERVER_TTL = Object.freeze({
  'context7':     60 * 60 * 1000,   // 1시간 — 라이브러리 문서는 자주 안 바뀜
  'brave-search': 10 * 60 * 1000,   // 10분 — 웹 검색
  'exa':          10 * 60 * 1000,   // 10분
  'tavily':       10 * 60 * 1000,   // 10분
  'serena':       5 * 60 * 1000,    // 5분 — 코드 분석 (코드 변경 가능)
  'jira':         2 * 60 * 1000,    // 2분 — 이슈 상태 자주 변경
  'notion':       5 * 60 * 1000,    // 5분
  '_default':     5 * 60 * 1000,    // 기본 5분
});

function hashKey(server, method, params) {
  const payload = JSON.stringify({ server, method, params });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

/**
 * MCP 응답 캐시 생성.
 * @param {object} [opts]
 * @param {string} [opts.cacheDir] — 캐시 디렉토리
 * @param {number} [opts.maxEntries] — 최대 엔트리 수 (LRU)
 * @returns {McpResponseCache}
 */
export function createMcpResponseCache(opts = {}) {
  const cacheDir = opts.cacheDir || DEFAULT_CACHE_DIR;
  const maxEntries = opts.maxEntries || DEFAULT_MAX_ENTRIES;

  mkdirSync(cacheDir, { recursive: true });

  // 메모리 핫캐시 (Map — insertion order = LRU)
  const hot = new Map();

  let hits = 0;
  let misses = 0;

  function getTtl(server) {
    return SERVER_TTL[server] || SERVER_TTL._default;
  }

  function getCachePath(key) {
    return join(cacheDir, `${key}.json`);
  }

  /**
   * 캐시 조회.
   * @param {string} server — MCP 서버 이름
   * @param {string} method — MCP 메서드
   * @param {*} params — 요청 파라미터
   * @returns {{ hit: boolean, data?: * }}
   */
  function get(server, method, params) {
    const key = hashKey(server, method, params);
    const ttl = getTtl(server);

    // 1) 메모리 핫캐시
    if (hot.has(key)) {
      const entry = hot.get(key);
      if (Date.now() - entry.ts < ttl) {
        hits++;
        // LRU: 삭제 후 재삽입 (Map은 insertion order)
        hot.delete(key);
        hot.set(key, entry);
        return { hit: true, data: entry.data };
      }
      hot.delete(key);
    }

    // 2) 파일 캐시
    const path = getCachePath(key);
    if (existsSync(path)) {
      try {
        const entry = JSON.parse(readFileSync(path, 'utf8'));
        if (Date.now() - entry.ts < ttl) {
          hits++;
          hot.set(key, entry);
          evictIfNeeded();
          return { hit: true, data: entry.data };
        }
        // expired — 삭제
        try { unlinkSync(path); } catch { /* ignore */ }
      } catch { /* corrupt file */ }
    }

    misses++;
    return { hit: false };
  }

  /**
   * 캐시 저장.
   * @param {string} server
   * @param {string} method
   * @param {*} params
   * @param {*} data — 응답 데이터
   */
  function set(server, method, params, data) {
    const key = hashKey(server, method, params);
    const entry = { ts: Date.now(), server, method, data };

    // 메모리
    hot.set(key, entry);
    evictIfNeeded();

    // 파일
    try {
      writeFileSync(getCachePath(key), JSON.stringify(entry), 'utf8');
    } catch { /* best-effort */ }
  }

  function evictIfNeeded() {
    while (hot.size > maxEntries) {
      const oldest = hot.keys().next().value;
      hot.delete(oldest);
    }
  }

  /**
   * 만료된 파일 캐시 정리.
   * @returns {number} 삭제된 파일 수
   */
  function prune() {
    let pruned = 0;
    try {
      for (const name of readdirSync(cacheDir)) {
        if (!name.endsWith('.json')) continue;
        const path = join(cacheDir, name);
        try {
          const entry = JSON.parse(readFileSync(path, 'utf8'));
          const ttl = getTtl(entry.server || '_default');
          if (Date.now() - entry.ts >= ttl) {
            unlinkSync(path);
            pruned++;
          }
        } catch {
          // corrupt — 삭제
          try { unlinkSync(path); pruned++; } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
    return pruned;
  }

  /**
   * 캐시 통계.
   * @returns {{ hits, misses, hotSize, diskFiles, hitRate }}
   */
  function stats() {
    let diskFiles = 0;
    try {
      diskFiles = readdirSync(cacheDir).filter((n) => n.endsWith('.json')).length;
    } catch { /* ignore */ }

    const total = hits + misses;
    return {
      hits,
      misses,
      hotSize: hot.size,
      diskFiles,
      hitRate: total > 0 ? `${((hits / total) * 100).toFixed(1)}%` : '0%',
    };
  }

  /** 전체 캐시 초기화. */
  function clear() {
    hot.clear();
    try {
      for (const name of readdirSync(cacheDir)) {
        if (name.endsWith('.json')) {
          try { unlinkSync(join(cacheDir, name)); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
    hits = 0;
    misses = 0;
  }

  return Object.freeze({
    get,
    set,
    prune,
    stats,
    clear,
    get cacheDir() { return cacheDir; },
  });
}

// 싱글톤 인스턴스 (Hub 프로세스 내에서 공유)
let _instance = null;

export function getMcpResponseCache(opts) {
  if (!_instance) _instance = createMcpResponseCache(opts);
  return _instance;
}
