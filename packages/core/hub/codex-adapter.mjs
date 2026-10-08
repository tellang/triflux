import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexProfileConfigOverrides } from "../scripts/lib/codex-profile-config.mjs";
import {
  buildExecCommand,
  escapePwshSingleQuoted,
  executeWithAttempts,
  normalizePathForShell,
  posixQuote,
  runProcess,
  shellQuote,
} from "./cli-adapter-base.mjs";
import { runPreflight } from "./codex-preflight.mjs";
import { privateTmpDir } from "./lib/private-tmp.mjs";
import { isActivityLifecycleEnabled } from "./lib/worker-lifecycle.mjs";
import { IS_WINDOWS } from "./platform.mjs";

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
  const promptArg = shellQuote(prompt);
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
      parts.push("-c", posixQuote(override));
    }
  }
  parts.push('$(cat "$PROMPT_FILE")');
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `cd ${posixQuote(normalizePathForShell(opts.workdir))}`,
    `PROMPT_FILE=${posixQuote(normalizePathForShell(opts.promptFile))}`,
    `TFX_CODEX_TIMEOUT_MS=${posixQuote(String(opts.timeout ?? ""))}`,
    parts.join(" "),
    "",
  ].join("\n");
}

export function buildLaunchScript(opts = {}) {
  const dir = privateTmpDir("triflux-codex-launch");
  const path = join(dir, `${String(opts.id || "launch")}.sh`);
  writeFileSync(path, createLaunchScriptText(opts), "utf8");
  return path;
}

// ── Exec args builder ───────────────────────────────────────────

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

  if (!prompt) return command.replace(/\s+(""|'')$/u, "");

  // stderr 캡처: codex 실패 시에도 원인 추적 가능 (resultFile.err)
  if (!opts.resultFile) return command;
  const errFile = `${opts.resultFile}.err`;
  const quoted = IS_WINDOWS
    ? `'${escapePwshSingleQuoted(errFile)}'`
    : posixQuote(errFile);
  return `${command} 2>${quoted}`;
}

// ── Codex execution ─────────────────────────────────────────────

async function runCodex(prompt, workdir, preflight, attempt) {
  const dir = privateTmpDir("triflux-codex-exec");
  const resultFile = join(
    dir,
    `codex-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );
  const command = commandWithOverrides(
    buildExecCommand(prompt, resultFile, {
      profile: attempt.profile,
      skipGitRepoCheck: true,
      sandboxBypass: attempt.forceBypass,
      // runProcess 는 shell: true 라 Windows 에서 cmd.exe 로 실행된다.
      shell: IS_WINDOWS ? "cmd" : "posix",
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
