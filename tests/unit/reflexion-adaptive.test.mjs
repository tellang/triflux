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
    // active: confidence > 0.5
    store.addAdaptiveRule({
      project_slug: "project-active",
      pattern: "err_module_not_found",
      confidence: 0.8,
      hit_count: 5,
      last_seen_ms: Date.now(),
    });
    // inactive: confidence <= 0.5
    store.addAdaptiveRule({
      project_slug: "project-active",
      pattern: "modulenotfounderror",
      confidence: 0.4,
      hit_count: 1,
      last_seen_ms: Date.now(),
    });
    // different project
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
});
