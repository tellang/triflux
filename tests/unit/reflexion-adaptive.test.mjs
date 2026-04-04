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

describe("reflexion adaptive rules", () => {
  let store;
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "reflexion-adaptive-test-"));
    store = createStore(join(tmpDir, "adaptive.db"));
  });

  afterEach(() => {
    store.close();
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
    const error =
      "TypeError: Cannot read properties of undefined at /tmp/example.js:10:2";
    const adaptive = store.addReflexion({
      ...adaptiveRuleFromError({
        projectSlug: "alpha",
        sessionId: "adaptive-session",
        sessionCount: 1,
        tool_name: "exec_command",
        error,
      }),
      confidence: 0.9,
    });

    const reflexion = learnFromError(store, {
      error,
      solution: "Guard before property access",
    });
    const updated = learnFromError(store, {
      error,
      solution: "Guard before property access",
      success: true,
    });

    assert.notEqual(reflexion.id, adaptive.id);
    assert.equal(updated.id, reflexion.id);
    assert.equal(updated.type, "reflexion");
    assert.equal(store.getReflexion(adaptive.id).type, "adaptive");
  });

  it("promotes adaptive rules after the same pattern appears in a second session", () => {
    const created = store.addReflexion(
      adaptiveRuleFromError({
        projectSlug: "alpha",
        sessionId: "session-1",
        sessionCount: 1,
        tool_name: "exec_command",
        error: "ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:3000",
      }),
    );

    const promoted = promoteRule(store, created.id, {
      projectSlug: "alpha",
      sessionId: "session-2",
      sessionCount: 2,
    });

    assert.ok(promoted);
    assert.equal(promoted.hit_count, 2);
    assert.equal(promoted.adaptive_state.session_occurrences, 2);
    assert.deepEqual(promoted.adaptive_state.session_ids, [
      "session-1",
      "session-2",
    ]);
    assert.equal(promoted.confidence, 0.6);
  });

  it("decays stale adaptive rules and deletes entries below the confidence floor", () => {
    const survivor = store.addReflexion({
      ...adaptiveRuleFromError({
        projectSlug: "alpha",
        sessionId: "session-1",
        sessionCount: 1,
        tool_name: "exec_command",
        error: "TimeoutError: command timed out",
      }),
      confidence: 0.75,
    });
    const removable = store.addReflexion({
      ...adaptiveRuleFromError({
        projectSlug: "alpha",
        sessionId: "session-1",
        sessionCount: 1,
        tool_name: "exec_command",
        error: "EACCES: permission denied",
      }),
      confidence: 0.35,
    });

    const result = decayRules(store, 6);

    assert.equal(result.updated.length, 1);
    assert.deepEqual(result.deleted, [removable.id]);
    assert.equal(store.getReflexion(removable.id), null);
    assert.equal(store.getReflexion(survivor.id).confidence, 0.65);
  });

  it("returns only active adaptive rules for a project slug", () => {
    const active = store.addReflexion({
      ...adaptiveRuleFromError({
        projectSlug: "project-active",
        sessionId: "session-a",
        sessionCount: 1,
        tool_name: "exec_command",
        error: "ERR_MODULE_NOT_FOUND: missing package",
      }),
      confidence: 0.8,
    });
    store.addReflexion({
      ...adaptiveRuleFromError({
        projectSlug: "project-active",
        sessionId: "session-b",
        sessionCount: 1,
        tool_name: "exec_command",
        error: "ModuleNotFoundError: missing python package",
      }),
      confidence: 0.4,
    });
    store.addReflexion({
      ...adaptiveRuleFromError({
        projectSlug: "project-other",
        sessionId: "session-c",
        sessionCount: 1,
        tool_name: "exec_command",
        error: "fatal: not a git repository",
      }),
      confidence: 0.9,
    });

    const rules = getActiveAdaptiveRules(store, "project-active");

    assert.equal(rules.length, 1);
    assert.equal(rules[0].id, active.id);
    assert.equal(rules[0].type, "adaptive");
  });
});
