// codex-review — pure helper tests (no actual Codex invocation).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildReviewPrompt,
  parseVerdict,
  resolveReviewDiff,
} from "../../hub/team/codex-review.mjs";

test("parseVerdict: extracts APPROVED marker", () => {
  assert.equal(parseVerdict("some text\nVERDICT: APPROVED\n"), "APPROVED");
});

test("parseVerdict: extracts REQUEST_CHANGES marker", () => {
  assert.equal(
    parseVerdict("findings here\nVERDICT: REQUEST_CHANGES"),
    "REQUEST_CHANGES",
  );
});

test("parseVerdict: extracts COMMENT marker", () => {
  assert.equal(
    parseVerdict("summary\n\nVERDICT: COMMENT\n"),
    "COMMENT",
  );
});

test("parseVerdict: falls back to REQUEST_CHANGES if keyword appears without marker", () => {
  assert.equal(
    parseVerdict("This change is risky, REQUEST_CHANGES."),
    "REQUEST_CHANGES",
  );
});

test("parseVerdict: UNKNOWN when nothing matches", () => {
  assert.equal(parseVerdict("just chatter"), "UNKNOWN");
});

test("parseVerdict: APPROVED must be a standalone word (bound check)", () => {
  // "DISAPPROVED" should not count
  assert.equal(parseVerdict("This is DISAPPROVED totally"), "UNKNOWN");
});

test("buildReviewPrompt: wraps diff and includes range", () => {
  const prompt = buildReviewPrompt("diff --git a b\n+added\n", {
    range: "HEAD~1..HEAD",
  });
  assert.match(prompt, /HEAD~1\.\.HEAD/);
  assert.match(prompt, /```diff/);
  assert.match(prompt, /\+added/);
  assert.match(prompt, /VERDICT:/);
});

test("buildReviewPrompt: includes all three severity buckets", () => {
  const prompt = buildReviewPrompt("x", { range: "main..HEAD" });
  assert.match(prompt, /HIGH/);
  assert.match(prompt, /MEDIUM/);
  assert.match(prompt, /LOW/);
});

test("resolveReviewDiff: single-commit ref expands to ~1..ref range", () => {
  // Spy via a monkeypatch would require dep injection. Instead, validate
  // behavior indirectly by asserting the return shape against an actually
  // reachable ref. Use HEAD since every test run has at least 1 commit.
  const { diff, range } = resolveReviewDiff({ ref: "HEAD" });
  assert.equal(range, "HEAD~1..HEAD");
  assert.ok(typeof diff === "string");
});

test("resolveReviewDiff: range ref passes through unchanged", () => {
  const { range } = resolveReviewDiff({ ref: "HEAD~2..HEAD" });
  assert.equal(range, "HEAD~2..HEAD");
});

test("resolveReviewDiff: explicit base overrides implicit ~1", () => {
  const { range } = resolveReviewDiff({ ref: "HEAD", base: "HEAD~3" });
  assert.equal(range, "HEAD~3..HEAD");
});
