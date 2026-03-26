import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  generateQueries,
  normalizeResults,
  buildReport,
  saveReport,
} from '../../hub/research.mjs';

// ── SKILL.md 구조 검증 ──

const SKILL_PATH = new URL('../../skills/tfx-autoresearch/SKILL.md', import.meta.url);

describe('tfx-autoresearch SKILL.md — 구조 검증', () => {
  let content;

  before(async () => {
    content = await readFile(SKILL_PATH, 'utf-8');
  });

  it('SKILL.md 파일이 존재하고 읽을 수 있어야 한다', () => {
    assert.ok(content, 'content must be non-empty');
    assert.ok(content.length > 100, 'SKILL.md must have substantial content');
  });

  it('트리거 키워드가 모두 포함되어야 한다', () => {
    const triggers = ['autoresearch', '리서치', '자동 리서치', '웹 리서치', '조사해', '알아봐', 'research this'];
    for (const trigger of triggers) {
      assert.ok(content.includes(trigger), `트리거 "${trigger}" 누락`);
    }
  });

  it('마크다운 구조가 유효해야 한다', () => {
    assert.ok(content.startsWith('---'), 'frontmatter 시작 --- 필요');
    const secondDash = content.indexOf('---', 3);
    assert.ok(secondDash > 0, 'frontmatter 종료 --- 필요');

    const frontmatter = content.substring(0, secondDash);
    assert.ok(frontmatter.includes('name:'), 'frontmatter name 필드 필요');
    assert.ok(frontmatter.includes('description:'), 'frontmatter description 필드 필요');
    assert.ok(frontmatter.includes('triggers:'), 'frontmatter triggers 필드 필요');
  });
});

// ── generateQueries ──

describe('generateQueries', () => {
  it('주제 → 3-5개 쿼리를 생성해야 한다', () => {
    const queries = generateQueries('Next.js 15 App Router');
    assert.ok(Array.isArray(queries), '배열이어야 한다');
    assert.ok(queries.length >= 3, `최소 3개 쿼리 필요, 실제: ${queries.length}`);
    assert.ok(queries.length <= 5, `최대 5개 쿼리, 실제: ${queries.length}`);
    for (const q of queries) {
      assert.ok(typeof q === 'string' && q.length > 0, '각 쿼리는 비어있지 않은 문자열');
    }
  });

  it('한국어 입력 → 영어 쿼리도 포함해야 한다', () => {
    const queries = generateQueries('리액트 상태 관리 비교');
    const hasKorean = queries.some((q) => /[가-힣]/.test(q));
    const hasEnglish = queries.some((q) => /[a-zA-Z]/.test(q));
    assert.ok(hasKorean, '한국어 쿼리가 포함되어야 한다');
    assert.ok(hasEnglish, '영어 쿼리도 포함되어야 한다');
  });

  it('빈 입력 → 빈 배열을 반환해야 한다', () => {
    assert.deepStrictEqual(generateQueries(''), []);
    assert.deepStrictEqual(generateQueries(null), []);
    assert.deepStrictEqual(generateQueries(undefined), []);
    assert.deepStrictEqual(generateQueries('   '), []);
  });
});

// ── normalizeResults ──

describe('normalizeResults', () => {
  it('중복 URL을 제거해야 한다', () => {
    const raw = [
      { title: 'A', url: 'https://a.com', snippet: 'aaa' },
      { title: 'A dup', url: 'https://a.com', snippet: 'aaa dup' },
      { title: 'B', url: 'https://b.com', snippet: 'bbb' },
    ];
    const result = normalizeResults(raw);
    assert.equal(result.length, 2, '중복 제거 후 2개');
    const urls = result.map((r) => r.url);
    assert.ok(urls.includes('https://a.com'));
    assert.ok(urls.includes('https://b.com'));
  });

  it('빈/null 결과를 필터링해야 한다', () => {
    const raw = [
      null,
      undefined,
      {},
      { title: 'Valid', url: 'https://valid.com', snippet: 'ok' },
      { title: 'No URL', url: '', snippet: 'missing url' },
    ];
    const result = normalizeResults(raw);
    assert.equal(result.length, 1, 'null/빈 결과 필터 후 1개');
    assert.equal(result[0].url, 'https://valid.com');
  });
});

// ── buildReport ──

describe('buildReport', () => {
  it('마크다운 구조를 갖춰야 한다 (# 제목, ## 섹션)', () => {
    const md = buildReport('Test Topic', ['Finding 1'], []);
    assert.ok(md.startsWith('# Research: Test Topic'), 'H1 제목');
    assert.ok(md.includes('## Executive Summary'), 'Executive Summary 섹션');
    assert.ok(md.includes('## Key Findings'), 'Key Findings 섹션');
    assert.ok(md.includes('## Actionable Recommendations'), 'Recommendations 섹션');
    assert.ok(md.includes('## Sources'), 'Sources 섹션');
  });

  it('출처 목록을 포함해야 한다', () => {
    const sources = [
      { title: 'MDN', url: 'https://mdn.io', snippet: 'Web docs' },
      { title: 'Blog', url: 'https://blog.com', snippet: 'Tech blog' },
    ];
    const md = buildReport('APIs', ['REST is popular'], sources);
    assert.ok(md.includes('[MDN](https://mdn.io)'), 'MDN 출처 링크');
    assert.ok(md.includes('[Blog](https://blog.com)'), 'Blog 출처 링크');
    assert.ok(md.includes('Web docs'), 'MDN 스니펫');
  });
});

// ── saveReport ──

describe('saveReport', () => {
  const tmpBase = join(import.meta.dirname, '..', '..', '.tfx-test-tmp');

  before(async () => {
    await mkdir(tmpBase, { recursive: true });
  });

  after(async () => {
    await rm(tmpBase, { recursive: true, force: true });
  });

  it('.tfx/reports/ 경로를 반환해야 한다', () => {
    const content = '# Test Report\n';
    const filepath = saveReport('테스트 주제', content, tmpBase);
    assert.ok(filepath.includes('.tfx'), '.tfx 디렉토리 포함');
    assert.ok(filepath.includes('reports'), 'reports 디렉토리 포함');
    assert.ok(filepath.endsWith('.md'), '.md 확장자');
    assert.ok(filepath.includes('research-'), 'research- 접두사');
  });
});
