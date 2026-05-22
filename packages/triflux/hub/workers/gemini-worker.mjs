// hub/workers/gemini-worker.mjs
// Deprecated compatibility surface. Direct Gemini CLI execution is removed;
// old imports now route through Antigravity.

import { existsSync } from "node:fs";
import { extname } from "node:path";

import { AntigravityRouteWorker } from "./antigravity-route-worker.mjs";
import { withRetry } from "./worker-utils.mjs";

function toStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? "").trim()).filter(Boolean);
}

/**
 * Windows에서 cmd.exe에 전달할 인자를 안전하게 quoting한다.
 */
function quoteWindowsCmdArg(value) {
  const raw = String(value ?? "").replace(/[\r\n]/g, " ");
  if (raw.length === 0) return '""';
  if (!/[\s"()^&|<>%!]/.test(raw)) return raw;
  const escaped = raw
    .replace(/%/g, "%%")
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\+)$/g, "$1$1");
  return `"${escaped}"`;
}

/**
 * Windows npm shim(.cmd) spawn 문제를 해결한다.
 */
function buildSpawnSpec(command, args) {
  if (process.platform !== "win32") {
    return { command, args, shell: false };
  }

  let resolved = command;
  if (!extname(resolved)) {
    for (const ext of [".exe", ".cmd", ".bat"]) {
      if (existsSync(resolved + ext)) {
        resolved = resolved + ext;
        break;
      }
    }
  }

  if (/\.(cmd|bat)$/i.test(resolved)) {
    const line = [resolved, ...args].map(quoteWindowsCmdArg).join(" ");
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/v:off", "/c", line],
      shell: false,
    };
  }

  return { command: resolved, args, shell: false };
}

function createWorkerError(message, details = {}) {
  const error = new Error(message);
  Object.assign(error, details);
  return error;
}

function normalizeRetryOptions(retryOptions) {
  if (!retryOptions || typeof retryOptions !== "object") {
    return Object.freeze({});
  }
  return Object.freeze({ ...retryOptions });
}

function isAntigravityRetryable(error) {
  return (
    error?.code === "WORKER_EXIT" &&
    error?.result?.exitCode !== 0 &&
    error?.result?.exitCode !== 2
  );
}

function detectAntigravityCategory(error) {
  const combined =
    `${error?.message || ""}\n${error?.stderr || ""}`.toLowerCase();

  if (
    /(unauthorized|forbidden|auth|login|token|credential|apikey|api key)/.test(
      combined,
    )
  ) {
    return "auth";
  }
  if (
    error?.result?.exitCode === 2 ||
    /unknown option|invalid option|config|route script/.test(combined)
  ) {
    return "config";
  }

  return "transient";
}

function buildAntigravityErrorInfo(error, attempts) {
  const category = detectAntigravityCategory(error);
  const retryable = isAntigravityRetryable(error);
  let recovery = "Retry the Antigravity route worker after correcting the issue.";

  if (category === "auth") {
    recovery = "Refresh the Antigravity authentication state and retry.";
  } else if (category === "config") {
    recovery = "Check the Antigravity route worker configuration.";
  }

  return Object.freeze({
    code: error?.code || "ANTIGRAVITY_EXECUTION_ERROR",
    retryable,
    attempts,
    category,
    recovery,
  });
}

export class GeminiWorker extends AntigravityRouteWorker {
  type = "antigravity";

  constructor(options = {}) {
    const { command, commandArgs, args, model, approvalMode, yolo, ...rest } =
      options;
    void commandArgs;
    void args;
    void model;
    void approvalMode;
    void yolo;
    super(rest);
    this.command = command || "agy";
    this.retryOptions = normalizeRetryOptions(options.retryOptions);
    this.lastRun = null;
  }

  getStatus() {
    return {
      type: "antigravity",
      state: this.children.size > 0 ? "running" : "idle",
      pid: null,
      last_run_at_ms: this.lastRun?.finishedAtMs || null,
      last_exit_code: this.lastRun?.exitCode ?? null,
    };
  }

  async run(prompt, options = {}) {
    const startedAtMs = Date.now();
    const result = await super.run(prompt, options);
    const normalized = {
      type: "antigravity",
      command: this.command,
      args: toStringList(options.extraArgs),
      response: result.response || result.output || "",
      output: result.output || result.response || "",
      stderr: result.stderr || "",
      exitCode: result.exitCode ?? 1,
      exitSignal: null,
      timedOut: result.exitCode === 124,
      startedAtMs,
      finishedAtMs: Date.now(),
      raw: result.raw || result,
    };
    this.lastRun = normalized;

    if (normalized.exitCode !== 0) {
      throw createWorkerError(
        `Antigravity route worker exited with code ${normalized.exitCode}`,
        {
          code: "WORKER_EXIT",
          result: normalized,
          stderr: normalized.stderr,
        },
      );
    }

    return normalized;
  }

  async execute(prompt, options = {}) {
    let attempts = 0;

    try {
      const result = await withRetry(
        async () => {
          attempts += 1;
          return this.run(prompt, options);
        },
        {
          ...this.retryOptions,
          shouldRetry: (error) => isAntigravityRetryable(error),
        },
      );

      return {
        output: result.response,
        exitCode: 0,
        sessionKey: options.sessionKey || null,
        raw: result,
      };
    } catch (error) {
      return {
        output: error.stderr || error.message || "Antigravity worker failed",
        exitCode: error.code === "ETIMEDOUT" ? 124 : 1,
        sessionKey: options.sessionKey || null,
        error: buildAntigravityErrorInfo(error, attempts || 1),
        raw: error.result || null,
      };
    }
  }
}

/** @visibleForTesting - 테스트 전용 export. 외부 소비 금지. */
export { buildSpawnSpec, quoteWindowsCmdArg };
