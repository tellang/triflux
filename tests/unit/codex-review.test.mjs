// codex-review — pure helper tests (no actual Codex invocation).

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregateVerdicts,
  buildReviewPrompt,
  expandRange,
  listChangedFiles,
  parseChangedFilesFromLog,
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
  assert.equal(parseVerdict("summary\n\nVERDICT: COMMENT\n"), "COMMENT");
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
  const calls = [];
  const { diff, range } = resolveReviewDiff({
    ref: "HEAD",
    runner: (cmd, args) => {
      calls.push({ cmd, args });
      return "fake diff";
    },
  });
  assert.equal(range, "HEAD~1..HEAD");
  assert.equal(diff, "fake diff");
  assert.deepEqual(calls[0], {
    cmd: "git",
    args: ["log", "-p", "--stat", "--no-color", "HEAD~1..HEAD"],
  });
});

test("resolveReviewDiff: range ref passes through unchanged", () => {
  const { range } = resolveReviewDiff({
    ref: "HEAD~2..HEAD",
    runner: () => "",
  });
  assert.equal(range, "HEAD~2..HEAD");
});

test("resolveReviewDiff: explicit base overrides implicit ~1", () => {
  const { range } = resolveReviewDiff({
    ref: "HEAD",
    base: "HEAD~3",
    runner: () => "",
  });
  assert.equal(range, "HEAD~3..HEAD");
});

test("runCodexReview: rejects oversized prompt without spawning codex", async () => {
  let spawned = false;
  const result = await runCodexReview({
    ref: "HEAD",
    base: "HEAD~1",
    _deps: {
      resolveReviewDiff: () => ({
        diff: `diff --git a/big.txt b/big.txt\n+${"x".repeat(40_000)}\n`,
        range: "HEAD~1..HEAD",
      }),
      runCodexOnPrompt: () => {
        spawned = true;
        throw new Error("must not spawn codex for oversized prompt");
      },
    },
  });

  assert.equal(spawned, false);
  assert.equal(result.ok, false);
  assert.match(result.error, /prompt too large/);
  assert.equal(result.verdict, null);
  assert.ok(result.promptBytes > 32_000);
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
    aggregateVerdicts([{ verdict: "APPROVED" }, { verdict: "APPROVED" }]),
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
  const calls = [];
  const files = listChangedFiles("HEAD~1..HEAD", (cmd, args) => {
    calls.push({ cmd, args });
    return "hub/team/codex-review.mjs\n\ntests/unit/codex-review.test.mjs\n";
  });
  assert.ok(Array.isArray(files));
  assert.ok(files.length > 0, "at least one file should differ");
  for (const f of files) {
    assert.equal(typeof f, "string");
    assert.ok(f.length > 0);
  }
  assert.deepEqual(calls[0], {
    cmd: "git",
    args: ["log", "--name-only", "--pretty=format:", "HEAD~1..HEAD"],
  });
});

test("listChangedFiles: empty range returns empty array", () => {
  // HEAD..HEAD has no changes.
  const files = listChangedFiles("HEAD..HEAD");
  assert.deepEqual(files, []);
});

test("resolveReviewDiff: file param scopes diff via `-- <file>`", () => {
  const calls = [];
  const target = "hub/team/codex-review.mjs";
  const { diff, range, file } = resolveReviewDiff({
    ref: "HEAD",
    file: target,
    runner: (cmd, args) => {
      calls.push({ cmd, args });
      return `diff --git a/${target} b/${target}\n+changed\n`;
    },
  });
  assert.equal(range, "HEAD~1..HEAD");
  assert.equal(file, target);
  assert.ok(diff.includes(target), "scoped diff should reference target file");
  assert.deepEqual(calls[0], {
    cmd: "git",
    args: ["log", "-p", "--stat", "--no-color", "HEAD~1..HEAD", "--", target],
  });
});

test("expandRange: bare ref expands to ~1..ref", () => {
  assert.equal(expandRange({ ref: "HEAD" }), "HEAD~1..HEAD");
  assert.equal(expandRange({ ref: "abcdef0" }), "abcdef0~1..abcdef0");
});

