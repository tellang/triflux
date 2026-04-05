import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  __resetAdaptiveEngineForTests,
  createAdaptiveEngine,
} from '../../hub/adaptive.mjs';

afterEach(() => {
  __resetAdaptiveEngineForTests();
});

function createMockMemory() {
  const rules = new Map();
  return {
    decayCalls: [],
    resetCalls: [],
    recordCalls: [],
    decay(sessionId) {
      this.decayCalls.push(sessionId);
      return { activeRuleIds: [...rules.keys()] };
    },
    record(rule) {
      this.recordCalls.push(rule);
      rules.set(rule.id, structuredClone(rule));
      return { rule: structuredClone(rule), promoted: rule.tier >= 3 };
    },
    reset(scope) {
      this.resetCalls.push(scope);
      if (Number(scope?.tier) === 1) {
        for (const [id, rule] of rules.entries()) {
          if (rule.tier === 1) rules.delete(id);
        }
      }
    },
    getTier(tier) {
      return [...rules.values()].filter((rule) => rule.tier === tier).map((rule) => structuredClone(rule));
    },
    getAllRules() {
      return [...rules.values()].map((rule) => structuredClone(rule));
    },
  };
}

describe('hub/adaptive.mjs', () => {
  it('세션 시작 시 decay/cleanup/fingerprint를 1회만 실행한다', () => {
    const memory = createMockMemory();
    const cleanupCalls = [];
    const computeCalls = [];
    const engine = createAdaptiveEngine({
      projectSlug: 'alpha',
      memory,
      diagnostic: { diagnose: () => ({ matched: false, rule: null, confidence: 0, dnaFactor: null }) },
      injector: { cleanup: (ids) => cleanupCalls.push(ids), inject: () => false },
      fingerprintService: {
        computeFingerprint(context) {
          computeCalls.push(context);
          return { fingerprint_id: 'fp-1' };
        },
      },
      sessionIdFactory: () => 'session-a',
    });

    engine.startSession();
    engine.startSession();

    assert.deepEqual(memory.decayCalls, ['session-a']);
    assert.deepEqual(cleanupCalls, [[]]);
    assert.equal(computeCalls.length, 1);
  });

  it('진단 성공 시 memory.record를 호출하고 Tier 3 승격만 주입한다', () => {
    const memory = createMockMemory();
    const injectCalls = [];
    const engine = createAdaptiveEngine({
      projectSlug: 'alpha',
      memory,
      diagnostic: {
        diagnose(errorContext) {
          if (errorContext.stderr.includes('miss')) {
            return { matched: false, rule: null, confidence: 0, dnaFactor: null };
          }
          return {
            matched: true,
            confidence: 0.91,
            dnaFactor: 'cli.codex.config.sandbox',
            rule: {
              id: 'codex-sandbox-flag',
              pattern: 'cannot be used multiple times',
              rootCause: 'duplicate sandbox flag',
              rule: 'Do not pass --full-auto when sandbox is configured.',
              confidence: 0.91,
              occurrences: 3,
              firstSeen: '2026-04-01',
              lastSeen: '2026-04-04',
              sessionsWithout: 0,
              tier: 3,
            },
          };
        },
      },
      injector: {
        cleanup: () => 0,
        inject(rule) {
          injectCalls.push(rule);
          return true;
        },
      },
      fingerprintService: { computeFingerprint: () => ({ fingerprint_id: 'fp-1' }) },
      sessionIdFactory: () => 'session-b',
    });

    const miss = engine.handleError({ stderr: 'miss', tool: 'Bash', command: 'npm test' });
    const hit = engine.handleError({ stderr: 'cannot be used multiple times', tool: 'Bash', command: 'codex exec' });

    assert.deepEqual(miss, { diagnosed: false, rule: null, promoted: false });
    assert.equal(memory.recordCalls.length, 1);
    assert.equal(hit.diagnosed, true);
    assert.equal(hit.rule.id, 'codex-sandbox-flag');
    assert.equal(hit.promoted, true);
    assert.equal(injectCalls.length, 1);
  });

  it('통계와 endSession Tier1 정리를 제공한다', () => {
    const memory = createMockMemory();
    memory.record({
      id: 'tier1-rule',
      pattern: 'short-lived',
      rootCause: 'transient',
      rule: 'short term rule',
      confidence: 0.4,
      occurrences: 1,
      firstSeen: '2026-04-01',
      lastSeen: '2026-04-01',
      sessionsWithout: 0,
      tier: 1,
    });
    memory.record({
      id: 'tier2-rule',
      pattern: 'project-rule',
      rootCause: 'repeat',
      rule: 'mid term rule',
      confidence: 0.7,
      occurrences: 2,
      firstSeen: '2026-04-01',
      lastSeen: '2026-04-04',
      sessionsWithout: 0,
      tier: 2,
    });

    const engine = createAdaptiveEngine({
      projectSlug: 'alpha',
      memory,
      diagnostic: { diagnose: () => ({ matched: false, rule: null, confidence: 0, dnaFactor: null }) },
      injector: { cleanup: () => 0, inject: () => false },
      fingerprintService: { computeFingerprint: () => ({ fingerprint_id: 'fp-1' }) },
      sessionIdFactory: () => 'session-c',
    });

    engine.handleError({ stderr: 'miss', tool: 'Bash', command: 'npm test' });
    assert.deepEqual(engine.getStats(), {
      tier1Count: 1,
      tier2Count: 1,
      tier3Count: 0,
      totalErrors: 1,
    });

    engine.endSession();

    assert.equal(memory.getTier(1).length, 0);
    assert.equal(memory.resetCalls.length, 1);
  });

  it('프로세스당 singleton 인스턴스를 유지한다', () => {
    const first = createAdaptiveEngine({
      projectSlug: 'alpha',
      memory: createMockMemory(),
      diagnostic: { diagnose: () => ({ matched: false, rule: null, confidence: 0, dnaFactor: null }) },
      injector: { cleanup: () => 0, inject: () => false },
      fingerprintService: { computeFingerprint: () => ({ fingerprint_id: 'fp-1' }) },
    });
    const second = createAdaptiveEngine({ projectSlug: 'beta' });

    assert.equal(first, second);
  });
});
