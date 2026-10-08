// hub/cli-adapter-base.mjs — codex/gemini 공통 CLI adapter 인터페이스
// Phase 2: codex-adapter.mjs에서 추출한 재사용 가능 유틸리티

import { spawn } from "node:child_process";
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

// ── Shell utilities ─────────────────────────────────────────────

export function normalizePathForShell(value) {
  return IS_WINDOWS ? String(value).replace(/\\/g, "/") : String(value);
}

// POSIX 셸은 큰따옴표 안의 $(), 백틱을 실행하므로 작은따옴표로 감싼다.
export function posixQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// Windows 는 shell: true 가 cmd.exe 라 작은따옴표를 인용으로 읽지 않는다.
export function shellQuote(value) {
  return IS_WINDOWS ? JSON.stringify(String(value)) : posixQuote(value);
}

// PowerShell 은 ‘ ’ ‚ ‛ 도 작은따옴표로 읽는다. 따옴표 문자를 모두 겹쳐 써야 인용이 안 끝난다.
export function escapePwshSingleQuoted(value) {
  return String(value).replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&");
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
    shell = IS_WINDOWS ? "pwsh" : "posix",
  } = opts;
  const quote = (value) => quoteForShell(value, shell);

  const parts = ["codex", "exec"];
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

  if (sandboxBypass) parts.push("--dangerously-bypass-approvals-and-sandbox");
  if (skipGitRepoCheck) parts.push("--skip-git-repo-check");
  if (resultFile) parts.push("--output-last-message", quote(resultFile));
  parts.push("--color", "never");
  for (const override of profileOverrides) parts.push("-c", quote(override));
  // `codex exec`는 --cwd를 받지 않아 child process의 cwd로 제어한다.
  if (Array.isArray(mcpServers)) {
    for (const server of mcpServers) {
      parts.push("-c", `mcp_servers.${server}.enabled=true`);
    }
  }

  // cmd.exe 는 %VAR% 확장과 \" 의 인용 상태 반전 때문에 임의 문자열을 안전하게 인용할 수 없어
  // 프롬프트는 늘 파일 리다이렉트로 넘긴다.
  const useStdin = shell === "cmd" || resolveStdinPromptMode(stdinPrompt);
  const hasPrompt = typeof prompt === "string" && prompt.length > 0;
  if (useStdin && hasPrompt) {
    const promptFile = writePromptToTmpFile(prompt);
    // pwsh7 의 `<` 는 예약 문법이라 Get-Content -Raw 파이프로 stdin 에 넣는다.
    if (shell === "pwsh")
      return `Get-Content -Raw ${quote(promptFile)} | ${parts.join(" ")}`;
    return `${parts.join(" ")} < ${quote(promptFile)}`;
  }

  parts.push(quote(prompt));
  return parts.join(" ");
}

// Windows 는 같은 명령을 cmd.exe(runProcess 의 shell: true)나 PowerShell(psmux pane)에서 실행한다.
// PowerShell 큰따옴표는 $() 를 확장하므로 작은따옴표로 감싸고, cmd 에는 경로와 설정값만 넣는다.
export function quoteForShell(value, shell) {
  if (shell === "pwsh") return `'${escapePwshSingleQuoted(value)}'`;
  if (shell === "cmd") return JSON.stringify(String(value));
  return posixQuote(value);
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

// ── Attempt execution ───────────────────────────────────────────

/**
 * preflight 뒤 buildAttemptsFn 이 만든 시도를 순서대로 실행한다.
 *
 * @param {object} params
 * @param {(prompt: string, workdir: string, preflight: object, attempt: object) => Promise<object>} params.runFn
 * @param {(opts: object) => Promise<object>} params.preflightFn
 * @param {(opts: object, preflight: object) => object[]} params.buildAttemptsFn
 * @param {object} params.opts — caller-supplied execute options
 * @returns {Promise<object>} createResult-shaped result
 */
export async function executeWithAttempts({
  runFn,
  preflightFn,
  buildAttemptsFn,
  opts = {},
}) {
  const { withRetry } = await import("./workers/worker-utils.mjs");

  const preflight = await preflightFn(opts);
  if (!preflight.ok) {
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
        const result = await runFn(
          opts.prompt || "",
          opts.workdir || process.cwd(),
          preflight,
          attempts[attemptIndex],
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

  if (lastResult.ok) return lastResult;
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
    child = spawnProcess(command, {
      cwd: workdir,
      shell: true,
      windowsHide: true,
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