test("expandRange: explicit base overrides", () => {
  assert.equal(expandRange({ ref: "HEAD", base: "main" }), "main..HEAD");
  assert.equal(
    expandRange({ ref: "feat/x", base: "origin/main" }),
    "origin/main..feat/x",
  );
});

test("expandRange: range ref passes through unchanged", () => {
  assert.equal(expandRange({ ref: "HEAD~3..HEAD" }), "HEAD~3..HEAD");
  assert.equal(expandRange({ ref: "main..feat/x" }), "main..feat/x");
});

test("expandRange: defaults ref to HEAD when omitted", () => {
  assert.equal(expandRange({}), "HEAD~1..HEAD");
  assert.equal(expandRange(), "HEAD~1..HEAD");
});

test("listChangedFiles: git log semantics, deduped, no blanks", () => {
  const files = listChangedFiles("HEAD~1..HEAD", () =>
    ["", "foo.mjs", "bar.mjs", "", "foo.mjs", "baz.mjs", ""].join("\n"),
  );
  const unique = new Set(files);
  assert.equal(
    unique.size,
    files.length,
    "listChangedFiles must dedupe file paths",
  );
  for (const f of files) {
    assert.ok(f && !/^\s*$/.test(f), "no blank entries");
  }
});

test("parseChangedFilesFromLog: dedupes paths repeated across commits", () => {
  // Simulates `git log --name-only --pretty=format:` output where commit A
  // adds foo.mjs + bar.mjs, and commit B reverts bar.mjs. Both show up in
  // log output but only once each in the result.
  const canned = [
    "", // first commit's blank format line
    "foo.mjs",
    "bar.mjs",
    "", // second commit
    "bar.mjs", // revert — appears twice in log
    "",
    "baz.mjs", // third commit
  ].join("\n");
  const result = parseChangedFilesFromLog(canned);
  assert.deepEqual(result.sort(), ["bar.mjs", "baz.mjs", "foo.mjs"]);
});

test("parseChangedFilesFromLog: handles empty and whitespace-only input", () => {
  assert.deepEqual(parseChangedFilesFromLog(""), []);
  assert.deepEqual(parseChangedFilesFromLog("\n\n  \n\t\n"), []);
  assert.deepEqual(parseChangedFilesFromLog(null), []);
  assert.deepEqual(parseChangedFilesFromLog(undefined), []);
});

test("parseChangedFilesFromLog: preserves insertion order of first occurrence", () => {
  // Same file in 3 commits; first occurrence wins insertion order.
  const canned = "a\n\nb\na\nc\na\n";
  assert.deepEqual(parseChangedFilesFromLog(canned), ["a", "b", "c"]);
});

test("parseChangedFilesFromLog: handles CRLF line endings", () => {
  const canned = "alpha\r\nbeta\r\n\r\nalpha\r\ngamma\r\n";
  assert.deepEqual(parseChangedFilesFromLog(canned), [
    "alpha",
    "beta",
    "gamma",
  ]);
});

test("listChangedFiles: argv contract — does not pass --no-merges", () => {
  // Regression guard: merges must be included so enumeration stays aligned
  // with resolveReviewDiff's plain `git log -p`. Round 3 fix in PR #138.
  let capturedCmd = "";
  let capturedArgs = [];
  const stubRunner = (cmd, args) => {
    capturedCmd = cmd;
    capturedArgs = args;
    return "foo.mjs\nbar.mjs\n";
  };
  const result = listChangedFiles("HEAD~2..HEAD", stubRunner);
  assert.equal(capturedCmd, "git");
  assert.equal(capturedArgs[0], "log");
  assert.ok(capturedArgs.includes("--name-only"));
  assert.ok(capturedArgs.includes("--pretty=format:"));
  assert.ok(capturedArgs.includes("HEAD~2..HEAD"));
  assert.ok(!capturedArgs.includes("--no-merges"), "must not pass --no-merges");
  assert.deepEqual(result.sort(), ["bar.mjs", "foo.mjs"]);
});
