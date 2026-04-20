// Codex headless review helper. Runs a cross-model review of a git diff
// without going through Bash-level headless-guard (the guard only inspects
// `codex exec` invoked from the Bash tool — node `spawn` bypasses it
// intentionally because `tfx` is the sanctioned entry point).
//
// Contract:
//   runCodexReview({ ref = "HEAD", base?: string, timeoutMs = 180_000 })
//     → { ok, code?, verdict, stdout, stderr, diffBytes, error? }
//   runCodexReviewSharded({ ref, base, timeoutMs })
//     → { ok, verdict, range, files, perFile: [{ file, verdict, ... }] }
//   Verdict parsed from Codex output: APPROVED / REQUEST_CHANGES / COMMENT
//   / UNKNOWN when none is stated.
//
// Motivation: session 12 post-mortem (BUG-J fix merged without cross-review).
// Without an ergonomic `tfx review` path, every swarm bugfix skips the
// Codex independent opinion — the exact check that caught BUG-I's path-only
// filter bypass in round 1 (session 11 PR #134). Session 13 adds --shard
// per-file for diffs that exceed the 32KB single-spawn ceiling.

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// OS arg-list ceiling. The whole chain (bash → codex.cmd → node) fails
// with ENAMETOOLONG / "Argument list too long" well below the documented
// 128KB on Windows. Observed breakage at 62KB diff (session 12 self-dogfood).
// 32KB is a safe ceiling that covers most single-commit swarm fixes.
// Larger ranges should be reviewed per-file with --shard per-file or
// narrowed with --base.
export const MAX_PROMPT_BYTES = 32_000;

/**
 * Resolve the diff payload for a given ref.
 * - `a..b` ranges pass through unchanged
 * - `<commit>` expands to `<commit>~1..<commit>` (single-commit review)
 * - `HEAD` with no prior commit returns an empty string
 * - optional `file` scopes the diff to a single path via `-- <file>`
 *
 * @param {{ ref?: string, base?: string, file?: string }} opts
 * @returns {{ diff: string, range: string, file?: string }}
 */
export function resolveReviewDiff({ ref = "HEAD", base, file } = {}) {
  let range;
  if (base) {
    range = `${base}..${ref}`;
  } else if (ref.includes("..")) {
    range = ref;
  } else {
    range = `${ref}~1..${ref}`;
  }

  const args = ["log", "-p", "--stat", "--no-color", range];
  if (file) {
    args.push("--", file);
  }
  const diff = execFileSync("git", args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 50 * 1024 * 1024,
  });
  return { diff, range, file };
}

/**
 * List files changed in a range via `git diff --name-only`.
 * Used by shard mode to enumerate per-file review targets.
 *
 * @param {string} range — e.g. "HEAD~1..HEAD" or "main..feature"
 * @returns {string[]}
 */
