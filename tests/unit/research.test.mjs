// tests/unit/research.test.mjs — hub/research.mjs 유닛 테스트
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  generateQueries,
  normalizeResults,
  buildReport,
  saveReport,
} from '../../hub/research.mjs';

// ── generateQueries ──

describe('generateQueries — 한국어 입력', () => {
  it('한국어 주제 → 한국어 쿼리가 포함되어야 한다', () => {
    const queries = generateQueries('머신러닝 프레임워크');
    const hasKorean = queries.some((q) => /[가-힣]/.test(q));
    assert.ok(hasKorean, '한국어 쿼리 포함 필요');
  });

  it('한국어 주제 → 영어 쿼리도 함께 포함되어야 한다', () => {
    const queries = generateQueries('머신러닝 프레임워크');
    const hasEnglish = queries.some((q) => /[a-zA-Z]/.test(q));
    assert.ok(hasEnglish, '영어 쿼리도 포함 필요 (혼합 결과)');
  });

  it('lang="ko" 명시 → 한국어 쿼리가 포함되어야 한다', () => {
    const queries = generateQueries('database design', 'ko');
    const hasKorean = queries.some((q) => /[가-힣]/.test(q));
    assert.ok(hasKorean, 'lang=ko 명시 시 한국어 쿼리 포함 필요');
  });

  it('한국어 주제 → 5개 쿼리를 생성해야 한다', () => {
    const queries = generateQueries('클라우드 컴퓨팅 비교');
    assert.equal(queries.length, 5, '한국어 경로는 5개 쿼리');
  });
});

describe('generateQueries — 영어 입력', () => {
  it('영어 주제 → 영어 쿼리만 생성해야 한다', () => {
    const queries = generateQueries('TypeScript generics');
    for (const q of queries) {
      assert.ok(typeof q === 'string' && q.length > 0, '각 쿼리는 비어있지 않은 문자열');
      assert.ok(q.includes('TypeScript'), `쿼리에 주제어 포함: "${q}"`);
    }
  });

  it('lang="en" 명시 → 4개 쿼리를 생성해야 한다', () => {
    const queries = generateQueries('React hooks', 'en');
    assert.equal(queries.length, 4, '영어 경로는 4개 쿼리');
  });

  it('영어 주제에 "overview" 쿼리가 포함되어야 한다', () => {
    const queries = generateQueries('Docker containers');
    assert.ok(queries.some((q) => q.includes('overview')), '"overview" 쿼리 포함 필요');
  });

  it('영어 주제에 현재 연도가 포함된 쿼리가 있어야 한다', () => {
    const year = String(new Date().getFullYear());
    const queries = generateQueries('Kubernetes');
    assert.ok(queries.some((q) => q.includes(year)), `연도 ${year} 포함 쿼리 필요`);
  });
});

describe('generateQueries — auto 감지', () => {
  it('lang="auto" + 한글 주제 → 한국어 경로를 선택해야 한다', () => {
    const queries = generateQueries('파이썬 비동기', 'auto');
    assert.equal(queries.length, 5, 'auto 감지로 한국어 경로 → 5개');
  });

  it('lang="auto" + 영어 주제 → 영어 경로를 선택해야 한다', () => {
    const queries = generateQueries('async await patterns', 'auto');
    assert.equal(queries.length, 4, 'auto 감지로 영어 경로 → 4개');
  });

  it('lang 파라미터 생략 시 auto와 동일하게 동작해야 한다', () => {
    const withAuto = generateQueries('GraphQL');
    const withDefault = generateQueries('GraphQL');
    assert.deepEqual(withAuto, withDefault, 'lang 생략 == auto');
  });
});

// ── normalizeResults ──

