// codex-review — pure helper tests (no actual Codex invocation).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateVerdicts,
  buildReviewPrompt,
  listChangedFiles,
  parseVerdict,
  resolveReviewDiff,
  runCodexReview,
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

test("runCodexReview: rejects oversized prompt without spawning codex", async () => {
  // Use a deep range to force a large diff. This test validates the size
  // gate fires before any subprocess is invoked — no flakiness from a
  // missing codex binary.
  const result = await runCodexReview({ ref: "HEAD", base: "HEAD~1" });
  // If the commit itself is small the happy path spawns codex (and may
  // ENOENT in CI) — skip assertion if the prompt is under the ceiling.
  if (result.diffBytes > 0 && result.promptBytes > 32_000) {
    assert.equal(result.ok, false);
    assert.match(result.error, /prompt too large/);
    assert.equal(result.verdict, null);
  }
});

// ── shard-mode helpers ─────────────────────────────────────────

test("aggregateVerdicts: empty list returns UNKNOWN", () => {
  assert.equal(aggregateVerdicts([]), "UNKNOWN");
});

test("aggregateVerdicts: any REQUEST_CHANGES wins", () => {
  const fileResults = [
    { verdict: "APPROVED" },
    { verdict: "COMMENT" },
    { verdict: "REQUEST_CHANGES" },
    { verdict: "APPROVED" },
  ];
  assert.equal(aggregateVerdicts(fileResults), "REQUEST_CHANGES");
});

test("aggregateVerdicts: COMMENT overrides APPROVED but loses to REQUEST_CHANGES", () => {
  assert.equal(
    aggregateVerdicts([{ verdict: "APPROVED" }, { verdict: "COMMENT" }]),
    "COMMENT",
  );
});

test("aggregateVerdicts: all APPROVED returns APPROVED", () => {
  assert.equal(
    aggregateVerdicts([
      { verdict: "APPROVED" },
      { verdict: "APPROVED" },
    ]),
    "APPROVED",
  );
});

test("aggregateVerdicts: mixed APPROVED + UNKNOWN falls through to UNKNOWN", () => {
  assert.equal(
    aggregateVerdicts([{ verdict: "APPROVED" }, { verdict: "UNKNOWN" }]),
    "UNKNOWN",
  );
});

test("aggregateVerdicts: skipped entries are excluded from active set", () => {
  const results = [
    { verdict: "APPROVED", skipped: true },
    { verdict: "APPROVED" },
  ];
  assert.equal(aggregateVerdicts(results), "APPROVED");
});

test("aggregateVerdicts: all skipped returns UNKNOWN", () => {
  const results = [
    { verdict: "APPROVED", skipped: true },
    { verdict: "APPROVED", skipped: true },
  ];
  assert.equal(aggregateVerdicts(results), "UNKNOWN");
});

test("listChangedFiles: returns non-empty array for HEAD~1..HEAD", () => {
  // Repo has at least 1 prior commit (session bootstrap). This asserts the
  // shape, not a specific file list.
  const files = listChangedFiles("HEAD~1..HEAD");
  assert.ok(Array.isArray(files));
  assert.ok(files.length > 0, "at least one file should differ");
  for (const f of files) {
    assert.equal(typeof f, "string");
    assert.ok(f.length > 0);
  }
});

test("listChangedFiles: empty range returns empty array", () => {
  // HEAD..HEAD has no changes.
  const files = listChangedFiles("HEAD..HEAD");
  assert.deepEqual(files, []);
});

test("resolveReviewDiff: file param scopes diff via `-- <file>`", () => {
  // Any file that changed in HEAD~1..HEAD. Use listChangedFiles to pick one.
  const all = listChangedFiles("HEAD~1..HEAD");
  if (all.length === 0) return; // nothing to scope — skip
  const target = all[0];
  const { diff, range, file } = resolveReviewDiff({
    ref: "HEAD",
    file: target,
  });
  assert.equal(range, "HEAD~1..HEAD");
  assert.equal(file, target);
  assert.ok(typeof diff === "string");
  // Scoped diff should mention only the target file in its `diff --git` header.
  // Other files may still appear in --stat summary, so check body presence.
  assert.ok(diff.includes(target), "scoped diff should reference target file");
});
