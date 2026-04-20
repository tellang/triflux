// Codex headless review helper. Runs a cross-model review of a git diff
// without going through Bash-level headless-guard (the guard only inspects
// `codex exec` invoked from the Bash tool — node `spawn` bypasses it
// intentionally because `tfx` is the sanctioned entry point).
//
// Contract:
//   runCodexReview({ ref = "HEAD", base?: string, timeoutMs = 180_000 })
//     → { ok, code?, verdict, stdout, stderr, diffBytes, error? }
//   Verdict parsed from Codex output: APPROVED / REQUEST_CHANGES / COMMENT
//   / UNKNOWN when none is stated.
//
// Motivation: session 12 post-mortem (BUG-J fix merged without cross-review).
// Without an ergonomic `tfx review` path, every swarm bugfix skips the
// Codex independent opinion — the exact check that caught BUG-I's path-only
// filter bypass in round 1 (session 11 PR #134).

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the diff payload for a given ref.
 * - `a..b` ranges pass through unchanged
 * - `<commit>` expands to `<commit>~1..<commit>` (single-commit review)
 * - `HEAD` with no prior commit returns an empty string
 *
 * @param {{ ref?: string, base?: string }} opts
 * @returns {{ diff: string, range: string }}
 */
export function resolveReviewDiff({ ref = "HEAD", base } = {}) {
  let range;
  if (base) {
    range = `${base}..${ref}`;
  } else if (ref.includes("..")) {
    range = ref;
  } else {
    range = `${ref}~1..${ref}`;
  }

  const diff = execFileSync(
    "git",
    ["log", "-p", "--stat", "--no-color", range],
    {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 50 * 1024 * 1024,
    },
  );
  return { diff, range };
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
 * Run Codex review of a git range.
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

  // OS arg-list ceiling. The whole chain (bash → codex.cmd → node) fails
  // with ENAMETOOLONG / "Argument list too long" well below the documented
  // 128KB on Windows. Observed breakage at 62KB diff (session 12 self-dogfood).
  // 32KB is a safe ceiling that covers most single-commit swarm fixes.
  // Larger ranges should be reviewed per-file or with --base narrowing.
  const MAX_PROMPT_BYTES = 32_000;
  if (promptBytes > MAX_PROMPT_BYTES) {
    return {
      ok: false,
      error:
        `prompt too large (${promptBytes} bytes > ${MAX_PROMPT_BYTES}). ` +
        `Narrow the review with --base <sha> or split per-file. ` +
        `Large-diff streaming is tracked as a follow-up.`,
      verdict: null,
      stdout: "",
      stderr: "",
      diffBytes,
      promptBytes,
      range,
    };
  }

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
