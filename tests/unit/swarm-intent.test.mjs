// tests/unit/swarm-intent.test.mjs — X-Intent 생성/파싱/분류 유닛 테스트

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildIntentFromLLMResponse,
  classifyIntentPair,
  formatIntentTrailer,
  generateIntentPrompt,
  parseIntentTrailer,
} from "../../hub/team/swarm-intent.mjs";

describe("swarm-intent", () => {
  it("generateIntentPrompt returns system and user prompts", () => {
    const prompt = generateIntentPrompt(
      ["middleware/auth.mjs"],
      "diff --git a/middleware/auth.mjs b/middleware/auth.mjs\n+add rate limit",
      "harden auth rate limiting",
    );
    assert.equal(typeof prompt.systemPrompt, "string");
    assert.equal(typeof prompt.userPrompt, "string");
    assert.ok(prompt.systemPrompt.length > 0);
    assert.ok(prompt.userPrompt.includes("middleware/auth.mjs"));
  });

  it("formatIntentTrailer round-trips with parseIntentTrailer", () => {
    const intent = {
      scope: "auth",
      action: "harden",
      reason: "rate-limit bypass",
      touches: ["middleware/auth.mjs"],
      invariant: "tests pass",
      conflictsWith: "token schema",
    };
    const trailer = formatIntentTrailer(intent);
    assert.ok(trailer.startsWith("X-Intent: "));

    const message = `fix(auth): guard middleware\n\n${trailer}`;
    const parsed = parseIntentTrailer(message);
    assert.deepEqual(parsed, intent);
  });

  it("parseIntentTrailer returns null for missing or malformed trailers", () => {
    assert.equal(parseIntentTrailer("no trailer here"), null);
    assert.equal(parseIntentTrailer("X-Intent: not-json"), null);
    assert.equal(parseIntentTrailer(""), null);
  });

  it("classifyIntentPair detects contradictory via conflictsWith", () => {
    const a = {
      scope: "auth",
      action: "harden",
      touches: ["middleware/auth.mjs"],
      conflictsWith: "token schema",
    };
    const b = {
      scope: "auth",
      action: "token schema overhaul",
      touches: ["lib/token-store.mjs"],
      conflictsWith: "",
    };
    const result = classifyIntentPair(a, b);
    assert.equal(result.relation, "contradictory");
    assert.ok(result.reason.length > 0);
  });

  it("classifyIntentPair returns complementary for non-overlapping touches in same scope", () => {
    const a = {
      scope: "billing",
      action: "add",
      touches: ["billing/invoice.mjs"],
      conflictsWith: "",
    };
    const b = {
      scope: "billing",
      action: "refactor",
      touches: ["billing/tax.mjs"],
      conflictsWith: "",
    };
    const result = classifyIntentPair(a, b);
    assert.equal(result.relation, "complementary");
  });

  it("classifyIntentPair returns independent for different scopes", () => {
    const a = {
      scope: "auth",
      action: "harden",
      touches: ["middleware/auth.mjs"],
      conflictsWith: "",
    };
    const b = {
      scope: "ui",
      action: "style",
      touches: ["web/app.css"],
      conflictsWith: "",
    };
    const result = classifyIntentPair(a, b);
    assert.equal(result.relation, "independent");
  });

  it("buildIntentFromLLMResponse accepts raw JSON", () => {
    const raw = JSON.stringify({
      scope: "auth",
      action: "harden",
      reason: "fix bypass",
      touches: ["a.mjs"],
      invariant: "",
      conflictsWith: "",
    });
    const intent = buildIntentFromLLMResponse(raw);
    assert.equal(intent.scope, "auth");
    assert.equal(intent.action, "harden");
  });

  it("buildIntentFromLLMResponse extracts JSON from markdown fences", () => {
    const raw = [
      "Sure, here is the intent:",
      "```json",
      '{"scope":"api","action":"add","reason":"new endpoint","touches":["api/users.mjs"],"invariant":"","conflictsWith":""}',
      "```",
    ].join("\n");
    const intent = buildIntentFromLLMResponse(raw);
    assert.equal(intent.scope, "api");
    assert.equal(intent.action, "add");
    assert.deepEqual(intent.touches, ["api/users.mjs"]);
  });

  it("buildIntentFromLLMResponse falls back on garbage input", () => {
    const intent = buildIntentFromLLMResponse("totally not intent data");
    assert.equal(intent.scope, "unknown");
    assert.equal(intent.action, "unknown");
    assert.deepEqual(intent.touches, []);
  });
});
