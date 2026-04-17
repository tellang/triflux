// hub/workers/codex-mcp.mjs — Codex MCP 서버 래퍼
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  CODEX_MCP_EXECUTION_EXIT_CODE,
  CODEX_MCP_TRANSPORT_EXIT_CODE,
} from "../cli-adapter-base.mjs";
import { withRetry } from "./worker-utils.mjs";

const REQUIRED_TOOLS = ["codex", "codex-reply"];

export { CODEX_MCP_EXECUTION_EXIT_CODE, CODEX_MCP_TRANSPORT_EXIT_CODE };
export const DEFAULT_CODEX_MCP_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_CODEX_MCP_BOOTSTRAP_TIMEOUT_MS = 120 * 1000;

/**
 * Codex MCP transport/bootstrap 계층 오류
 */
export class CodexMcpTransportError extends Error {
  /**
   * @param {string} message
   * @param {object} [options]
   * @param {unknown} [options.cause]
   * @param {string} [options.stderr]
   */
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = "CodexMcpTransportError";
    this.stderr = options.stderr || "";
  }
}

function cloneEnv(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(([, value]) => typeof value === "string"),
  );
}

function collectTextContent(content = []) {
  return content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function normalizeStructuredContent(structuredContent, fallbackText = "") {
  if (!structuredContent || typeof structuredContent !== "object") {
    return { threadId: null, content: fallbackText };
  }

  const threadId =
    typeof structuredContent.threadId === "string"
      ? structuredContent.threadId
      : null;
  const content =
    typeof structuredContent.content === "string"
      ? structuredContent.content
      : fallbackText;

  return { threadId, content };
}

function buildCodexArguments(prompt, opts = {}) {
  const args = { prompt };

  if (typeof opts.cwd === "string" && opts.cwd) args.cwd = opts.cwd;
  if (typeof opts.model === "string" && opts.model) args.model = opts.model;
  if (typeof opts.profile === "string" && opts.profile)
    args.profile = opts.profile;
  if (typeof opts.approvalPolicy === "string" && opts.approvalPolicy) {
    args["approval-policy"] = opts.approvalPolicy;
  }
  if (typeof opts.sandbox === "string" && opts.sandbox)
    args.sandbox = opts.sandbox;
  if (opts.config && typeof opts.config === "object") args.config = opts.config;
  if (typeof opts.baseInstructions === "string" && opts.baseInstructions) {
    args["base-instructions"] = opts.baseInstructions;
  }
  if (
    typeof opts.developerInstructions === "string" &&
    opts.developerInstructions
  ) {
    args["developer-instructions"] = opts.developerInstructions;
  }
  if (typeof opts.compactPrompt === "string" && opts.compactPrompt) {
    args["compact-prompt"] = opts.compactPrompt;
  }

  return args;
}

function pickToolName(threadId) {
  return threadId ? "codex-reply" : "codex";
}

function withTimeout(promise, timeoutMs, message) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
    timer.unref?.();
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
  });
}

function normalizeRetryOptions(retryOptions) {
  if (!retryOptions || typeof retryOptions !== "object") {
    return Object.freeze({});
  }
  return Object.freeze({ ...retryOptions });
}

function isCodexRetryable(error) {
  return (
    error instanceof CodexMcpTransportError ||
    error?.code === "ETIMEDOUT" ||
    error?.cause?.code === "ETIMEDOUT"
  );
}

function detectWorkerCategory(error, fallbackCategory = "transient") {
  const combined =
    `${error?.message || ""}\n${error?.stderr || ""}`.toLowerCase();

  if (error?.code === "INVALID_INPUT") return "input";
  if (
    /(unauthorized|forbidden|auth|login|token|credential|apikey|api key)/i.test(
      combined,
    )
  ) {
    return "auth";
  }
  if (
    /(config|unknown option|invalid option|missing|필수 mcp 도구 누락)/i.test(
      combined,
    )
  ) {
    return "config";
  }

  return fallbackCategory;
}

function buildCodexErrorInfo(error, attempts) {
  const retryable = isCodexRetryable(error);
  const code =
    error instanceof CodexMcpTransportError
      ? "CODEX_TRANSPORT_ERROR"
      : error?.code || "CODEX_EXECUTION_ERROR";
  const category = detectWorkerCategory(
    error,
    retryable ? "transient" : "config",
  );

  let recovery =
    "Review the Codex worker error output and retry after correcting the issue.";
  if (code === "INVALID_INPUT") {
    recovery = "Provide a non-empty prompt before invoking the Codex worker.";
  } else if (retryable) {
    recovery = "Retry after reconnecting the Codex MCP transport.";
  } else if (category === "auth") {
    recovery = "Refresh the Codex authentication state and retry.";
  } else if (category === "config") {
    recovery = "Check the Codex MCP configuration and available tools.";
  }

  return Object.freeze({
    code,
    retryable,
    attempts,
    category,
    recovery,
  });
}