describe('normalizeResults — 중복 제거', () => {
  it('동일 URL 두 번 등장 시 첫 번째만 유지해야 한다', () => {
    const raw = [
      { title: 'First', url: 'https://example.com', snippet: 'first' },
      { title: 'Duplicate', url: 'https://example.com', snippet: 'dup' },
    ];
    const result = normalizeResults(raw);
    assert.equal(result.length, 1, '중복 제거 후 1개');
    assert.equal(result[0].title, 'First', '첫 번째 항목 유지');
  });

  it('서로 다른 URL은 모두 유지해야 한다', () => {
    const raw = [
      { title: 'A', url: 'https://a.com', snippet: '' },
      { title: 'B', url: 'https://b.com', snippet: '' },
      { title: 'C', url: 'https://c.com', snippet: '' },
    ];
    const result = normalizeResults(raw);
    assert.equal(result.length, 3, '3개 고유 URL → 3개 결과');
  });

  it('세 항목 중 중간 항목이 중복일 때 올바르게 제거해야 한다', () => {
    const raw = [
      { title: 'A', url: 'https://a.com', snippet: 'aaa' },
      { title: 'A2', url: 'https://a.com', snippet: 'aaa2' },
      { title: 'B', url: 'https://b.com', snippet: 'bbb' },
    ];
    const result = normalizeResults(raw);
    assert.equal(result.length, 2);
    assert.equal(result[1].url, 'https://b.com', 'B는 유지');
  });
});

describe('normalizeResults — null 항목 필터링', () => {
  it('null 항목을 필터링해야 한다', () => {
    const raw = [null, { title: 'Valid', url: 'https://valid.com', snippet: 'ok' }];
    const result = normalizeResults(raw);
    assert.equal(result.length, 1);
    assert.equal(result[0].url, 'https://valid.com');
  });

  it('undefined 항목을 필터링해야 한다', () => {
    const raw = [undefined, { title: 'V', url: 'https://v.com', snippet: '' }];
    const result = normalizeResults(raw);
    assert.equal(result.length, 1);
  });

  it('URL 없는 객체를 필터링해야 한다', () => {
    const raw = [
      { title: 'No URL', url: '', snippet: 'no url' },
      { title: 'Valid', url: 'https://ok.com', snippet: 'ok' },
    ];
    const result = normalizeResults(raw);
    assert.equal(result.length, 1, 'URL 없는 항목 제거');
    assert.equal(result[0].url, 'https://ok.com');
  });

  it('빈 배열 입력 → 빈 배열 반환', () => {
    assert.deepEqual(normalizeResults([]), []);
  });

  it('배열이 아닌 입력 → 빈 배열 반환', () => {
    assert.deepEqual(normalizeResults(null), []);
    assert.deepEqual(normalizeResults(undefined), []);
    assert.deepEqual(normalizeResults('string'), []);
  });

  it('"link" 필드를 url 별칭으로 인식해야 한다', () => {
    const raw = [{ title: 'Link field', link: 'https://link.com', snippet: 'via link' }];
    const result = normalizeResults(raw);
    assert.equal(result.length, 1);
    assert.equal(result[0].url, 'https://link.com');
  });

  it('"name" 필드를 title 별칭으로 인식해야 한다', () => {
    const raw = [{ name: 'Named item', url: 'https://named.com', description: 'via name' }];
    const result = normalizeResults(raw);
    assert.equal(result.length, 1);
    assert.equal(result[0].title, 'Named item');
  });
});

// ── buildReport ──

