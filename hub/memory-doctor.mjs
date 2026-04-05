import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, renameSync, lstatSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

// ── Constants ──

const SEVERITY = Object.freeze({ P0: 'P0', P1: 'P1', P2: 'P2' });
const WEIGHT = Object.freeze({ P0: 2.0, P1: 0.5, P2: 0.2 });

const MEMORY_LINK_RE = /\[([^\]]*)\]\(([^)]+\.md)\)/gu;

const PATHS_YAML_RE = /^paths:\s*\n(\s+-\s+.+\n?)+/mu;

const RULE_VIOLATION_PATTERNS = [
  /^\|\s*스킬\s*\|/mu,
  /^\|\s*디렉토리\s*\|/mu,
  /^```\s*(?:tree|npm ls|git log)/mu,
  /^\s*├──|└──/mu,
];

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/u;

const HANGUL_RE = /[\uAC00-\uD7A3]/u;
const LATIN_RE = /[a-zA-Z]{3,}/u;

// ── Helpers ──

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

function parseFrontmatter(content) {
  const match = FRONTMATTER_RE.exec(String(content || ''));
  if (!match) return { found: false, fields: {}, body: content };

  const fields = {};
  for (const line of match[1].split('\n')) {
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const val = line.slice(sep + 1).trim();
    if (key) fields[key] = val;
  }
  return { found: true, fields, body: String(content).slice(match[0].length).trim() };
}

function safeReadFile(filePath) {
  try {
    return existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
  } catch { return null; }
}

function safeReadDir(dirPath) {
  try {
    return existsSync(dirPath) ? readdirSync(dirPath) : [];
  } catch { return []; }
}

function isCI() {
  return process.env.CI === 'true' || process.env.DOCKER === 'true' || process.env.TFX_POSTINSTALL_FIX !== '1' && process.env.CI != null;
}

function makeCheckResult(id, name, severity, autofix, issues, error = null) {
  return Object.freeze({
    id,
    name,
    severity,
    autofix,
    issues: Object.freeze([...issues]),
    passed: issues.length === 0 && error == null,
    error,
  });
}

// ── Check Functions ──

function checkOrphanFiles(memoryDir) {
  const indexPath = join(memoryDir, 'MEMORY.md');
  const indexContent = safeReadFile(indexPath);
  if (indexContent == null) {
    return makeCheckResult('orphan-files', '고아 파일 감지', SEVERITY.P0, true, []);
  }

  const indexed = new Set();
  let m;
  const re = new RegExp(MEMORY_LINK_RE.source, MEMORY_LINK_RE.flags);
  while ((m = re.exec(indexContent)) !== null) {
    indexed.add(m[2]);
  }

  const diskFiles = safeReadDir(memoryDir)
    .filter(f => f.endsWith('.md') && f !== 'MEMORY.md');

  const orphans = diskFiles
    .filter(f => !indexed.has(f))
    .map(f => ({ file: f, detail: 'MEMORY.md 인덱스에 미등록' }));

  return makeCheckResult('orphan-files', '고아 파일 감지', SEVERITY.P0, true, orphans);
}

function checkPathsYamlBug(rulesDir) {
  const files = safeReadDir(rulesDir).filter(f => f.endsWith('.md'));
  const issues = [];

  for (const file of files) {
    const content = safeReadFile(join(rulesDir, file));
    if (content == null) continue;

    const fm = parseFrontmatter(content);
    if (!fm.found) continue;

    const rawFm = FRONTMATTER_RE.exec(content);
    if (rawFm && PATHS_YAML_RE.test(rawFm[1])) {
      issues.push({ file, detail: 'paths: YAML 배열 사용 (동작 안 함 — globs: CSV로 변환 필요)' });
    }
  }

  return makeCheckResult('paths-yaml-bug', 'paths: YAML 배열 버그', SEVERITY.P0, true, issues);
}

function checkTrifluxResidue(projectDir, claudeDir) {
  const issues = [];

  const omcState = join(projectDir, '.omc', 'state');
  if (existsSync(omcState)) {
    const now = Date.now();
    const staleThreshold = 7 * 24 * 60 * 60 * 1000;
    for (const f of safeReadDir(omcState).filter(f => f.endsWith('.json'))) {
      try {
        const stat = lstatSync(join(omcState, f));
        if (now - stat.mtimeMs > staleThreshold) {
          issues.push({ file: `.omc/state/${f}`, detail: '7일 이상 된 stale state 파일' });
        }
      } catch { /* skip */ }
    }
  }

  const scriptsDir = join(claudeDir, 'scripts');
  for (const f of safeReadDir(scriptsDir)) {
    try {
      const fullPath = join(scriptsDir, f);
      const stat = lstatSync(fullPath);
      if (stat.isSymbolicLink() && !existsSync(fullPath)) {
        issues.push({ file: `~/.claude/scripts/${f}`, detail: '깨진 심볼릭 링크' });
      }
    } catch { /* skip */ }
  }

  return makeCheckResult('triflux-residue', '기존 triflux 잔재', SEVERITY.P0, true, issues);
}

function checkRuleViolation(memoryDir) {
  const files = safeReadDir(memoryDir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
  const issues = [];

  for (const file of files) {
    const content = safeReadFile(join(memoryDir, file));
    if (content == null) continue;

    for (const pattern of RULE_VIOLATION_PATTERNS) {
      if (pattern.test(content)) {
        issues.push({ file, detail: '코드에서 도출 가능한 정보 포함' });
        break;
      }
    }
  }

  return makeCheckResult('rule-violation', '저장 규칙 위반', SEVERITY.P1, false, issues);
}

function checkStaleReferences(memoryDir, projectDir) {
  const files = safeReadDir(memoryDir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
  const issues = [];
  const fileRefRe = /(?:^|\s)([a-zA-Z][\w/.%-]+\.[a-z]{1,5})(?::(\d+))?/gu;

  for (const file of files) {
    const content = safeReadFile(join(memoryDir, file));
    if (content == null) continue;

    let m;
    const re = new RegExp(fileRefRe.source, fileRefRe.flags);
    while ((m = re.exec(content)) !== null) {
      const refPath = m[1];
      if (refPath.startsWith('http') || refPath.startsWith('node:') || refPath.includes('node_modules')) continue;
      const fullPath = resolve(projectDir, refPath);
      if (!existsSync(fullPath) && refPath.includes('/')) {
        issues.push({ file, detail: `존재하지 않는 파일 참조: ${refPath}` });
      }
    }
  }

  return makeCheckResult('stale-references', 'stale 참조', SEVERITY.P1, false, issues);
}

function checkLanguageInconsistency(memoryDir) {
  const files = safeReadDir(memoryDir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
  const issues = [];

  let koCount = 0;
  let enCount = 0;

  for (const file of files) {
    const content = safeReadFile(join(memoryDir, file));
    if (content == null) continue;
    const fm = parseFrontmatter(content);
    if (!fm.found) continue;

    const nameVal = fm.fields.name || '';
    const descVal = fm.fields.description || '';
    const combined = `${nameVal} ${descVal}`;

    if (HANGUL_RE.test(combined)) koCount++;
    else if (LATIN_RE.test(combined)) enCount++;
  }

  const majorLang = koCount >= enCount ? 'ko' : 'en';
  const isKoMajor = majorLang === 'ko';

  for (const file of files) {
    const content = safeReadFile(join(memoryDir, file));
    if (content == null) continue;
    const fm = parseFrontmatter(content);
    if (!fm.found || !fm.fields.name) continue;

    const combined = `${fm.fields.name} ${fm.fields.description || ''}`;
    const hasKo = HANGUL_RE.test(combined);
    const hasEn = LATIN_RE.test(combined);

    if (isKoMajor && !hasKo && hasEn) {
      issues.push({ file, detail: `다수 언어(한국어)와 불일치 — 영어 전용` });
    } else if (!isKoMajor && hasKo && !hasEn) {
      issues.push({ file, detail: `다수 언어(영어)와 불일치 — 한국어 전용` });
    }
  }

  return makeCheckResult('language-inconsistency', '언어 혼용', SEVERITY.P2, false, issues);
}

function checkOversizedFiles(memoryDir) {
  const files = safeReadDir(memoryDir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
  const issues = [];

  for (const file of files) {
    const content = safeReadFile(join(memoryDir, file));
    if (content == null) continue;
    const lineCount = content.split('\n').length;
    if (lineCount > 50) {
      issues.push({ file, detail: `${lineCount}줄 (50줄 초과)` });
    }
  }

  return makeCheckResult('oversized-files', '과대 파일', SEVERITY.P2, false, issues);
}

function checkMissingUserMemory(memoryDir) {
  const files = safeReadDir(memoryDir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
  const issues = [];

  const hasUserType = files.some(file => {
    const content = safeReadFile(join(memoryDir, file));
    if (content == null) return false;
    const fm = parseFrontmatter(content);
    return fm.found && fm.fields.type === 'user';
  });

  if (!hasUserType && files.length > 0) {
    issues.push({ file: 'memory/', detail: 'type: user 메모리 파일 없음 — 사용자 프로필 미등록' });
  }

  return makeCheckResult('missing-user-memory', 'user 타입 메모리 부재', SEVERITY.P2, true, issues);
}

// ── Fix Functions ──

function createBackup(files, backupDir) {
  const timestamp = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19);
  const dir = join(backupDir, timestamp);
  mkdirSync(dir, { recursive: true });

  const backed = [];
  for (const src of files) {
    if (!existsSync(src)) continue;
    const dst = join(dir, basename(src));
    copyFileSync(src, dst);
    backed.push({ src, dst });
  }

  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    timestamp,
    files: backed,
    restore: 'tfx memory-doctor --undo',
  }, null, 2), 'utf8');

  return { dir, files: backed };
}

function fixOrphanFiles(memoryDir, issues) {
  const indexPath = join(memoryDir, 'MEMORY.md');
  const content = safeReadFile(indexPath);
  if (content == null) return { action: 'skipped', fixed: [] };

  const additions = issues.map(({ file }) => {
    const fm = parseFrontmatter(safeReadFile(join(memoryDir, file)) || '');
    const desc = fm.fields.description || '(설명 없음)';
    return `- [${fm.fields.name || file}](${file}) — ${desc}`;
  });

  if (additions.length === 0) return { action: 'unchanged', fixed: [] };

  const separator = content.endsWith('\n') ? '' : '\n';
  writeFileSync(indexPath, `${content}${separator}${additions.join('\n')}\n`, 'utf8');

  return { action: 'fixed', fixed: issues.map(i => i.file) };
}

function fixPathsYamlBug(rulesDir, issues) {
  const fixed = [];

  for (const { file } of issues) {
    const filePath = join(rulesDir, file);
    const content = safeReadFile(filePath);
    if (content == null) continue;

    const fmMatch = FRONTMATTER_RE.exec(content);
    if (!fmMatch) continue;

    const fmRaw = fmMatch[1];
    const pathsMatch = PATHS_YAML_RE.exec(fmRaw);
    if (!pathsMatch) continue;

    const values = [];
    for (const line of pathsMatch[0].split('\n')) {
      const trimmed = line.replace(/^\s*-\s*/, '').replace(/^["']|["']$/gu, '').trim();
      if (trimmed && trimmed !== 'paths:') values.push(trimmed);
    }

    if (values.length === 0) continue;

    const globsLine = `globs: ${values.join(', ')}`;
    const nextFm = fmRaw.replace(pathsMatch[0], globsLine);
    const nextContent = `---\n${nextFm}\n---${content.slice(fmMatch[0].length)}`;
    writeFileSync(filePath, nextContent, 'utf8');
    fixed.push(file);
  }

  return { action: fixed.length > 0 ? 'fixed' : 'unchanged', fixed };
}

function fixTrifluxResidue(issues) {
  const fixed = [];

  for (const { file } of issues) {
    try {
      const fullPath = resolve(file.replace(/^~\/\.claude/u, join(process.env.HOME || '', '.claude')));
      if (!existsSync(fullPath)) continue;

      const archiveDir = join(resolve('.tfx', 'archive'));
      mkdirSync(archiveDir, { recursive: true });
      renameSync(fullPath, join(archiveDir, basename(fullPath)));
      fixed.push(file);
    } catch { /* skip unresolvable */ }
  }

  return { action: fixed.length > 0 ? 'fixed' : 'unchanged', fixed };
}

// ── Health Score ──

function computeHealthScore(checks) {
  let penalty = 0;
  for (const check of checks) {
    if (check.error != null) continue;
    const count = check.issues.length;
    const w = WEIGHT[check.severity] || 0;
    penalty += count * w;
  }
  return clamp(Number((10 - penalty).toFixed(1)), 0, 10);
}

// ── Factory ──

const ALL_CHECKS = [
  checkOrphanFiles,
  checkPathsYamlBug,
  checkTrifluxResidue,
  checkRuleViolation,
  checkStaleReferences,
  checkLanguageInconsistency,
  checkOversizedFiles,
  checkMissingUserMemory,
];

const FIX_MAP = {
  'orphan-files': fixOrphanFiles,
  'paths-yaml-bug': fixPathsYamlBug,
  'triflux-residue': fixTrifluxResidue,
};

export function createMemoryDoctor(options = {}) {
  const memoryDir = resolve(options.memoryDir || '');
  const rulesDir = resolve(options.rulesDir || '');
  const projectDir = resolve(options.projectDir || process.cwd());
  const claudeDir = resolve(options.claudeDir || '');
  const backupDir = resolve(options.backupDir || join(projectDir, '.tfx', 'backups'));

  function scan() {
    const checks = ALL_CHECKS.map(fn => {
      try {
        if (fn === checkOrphanFiles) return fn(memoryDir);
        if (fn === checkPathsYamlBug) return fn(rulesDir);
        if (fn === checkTrifluxResidue) return fn(projectDir, claudeDir);
        if (fn === checkRuleViolation) return fn(memoryDir);
        if (fn === checkStaleReferences) return fn(memoryDir, projectDir);
        if (fn === checkLanguageInconsistency) return fn(memoryDir);
        if (fn === checkOversizedFiles) return fn(memoryDir);
        if (fn === checkMissingUserMemory) return fn(memoryDir);
        return fn(memoryDir);
      } catch (err) {
        return makeCheckResult(fn.name.replace('check', '').replace(/([A-Z])/gu, '-$1').toLowerCase().replace(/^-/u, ''),
          fn.name, SEVERITY.P2, false, [], err.message);
      }
    });

    const healthScore = computeHealthScore(checks);
    const summary = {
      p0: checks.filter(c => c.severity === SEVERITY.P0 && !c.passed).length,
      p1: checks.filter(c => c.severity === SEVERITY.P1 && !c.passed).length,
      p2: checks.filter(c => c.severity === SEVERITY.P2 && !c.passed).length,
    };

    return Object.freeze({ checks, healthScore, summary });
  }

  function fix(checkId, opts = {}) {
    if (isCI() && !opts.force) {
      return { action: 'skipped_ci', backup: null, fixed: [] };
    }

    const { checks } = scan();
    const check = checks.find(c => c.id === checkId);
    if (!check || check.passed) return { action: 'no_issues', backup: null, fixed: [] };
    if (!check.autofix) return { action: 'manual_only', backup: null, fixed: [] };

    const fixFn = FIX_MAP[checkId];
    if (!fixFn) return { action: 'no_fixer', backup: null, fixed: [] };

    const affectedFiles = check.issues
      .map(i => {
        const candidate = join(checkId === 'orphan-files' ? memoryDir : rulesDir, i.file);
        return existsSync(candidate) ? candidate : null;
      })
      .filter(Boolean);

    const indexFile = checkId === 'orphan-files' ? join(memoryDir, 'MEMORY.md') : null;
    const backupFiles = indexFile ? [indexFile, ...affectedFiles] : affectedFiles;

    const backup = backupFiles.length > 0 ? createBackup(backupFiles, backupDir) : null;

    const dir = checkId === 'orphan-files' ? memoryDir : checkId === 'paths-yaml-bug' ? rulesDir : projectDir;
    const result = fixFn(dir, check.issues);

    return { ...result, backup: backup?.dir || null };
  }

  function fixAll(opts = {}) {
    if (isCI() && !opts.force) {
      return { results: [], backup: null };
    }

    const { checks } = scan();
    const targets = checks.filter(c => {
      if (opts.severity && c.severity !== opts.severity) return false;
      return c.autofix && !c.passed;
    });

    const results = targets.map(c => ({ id: c.id, ...fix(c.id, opts) }));
    return { results };
  }

  return Object.freeze({ scan, fix, fixAll, getHealthScore: computeHealthScore });
}

export { computeHealthScore, parseFrontmatter, isCI };
