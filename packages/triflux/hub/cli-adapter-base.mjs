// hub/cli-adapter-base.mjs — codex/gemini 공통 CLI adapter 인터페이스
// Phase 2: codex-adapter.mjs에서 추출한 재사용 가능 유틸리티

import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

import { codexProfileConfigOverrides } from "../scripts/lib/codex-profile-config.mjs";
import { writePromptToTmpFile } from "./lib/prompt-tmp.mjs";
import {
  createActivityLifecycle,
  isActivityLifecycleEnabled,
  resolveHardCeilingMs,
  resolveStallInterventionMs,
} from "./lib/worker-lifecycle.mjs";
import { IS_WINDOWS, killProcess } from "./platform.mjs";
import { createInterventionLadder } from "./team/intervention.mjs";

// ── Quota retry-after 파싱 ──────────────────────────────────────

const FALLBACK_COOLDOWN_MS = { codex: 5 * 3600_000, gemini: 86400_000 };

/**
 * 에러 텍스트에서 retry-after 시간을 동적 파싱.
 * "try again at 2026-04-11T10:00:00Z", "retry after 3600 seconds",
 * "resets in 7 days", "wait 5 hours" 등을 감지.
 */
export function parseRetryAfterMs(text, provider) {
  // 1. ISO timestamp: "try again at 2026-04-11T10:00:00"
  const isoMatch = text.match(
    /(?:try again|retry|available|resets?)\s+(?:at|after)\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/i,
  );
  if (isoMatch) {
    const target = new Date(isoMatch[1]).getTime();
    if (target > Date.now()) return target - Date.now();
  }

  // 2. Duration: "N seconds/minutes/hours/days"
  const durMatch = text.match(
    /(?:retry|wait|resets?|again)\s+(?:in\s+|after\s+)?(\d+)\s*(second|minute|hour|day|week)/i,
  );
  if (durMatch) {
    const n = Number(durMatch[1]);
    const unit = durMatch[2].toLowerCase();
    const multipliers = {
      second: 1000,
      minute: 60_000,
      hour: 3600_000,
      day: 86400_000,
      week: 604800_000,
    };
    return n * (multipliers[unit] || 3600_000);
  }

  // 3. "7 days" / "24 hours" 단독 (context 없이)
  const standaloneMatch = text.match(/(\d+)\s*(day|hour|week|minute)/i);
  if (standaloneMatch) {
    const n = Number(standaloneMatch[1]);
    const unit = standaloneMatch[2].toLowerCase();
    const multipliers = {
      minute: 60_000,
      hour: 3600_000,
      day: 86400_000,
      week: 604800_000,
    };
    const parsed = n * (multipliers[unit] || 3600_000);
    if (parsed >= 3600_000) return parsed; // 1시간 이상만 신뢰
  }

  // 4. fallback: provider 기본값
  return FALLBACK_COOLDOWN_MS[provider] || 5 * 3600_000;
}

// ── Codex CLI compatibility ─────────────────────────────────────

let _cachedVersion = null;

/**
 * `codex --version` 실행 결과를 파싱하여 마이너 버전 숫자 반환.
 * 파싱 실패 시 0 반환 (구버전으로 간주).
 * @returns {number} 마이너 버전 (예: 0.117.0 → 117)
 */
