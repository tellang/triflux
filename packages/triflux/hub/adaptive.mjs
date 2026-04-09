import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDiagnosticPipeline } from "./adaptive-diagnostic.mjs";
import { createAdaptiveInjector } from "./adaptive-inject.mjs";
import { createAdaptiveMemory } from "./adaptive-memory.mjs";
import { createAdaptiveFingerprintService } from "./session-fingerprint.mjs";

let singletonEngine = null;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function toRuleList(value) {
  return Array.isArray(value) ? value : [];
}

function resolveTierCount(memory, tier) {
  if (typeof memory.getTier === "function") {
    const rules = memory.getTier(tier);
    return Array.isArray(rules) ? rules.length : 0;
  }
  return toRuleList(memory.getAllRules?.()).filter(
    (rule) => Number(rule?.tier) === tier,
  ).length;
}

function resolveActiveRuleIds(memory, decayResult) {
  if (Array.isArray(decayResult?.activeRuleIds))
    return [...decayResult.activeRuleIds];
  return toRuleList(memory.getAllRules?.())
    .map((rule) => rule.id)
    .filter(Boolean);
}

function resolveRecordedRule(recordResult) {
  if (recordResult?.rule)
    return {
      rule: recordResult.rule,
      promoted: Boolean(recordResult.promoted),
    };
  return { rule: recordResult || null, promoted: false };
}

function createEngineInstance(opts = {}) {
  const repoRoot = opts.repoRoot || process.cwd();
  const claudeMdPath = opts.claudeMdPath || join(repoRoot, "CLAUDE.md");
  const projectSlug = String(opts.projectSlug || "default").trim() || "default";
  const now = opts.now || (() => Date.now());
  const sessionIdFactory = opts.sessionIdFactory || (() => randomUUID());

  const memory =
    opts.memory ||
    opts.memoryFactory?.(opts) ||
    createAdaptiveMemory({ projectSlug, ...opts.memoryOptions });
  const diagnostic =
    opts.diagnostic ||
    opts.diagnosticFactory?.(opts) ||
    createDiagnosticPipeline(opts.diagnosticOptions);
  const injector =
    opts.injector ||
    opts.injectorFactory?.(opts) ||
    createAdaptiveInjector({ claudeMdPath, ...opts.injectorOptions });
  const fingerprintService =
    opts.fingerprintService ||
    opts.fingerprintFactory?.(opts) ||
    createAdaptiveFingerprintService(opts.fingerprintOptions);

  let started = false;
  let currentSessionId = null;
  let lastFingerprintId = null;
  const counters = {
    totalErrors: 0,
    diagnosedErrors: 0,
  };

  function refreshFingerprint() {
    if (typeof fingerprintService.computeFingerprint !== "function") return;
    const fingerprint = fingerprintService.computeFingerprint({
      scope: projectSlug,
      cwd: repoRoot,
      filePath: claudeMdPath,
      workType: "adaptive",
      timestamp: now(),
    });
    lastFingerprintId = fingerprint?.fingerprint_id || lastFingerprintId;
  }

  function startSession() {
    if (started) return;
    currentSessionId = sessionIdFactory();
    const decayResult =
      typeof memory.decay === "function"
        ? memory.decay(currentSessionId)
        : null;
    injector.cleanup?.(resolveActiveRuleIds(memory, decayResult));
    refreshFingerprint();
    started = true;
  }

  function handleError(errorContext = {}) {
    if (!started) startSession();
    counters.totalErrors += 1;

    const diagnosis = diagnostic.diagnose({
      ...errorContext,
      projectSlug,
      sessionId: currentSessionId,
    });
    if (!diagnosis?.matched || !diagnosis.rule) {
      return Object.freeze({ diagnosed: false, rule: null, promoted: false });
    }

    counters.diagnosedErrors += 1;
    const { rule: recordedRule, promoted } = resolveRecordedRule(
      memory.record({
        ...diagnosis.rule,
        confidence: diagnosis.confidence,
        dnaFactor: diagnosis.dnaFactor,
        sessionId: currentSessionId,
        lastSeen: new Date(now()).toISOString().slice(0, 10),
      }),
    );

    const nextRule = clone(recordedRule || diagnosis.rule);
    if (nextRule?.tier >= 3 && promoted) {
      injector.inject?.(nextRule);
    }

    return Object.freeze({
      diagnosed: true,
      rule: nextRule,
      promoted: Boolean(promoted),
    });
  }

  function endSession() {
    if (!started) return;
    memory.reset?.({ tier: 1, sessionId: currentSessionId });
    started = false;
    currentSessionId = null;
  }

  function getStats() {
    return Object.freeze({
      tier1Count: resolveTierCount(memory, 1),
      tier2Count: resolveTierCount(memory, 2),
      tier3Count: resolveTierCount(memory, 3),
      totalErrors: counters.totalErrors,
    });
  }

  return Object.freeze({
    handleError,
    startSession,
    endSession,
    getStats,
    __lastFingerprintId: () => lastFingerprintId,
  });
}

export function createAdaptiveEngine(opts = {}) {
  if (singletonEngine) return singletonEngine;
  singletonEngine = createEngineInstance(opts);
  return singletonEngine;
}

export function __resetAdaptiveEngineForTests() {
  singletonEngine = null;
}

export default createAdaptiveEngine;
