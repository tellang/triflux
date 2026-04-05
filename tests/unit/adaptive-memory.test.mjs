import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createAdaptiveMemory } from '../../hub/adaptive-memory.mjs';

const BASE_RULE = {
  id: 'codex-sandbox-flag',
  pattern: 'cannot be used multiple times',
  rootCause: 'config.toml sandbox와 CLI 플래그가 중복된다',
  rule: 'config.toml에 sandbox가 있으면 --full-auto를 제거한다',
  confidence: 0.9,
  dnaFactor: 'cli.codex.config.sandbox',
};

describe('adaptive-memory', () => {
  let globalDir;
  let sessionDir;
  let tempRoot;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'adaptive-memory-test-'));
    globalDir = join(tempRoot, 'global');
    sessionDir = join(tempRoot, 'session');
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function createMemory() {
    return createAdaptiveMemory({
      projectSlug: 'alpha-project',
      globalDir,
      sessionDir,
    });
  }

  function recordInSession(sessionId, rule = BASE_RULE) {
    const memory = createMemory();
    memory.decay(sessionId);
    return { memory, result: memory.record(rule) };
  }

  it('기본 규칙을 Tier 1 세션 메모리에 기록한다', () => {
    const { memory, result } = recordInSession('session-1');
    const [rule] = memory.getTier(1);
    const sessionFile = join(sessionDir, 'adaptive-session.json');

    assert.equal(result.promoted, false);
    assert.equal(rule.id, BASE_RULE.id);
    assert.equal(rule.tier, 1);
    assert.equal(rule.occurrences, 1);
    assert.equal(rule.sessionsWithout, 0);
    assert.equal(rule.dnaFactor, BASE_RULE.dnaFactor);
    assert.ok(existsSync(sessionFile));

    const stored = JSON.parse(readFileSync(sessionFile, 'utf8'));
    assert.equal(stored.sessionId, 'session-1');
    assert.equal(stored.rules.length, 1);
  });

  it('같은 패턴이 두 세션에서 반복되면 Tier 2로 승격한다', () => {
    recordInSession('session-1');
    const { memory, result } = recordInSession('session-2');
    const [tier2Rule] = memory.getTier(2);

    assert.equal(result.promoted, true);
    assert.equal(result.fromTier, 1);
    assert.equal(result.toTier, 2);
    assert.equal(memory.getTier(1).length, 0);
    assert.equal(tier2Rule.id, BASE_RULE.id);
    assert.equal(tier2Rule.tier, 2);
    assert.equal(tier2Rule.occurrences, 2);
    assert.equal(tier2Rule.confidence, 0.9);
  });

  it('Tier 2 규칙이 3회 이상이고 confidence가 높으면 Tier 3로 승격한다', () => {
    recordInSession('session-1');
    recordInSession('session-2');
    const { memory, result } = recordInSession('session-3');
    const [tier3Rule] = memory.getTier(3);

    assert.equal(result.promoted, true);
    assert.equal(result.fromTier, 2);
    assert.equal(result.toTier, 3);
    assert.equal(memory.getTier(2).length, 0);
    assert.equal(tier3Rule.id, BASE_RULE.id);
    assert.equal(tier3Rule.tier, 3);
    assert.equal(tier3Rule.occurrences, 3);
  });

  it('Tier 2 규칙은 5세션 연속 미발생 시 confidence가 감소하고 바닥 아래면 제거된다', () => {
    const seedRule = { ...BASE_RULE, confidence: 0.6 };
    recordInSession('session-1', seedRule);
    recordInSession('session-2', seedRule);

    let memory = createMemory();
    for (const sessionId of ['session-3', 'session-4', 'session-5', 'session-6', 'session-7']) {
      memory = createMemory();
      memory.decay(sessionId);
    }

    let [tier2Rule] = memory.getTier(2);
    assert.equal(tier2Rule.confidence, 0.4);
    assert.equal(tier2Rule.sessionsWithout, 5);

    for (const sessionId of ['session-8', 'session-9', 'session-10', 'session-11', 'session-12']) {
      memory = createMemory();
      memory.decay(sessionId);
    }

    assert.equal(memory.getRule(BASE_RULE.id), null);
    assert.equal(memory.getTier(2).length, 0);
  });

  it('Tier 3 규칙은 10세션에 경고하고 20세션 미발생 시 제거한다', () => {
    recordInSession('session-1');
    recordInSession('session-2');
    recordInSession('session-3');

    let warningSummary = null;
    let memory = createMemory();
    for (let index = 4; index <= 13; index += 1) {
      memory = createMemory();
      warningSummary = memory.decay(`session-${index}`);
    }

    assert.ok(warningSummary.warned.includes(BASE_RULE.id));
    assert.equal(memory.getTier(3)[0].sessionsWithout, 10);

    let removalSummary = null;
    for (let index = 14; index <= 23; index += 1) {
      memory = createMemory();
      removalSummary = memory.decay(`session-${index}`);
    }

    assert.ok(removalSummary.removed.includes(BASE_RULE.id));
    assert.equal(memory.getTier(3).length, 0);
    assert.equal(memory.getRule(BASE_RULE.id), null);
  });
});