/**
 * Codex MCP 워커
 */
export class CodexMcpWorker {
  type = "codex";

  /**
   * @param {object} [options]
   * @param {string} [options.command]
   * @param {string[]} [options.args]
   * @param {string} [options.cwd]
   * @param {Record<string, string>} [options.env]
   * @param {{ name: string, version: string }} [options.clientInfo]
   * @param {number} [options.bootstrapTimeoutMs]
   */
  constructor(options = {}) {
    this.command = options.command || process.env.CODEX_BIN || "codex";
    this.args =
      Array.isArray(options.args) && options.args.length
        ? [...options.args]
        : ["mcp-server"];
    this.cwd = options.cwd || process.cwd();
    this.env = cloneEnv({ ...cloneEnv(process.env), ...cloneEnv(options.env) });
    this.clientInfo = options.clientInfo || {
      name: "triflux-codex-mcp",
      version: "1.0.0",
    };
    this.bootstrapTimeoutMs = Number.isFinite(options.bootstrapTimeoutMs)
      ? options.bootstrapTimeoutMs
      : DEFAULT_CODEX_MCP_BOOTSTRAP_TIMEOUT_MS;
    this.retryOptions = normalizeRetryOptions(options.retryOptions);

    this.client = null;
    this.transport = null;
    this.ready = false;
    this.availableTools = new Set();
    this.threadIds = new Map();
    this.serverStderr = "";
  }

  isReady() {
    return this.ready;
  }

  getThreadId(sessionKey) {
    return this.threadIds.get(sessionKey) || null;
  }

  setThreadId(sessionKey, threadId) {
    if (!sessionKey || !threadId) return;
    this.threadIds.set(sessionKey, threadId);
  }

  clearThread(sessionKey) {
    if (!sessionKey) return;
    this.threadIds.delete(sessionKey);
  }

