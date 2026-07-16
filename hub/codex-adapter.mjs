import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { codexProfileConfigOverrides } from "../scripts/lib/codex-profile-config.mjs";
import {
  buildExecCommand,
  createResult,
  executeWithCircuitBroker,
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
// launcher/circuit-broker workdir contracts have focused coverage.
export function buildExecArgs(opts = {}) {
  const prompt = typeof opts.prompt === "string" ? opts.prompt : "";
  const command = buildExecCommand(prompt, opts.resultFile || null, {
    profile: opts.profile,
    codexHome: opts.codexHome,
    disallowUltra: opts.disallowUltra,
    skipGitRepoCheck: true,
    sandboxBypass: true,
    cwd: opts.cwd,
    // stdinPrompt 가 명시되면 buildExecCommand 로 forward.
    // headless 워커 spawn (backend.mjs) 은 default (stdin on, macOS hook fix).
    // launcher path (launcher-template.mjs) 는 결정론 위해 false 전달.
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

async function runCodex(prompt, workdir, preflight, attempt, lease) {
  const dir = join(tmpdir(), "triflux-codex-exec");
  mkdirSync(dir, { recursive: true });
  const resultFile = join(
    dir,
    `codex-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );
  const command = commandWithOverrides(
    buildExecCommand(prompt, resultFile, {
      profile: lease?.profile ?? attempt.profile,
      skipGitRepoCheck: true,
      sandboxBypass: attempt.forceBypass,
    }),
    prompt,
    preflight.codexPath,
    buildOverrides(attempt.requested, attempt.excluded),
  );
  // PRD A1 — lease 메타데이터를 spawn env 에 적용한다. lease.authFile 이 있으면
  // 해당 파일이 위치한 디렉토리를 CODEX_HOME 으로 export 해서 codex CLI 가 그
  // account 의 auth.json 을 사용하게 한다. lease 가 null 이면 default ~/.codex
  // 동작 유지 (회귀 없음). lease.env 는 추가 환경변수 (provider 고정 등) 주입용.
  const spawnEnv = lease ? buildLeaseSpawnEnv(lease) : undefined;
  const authCheck = validateLeaseAuth(lease, spawnEnv);
  if (!authCheck.ok) {
    return createResult(false, {
      stderr: authCheck.error,
      failureMode: "auth_sync",
      skipCircuit: true,
    });
  }
  return runProcess(command, workdir, attempt.timeout, {
    resultFile,
    inferStallMode,
    spawnEnv,
    cli: "codex",
    codexHome: spawnEnv?.CODEX_HOME,
  });
}

function buildLeaseSpawnEnv(lease) {
  const extra = {};
  if (lease.authFile) {
    // lease.authFile 은 보통 ~/.claude/cache/tfx-hub/codex-auth-<account>.json 형식.
    // codex CLI 는 CODEX_HOME 을 통해 auth.json 위치를 결정하므로, 이 cache 파일을
    // 직접 CODEX_HOME 후보 디렉토리로 사용한다. cache 파일 자체가 auth.json 이름이
    // 아니라면 후속 PR 에서 isolated dir + symlink/복사 처리한다 (PRD Open Question).
    // 현재는 lease.authFile 의 dirname 을 export 하되, 그 dirname 안에 auth.json 이
    // 실제로 있을 때만 적용한다 (false-positive 회피).
    try {
      const dir = dirnameOf(lease.authFile);
      if (dir) extra.CODEX_HOME = dir;
    } catch {}
  }
  if (lease.env && typeof lease.env === "object") {
    Object.assign(extra, lease.env);
  }
  return Object.keys(extra).length ? { ...process.env, ...extra } : undefined;
}

function validateLeaseAuth(lease, spawnEnv) {
  if (!lease?.authFile) return { ok: true };
  if (basename(lease.authFile) !== "auth.json") {
    return {
      ok: false,
      error: `lease authFile must resolve to auth.json for account ${lease.id}`,
    };
  }
  if (!existsSync(lease.authFile)) {
    return {
      ok: false,
      error: `lease authFile missing for account ${lease.id}: ${lease.authFile}`,
    };
  }
  if (dirnameOf(lease.authFile) !== spawnEnv?.CODEX_HOME) {
    return {
      ok: false,
      // This is currently expected to match because buildLeaseSpawnEnv derives
      // CODEX_HOME from authFile. Keep the guard so future lease.env overrides
      // cannot silently point Codex at a different account home.
      error: `CODEX_HOME mismatch for account ${lease.id}`,
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(lease.authFile, "utf8"));
    const accountId =
      parsed?.tokens?.account_id ??
      parsed?.account_id ??
      parsed?.accountId ??
      null;
    if (!accountId) {
      return {
        ok: false,
        error: `lease authFile has no account_id for account ${lease.id}`,
      };
    }
    if (accountId !== lease.id) {
      return {
        ok: false,
        error: `lease authFile account mismatch: expected ${lease.id}, got ${accountId}`,
      };
    }
  } catch (error) {
    return {
      ok: false,
      error: `lease authFile unreadable for account ${lease.id}: ${error?.message || error}`,
    };
  }
  return { ok: true };
}

function dirnameOf(filePath) {
  if (typeof filePath !== "string" || !filePath) return null;
  const lastSep = Math.max(
    filePath.lastIndexOf("/"),
    filePath.lastIndexOf("\\"),
  );
  if (lastSep < 0) return null;
  return filePath.slice(0, lastSep);
}

// ── Public API ──────────────────────────────────────────────────

export async function getCircuitState() {
  const brokerMod = await import("./account-broker.mjs");
  if (!brokerMod.broker) return { state: "closed", failures: [] };
  const snap = brokerMod.broker
    .snapshot()
    .filter((a) => a.provider === "codex");
  return snap.length
    ? { state: snap[0].circuitState, accounts: snap }
    : { state: "closed", failures: [] };
}

export function execute(opts = {}) {
  return executeWithCircuitBroker({
    provider: "codex",
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
