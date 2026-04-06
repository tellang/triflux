import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  adaptiveRuleFromError,
  decayRules,
  getActiveAdaptiveRules,
  learnFromError,
  promoteRule,
} from "../../hub/reflexion.mjs";
import { createStore } from "../../hub/store.mjs";
import { createStoreAdapter } from "../../hub/store-adapter.mjs";

describe("reflexion adaptive rules", () => {
  let store;
  let tmpDir;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reflexion-adaptive-test-"));
    store = await createStoreAdapter(join(tmpDir, "adaptive.db"));
  });

  afterEach(() => {
    if (store.close) store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("builds adaptive rule payloads from PostToolUseFailure context", () => {
    const rule = adaptiveRuleFromError({
      projectSlug: "alpha",
      sessionId: "session-1",
      sessionCount: 1,
      tool_name: "exec_command",
      tool_input: { command: "npm test" },
      error: "ENOENT: no such file or directory, open /tmp/missing.txt",
    });

    assert.ok(rule);
    assert.equal(rule.type, "adaptive");
    assert.equal(rule.context.project_slug, "alpha");
    assert.equal(rule.adaptive_state.project_slug, "alpha");
    assert.equal(rule.adaptive_state.session_occurrences, 1);
    assert.deepEqual(rule.adaptive_state.session_ids, ["session-1"]);
    assert.match(rule.error_pattern, /enoent/);
    assert.match(rule.solution, /npm test/);
  });

  it("keeps reflexion learning backward compatible when adaptive rules coexist", () => {
    // learnFromError는 reflexion_entries 테이블 사용 (@deprecated)
    // addAdaptiveRule은 adaptive_rules 테이블 사용
    // 두 시스템이 독립적으로 공존 가능한지 검증
    const error =
      "TypeError: Cannot read properties of undefined at /tmp/example.js:10:2";

    const adaptiveRule = adaptiveRuleFromError({
      projectSlug: "alpha",
      sessionId: "adaptive-session",
      sessionCount: 1,
      tool_name: "exec_command",
      error,
    });
    const added = store.addAdaptiveRule({
      project_slug: "alpha",
      pattern: adaptiveRule.error_pattern,
      confidence: 0.9,
      hit_count: 1,
      last_seen_ms: Date.now(),
    });

    // reflexion_entries에 별도 저장 (learnFromError는 reflexion_entries 사용)
    const reflexion = learnFromError(store, {
      error,
      solution: "Guard before property access",
    });

    assert.ok(added);
    assert.ok(reflexion);
    // 다른 테이블이므로 ID가 다름
    assert.notEqual(reflexion.id, `${added.project_slug}:${added.pattern}`);
  });

  it("promotes adaptive rules after the same pattern appears", () => {
    // adaptive_rules 테이블에 규칙 추가
    const rule = adaptiveRuleFromError({
      projectSlug: "alpha",
      sessionId: "session-1",
      sessionCount: 1,
      tool_name: "exec_command",
      error: "ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:3000",
    });
    store.addAdaptiveRule({
      project_slug: "alpha",
      pattern: rule.error_pattern,
      confidence: 0.5,
      hit_count: 1,
      last_seen_ms: Date.now(),
    });

    // promoteRule: projectSlug + pattern 기반
    const promoted = promoteRule(store, "alpha", rule.error_pattern);

    assert.ok(promoted);
    assert.equal(promoted.hit_count, 2); // +1
    assert.ok(promoted.confidence > 0.5); // promoted
  });

  it("decays stale adaptive rules and deletes entries below the confidence floor", () => {
    const oldTime = Date.now() - (10 * 24 * 3600 * 1000); // 10일 전

    // survivor: confidence 높음
    store.addAdaptiveRule({
      project_slug: "alpha",
      pattern: "timeouterror_command_timed_out",
      confidence: 0.75,
      hit_count: 3,
      last_seen_ms: oldTime,
      created_ms: oldTime,
    });

    // removable: confidence 낮음 → decay 후 삭제
    store.addAdaptiveRule({
      project_slug: "alpha",
      pattern: "eacces_permission_denied",
      confidence: 0.35,
      hit_count: 1,
      last_seen_ms: oldTime,
      created_ms: oldTime,
    });

    const result = decayRules(store, 6);

    // removable은 0.35 - 0.1 = 0.25 < 0.3 → 삭제
    assert.ok(result.deleted.length >= 1);
    assert.ok(result.deleted.some(id => id.includes("eacces")));
    // survivor는 0.75 - 0.1 = 0.65 → 생존
    const survivorRule = store.findAdaptiveRule("alpha", "timeouterror_command_timed_out");
    assert.ok(survivorRule);
    assert.ok(survivorRule.confidence < 0.75); // decayed
  });

  it("returns only active adaptive rules for a project slug", () => {
    store.addAdaptiveRule({
      project_slug: "project-active",
      pattern: "err_module_not_found",
      confidence: 0.8,
      hit_count: 5,
      last_seen_ms: Date.now(),
    });
    store.addAdaptiveRule({
      project_slug: "project-active",
      pattern: "modulenotfounderror",
      confidence: 0.4,
      hit_count: 1,
      last_seen_ms: Date.now(),
    });
    store.addAdaptiveRule({
      project_slug: "project-other",
      pattern: "fatal_not_a_git_repository",
      confidence: 0.9,
      hit_count: 10,
      last_seen_ms: Date.now(),
    });

    const rules = getActiveAdaptiveRules(store, "project-active");

    assert.equal(rules.length, 1);
    assert.equal(rules[0].pattern, "err_module_not_found");
    assert.equal(rules[0].confidence, 0.8);
  });

  it("includes rules at default confidence (0.5) in active results", () => {
    store.addAdaptiveRule({
      project_slug: "alpha",
      pattern: "default_confidence_rule",
      confidence: 0.5,
      hit_count: 1,
      last_seen_ms: Date.now(),
    });

    const rules = getActiveAdaptiveRules(store, "alpha");
    assert.equal(rules.length, 1);
    assert.equal(rules[0].confidence, 0.5);
  });

  it("promoteRule returns null for non-existing rule", () => {
    const result = promoteRule(store, "nonexistent", "missing_pattern");
    assert.equal(result, null);
  });

  it("decayRules does not inflate hit_count", () => {
    const oldTime = Date.now() - (10 * 24 * 3600 * 1000);
    store.addAdaptiveRule({
      project_slug: "alpha",
      pattern: "no_inflate_test",
      confidence: 0.7,
      hit_count: 3,
      last_seen_ms: oldTime,
      created_ms: oldTime,
    });

    decayRules(store, 1);

    const rule = store.findAdaptiveRule("alpha", "no_inflate_test");
    assert.ok(rule);
    assert.equal(rule.hit_count, 3); // unchanged, not 4
    assert.ok(rule.confidence < 0.7); // decayed
  });

  it("decayRules skips rules younger than 7 days", () => {
    const recentTime = Date.now() - (3 * 24 * 3600 * 1000); // 3일 전
    store.addAdaptiveRule({
      project_slug: "alpha",
      pattern: "recent_rule",
      confidence: 0.6,
      hit_count: 1,
      last_seen_ms: recentTime,
      created_ms: recentTime,
    });

    const result = decayRules(store, 1);

    assert.equal(result.updated.length, 0);
    assert.equal(result.deleted.length, 0);
    const rule = store.findAdaptiveRule("alpha", "recent_rule");
    assert.equal(rule.confidence, 0.6); // unchanged
  });

  it("decayRules filters by projectSlug when provided", () => {
    const oldTime = Date.now() - (10 * 24 * 3600 * 1000);
    store.addAdaptiveRule({ project_slug: "alpha", pattern: "p1", confidence: 0.7, hit_count: 1, last_seen_ms: oldTime, created_ms: oldTime });
    store.addAdaptiveRule({ project_slug: "beta", pattern: "p2", confidence: 0.7, hit_count: 1, last_seen_ms: oldTime, created_ms: oldTime });

    const result = decayRules(store, 1, "alpha");

    // alpha만 decay됨
    assert.equal(result.updated.length, 1);
    const betaRule = store.findAdaptiveRule("beta", "p2");
    assert.equal(betaRule.confidence, 0.7); // beta는 건드리지 않음
  });

  it("listAdaptiveRules returns all rules without projectSlug", () => {
    store.addAdaptiveRule({ project_slug: "a", pattern: "p1", confidence: 0.8, hit_count: 1, last_seen_ms: Date.now() });
    store.addAdaptiveRule({ project_slug: "b", pattern: "p2", confidence: 0.6, hit_count: 1, last_seen_ms: Date.now() });

    const all = store.listAdaptiveRules();
    assert.equal(all.length, 2);
  });

  it("listAdaptiveRules filters by projectSlug", () => {
    store.addAdaptiveRule({ project_slug: "a", pattern: "p1", confidence: 0.8, hit_count: 1, last_seen_ms: Date.now() });
    store.addAdaptiveRule({ project_slug: "b", pattern: "p2", confidence: 0.6, hit_count: 1, last_seen_ms: Date.now() });

    const filtered = store.listAdaptiveRules("a");
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].project_slug, "a");
  });

  it("deleteAdaptiveRule returns false for non-existing rule", () => {
    const result = store.deleteAdaptiveRule("nonexistent", "missing");
    assert.equal(result, false);
  });

  it("schema v2 stores solution and error_message", () => {
    const added = store.addAdaptiveRule({
      project_slug: "alpha",
      pattern: "schema_v2_test",
      confidence: 0.5,
      hit_count: 1,
      last_seen_ms: Date.now(),
      error_message: "connection refused",
      solution: "check if server is running",
      context: '{"tool":"exec"}',
    });

    assert.ok(added);
    const found = store.findAdaptiveRule("alpha", "schema_v2_test");
    assert.equal(found.error_message, "connection refused");
    assert.equal(found.solution, "check if server is running");
    assert.equal(found.context, '{"tool":"exec"}');
  });
});

