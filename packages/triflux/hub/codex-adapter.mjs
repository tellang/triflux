import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexProfileConfigOverrides } from "../scripts/lib/codex-profile-config.mjs";
import {
  buildExecCommand,
  executeWithAttempts,
  normalizePathForShell,
  runProcess,
  shellQuote,
} from "./cli-adapter-base.mjs";
import { runPreflight } from "./codex-preflight.mjs";
import { isActivityLifecycleEnabled } from "./lib/worker-lifecycle.mjs";

// ── Codex-specific stall inference ──────────────────────────────

function inferStallMode(stdout, stderr) {
  const text = `${stdout}\n${stderr}`.toLowerCase();
  if (
    /(rate.?limit|quota|throttl|too.many.requests|429|usage.limit)/u.test(text)
  )
    return "rate_limited";
  if (/(approval|approve|permission|sandbox|bypass)/u.test(text))
    return "approval_stall";
  if (
    /\bmcp\b|context7|playwright|tavily|exa|brave|sequential|server/u.test(text)
  )
    return "mcp_stall";
  return "timeout";
}

// ── Codex command building ──────────────────────────────────────

function commandWithOverrides(command, prompt, codexPath, overrides = []) {
  const next = codexPath
    ? command.replace(/^codex\b/u, shellQuote(codexPath))
    : command;
  if (!overrides.length) return next;
  const promptArg = JSON.stringify(prompt);
  const flags = overrides
    .flatMap((value) => ["-c", shellQuote(value)])
    .join(" ");
  return next.endsWith(promptArg)
    ? `${next.slice(0, -promptArg.length)}${flags} ${promptArg}`
    : `${next} ${flags}`;
}

function buildOverrides(requested, excluded) {
  return [
    ...new Set(
      (requested || []).filter((name) => (excluded || []).includes(name)),
    ),
  ].map((name) => `mcp_servers.${name}.enabled=false`);
}

function buildAttempts(opts, preflight) {
  const timeout = Number.isFinite(opts.timeout) ? opts.timeout : 300_000;
  const requested = Array.isArray(opts.mcpServers) ? [...opts.mcpServers] : [];
  const base = {
    timeout,
    profile: opts.profile,
    requested,
    excluded: [...(preflight.excludeMcpServers || [])],
    forceBypass: preflight.needsBypass,
  };
  if (opts.retryOnFail === false) return [base];
  const retryTimeout = isActivityLifecycleEnabled() ? timeout : timeout * 2;
  return [
    base,
    { ...base, timeout: retryTimeout, excluded: requested, forceBypass: true },
  ];
}

// ── Launch script ───────────────────────────────────────────────

function createLaunchScriptText(opts) {
  const parts = [
    "codex",
    "exec",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
  ];
  // Select the effort profile via `-c` config overrides instead of
  // `--profile <name>` (see buildExecCommand): codex 0.134+ rejects `--profile
  // X` whenever config.toml still contains an inline [profiles.X] table.
  if (opts.profile) {
    for (const override of codexProfileConfigOverrides(opts.profile)) {
      parts.push("-c", shellQuote(override));
    }
  }
  parts.push('$(cat "$PROMPT_FILE")');
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `cd ${shellQuote(normalizePathForShell(opts.workdir))}`,
    `PROMPT_FILE=${shellQuote(normalizePathForShell(opts.promptFile))}`,
    `TFX_CODEX_TIMEOUT_MS=${shellQuote(String(opts.timeout ?? ""))}`,
    parts.join(" "),
    "",
  ].join("\n");
}

export function buildLaunchScript(opts = {}) {
  const dir = join(tmpdir(), "triflux-codex-launch");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${String(opts.id || "launch")}.sh`);
  writeFileSync(path, createLaunchScriptText(opts), "utf8");
  return path;
}

// ── Exec args builder ───────────────────────────────────────────

// CTO boundary: this adapter assembles Codex prompts outside
// scripts/tfx-route.sh. Keep north-star injection in tfx-route.sh until
// launcher workdir contracts have focused coverage.
export function buildExecArgs(opts = {}) {
  const prompt = typeof opts.prompt === "string" ? opts.prompt : "";
  const command = buildExecCommand(prompt, opts.resultFile || null, {
    profile: opts.profile,
    codexHome: opts.codexHome,
    disallowUltra: opts.disallowUltra,
    enforceCanonicalProfile: opts.enforceCanonicalProfile,
    skipGitRepoCheck: true,
    sandboxBypass: true,
    cwd: opts.cwd,
    // stdinPrompt 가 명시되면 buildExecCommand 로 forward.
    // headless 워커 spawn (backend.mjs) 은 default (stdin on, macOS hook fix).
    stdinPrompt: opts.stdinPrompt,
  });

  if (!prompt) return command.replace(/\s+""$/u, "");

  let result;
  const quotedPrompt = JSON.stringify(prompt);
  // PowerShell: (Get-Content -Raw '...'), bash: "$(cat '...')"
  if (
    (/^\(Get-Content\b[\s\S]*\)$/u.test(prompt) ||
      /^"\$\(cat\b[\s\S]*\)"$/u.test(prompt)) &&
    command.endsWith(quotedPrompt)
  ) {
    result = `${command.slice(0, -quotedPrompt.length)}${prompt}`;
  } else {
    result = command;
  }

  // stderr 캡처: codex 실패 시에도 원인 추적 가능 (resultFile.err)
  if (opts.resultFile) {
    result += ` 2>'${opts.resultFile}.err'`;
  }
  return result;
}

// ── Codex execution ─────────────────────────────────────────────

async function runCodex(prompt, workdir, preflight, attempt) {
  const dir = join(tmpdir(), "triflux-codex-exec");
  mkdirSync(dir, { recursive: true });
  const resultFile = join(
    dir,
    `codex-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );
  const command = commandWithOverrides(
    buildExecCommand(prompt, resultFile, {
      profile: attempt.profile,
      skipGitRepoCheck: true,
      sandboxBypass: attempt.forceBypass,
    }),
    prompt,
    preflight.codexPath,
    buildOverrides(attempt.requested, attempt.excluded),
  );
  return runProcess(command, workdir, attempt.timeout, {
    resultFile,
    inferStallMode,
    cli: "codex",
  });
}

// ── Public API ──────────────────────────────────────────────────

export function execute(opts = {}) {
  return executeWithAttempts({
    runFn: runCodex,
    preflightFn: (o) =>
      runPreflight({
        mcpServers: o.mcpServers,
        subcommand: "exec",
        workdir: o.workdir,
      }),
    buildAttemptsFn: buildAttempts,
    opts,
  });
}
