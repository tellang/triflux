/**
 * Anti-Slop Code Pass
 * AI 생성 코드에서 불필요한 요소를 자동 탐지/제거하는 정적 분석 모듈
 */

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

/** @type {ReadonlyArray<{type: string, pattern: RegExp, severity: string, autoFixable: boolean, multiline: boolean}>} */
export const SLOP_PATTERNS = Object.freeze([
  {
    type: 'trivial_comment',
    pattern: /^\s*\/\/\s*(import|define|set|get|return|export)\s/i,
    severity: 'low',
    autoFixable: true,
    multiline: false,
  },
  {
    type: 'empty_catch',
    pattern: /catch\s*\([^)]*\)\s*\{\s*\}/,
    severity: 'med',
    autoFixable: false,
    multiline: true,
  },
  {
    type: 'console_debug',
    pattern: /^\s*console\.(log|debug|info)\(/,
    severity: 'low',
    autoFixable: true,
    multiline: false,
  },
  {
    type: 'useless_jsdoc',
    pattern: /\/\*\*\s*\n\s*\*\s*\n\s*\*\//,
    severity: 'low',
    autoFixable: true,
    multiline: true,
  },
  {
    type: 'rethrow_only',
    pattern: /catch\s*\((\w+)\)\s*\{\s*throw\s+\1\s*;?\s*\}/,
    severity: 'med',
    autoFixable: false,
    multiline: true,
  },
  {
    type: 'redundant_type',
    pattern: /:\s*(string|number|boolean)\s*=\s*('[^']*'|"[^"]*"|\d+|true|false)/,
    severity: 'low',
    autoFixable: false,
    multiline: false,
  },
  {
    type: 'commented_code',
    pattern: /^\s*\/\/\s*(const |let |var |function |class |if\s*\(|for\s*\(|while\s*\(|return |await )/,
    severity: 'low',
    autoFixable: true,
    multiline: false,
  },
]);

const SEVERITY_WEIGHT = { low: 2, med: 5 };

/**
 * 파일 내용에서 slop 패턴 탐지
 * @param {string} content - 파일 내용
 * @param {string} [filePath] - 파일 경로 (보고용)
 * @returns {{ issues: Array<{line: number, type: string, severity: string, suggestion: string, text: string, autoFixable: boolean}>, score: number }}
 */
export function detectSlop(content, filePath = '') {
  const lines = content.split('\n');
  const issues = [];

  for (const sp of SLOP_PATTERNS) {
    if (sp.multiline) continue;
    for (let i = 0; i < lines.length; i++) {
      if (sp.pattern.test(lines[i])) {
        issues.push({
          line: i + 1,
          type: sp.type,
          severity: sp.severity,
          suggestion: `${sp.type} 패턴 감지`,
          text: lines[i].trim(),
          autoFixable: sp.autoFixable,
          file: filePath,
        });
      }
    }
  }

  for (const sp of SLOP_PATTERNS) {
    if (!sp.multiline) continue;
    const regex = new RegExp(sp.pattern.source, sp.pattern.flags.replace('g', '') + 'g');
    let match;
    while ((match = regex.exec(content)) !== null) {
      const line = content.substring(0, match.index).split('\n').length;
      issues.push({
        line,
        type: sp.type,
        severity: sp.severity,
        suggestion: `${sp.type} 패턴 감지`,
        text: match[0].split('\n')[0].trim(),
        autoFixable: sp.autoFixable,
        file: filePath,
      });
    }
  }

  issues.sort((a, b) => a.line - b.line);

  const totalPenalty = issues.reduce((sum, i) => sum + (SEVERITY_WEIGHT[i.severity] || 2), 0);
  const score = Math.max(0, 100 - totalPenalty);

  return { issues, score };
}

/**
 * 자동 수정 (safe transforms만)
 * @param {string} content - 파일 내용
 * @param {Array<{type: string, autoFixable: boolean}>} issues - detectSlop 결과
 * @returns {{ fixed: string, applied: number, skipped: number }}
 */
export function autoFixSlop(content, issues) {
  if (!issues || issues.length === 0) return { fixed: content, applied: 0, skipped: 0 };

  const fixable = issues.filter(i => i.autoFixable);
  const skipped = issues.length - fixable.length;

  if (fixable.length === 0) return { fixed: content, applied: 0, skipped };

  let fixed = content;
  let applied = 0;

  // Multi-line: useless_jsdoc 제거
  if (fixable.some(i => i.type === 'useless_jsdoc')) {
    const matches = fixed.match(/\/\*\*\s*\n\s*\*\s*\n\s*\*\/\n?/g);
    if (matches) {
      fixed = fixed.replace(/\/\*\*\s*\n\s*\*\s*\n\s*\*\/\n?/g, '');
      applied += matches.length;
    }
  }

  // Line-level: trivial_comment, console_debug, commented_code 제거
  const lineTypes = new Set(
    fixable
      .filter(i => ['trivial_comment', 'console_debug', 'commented_code'].includes(i.type))
      .map(i => i.type),
  );

  if (lineTypes.size > 0) {
    const linePatterns = SLOP_PATTERNS.filter(p => lineTypes.has(p.type));
    const lines = fixed.split('\n');
    const result = [];
    for (const line of lines) {
      let remove = false;
      for (const p of linePatterns) {
        if (p.pattern.test(line)) {
          remove = true;
          applied++;
          break;
        }
      }
      if (!remove) result.push(line);
    }
    fixed = result.join('\n');
  }

  return { fixed, applied, skipped };
}

function matchesGlob(filePath, pattern) {
  const normalized = '/' + filePath.replace(/\\/g, '/');

  // **/*.ext → 확장자 매칭
  if (pattern.startsWith('**/*.')) {
    const ext = pattern.slice(4);
    return normalized.endsWith(ext);
  }

  // *.ext → 확장자 매칭 (디렉토리 무관)
  if (pattern.startsWith('*.') && !pattern.includes('/')) {
    const ext = pattern.slice(1);
    return normalized.endsWith(ext);
  }

  // **/dir/** → 디렉토리 포함 여부
  const dirMatch = pattern.match(/^\*\*\/([^*]+)\/\*\*$/);
  if (dirMatch) {
    return normalized.includes('/' + dirMatch[1] + '/');
  }

  return false;
}

/**
 * 디렉토리 전체 스캔
 * @param {string} dirPath - 스캔 대상 디렉토리
 * @param {object} [opts]
 * @param {string[]} [opts.include] - 포함할 glob 패턴
 * @param {string[]} [opts.exclude] - 제외할 glob 패턴
 * @param {boolean} [opts.autoFix] - 자동 수정 여부
 * @returns {Promise<{ files: Array<{path: string, issues: Array, score: number}>, summary: object }>}
 */
export async function scanDirectory(dirPath, opts = {}) {
  const {
    include = ['**/*.mjs', '**/*.js', '**/*.ts'],
    exclude = ['**/node_modules/**', '**/dist/**', '**/.git/**'],
    autoFix = false,
  } = opts;

  const entries = await readdir(dirPath, { recursive: true });
  const files = [];

  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, '/');
    const fullPath = join(dirPath, entry);

    let st;
    try { st = await stat(fullPath); } catch { continue; }
    if (!st.isFile()) continue;

    const included = include.some(p => matchesGlob(normalized, p));
    const excluded = exclude.some(p => matchesGlob(normalized, p));
    if (!included || excluded) continue;

    const fileContent = await readFile(fullPath, 'utf-8');
    const { issues, score } = detectSlop(fileContent, normalized);

    if (autoFix && issues.length > 0) {
      const { fixed, applied } = autoFixSlop(fileContent, issues);
      if (applied > 0) await writeFile(fullPath, fixed, 'utf-8');
    }

    files.push({ path: normalized, issues, score });
  }

  const totalIssues = files.reduce((sum, f) => sum + f.issues.length, 0);
  const avgScore = files.length > 0
    ? Math.round(files.reduce((sum, f) => sum + f.score, 0) / files.length)
    : 100;

  const byType = {};
  for (const f of files) {
    for (const issue of f.issues) {
      byType[issue.type] = (byType[issue.type] || 0) + 1;
    }
  }

  return {
    files,
    summary: { totalFiles: files.length, totalIssues, averageScore: avgScore, byType },
  };
}
