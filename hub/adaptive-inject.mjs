import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SECTION_HEADING = '## Adaptive Rules (triflux auto-generated)';
const DEFAULT_MAX_RULES = 10;
const SECTION_RE = /^## Adaptive Rules \(triflux auto-generated\)$/mu;
const BLOCK_RE = /<!-- tfx-adaptive:start rule_id="([^"]+)" confidence=([0-9.]+) occurrences=(\d+) first_seen=([0-9-]+) last_seen=([0-9-]+) -->\r?\n([^\r\n]*)\r?\n<!-- tfx-adaptive:end -->/gu;

function cloneRule(rule) {
  return Object.freeze({ ...rule });
}

function clampConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(1, Math.max(0, numeric));
}

function normalizeOccurrences(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.max(1, Math.trunc(numeric));
}

function formatConfidence(value) {
  return Number(clampConfidence(value).toFixed(6)).toString();
}

function normalizeDate(value, fallback) {
  const text = String(value ?? fallback ?? '').trim();
  return text || fallback;
}

function normalizeRuleInput(rule, fallback = {}) {
  if (!rule || typeof rule !== 'object') return null;

  const id = String(rule.id ?? rule.rule_id ?? fallback.id ?? '').trim();
  const text = String(rule.rule ?? rule.text ?? fallback.rule ?? '').trim();
  const firstSeen = normalizeDate(
    rule.firstSeen ?? rule.first_seen,
    fallback.firstSeen ?? fallback.lastSeen ?? '1970-01-01',
  );
  const lastSeen = normalizeDate(rule.lastSeen ?? rule.last_seen, fallback.lastSeen ?? firstSeen);
  if (!id || !text || /["\r\n]/u.test(id) || /[\r\n]/u.test(text)) {
    return null;
  }

  return cloneRule({
    id,
    rule: text,
    confidence: clampConfidence(rule.confidence ?? fallback.confidence),
    occurrences: normalizeOccurrences(rule.occurrences ?? fallback.occurrences),
    firstSeen,
    lastSeen,
  });
}

function trimLeadingBlankLines(text) {
  return String(text ?? '').replace(/^(?:[ \t]*\r?\n)+/u, '');
}

function trimTrailingBlankLines(text) {
  return String(text ?? '').replace(/(?:\r?\n[ \t]*)+$/u, '');
}

function parseInjectedRules(sectionBody = '') {
  const matches = Array.from(String(sectionBody).matchAll(BLOCK_RE));
  return matches.map(([, id, confidence, occurrences, firstSeen, lastSeen, text]) => cloneRule({
    id,
    rule: text,
    confidence: clampConfidence(confidence),
    occurrences: normalizeOccurrences(occurrences),
    firstSeen,
    lastSeen,
  }));
}

function readDocument(claudeMdPath) {
  const raw = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, 'utf8') : '';
  const sectionStart = raw.search(SECTION_RE);
  if (sectionStart === -1) {
    return { before: raw, after: '', rules: [] };
  }

  const headingEnd = raw.indexOf('\n', sectionStart);
  const bodyStart = headingEnd === -1 ? raw.length : headingEnd + 1;
  const rest = raw.slice(bodyStart);
  const nextHeadingOffset = rest.search(/^#{1,6}\s/mu);
  const sectionEnd = nextHeadingOffset === -1 ? raw.length : bodyStart + nextHeadingOffset;
  const body = raw.slice(bodyStart, sectionEnd);

  return {
    before: raw.slice(0, sectionStart),
    after: raw.slice(sectionEnd),
    rules: parseInjectedRules(body),
  };
}

function serializeRule(rule) {
  return [
    `<!-- tfx-adaptive:start rule_id="${rule.id}" confidence=${formatConfidence(rule.confidence)} occurrences=${rule.occurrences} first_seen=${rule.firstSeen} last_seen=${rule.lastSeen} -->`,
    rule.rule,
    '<!-- tfx-adaptive:end -->',
  ].join('\n');
}

function serializeDocument(before, rules, after) {
  const section = rules.length > 0
    ? `${SECTION_HEADING}\n\n${rules.map(serializeRule).join('\n\n')}`
    : '';
  const parts = [trimTrailingBlankLines(before), section, trimLeadingBlankLines(after)].filter(Boolean);
  return parts.length > 0 ? `${parts.join('\n\n')}\n` : '';
}

function enforceMaxRules(rules, maxRules) {
  if (rules.length <= maxRules) return rules.map(cloneRule);
  const ranked = rules
    .map((rule, index) => ({ ...rule, index }))
    .sort((left, right) => (
      left.confidence - right.confidence
      || left.occurrences - right.occurrences
      || left.lastSeen.localeCompare(right.lastSeen)
      || left.index - right.index
      || left.id.localeCompare(right.id)
    ));
  const removedIds = new Set(ranked.slice(0, rules.length - maxRules).map((rule) => rule.id));
  return rules.filter((rule) => !removedIds.has(rule.id)).map(cloneRule);
}

export function createAdaptiveInjector(opts = {}) {
  const claudeMdPath = resolve(opts.claudeMdPath ?? join(process.cwd(), 'CLAUDE.md'));
  const maxRules = Number.isInteger(opts.maxRules) && opts.maxRules > 0 ? opts.maxRules : DEFAULT_MAX_RULES;

  function listInjected() {
    return readDocument(claudeMdPath).rules.map(cloneRule);
  }

  function inject(rule) {
    const document = readDocument(claudeMdPath);
    const targetId = String(rule?.id ?? rule?.rule_id ?? '').trim();
    const existing = document.rules.find((item) => item.id === targetId);
    const normalized = normalizeRuleInput(rule, existing ?? {});
    if (!normalized) return false;

    const nextRules = existing
      ? document.rules.map((item) => (item.id === normalized.id
        ? cloneRule({
          ...item,
          confidence: normalized.confidence,
          occurrences: normalized.occurrences,
          lastSeen: normalized.lastSeen,
        })
        : cloneRule(item)))
      : [...document.rules.map(cloneRule), normalized];
    const limitedRules = enforceMaxRules(nextRules, maxRules);
    writeFileSync(claudeMdPath, serializeDocument(document.before, limitedRules, document.after), 'utf8');
    return limitedRules.some((item) => item.id === normalized.id);
  }

  function remove(ruleId) {
    const targetId = String(ruleId ?? '').trim();
    if (!targetId || !existsSync(claudeMdPath)) return false;
    const document = readDocument(claudeMdPath);
    if (!document.rules.some((rule) => rule.id === targetId)) return false;
    const nextRules = document.rules.filter((rule) => rule.id !== targetId).map(cloneRule);
    writeFileSync(claudeMdPath, serializeDocument(document.before, nextRules, document.after), 'utf8');
    return true;
  }

  function cleanup(activeRuleIds = []) {
    const activeIds = new Set(Array.isArray(activeRuleIds) ? activeRuleIds : Array.from(activeRuleIds));
    return listInjected().reduce(
      (count, rule) => count + (activeIds.has(rule.id) ? 0 : Number(remove(rule.id))),
      0,
    );
  }

  return Object.freeze({
    inject,
    remove,
    listInjected,
    cleanup,
  });
}

export default createAdaptiveInjector;
