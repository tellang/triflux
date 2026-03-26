// hub/research.mjs — 자율 웹 리서치 엔진 코어
// 검색 쿼리 생성 → 결과 정규화 → 보고서 빌드 → 저장

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TFX_REPORTS_DIR } from './paths.mjs';

/**
 * 주제에서 검색 쿼리 3-5개를 자동 생성한다.
 * 한국어 주제 → 한국어 + 영어 혼합, 영어 주제 → 영어 쿼리.
 * @param {string} topic - 리서치 주제
 * @param {'ko'|'en'|'auto'} [lang='auto'] - 언어 힌트
 * @returns {string[]} 검색 쿼리 배열
 */
export function generateQueries(topic, lang = 'auto') {
  if (!topic || typeof topic !== 'string' || !topic.trim()) return [];

  const t = topic.trim();
  const detectedLang = lang === 'auto' ? detectLang(t) : lang;

  if (detectedLang === 'ko') {
    return [
      `${t} 정리`,
      `${t} 비교 분석`,
      `${t} 최신 동향 ${new Date().getFullYear()}`,
      `${toEnglishQuery(t)} overview`,
      `${toEnglishQuery(t)} comparison ${new Date().getFullYear()}`,
    ];
  }

  return [
    `${t} overview`,
    `${t} comparison`,
    `${t} best practices ${new Date().getFullYear()}`,
    `${t} pros and cons`,
  ];
}

/**
 * 검색 원시 결과를 정규화한다. 중복 URL 제거 + 빈/null 필터링.
 * @param {Array<object|null|undefined>} rawResults - 검색 엔진 원시 결과
 * @returns {Array<{title: string, url: string, snippet: string}>}
 */
export function normalizeResults(rawResults) {
  if (!Array.isArray(rawResults)) return [];

  const seen = new Set();
  const out = [];

  for (const r of rawResults) {
    if (!r || typeof r !== 'object') continue;
    const url = (r.url || r.link || '').trim();
    const title = (r.title || r.name || '').trim();
    const snippet = (r.snippet || r.description || r.content || '').trim();

    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ title, url, snippet });
  }

  return out;
}

/**
 * 리서치 보고서를 마크다운으로 빌드한다.
 * @param {string} topic - 리서치 주제
 * @param {string[]} findings - 핵심 발견 목록
 * @param {Array<{title: string, url: string, snippet: string}>} sources - 출처 목록
 * @returns {string} 마크다운 문자열
 */
export function buildReport(topic, findings, sources) {
  const date = new Date().toISOString().split('T')[0];
  const findingsSection = (findings || [])
    .map((f, i) => `${i + 1}. ${f}`)
    .join('\n');
  const sourcesSection = (sources || [])
    .map((s) => `- [${s.title || s.url}](${s.url})${s.snippet ? ` — ${s.snippet}` : ''}`)
    .join('\n');

  return `# Research: ${topic}
Date: ${date}

## Executive Summary
${topic}에 대한 자동 리서치 결과입니다.

## Key Findings
${findingsSection || '_발견 없음_'}

## Actionable Recommendations
리서치 결과를 바탕으로 다음 단계를 검토하세요.

## Sources
${sourcesSection || '_출처 없음_'}
`;
}

/**
 * 보고서를 .tfx/reports/research-{timestamp}.md에 저장한다.
 * @param {string} topic - 리서치 주제 (파일명 생성용)
 * @param {string} content - 마크다운 보고서 내용
 * @param {string} [baseDir=process.cwd()] - 프로젝트 루트 경로
 * @returns {string} 저장된 파일 경로
 */
export function saveReport(topic, content, baseDir = process.cwd()) {
  const dir = join(baseDir, TFX_REPORTS_DIR);
  const resolvedDir = resolve(dir);
  const expectedBase = resolve(baseDir || TFX_REPORTS_DIR);
  if (!resolvedDir.startsWith(expectedBase)) {
    throw new Error('Invalid report directory: path traversal detected');
  }
  mkdirSync(dir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const slug = (topic || 'untitled')
    .replace(/[^a-zA-Z0-9가-힣\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 40)
    .toLowerCase();
  const filename = `research-${ts}-${slug}.md`;
  const filepath = join(dir, filename);

  writeFileSync(filepath, content, 'utf-8');
  return filepath;
}

// ── internal helpers ──

/**
 * 텍스트에 한글이 포함되어 있으면 'ko', 아니면 'en'
 * @param {string} text
 * @returns {'ko'|'en'}
 */
function detectLang(text) {
  return /[가-힣]/.test(text) ? 'ko' : 'en';
}

/**
 * 한국어 토픽에서 영어 검색 쿼리용 문자열 추출.
 * 영문/숫자만 남기고, 없으면 원문 그대로 반환.
 * @param {string} text
 * @returns {string}
 */
function toEnglishQuery(text) {
  const eng = text.replace(/[가-힣\s]+/g, ' ').trim();
  return eng || text;
}
