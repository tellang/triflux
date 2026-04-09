// hub/cli-adapter-base.mjs — codex/gemini 공통 CLI adapter 인터페이스
// Phase 2: codex-adapter.mjs에서 추출한 재사용 가능 유틸리티

import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { IS_WINDOWS, killProcess } from "./platform.mjs";

// ── Codex CLI compatibility ─────────────────────────────────────

let _cachedVersion = null;

/**
 * `codex --version` 실행 결과를 파싱하여 마이너 버전 숫자 반환.
 * 파싱 실패 시 0 반환 (구버전으로 간주).
 * @returns {number} 마이너 버전 (예: 0.117.0 → 117)
 */
export function getCodexVersion() {
  if (_cachedVersion !== null) return _cachedVersion;
  try {
    const out = execSync("codex --version", {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    const match = out.match(/(\d+)\.(\d+)\.(\d+)/);
    _cachedVersion = match ? Number.parseInt(match[2], 10) : 0;
  } catch {
    _cachedVersion = 0;
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
 * @param {string} prompt
 * @param {string|null} resultFile — null이면 --output-last-message 생략
 * @param {{ profile?: string, skipGitRepoCheck?: boolean, sandboxBypass?: boolean, cwd?: string, mcpServers?: string[] }} [opts]
 * @returns {string} 실행할 셸 커맨드
 */
export function buildExecCommand(prompt, resultFile = null, opts = {}) {
  const {
    profile,
    skipGitRepoCheck = true,
    sandboxBypass = true,
    cwd,
    mcpServers,
  } = opts;

  const parts = ["codex"];
  if (profile) parts.push("--profile", profile);

  if (FEATURES.execSubcommand) {
    parts.push("exec");
    if (sandboxBypass) parts.push("--dangerously-bypass-approvals-and-sandbox");
    if (skipGitRepoCheck) parts.push("--skip-git-repo-check");
    if (resultFile && FEATURES.outputLastMessage) {
      parts.push("--output-last-message", resultFile);
    }
    if (FEATURES.colorNever) parts.push("--color", "never");
    if (cwd) parts.push("--cwd", `'${escapePwshSingleQuoted(cwd)}'`);
    if (Array.isArray(mcpServers)) {
      for (const server of mcpServers) {
        parts.push("-c", `mcp_servers.${server}.enabled=true`);
      }
    }
  } else {
    parts.push("--dangerously-bypass-approvals-and-sandbox");
    if (skipGitRepoCheck) parts.push("--skip-git-repo-check");
  }

  parts.push(JSON.stringify(prompt));
  return parts.join(" ");
}

// ── Sleep ───────────────────────────────────────────────────────

export function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
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
  const lease = brokerMod.broker?.lease({ provider });
  if (!lease) {
    return createResult(false, { fellBack: true, failureMode: "circuit_open" });
  }

  const preflight = await preflightFn(opts);
  if (!preflight.ok) {
    brokerMod.broker.release(lease.id, { ok: false });
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

  if (lastResult.ok) {
    brokerMod.broker.release(lease.id, { ok: true });
    return lastResult;
  }

  brokerMod.broker.release(lease.id, { ok: false });
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
 * @param {number} timeout — max duration in ms
 * @param {object} [opts]
 * @param {string} [opts.resultFile] — file to read output from (if CLI writes there)
 * @param {function} [opts.inferStallMode] — (stdout, stderr) => string. Default: () => 'timeout'
 * @param {number} [opts.stallCheckIntervalMs] — stall check interval (default 10_000)
 * @param {number} [opts.stallThresholdMs] — stall threshold (default 30_000)
 * @returns {Promise<object>} createResult-shaped object
 */
export async function runProcess(command, workdir, timeout, opts = {}) {
  const startedAt = Date.now();
  const inferStallMode = opts.inferStallMode || (() => "timeout");
  const stallCheckIntervalMs = opts.stallCheckIntervalMs ?? 10_000;
  const stallThresholdMs = opts.stallThresholdMs ?? 30_000;
  const resultFile = opts.resultFile || null;

  let stdout = "";
  let stderr = "";
  let exitCode = null;
  let failureMode = null;
  let child;

  try {
    child = spawn(command, { cwd: workdir, shell: true, windowsHide: true });
  } catch (error) {
    return createResult(false, {
      stderr: String(error?.message || error),
      duration: Date.now() - startedAt,
    });
  }

  let lastBytes = 0;
  let lastChange = Date.now();
  const touch = () => {
    lastChange = Date.now();
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
    await terminateChild(child.pid);
  };

  const timeoutTimer = setTimeout(() => {
    void stopFor("timeout");
  }, timeout);
  const stallTimer = setInterval(() => {
    const size = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
    if (size !== lastBytes) {
      lastBytes = size;
      return;
    }
    if (Date.now() - lastChange >= stallThresholdMs)
      void stopFor(inferStallMode(stdout, stderr));
  }, stallCheckIntervalMs);
  timeoutTimer.unref?.();
  stallTimer.unref?.();

  await new Promise((resolve) =>
    child.on("close", (code) => {
      exitCode = code;
      resolve();
    }),
  );
  clearTimeout(timeoutTimer);
  clearInterval(stallTimer);

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
    duration: Date.now() - startedAt,
    failureMode: ok ? null : failureMode || "crash",
  });
}