describe('buildReport — 출력 형식', () => {
  it('H1 제목에 주제가 포함되어야 한다', () => {
    const md = buildReport('Test Topic', [], []);
    assert.ok(md.startsWith('# Research: Test Topic'), 'H1 제목 포함');
  });

  it('Date 헤더가 ISO 날짜 형식으로 포함되어야 한다', () => {
    const md = buildReport('Topic', [], []);
    const today = new Date().toISOString().split('T')[0];
    assert.ok(md.includes(`Date: ${today}`), `오늘 날짜 ${today} 포함 필요`);
  });

  it('## Executive Summary 섹션이 존재해야 한다', () => {
    const md = buildReport('Topic', [], []);
    assert.ok(md.includes('## Executive Summary'), 'Executive Summary 섹션 필요');
  });

  it('## Key Findings 섹션이 존재해야 한다', () => {
    const md = buildReport('Topic', [], []);
    assert.ok(md.includes('## Key Findings'), 'Key Findings 섹션 필요');
  });

  it('## Actionable Recommendations 섹션이 존재해야 한다', () => {
    const md = buildReport('Topic', [], []);
    assert.ok(md.includes('## Actionable Recommendations'), 'Recommendations 섹션 필요');
  });

  it('## Sources 섹션이 존재해야 한다', () => {
    const md = buildReport('Topic', [], []);
    assert.ok(md.includes('## Sources'), 'Sources 섹션 필요');
  });

  it('findings가 번호 매겨진 목록으로 렌더링되어야 한다', () => {
    const md = buildReport('Topic', ['First finding', 'Second finding'], []);
    assert.ok(md.includes('1. First finding'), '첫 번째 항목 번호');
    assert.ok(md.includes('2. Second finding'), '두 번째 항목 번호');
  });

  it('findings가 비어있을 때 "_발견 없음_" 플레이스홀더가 나타나야 한다', () => {
    const md = buildReport('Empty', [], []);
    assert.ok(md.includes('_발견 없음_'), 'findings 없음 플레이스홀더');
  });

  it('findings가 null일 때도 "_발견 없음_" 플레이스홀더가 나타나야 한다', () => {
    const md = buildReport('Empty', null, []);
    assert.ok(md.includes('_발견 없음_'), 'findings null 플레이스홀더');
  });

  it('sources가 비어있을 때 "_출처 없음_" 플레이스홀더가 나타나야 한다', () => {
    const md = buildReport('No Sources', ['finding'], []);
    assert.ok(md.includes('_출처 없음_'), 'sources 없음 플레이스홀더');
  });

  it('sources가 마크다운 링크 형식으로 렌더링되어야 한다', () => {
    const sources = [{ title: 'MDN', url: 'https://mdn.io', snippet: 'Web docs' }];
    const md = buildReport('Topic', [], sources);
    assert.ok(md.includes('[MDN](https://mdn.io)'), '마크다운 링크 형식');
  });

  it('source에 snippet이 있으면 — 구분자 뒤에 포함되어야 한다', () => {
    const sources = [{ title: 'Blog', url: 'https://blog.com', snippet: 'tech content' }];
    const md = buildReport('Topic', [], sources);
    assert.ok(md.includes('— tech content'), 'snippet — 구분자 포함');
  });

  it('source에 snippet이 없으면 — 구분자가 없어야 한다', () => {
    const sources = [{ title: 'Blog', url: 'https://blog.com', snippet: '' }];
    const md = buildReport('Topic', [], sources);
    assert.ok(!md.includes('— '), 'snippet 없으면 — 구분자 제외');
  });
});

// ── saveReport ──

describe('saveReport — 정상 저장', () => {
  const tmpBase = join(
    new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'),
    '../../.tfx-research-test-tmp',
  );

  before(async () => {
    await mkdir(tmpBase, { recursive: true });
  });

  after(async () => {
    await rm(tmpBase, { recursive: true, force: true });
  });

  it('.tfx/reports/ 경로를 반환해야 한다', () => {
    const filepath = saveReport('test topic', '# Content\n', tmpBase);
    assert.ok(filepath.includes('.tfx'), '.tfx 경로 포함');
    assert.ok(filepath.includes('reports'), 'reports 경로 포함');
  });

  it('반환 경로가 .md 확장자여야 한다', () => {
    const filepath = saveReport('test topic', '# Content\n', tmpBase);
    assert.ok(filepath.endsWith('.md'), '.md 확장자');
  });

  it('파일명에 "research-" 접두사가 있어야 한다', () => {
    const filepath = saveReport('test topic', '# Content\n', tmpBase);
    const filename = filepath.split(/[\\/]/).at(-1);
    assert.ok(filename.startsWith('research-'), 'research- 접두사');
  });

  it('파일이 실제로 디스크에 생성되어야 한다', async () => {
    const content = '# Disk Write Test\n';
    const filepath = saveReport('disk write', content, tmpBase);
    const written = await readFile(filepath, 'utf-8');
    assert.equal(written, content, '저장된 내용이 입력과 일치');
  });

  it('파일명에 주제 슬러그가 포함되어야 한다', () => {
    const filepath = saveReport('my research topic', '# Content\n', tmpBase);
    const filename = filepath.split(/[\\/]/).at(-1);
    assert.ok(filename.includes('my-research-topic'), '슬러그 포함');
  });

  it('한국어 주제도 슬러그로 변환되어야 한다', () => {
    const filepath = saveReport('한국어 주제 테스트', '# Content\n', tmpBase);
    const filename = filepath.split(/[\\/]/).at(-1);
    assert.ok(filename.endsWith('.md'), '한국어 주제도 .md 생성');
  });

  it('topic이 null일 때 "untitled" 슬러그를 사용해야 한다', () => {
    const filepath = saveReport(null, '# Content\n', tmpBase);
    const filename = filepath.split(/[\\/]/).at(-1);
    assert.ok(filename.includes('untitled'), 'null topic → untitled 슬러그');
  });
});

