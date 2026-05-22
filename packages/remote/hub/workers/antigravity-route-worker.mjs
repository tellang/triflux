// hub/workers/antigravity-route-worker.mjs — SDK-free Antigravity route worker

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

function resolveCandidatePath(candidate, cwd = process.cwd()) {
  if (!candidate) return null;
  const normalized = String(candidate).startsWith("/")
    ? String(candidate)
    : resolve(cwd, String(candidate));
  return existsSync(normalized) ? normalized : null;
}

function resolveRouteScript(explicitPath, cwd = process.cwd(), env = process.env) {
  const candidates = [
    explicitPath,
    env.TFX_DELEGATOR_ROUTE_SCRIPT,
    env.TFX_ROUTE_SCRIPT,
    resolve(SCRIPT_DIR, "..", "..", "scripts", "tfx-route.sh"),
    resolve(cwd, "scripts", "tfx-route.sh"),
  ];

  for (const candidate of candidates) {
    const resolved = resolveCandidatePath(candidate, cwd);
    if (resolved) return resolved;
  }

  return null;
}

function parseRouteType(stderr = "") {
  const match = String(stderr).match(/type=([a-z-]+)/);
  if (!match) return "antigravity";
  return match[1] === "gemini" ? "antigravity" : match[1];
}

function normalizeResult(result = {}) {
  const output = result.output || result.error || "";
  const exitCode = result.exitCode ?? (result.ok ? 0 : 1);
  return {
    response: output,
    output,
    exitCode,
    stderr: result.stderr || "",
    raw: result,
  };
}

export class AntigravityRouteWorker {
  type = "antigravity";

  constructor(options = {}) {
    this.cwd = options.cwd || process.cwd();
    this.env = { ...process.env, ...(options.env || {}) };
    this.routeScript = resolveRouteScript(options.routeScript, this.cwd, this.env);
    this.bashCommand = options.bashCommand || this.env.BASH_BIN || "bash";
    this.timeoutMs =
      Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
        ? Number(options.timeoutMs)
        : DEFAULT_TIMEOUT_MS;
    this.children = new Set();
  }

  isReady() {
    return Boolean(this.routeScript);
  }

  async start() {}

  async stop() {
    for (const child of this.children) {
      child.kill("SIGTERM");
    }
    this.children.clear();
  }

  async run(prompt, options = {}) {
    if (!this.routeScript) {
      return normalizeResult({
        ok: false,
        output: "tfx-route.sh 경로를 찾지 못했습니다.",
        exitCode: 70,
      });
    }

    const timeoutMs =
      Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
        ? Number(options.timeoutMs)
        : this.timeoutMs;
    const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
    const childArgs = [
      this.routeScript,
      options.agentType || "executor",
      String(prompt ?? ""),
      options.mcpProfile || "auto",
      String(timeoutSec),
    ];
    const childEnv = {
      ...this.env,
      ...(options.env || {}),
      TFX_CLI_MODE: "antigravity",
    };

    const result = await new Promise((resolveResult) => {
      const child = spawn(this.bashCommand, childArgs, {
        cwd: options.cwd || this.cwd,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.children.add(child);

      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
      }, timeoutMs);
      timeout.unref?.();

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("close", (code, signal) => {
        clearTimeout(timeout);
        this.children.delete(child);
        const timedOut = signal === "SIGTERM" && code === null;
        resolveResult({
          ok: code === 0,
          output: stdout.trim() || stderr.trim(),
          stderr: stderr.trim(),
          exitCode: timedOut ? 124 : (code ?? 1),
          providerResolved: parseRouteType(stderr),
        });
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        this.children.delete(child);
        resolveResult({
          ok: false,
          output: error.message,
          stderr,
          exitCode: 1,
        });
      });
    });

    return normalizeResult(result);
  }

  async execute(prompt, options = {}) {
    const result = await this.run(prompt, options);
    return {
      output: result.output,
      exitCode: result.exitCode,
      threadId: null,
      sessionKey: null,
      raw: result.raw,
    };
  }
}