describe("reflexion adaptive rules — memory-store fallback", () => {
  let store;

  beforeEach(async () => {
    // SQLite 없이 인메모리 스토어로 생성
    store = await createStoreAdapter("/nonexistent/path.db", {
      loadDatabase: async () => { throw new Error("SQLite unavailable"); },
    });
  });

  it("memory-store supports listAdaptiveRules", () => {
    store.addAdaptiveRule({ project_slug: "mem", pattern: "p1", confidence: 0.8, hit_count: 1, last_seen_ms: Date.now() });
    store.addAdaptiveRule({ project_slug: "mem", pattern: "p2", confidence: 0.6, hit_count: 1, last_seen_ms: Date.now() });

    const all = store.listAdaptiveRules();
    assert.equal(all.length, 2);

    const filtered = store.listAdaptiveRules("mem");
    assert.equal(filtered.length, 2);
  });

  it("memory-store supports deleteAdaptiveRule", () => {
    store.addAdaptiveRule({ project_slug: "mem", pattern: "deleteme", confidence: 0.5, hit_count: 1, last_seen_ms: Date.now() });
    assert.ok(store.findAdaptiveRule("mem", "deleteme"));

    const deleted = store.deleteAdaptiveRule("mem", "deleteme");
    assert.equal(deleted, true);
    assert.equal(store.findAdaptiveRule("mem", "deleteme"), null);
  });

  it("decayRules works with memory-store fallback", () => {
    const oldTime = Date.now() - (10 * 24 * 3600 * 1000);
    store.addAdaptiveRule({ project_slug: "mem", pattern: "stale", confidence: 0.35, hit_count: 1, last_seen_ms: oldTime, created_ms: oldTime });

    const result = decayRules(store, 1);

    assert.ok(result.deleted.length >= 1);
  });

  it("getActiveAdaptiveRules works with memory-store fallback", () => {
    store.addAdaptiveRule({ project_slug: "mem", pattern: "active_rule", confidence: 0.7, hit_count: 1, last_seen_ms: Date.now() });

    const rules = getActiveAdaptiveRules(store, "mem");
    assert.equal(rules.length, 1);
  });
});
