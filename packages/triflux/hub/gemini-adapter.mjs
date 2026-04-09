// hub/gemini-adapter.mjs — Gemini CLI 방어 계층
// codex-adapter.mjs와 동일 패턴, cli-adapter-base 공통 인터페이스 사용

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeWithCircuitBroker,
  normalizePathForShell,
  runProcess,
  shellQuote,
} from "./cli-adapter-base.mjs";
import { whichCommandAsync } from "./platform.mjs";

// ── Gemini-specific stall inference ─────────────────────────────

function inferStallMode(stdout, stderr) {
  const text = `${stdout}\n${stderr}`.toLowerCase();
  if (/(rate.?limit|quota|resource.?exhaust|429)/u.test(text))
    return "rate_limited";
  if (
    /(unauthorized|forbidden|auth|login|token|credential|api.?key)/u.test(text)
  )
    return "auth_stall";
  if (/\bmcp\b|playwright|tavily|brave|sequential|server/u.test(text))
    return "mcp_stall";
  return "timeout";
}

// ── Preflight ───────────────────────────────────────────────────

async function runPreflight(opts = {}) {
  const geminiPath = await whichCommandAsync("gemini");
  if (!geminiPath) {
    return {
      geminiPath: null,
      warnings: [
        "Gemini CLI not found. Install Gemini and ensure `gemini` is available on PATH.",
      ],
      excludeMcpServers: [],
      ok: false,
    };
  }

  const warnings = [];
  const excludeMcpServers = [];

  for (const name of Array.isArray(opts.mcpServers) ? opts.mcpServers : []) {
    const server = String(name ?? "").trim();
    if (!server) continue;
    // Gemini MCP health는 best-effort: 실행 시점에 --allowed-mcp-server-names로 필터링
    // 사전 probe는 수행하지 않음 (gemini가 자체적으로 graceful degrade)
  }

  return { geminiPath, warnings, excludeMcpServers, ok: true };
}

// ── Command building ────────────────────────────────────────────

function buildGeminiCommand(prompt, resultFile, opts = {}) {
  const parts = ["gemini"];

  if (opts.model) parts.push("--model", shellQuote(opts.model));
  parts.push("--yolo");

  const allowed = Array.isArray(opts.allowedMcpServers)
    ? opts.allowedMcpServers
    : [];
  const excluded = Array.isArray(opts.excludeMcpServers)
    ? opts.excludeMcpServers
    : [];
  const filtered = allowed.filter((name) => !excluded.includes(name));
  if (filtered.length) {
    parts.push(
      "--allowed-mcp-server-names",
      ...filtered.map((n) => shellQuote(n)),
    );
  }

  parts.push("--prompt", shellQuote(prompt));
  parts.push("--output-format", "text");

  if (resultFile) {
    return `${parts.join(" ")} > ${shellQuote(normalizePathForShell(resultFile))} 2>${shellQuote(normalizePathForShell(resultFile + ".err"))}`;
  }

  return parts.join(" ");
}

function buildAttempts(opts, preflight) {
  const timeout = Number.isFinite(opts.timeout) ? opts.timeout : 900_000;
  const base = {
    timeout,
    model: opts.model,
    allowedMcpServers: Array.isArray(opts.mcpServers)
      ? [...opts.mcpServers]
      : [],
    excludeMcpServers: [...(preflight.excludeMcpServers || [])],
  };
  if (opts.retryOnFail === false) return [base];
  return [base, { ...base, timeout: timeout * 2, allowedMcpServers: [] }];
}

// ── Public: buildExecArgs ───────────────────────────────────────

export function buildExecArgs(opts = {}) {
  const prompt = typeof opts.prompt === "string" ? opts.prompt : "";
  return buildGeminiCommand(prompt, opts.resultFile || null, {
    model: opts.model,
    allowedMcpServers: opts.mcpServers,
  });
}

// ── Execution ───────────────────────────────────────────────────

async function runGemini(prompt, workdir, preflight, attempt) {
  const dir = join(tmpdir(), "triflux-gemini-exec");
  mkdirSync(dir, { recursive: true });
  const resultFile = join(
    dir,
    `gemini-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );
  const command = buildGeminiCommand(prompt, resultFile, {
    model: attempt.model,
    allowedMcpServers: attempt.allowedMcpServers,
    excludeMcpServers: attempt.excludeMcpServers,
  });
  return runProcess(command, workdir, attempt.timeout, {
    resultFile,
    inferStallMode,
  });
}

// ── Public API ──────────────────────────────────────────────────

export async function getCircuitState() {
  const brokerMod = await import("./account-broker.mjs");
  if (!brokerMod.broker) return { state: "closed", failures: [] };
  const snap = brokerMod.broker
    .snapshot()
    .filter((a) => a.provider === "gemini");
  return snap.length
    ? { state: snap[0].circuitState, accounts: snap }
    : { state: "closed", failures: [] };
}

export function execute(opts = {}) {
  return executeWithCircuitBroker({
    provider: "gemini",
    runFn: runGemini,
    preflightFn: (o) => runPreflight({ mcpServers: o.mcpServers }),
    buildAttemptsFn: buildAttempts,
    opts,
  });
}