  async start() {
    if (this.ready && this.client && this.transport) return;

    await this.stop();

    const transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      cwd: this.cwd,
      env: this.env,
      stderr: "pipe",
    });
    const client = new Client(this.clientInfo, { capabilities: {} });

    this.serverStderr = "";
    transport.stderr?.on("data", (chunk) => {
      this.serverStderr += String(chunk);
      if (this.serverStderr.length > 16000) {
        this.serverStderr = this.serverStderr.slice(-16000);
      }
    });

    try {
      await withTimeout(
        (async () => {
          await client.connect(transport);
          const tools = await client.listTools(undefined, {
            timeout: this.bootstrapTimeoutMs,
          });
          this.availableTools = new Set(tools.tools.map((tool) => tool.name));

          for (const requiredTool of REQUIRED_TOOLS) {
            if (!this.availableTools.has(requiredTool)) {
              throw new Error(`필수 MCP 도구 누락: ${requiredTool}`);
            }
          }
        })(),
        this.bootstrapTimeoutMs,
        `Codex MCP bootstrap timeout (${this.bootstrapTimeoutMs}ms)`,
      );
    } catch (error) {
      await client.close().catch(() => {});
      transport.stderr?.destroy?.();
      throw new CodexMcpTransportError(
        `Codex MCP 연결 실패: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error, stderr: this.serverStderr.trim() },
      );
    }

    this.client = client;
    this.transport = transport;
    this.ready = true;
  }

  async stop() {
    this.ready = false;
    this.availableTools.clear();

    const client = this.client;
    const transport = this.transport;
    this.transport = null;
    this.client = null;

    if (client) {
      await client.close().catch(() => {});
    } else if (transport) {
      await transport.close().catch(() => {});
    }

    transport?.stderr?.destroy?.();
  }

  /**
   * @param {string} prompt
   * @param {import('./interface.mjs').WorkerExecuteOptions} [opts]
   * @returns {Promise<import('./interface.mjs').WorkerResult>}
   */
  async execute(prompt, opts = {}) {
    if (typeof prompt !== "string" || !prompt.trim()) {
      return {
        output: "prompt는 비어 있을 수 없습니다.",
        exitCode: CODEX_MCP_EXECUTION_EXIT_CODE,
        threadId: null,
        sessionKey: opts.sessionKey || null,
        error: buildCodexErrorInfo(
          { code: "INVALID_INPUT", message: "prompt는 비어 있을 수 없습니다." },
          0,
        ),
        raw: null,
      };
    }

    const sessionKey =
      typeof opts.sessionKey === "string" && opts.sessionKey
        ? opts.sessionKey
        : null;

    if (opts.resetSession && sessionKey) {
      this.clearThread(sessionKey);
    }

    const threadId =
      typeof opts.threadId === "string" && opts.threadId
        ? opts.threadId
        : sessionKey
          ? this.getThreadId(sessionKey)
          : null;
    const timeoutMs = Number.isFinite(opts.timeoutMs)
      ? opts.timeoutMs
      : DEFAULT_CODEX_MCP_TIMEOUT_MS;
    let attempts = 0;
    let activeThreadId = threadId;

    try {
      const { rawResult, normalized } = await withRetry(
        async () => {
          attempts += 1;
          if (attempts === 1) {
            await this.start();
          } else {
            await this.stop();
            await this.start();
          }

          const toolName = pickToolName(activeThreadId);
          const toolArguments =
            toolName === "codex-reply"
              ? { prompt, threadId: activeThreadId }
              : buildCodexArguments(prompt, opts);

          const nextRawResult = await this.client.callTool(
            { name: toolName, arguments: toolArguments },
            undefined,
            { timeout: timeoutMs },
          );

          const textContent = collectTextContent(nextRawResult.content);
          const nextNormalized = normalizeStructuredContent(
            nextRawResult.structuredContent,
            textContent,
          );
          activeThreadId = nextNormalized.threadId || activeThreadId;

          return { rawResult: nextRawResult, normalized: nextNormalized };
        },
        {
          ...this.retryOptions,
          shouldRetry: (error) => isCodexRetryable(error),
        },
      );

      if (sessionKey && normalized.threadId) {
        this.setThreadId(sessionKey, normalized.threadId);
      }

      if (rawResult.isError) {
        return {
          output: normalized.content,
          exitCode: CODEX_MCP_EXECUTION_EXIT_CODE,
          threadId: normalized.threadId,
          sessionKey,
          error: buildCodexErrorInfo(
            { code: "CODEX_TOOL_ERROR", message: normalized.content },
            attempts,
          ),
          raw: rawResult,
        };
      }

      return {
        output: normalized.content,
        exitCode: 0,
        threadId: normalized.threadId,
        sessionKey,
        raw: rawResult,
      };
    } catch (error) {
      await this.stop().catch(() => {});
      return {
        output: error instanceof Error ? error.message : String(error),
        exitCode: CODEX_MCP_EXECUTION_EXIT_CODE,
        threadId: activeThreadId,
        sessionKey,
        error: buildCodexErrorInfo(error, attempts || 1),
        raw: null,
      };
    }
  }
}

export function createCodexMcpWorker(options = {}) {
  return new CodexMcpWorker(options);
}

function parseCliArgs(argv) {
  const options = {
    command: process.env.CODEX_BIN || "codex",
    cwd: process.cwd(),
    timeoutMs: DEFAULT_CODEX_MCP_TIMEOUT_MS,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error(`${token} 값이 필요합니다.`);
      }
      i += 1;
      return value;
    };

    switch (token) {
      case "--prompt":
        options.prompt = next();
        break;
      case "--thread-id":
        options.threadId = next();
        break;
      case "--session-key":
        options.sessionKey = next();
        break;
      case "--cwd":
        options.cwd = next();
        break;
      case "--profile":
        options.profile = next();
        break;
      case "--model":
        options.model = next();
        break;
      case "--approval-policy":
        options.approvalPolicy = next();
        break;
      case "--sandbox":
        options.sandbox = next();
        break;
      case "--base-instructions":
        options.baseInstructions = next();
        break;
      case "--developer-instructions":
        options.developerInstructions = next();
        break;
      case "--compact-prompt":
        options.compactPrompt = next();
        break;
      case "--timeout-ms":
        options.timeoutMs = Number.parseInt(next(), 10);
        break;
      case "--config-json":
        options.config = JSON.parse(next());
        break;
      case "--codex-command":
        options.command = next();
        break;
      case "--reset-session":
        options.resetSession = true;
        break;
      default:
        throw new Error(`알 수 없는 옵션: ${token}`);
    }
  }

  if (typeof options.prompt !== "string" || !options.prompt) {
    throw new Error("--prompt는 필수입니다.");
  }

  return options;
}

export async function runCodexMcpCli(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    console.error(
      `[codex-mcp] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 64;
    return;
  }

  const worker = new CodexMcpWorker({
    command: options.command,
    cwd: options.cwd,
  });

  try {
    const result = await worker.execute(options.prompt, options);
    if (result.output) {
      process.stdout.write(result.output);
      if (!result.output.endsWith("\n")) {
        process.stdout.write("\n");
      }
    }
    process.exitCode = result.exitCode;
  } catch (error) {
    const lines = [error instanceof Error ? error.message : String(error)];
    if (error instanceof CodexMcpTransportError && error.stderr) {
      lines.push(error.stderr);
    }
    console.error(`[codex-mcp] ${lines.join("\n")}`);
    process.exitCode = CODEX_MCP_TRANSPORT_EXIT_CODE;
  } finally {
    await worker.stop();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await runCodexMcpCli();
  process.exit(process.exitCode ?? 0);
}