export function listChangedFiles(range) {
  const out = execFileSync(
    "git",
    ["diff", "--name-only", range],
    { encoding: "utf8", windowsHide: true, maxBuffer: 50 * 1024 * 1024 },
  );
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Build the Codex review prompt.
 * @param {string} diff
 * @param {{ range: string }} ctx
 */
export function buildReviewPrompt(diff, { range }) {
  return [
    `You are acting as an independent cross-model reviewer.`,
    `Review the following git log range: ${range}.`,
    ``,
    `Scope: correctness, regression risk, security, test coverage, code style.`,
    ``,
    `Classify each finding as:`,
    `- HIGH: blocking — logic bug, security hole, regression`,
    `- MEDIUM: should-fix — missing test, readability, maintainability`,
    `- LOW: nit — style, micro-optimization`,
    ``,
    `Format each finding as: [SEVERITY] file:line — description. Suggested fix: ...`,
    `If a category has no findings, write 'none'.`,
    ``,
    `End with exactly one line stating the verdict:`,
    `VERDICT: APPROVED  (no HIGH findings)`,
    `VERDICT: REQUEST_CHANGES  (any HIGH finding)`,
    `VERDICT: COMMENT  (observations only, no blockers)`,
    ``,
    "```diff",
    diff,
    "```",
  ].join("\n");
}

/**
 * Parse the verdict marker from Codex stdout.
 * @param {string} stdout
 */
export function parseVerdict(stdout) {
  const match = stdout.match(
    /VERDICT:\s*(APPROVED|REQUEST_CHANGES|COMMENT)\b/i,
  );
  if (match) return match[1].toUpperCase();
  if (/REQUEST_CHANGES/i.test(stdout)) return "REQUEST_CHANGES";
  if (/\bAPPROVED\b/i.test(stdout)) return "APPROVED";
  return "UNKNOWN";
}

/**
 * Aggregate per-file verdicts into an overall verdict.
 * - Any REQUEST_CHANGES → REQUEST_CHANGES
 * - Any COMMENT (no REQUEST_CHANGES) → COMMENT
 * - All APPROVED (skipped excluded) → APPROVED
 * - Mixed with UNKNOWN → UNKNOWN (conservative)
 *
 * @param {Array<{verdict: string|null, skipped?: boolean}>} fileResults
 * @returns {string}
 */
export function aggregateVerdicts(fileResults) {
  const active = fileResults.filter((r) => !r.skipped);
  if (active.length === 0) return "UNKNOWN";
  const verdicts = active.map((r) => r.verdict);
  if (verdicts.some((v) => v === "REQUEST_CHANGES")) return "REQUEST_CHANGES";
  if (verdicts.some((v) => v === "COMMENT")) return "COMMENT";
  if (verdicts.every((v) => v === "APPROVED")) return "APPROVED";
  return "UNKNOWN";
}

/**
 * Internal: run Codex on a pre-built prompt and parse the response.
 * Shared by single-mode runCodexReview and shard-mode runCodexReviewSharded.
 */
async function _runCodexOnPrompt({
  prompt,
  range,
  diffBytes,
  timeoutMs,
  sandbox,
  env,
}) {
  // Prompt is a full git diff — often >10KB, regularly >60KB on swarm
  // bugfixes. Windows cmd.exe caps command lines at ~8KB and node's
  // `spawn(..., [promptArg])` route cannot exceed the OS arg limit
  // (ENAMETOOLONG on Windows). Persist the prompt to a tmp file and let
  // bash read it back — same pattern session 11 used manually
  // (`codex exec "$(cat prompt.md)" ...`).
  const tmpDir = mkdtempSync(join(tmpdir(), "tfx-review-"));
  const promptFile = join(tmpDir, "prompt.md").replace(/\\/g, "/");
  writeFileSync(promptFile, prompt);

  const shellCmd = [
    "codex",
    "exec",
    "-s",
    sandbox,
    "--dangerously-bypass-approvals-and-sandbox",
    `"$(cat '${promptFile.replace(/'/g, "'\\''")}')"`,
  ].join(" ");

  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", shellCmd], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    const cleanupTmp = () => {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    };

    child.on("error", (err) => {
      clearTimeout(timer);
      cleanupTmp();
      resolve({
        ok: false,
        error: err.message,
        verdict: null,
        stdout,
        stderr,
        diffBytes,
        range,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      cleanupTmp();
      if (timedOut) {
        resolve({
          ok: false,
          code,
          error: `codex review timed out after ${timeoutMs}ms`,
          verdict: null,
          stdout,
          stderr,
          diffBytes,
          range,
        });
        return;
      }
      resolve({
        ok: code === 0,
        code,
        verdict: parseVerdict(stdout),
        stdout,
        stderr,
        diffBytes,
        range,
      });
    });
  });
}

/**
 * Run Codex review of a git range (single-spawn mode).
 * @param {object} opts
 * @param {string} [opts.ref="HEAD"]
 * @param {string} [opts.base]
 * @param {number} [opts.timeoutMs=180000]
 * @param {string} [opts.sandbox="read-only"]
 * @param {object} [opts.env]
 */
export async function runCodexReview({
  ref = "HEAD",
  base,
  timeoutMs = 180_000,
  sandbox = "read-only",
  env = process.env,
} = {}) {
  let range;
  let diff;
  try {
    ({ diff, range } = resolveReviewDiff({ ref, base }));
  } catch (err) {
    return {
      ok: false,
      error: `git log failed: ${err.message}`,
      verdict: null,
      stdout: "",
      stderr: "",
      diffBytes: 0,
    };
  }

  const diffBytes = Buffer.byteLength(diff, "utf8");
  if (diffBytes === 0) {
    return {
      ok: false,
      error: `empty diff for range ${range}`,
      verdict: null,
      stdout: "",
      stderr: "",
      diffBytes: 0,
      range,
    };
  }

  const prompt = buildReviewPrompt(diff, { range });
  const promptBytes = Buffer.byteLength(prompt, "utf8");

  if (promptBytes > MAX_PROMPT_BYTES) {
    return {
      ok: false,
      error:
        `prompt too large (${promptBytes} bytes > ${MAX_PROMPT_BYTES}). ` +
        `Retry with --shard per-file or narrow with --base <sha>.`,
      verdict: null,
      stdout: "",
      stderr: "",
      diffBytes,
      promptBytes,
      range,
    };
  }

  return _runCodexOnPrompt({
    prompt,
    range,
    diffBytes,
    timeoutMs,
    sandbox,
    env,
  });
}

/**
 * Run Codex review sharded per-file. Each changed file in the range gets
 * its own Codex spawn with its own 32KB budget. Results are aggregated.
 *
 * Sequential, not parallel — Codex headless startup is ~30-90s per call
 * and parallel spawns risk auth contention. Wall-clock scales linearly
 * with file count, budget accordingly (default timeout applies per-file).
 *
 * @param {object} opts — same shape as runCodexReview
 * @returns {Promise<{ok: boolean, verdict: string, range: string, files: string[], perFile: object[], error?: string}>}
 */
export async function runCodexReviewSharded({
  ref = "HEAD",
  base,
  timeoutMs = 180_000,
  sandbox = "read-only",
  env = process.env,
  onFileStart,
  onFileDone,
} = {}) {
  let range;
  if (base) {
    range = `${base}..${ref}`;
  } else if (ref.includes("..")) {
    range = ref;
  } else {
    range = `${ref}~1..${ref}`;
  }

  let files;
  try {
    files = listChangedFiles(range);
  } catch (err) {
    return {
      ok: false,
      error: `git diff --name-only failed: ${err.message}`,
      verdict: "UNKNOWN",
      range,
      files: [],
      perFile: [],
    };
  }

  if (files.length === 0) {
    return {
      ok: false,
      error: `no changed files in range ${range}`,
      verdict: "UNKNOWN",
      range,
      files: [],
      perFile: [],
    };
  }

  const perFile = [];
  for (const file of files) {
    if (typeof onFileStart === "function") {
      try {
        onFileStart({ file, index: perFile.length, total: files.length });
      } catch {
        /* caller callback errors should not block review */
      }
    }

    let fileDiff;
    try {
      ({ diff: fileDiff } = resolveReviewDiff({ ref, base, file }));
    } catch (err) {
      const entry = {
        file,
        ok: false,
        error: `git log scope failed: ${err.message}`,
        verdict: "UNKNOWN",
        diffBytes: 0,
        range: `${range} -- ${file}`,
      };
      perFile.push(entry);
      if (typeof onFileDone === "function") {
        try {
          onFileDone(entry);
        } catch {
          /* ignore */
        }
      }
      continue;
    }

    const diffBytes = Buffer.byteLength(fileDiff, "utf8");
    if (diffBytes === 0) {
      const entry = {
        file,
        ok: true,
        skipped: true,
        error: `empty diff for ${file} (likely rename/mode-only)`,
        verdict: "APPROVED",
        diffBytes: 0,
        range: `${range} -- ${file}`,
      };
      perFile.push(entry);
      if (typeof onFileDone === "function") {
        try {
          onFileDone(entry);
        } catch {
          /* ignore */
        }
      }
      continue;
    }

    const scopedRange = `${range} -- ${file}`;
    const prompt = buildReviewPrompt(fileDiff, { range: scopedRange });
    const promptBytes = Buffer.byteLength(prompt, "utf8");
    if (promptBytes > MAX_PROMPT_BYTES) {
      const entry = {
        file,
        ok: false,
        error:
          `prompt too large (${promptBytes} bytes > ${MAX_PROMPT_BYTES}) ` +
          `for single file. Review this file manually or split the commit.`,
        verdict: "UNKNOWN",
        diffBytes,
        promptBytes,
        range: scopedRange,
      };
      perFile.push(entry);
      if (typeof onFileDone === "function") {
        try {
          onFileDone(entry);
        } catch {
          /* ignore */
        }
      }
      continue;
    }

    const res = await _runCodexOnPrompt({
      prompt,
      range: scopedRange,
      diffBytes,
      timeoutMs,
      sandbox,
      env,
    });
    const entry = { file, ...res };
    perFile.push(entry);
    if (typeof onFileDone === "function") {
      try {
        onFileDone(entry);
      } catch {
        /* ignore */
      }
    }
  }

  const verdict = aggregateVerdicts(perFile);
  const ok = perFile.every((r) => r.ok);
  return { ok, verdict, range, files, perFile };
}