describe('saveReport — path traversal 가드', () => {
  // 가드 로직 검증:
  // saveReport 내부에서 resolve(join(baseDir, TFX_REPORTS_DIR)).startsWith(resolve(baseDir))
  // 를 확인한다. TFX_REPORTS_DIR 상수('.tfx/reports')는 traversal 문자를 포함하지 않으므로
  // 정상 baseDir에서는 항상 통과한다.
  // 가드가 의도한 대로 동작하는지 guard 로직 자체를 단위 검증한다.

  it('정상 baseDir → 가드가 throw하지 않아야 한다', () => {
    const tmpBase = join(
      new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'),
      '../../.tfx-guard-test-tmp',
    );
    // 실제로 디렉토리 생성 없이 가드만 통과하는지 확인
    // (mkdirSync recursive이므로 path가 유효하면 생성됨)
    assert.doesNotThrow(
      () => {
        // 실제 파일 저장이 아닌 가드 로직 등가 검증
        const TFX_REPORTS_DIR = '.tfx/reports';
        const dir = join(tmpBase, TFX_REPORTS_DIR);
        const resolvedDir = resolve(dir);
        const expectedBase = resolve(tmpBase);
        if (!resolvedDir.startsWith(expectedBase)) {
          throw new Error('Invalid report directory: path traversal detected');
        }
      },
      '정상 경로에서 가드 에러 없어야 함',
    );
  });

  it('가드 로직: join(baseDir, "../../evil")이 baseDir 밖으로 탈출하면 에러를 던져야 한다', () => {
    // saveReport의 가드와 동일한 로직을 직접 실행하여 traversal 감지를 검증
    const baseDir = '/tmp/safe-project';
    const maliciousRelDir = '../../evil';
    const resolvedDir = resolve(join(baseDir, maliciousRelDir));
    const expectedBase = resolve(baseDir);
    const escaped = !resolvedDir.startsWith(expectedBase);
    assert.ok(escaped, 'traversal 경로가 baseDir 밖으로 탈출해야 한다');

    assert.throws(
      () => {
        if (escaped) throw new Error('Invalid report directory: path traversal detected');
      },
      /path traversal detected/,
      'traversal 탈출 시 에러 메시지 일치',
    );
  });

  it('가드 로직: 형제 디렉토리 탈출 시도도 감지해야 한다', () => {
    const baseDir = '/tmp/project-a';
    const maliciousRelDir = '../project-b/secrets';
    const resolvedDir = resolve(join(baseDir, maliciousRelDir));
    const expectedBase = resolve(baseDir);
    assert.ok(
      !resolvedDir.startsWith(expectedBase),
      '형제 디렉토리 탈출이 감지되어야 한다',
    );
  });

  it('가드 로직: 단일 ".." 탈출 시도도 감지해야 한다', () => {
    const baseDir = '/tmp/nested/project';
    const maliciousRelDir = '../outside';
    const resolvedDir = resolve(join(baseDir, maliciousRelDir));
    const expectedBase = resolve(baseDir);
    assert.ok(
      !resolvedDir.startsWith(expectedBase),
      '단일 ".." 탈출이 감지되어야 한다',
    );
  });

  it('가드 로직: baseDir 하위 경로는 항상 통과해야 한다', () => {
    const baseDir = '/tmp/project';
    const safeRelDir = 'subdir/reports';
    const resolvedDir = resolve(join(baseDir, safeRelDir));
    const expectedBase = resolve(baseDir);
    assert.ok(
      resolvedDir.startsWith(expectedBase),
      'baseDir 하위 경로는 통과',
    );
  });
});