export function getCodexVersion() {
  if (_cachedVersion !== null) return _cachedVersion;
  const override = Number(process.env.TFX_CODEX_VERSION_MINOR);
  if (Number.isFinite(override) && override > 0) {
    _cachedVersion = override;
    return _cachedVersion;
  }
  try {
    const out = execSync("codex --version", {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    const match = out.match(/(\d+)\.(\d+)\.(\d+)/);
    _cachedVersion = match ? Number.parseInt(match[2], 10) : 0;
  } catch {
    // Command builders should remain stable in CI even when the real Codex
    // CLI is absent. Runtime preflight still reports/install-gates Codex
    // separately; this fallback only selects the modern argv shape.
    _cachedVersion = 117;
  }
  return _cachedVersion;
}

/**
 * 최소 마이너 버전 이상인지 확인.
 * @param {number} minMinor
 * @returns {boolean}
 */
export function gte(minMinor) {
  return getCodexVersion() >= minMinor;
}

/**
 * Codex CLI 기능별 분기 객체.
 * 실측 기반 임계값: 0.114.0에서 exec/skip-git-repo-check/color 확인됨.
 * --output-last-message는 0.114.0에 없음 (0.117+ 추정).
 */
export const FEATURES = {
  /** exec 서브커맨드 사용 가능 여부 (0.110+ 이전부터 존재) */
  get execSubcommand() {
    return gte(110);
  },
  /** --output-last-message 플래그 지원 여부 (0.117+) */
  get outputLastMessage() {
    return gte(117);
  },
  /** --color <COLOR> 플래그 지원 여부 (exec와 동시 도입) */
  get colorNever() {
    return gte(110);
  },
  /** 플러그인 시스템 지원 여부 (향후 확장용) */
  get pluginSystem() {
    return gte(120);
  },
};

// ── Shell utilities ─────────────────────────────────────────────

export function normalizePathForShell(value) {
  return IS_WINDOWS ? String(value).replace(/\\/g, "/") : String(value);
}

export function shellQuote(value) {
  return JSON.stringify(String(value));
}

export function escapePwshSingleQuoted(value) {
  return String(value).replace(/'/g, "''");
}

export const CODEX_MCP_TRANSPORT_EXIT_CODE = 70;
export const CODEX_MCP_EXECUTION_EXIT_CODE = 1;

/**
 * long-form 플래그 기반 명령 빌더.
 *
 * macOS 회귀 fix (codex v0.130.0 oh-my-codex hook lifecycle): 매우 긴
 * argv-inline prompt 가 SessionStart Failed 를 유발하므로 default 가 prompt
 * 를 stdin 으로 전달하는 패턴. 셸별 분기:
 *   - Unix (bash/zsh): `codex exec ... < '/tmp/triflux-codex-prompt/prompt-*.txt'`
 *   - Windows (pwsh7): `Get-Content -Raw 'path' | codex exec ...`
 *     (pwsh7 의 `<` 는 reserved future syntax 라 호환성 보장 안 됨)
 *
 * 환경 변수 `TFX_CODEX_STDIN_PROMPT=0` 이면 legacy argv-inline 으로 회귀.
 * 결정론 보장이 필요한 launcher path 는 호출 시 `stdinPrompt: false` 명시.
 *
 * @param {string} prompt
 * @param {string|null} resultFile — null이면 --output-last-message 생략
 * @param {{ profile?: string, codexHome?: string, disallowUltra?: boolean, enforceCanonicalProfile?: boolean, skipGitRepoCheck?: boolean, sandboxBypass?: boolean, cwd?: string, mcpServers?: string[], stdinPrompt?: boolean }} [opts]
 * @returns {string} 실행할 셸 커맨드
 */
export function buildExecCommand(prompt, resultFile = null, opts = {}) {
  const {
    profile,
    skipGitRepoCheck = true,
    sandboxBypass = true,
    mcpServers,
    stdinPrompt,
    codexHome,
    disallowUltra,
    enforceCanonicalProfile,
  } = opts;

  const parts = ["codex"];
  // Select the effort profile via `-c` config overrides instead of
  // `--profile <name>`. codex 0.134+ rejects `--profile X` whenever config.toml
  // still contains an inline [profiles.X] table (and codex re-injects such
  // tables when it rewrites config.toml), so the `-c model=.. -c
  // model_reasoning_effort=..` form is immune and mutates no config.
  const profileOverrides = profile
    ? codexProfileConfigOverrides(profile, {
        codexHome,
        disallowUltra,
        enforceCanonicalProfile,
      })
    : [];

  if (FEATURES.execSubcommand) {
    parts.push("exec");
    if (sandboxBypass) parts.push("--dangerously-bypass-approvals-and-sandbox");
    if (skipGitRepoCheck) parts.push("--skip-git-repo-check");
    if (resultFile && FEATURES.outputLastMessage) {
      parts.push("--output-last-message", resultFile);
    }
    if (FEATURES.colorNever) parts.push("--color", "never");
    for (const override of profileOverrides)
      parts.push("-c", shellQuote(override));
    // NOTE: `codex exec`는 --cwd 플래그를 지원하지 않는다. Node spawn의 cwd
    // 옵션으로 child process의 working directory를 제어한다 (conductor.mjs 참조).
    // opts.cwd는 기록용으로만 받아두고 CLI command에는 반영하지 않는다.
    // (이전 커밋에서 잘못 추가되어 shard 전체가 exit 2로 크래시한 회귀 #94 후속 이슈)
    if (Array.isArray(mcpServers)) {
      for (const server of mcpServers) {
        parts.push("-c", `mcp_servers.${server}.enabled=true`);
      }
    }
  } else {
    parts.push("--dangerously-bypass-approvals-and-sandbox");
    if (skipGitRepoCheck) parts.push("--skip-git-repo-check");
    for (const override of profileOverrides)
      parts.push("-c", shellQuote(override));
  }

  const useStdin = resolveStdinPromptMode(stdinPrompt);
  const hasPrompt = typeof prompt === "string" && prompt.length > 0;
  if (useStdin && hasPrompt) {
    const promptFile = writePromptToTmpFile(prompt);
    if (IS_WINDOWS) {
      // pwsh7 호환: `<` redirect 는 reserved future syntax 라 동작 불안정.
      // Get-Content -Raw stdin pipe 로 prompt 를 codex stdin 에 주입.
      return `Get-Content -Raw '${escapePwshSingleQuoted(promptFile)}' | ${parts.join(" ")}`;
    }
    return `${parts.join(" ")} < ${shellQuote(promptFile)}`;
  }

  parts.push(JSON.stringify(prompt));
  return parts.join(" ");
}

function resolveStdinPromptMode(explicit) {
  if (typeof explicit === "boolean") return explicit;
  // Default ON to fix macOS codex hook regression. Opt out via env=0.
  const env = process.env.TFX_CODEX_STDIN_PROMPT;
  if (env === "0" || env === "false") return false;
  return true;
}

// ── Sleep ───────────────────────────────────────────────────────

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Result factory ──────────────────────────────────────────────

export function createResult(ok, extra = {}) {
  return {
    ok,
    output: "",
    stderr: "",
    exitCode: null,
    duration: 0,
    retried: false,
    fellBack: false,
    failureMode: ok ? null : "crash",
    ...extra,
  };
}

export function appendWarnings(stderr, warnings = []) {
  const text = warnings.map((item) => `[preflight] ${item}`).join("\n");
  return [stderr, text].filter(Boolean).join("\n");
}

// ── Broker-integrated execution ─────────────────────────────────

/**
 * Shared execute() logic that uses account-broker for per-account circuit
 * breaking instead of a global breaker.
 *
 * @param {object} params
 * @param {string} params.provider — 'codex' | 'gemini'
 * @param {(prompt: string, workdir: string, preflight: object, attempt: object) => Promise<object>} params.runFn
 * @param {(opts: object) => Promise<object>} params.preflightFn
 * @param {(opts: object, preflight: object) => object[]} params.buildAttemptsFn
 * @param {object} params.opts — caller-supplied execute options
 * @returns {Promise<object>} createResult-shaped result
 */
export async function executeWithCircuitBroker({
  provider,
  runFn,
  preflightFn,
  buildAttemptsFn,
  opts = {},
}) {
  // late-import to avoid circular dependency at module load time
  const brokerMod = await import("./account-broker.mjs");
  const { withRetry } = await import("./workers/worker-utils.mjs");

  // access broker as live binding property (not destructured) so reloadBroker() propagates
  const hasBroker = brokerMod.broker != null;
  // Empty broker (TFX_DISABLE_ACCOUNT_BROKER=1 or zero accounts) must not
  // gate execution. lease() is null because there are no accounts to lease,
  // not because all accounts are busy/cooldown/circuit. Treat it like
  // hasBroker=false and fall through to the default auth path.
  const brokerDisabled = hasBroker && brokerMod.broker.isDisabled === true;
  const effectiveBroker = hasBroker && !brokerDisabled;
  const lease = effectiveBroker ? brokerMod.broker.lease({ provider }) : null;
  if (effectiveBroker && !lease) {
    return createResult(false, { fellBack: true, failureMode: "circuit_open" });
  }

  const preflight = await preflightFn(opts);
  if (!preflight.ok) {
    if (lease) brokerMod.broker.release(lease.id, { ok: false });
    return createResult(false, {
      stderr: appendWarnings("", preflight.warnings),
      fellBack: opts.fallbackToClaude !== false,
      failureMode: "crash",
    });
  }

  const attempts = buildAttemptsFn(opts, preflight);
  let attemptIndex = 0;
  let lastResult = createResult(false);

  try {
    lastResult = await withRetry(
      async () => {
        // PRD A1: lease 메타데이터를 runFn 에 전달해서 adapter 가 실제 spawn 시
        // 해당 account 의 authFile/env/profile 을 적용할 수 있게 한다. lease=null
        // 이면 adapter 는 default 경로 (단일 ~/.codex/auth.json) 로 동작한다.
        const result = await runFn(
          opts.prompt || "",
          opts.workdir || process.cwd(),
          preflight,
          attempts[attemptIndex],
          lease,
        );
        const current = {
          ...result,
          stderr: appendWarnings(result.stderr, preflight.warnings),
          retried: attemptIndex > 0,
        };
        const canRetry = !current.ok && attemptIndex < attempts.length - 1;
        attemptIndex += 1;
        if (!canRetry) return current;
        const error = new Error("retry");
        error.retryable = true;
        error.result = current;
        throw error;
      },
      {
        maxAttempts: attempts.length,
        baseDelayMs: 250,
        maxDelayMs: 750,
        shouldRetry: (error) => error?.retryable === true,
      },
    );
  } catch (error) {
    lastResult =
      error?.result ||
      createResult(false, { stderr: String(error?.message || error) });
  }

  if (lastResult.ok) {
    if (lease) brokerMod.broker.release(lease.id, { ok: true });
    return lastResult;
  }

  if (lease) {
    if (lastResult.failureMode === "rate_limited") {
      const text = `${lastResult.output || ""}\n${lastResult.stderr || ""}`;
      const coolMs = parseRetryAfterMs(text, provider);
      brokerMod.broker.markRateLimited(lease.id, coolMs);
      brokerMod.broker.emit("cooldown", {
        id: lease.id,
        provider,
        coolMs,
        reason: "quota_exhausted",
      });
    } else {
      brokerMod.broker.release(lease.id, { ok: false });
    }
  }
  return {
    ...lastResult,
    retried: attempts.length > 1,
    fellBack: opts.fallbackToClaude !== false,
  };
}

// ── Process termination ─────────────────────────────────────────

export async function terminateChild(pid, opts = {}) {
  if (!pid) return;
  const graceMs = opts.graceMs ?? 5000;
  killProcess(pid, { signal: "SIGTERM", tree: true, timeout: graceMs });
  await sleep(graceMs);
  killProcess(pid, {
    signal: "SIGKILL",
    tree: true,
    force: true,
    timeout: graceMs,
  });
}

// ── Process execution with stall detection ──────────────────────

/**
 * Spawn a CLI process with timeout + stall detection.
 *
 * @param {string} command — shell command to run
 * @param {string} workdir — cwd for the child process
 * @param {number} timeout — legacy wall-clock duration (TFX_ACTIVITY_LIFECYCLE=0 only)
 * @param {object} [opts]
 * @param {string} [opts.resultFile] — file to read output from (if CLI writes there)
 * @param {function} [opts.inferStallMode] — (stdout, stderr) => string. Default: () => 'timeout'
 * @param {number} [opts.stallCheckIntervalMs] — stall check interval (default 10_000)
 * @param {number} [opts.stallThresholdMs] — inactivity threshold
 * @param {number} [opts.hardCeilingMs] — activity-independent maximum duration
 * @param {(context: object) => Promise<boolean|string>|boolean|string} [opts.onStallIntervene]
 *   T5 intervention seam; true or "resolved" keeps the process alive
 * @param {object} [opts.deps] — clock/process/timer overrides for deterministic tests
 * @returns {Promise<object>} createResult-shaped object
 */
export async function runProcess(command, workdir, timeout, opts = {}) {
  const deps = opts.deps || {};
  const now = deps.now || Date.now;
  const spawnProcess = deps.spawn || spawn;
  const scheduleTimeout = deps.setTimeout || setTimeout;
  const cancelTimeout = deps.clearTimeout || clearTimeout;
  const scheduleInterval = deps.setInterval || setInterval;
  const cancelInterval = deps.clearInterval || clearInterval;
  const terminateProcess = deps.terminateChild || terminateChild;
  const startedAt = now();
  const inferStallMode = opts.inferStallMode || (() => "timeout");
  const stallCheckIntervalMs = opts.stallCheckIntervalMs ?? 10_000;
  const legacyLifecycle = !isActivityLifecycleEnabled();
  const stallThresholdMs =
    opts.stallThresholdMs ??
    (legacyLifecycle ? 30_000 : resolveStallInterventionMs());
  const hardCeilingMs = opts.hardCeilingMs ?? resolveHardCeilingMs();
  const earlyClassifyMs = opts.earlyClassifyMs ?? 30_000;
  const resultFile = opts.resultFile || null;

  let stdout = "";
  let stderr = "";
  let exitCode = null;
  let failureMode = null;
  let child;

  try {
    // PRD A1: opts.spawnEnv 가 있으면 그 env 로 spawn (lease 의 authFile/env 적용).
    // undefined 면 spawn 의 default 동작 (부모 process env inherit) 유지.
    child = spawnProcess(command, {
      cwd: workdir,
      shell: true,
      windowsHide: true,
      env: opts.spawnEnv,
    });
  } catch (error) {
    return createResult(false, {
      stderr: String(error?.message || error),
      duration: now() - startedAt,
    });
  }

  const resultFileSignature = () => {
    if (!resultFile) return "";
    try {
      const info = statSync(resultFile);
      return `${info.size}:${info.mtimeMs}`;
    } catch {
      return "";
    }
  };

  let lastBytes = 0;
  let lastResultFileSignature = resultFileSignature();
  let lastChange = now();
  const activitySignature = () =>
    `${Buffer.byteLength(stdout) + Buffer.byteLength(stderr)}:${resultFileSignature()}`;
  let ladder = null;
  const lifecycle = createActivityLifecycle({
    enabled: !legacyLifecycle,
    interventionMs: stallThresholdMs,
    hardCeilingMs,
    now,
    onIntervene: async (context) => {
      if (typeof opts.onStallIntervene === "function") {
        const result = await opts.onStallIntervene(context);
        return result === true || result === "resolved";
      }
      ladder ??= createInterventionLadder({
        target: {
          pid: child.pid,
          cli: opts.cli,
          codexHome: opts.codexHome,
          rolloutFile: opts.rolloutFile,
        },
        readActivitySignature: activitySignature,
        deps:
          typeof opts.resumeHandler === "function"
            ? { resumeHandler: opts.resumeHandler }
            : {},
      });
      const result = await ladder.intervene();
      return result?.outcome === "reactivated" || result?.outcome === "resumed";
    },
  });
  const touch = () => {
    lastChange = now();
    lifecycle.observe(activitySignature());
  };
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
    touch();
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
    touch();
  });
  child.on("error", (error) => {
    stderr += String(error?.message || error);
    failureMode ||= "crash";
  });

  const stopFor = async (mode) => {
    if (failureMode) return;
    failureMode = mode;
    await terminateProcess(child.pid);
  };

  const timeoutTimer = legacyLifecycle
    ? scheduleTimeout(() => {
        void stopFor("timeout");
      }, timeout)
    : null;
  const stallTimer = scheduleInterval(() => {
    const size = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
    const currentResultFileSignature = resultFileSignature();
    if (
      size !== lastBytes ||
      currentResultFileSignature !== lastResultFileSignature
    ) {
      lastBytes = size;
      lastResultFileSignature = currentResultFileSignature;
      touch();
    }
    if (legacyLifecycle) {
      if (now() - lastChange >= stallThresholdMs)
        void stopFor(inferStallMode(stdout, stderr));
      return;
    }
    const quietMs = now() - lastChange;
    const mode = inferStallMode(stdout, stderr);
    if (
      quietMs >= earlyClassifyMs &&
      (mode === "rate_limited" || mode === "auth_stall")
    ) {
      void stopFor(inferStallMode(stdout, stderr));
      return;
    }
    void lifecycle
      .check({
        pid: child.pid,
        command,
        workdir,
        mode,
        stdoutTail: stdout.slice(-2000),
        stderrTail: stderr.slice(-2000),
      })
      .then((reason) => {
        if (!reason) return;
        void stopFor(reason === "hard_ceiling" ? "timeout" : mode);
      });
  }, stallCheckIntervalMs);
  timeoutTimer?.unref?.();
  stallTimer?.unref?.();

  await new Promise((resolve) =>
    child.on("close", (code) => {
      exitCode = code;
      resolve();
    }),
  );
  if (timeoutTimer) cancelTimeout(timeoutTimer);
  cancelInterval(stallTimer);

  const fileOutput =
    resultFile && existsSync(resultFile)
      ? readFileSync(resultFile, "utf8")
      : "";
  const output = fileOutput || stdout;
  const ok = failureMode == null && exitCode === 0;
  return createResult(ok, {
    output,
    stderr,
    exitCode,
    duration: now() - startedAt,
    failureMode: ok ? null : failureMode || "crash",
  });
}
