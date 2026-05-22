// hub/gemini-adapter.mjs — legacy Gemini adapter compatibility layer
// The "gemini" route is retained as an alias, but execution is Antigravity/agy.

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeWithCircuitBroker,
  normalizePathForShell,
  runProcess,
} from "./cli-adapter-base.mjs";
import { whichCommandAsync } from "./platform.mjs";

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// ── Antigravity stall inference ─────────────────────────────────

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
  const agyPath = await whichCommandAsync("agy");
  if (!agyPath) {
    return {
      agyPath: null,
      warnings: [
        "Antigravity CLI not found. Install Antigravity and ensure `agy` is available on PATH.",
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
    // Antigravity MCP health는 best-effort: 실행 시점 probe는 수행하지 않음.
  }

  return { agyPath, warnings, excludeMcpServers, ok: true };
}

// ── Command building ────────────────────────────────────────────

function buildGeminiCommand(prompt, resultFile, opts = {}) {
  const parts = [
    "printf",
    "%s",
    shellSingleQuote(prompt),
    "|",
    "agy",
    "--print",
    "--dangerously-skip-permissions",
  ];

  if (resultFile) {
    return `${parts.join(" ")} > ${shellSingleQuote(normalizePathForShell(resultFile))} 2>${shellSingleQuote(normalizePathForShell(resultFile + ".err"))}`;
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

async function runGemini(prompt, workdir, preflight, attempt, lease) {
  const dir = join(tmpdir(), "triflux-antigravity-exec");
  mkdirSync(dir, { recursive: true });
  const resultFile = join(
    dir,
    `agy-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );
  const command = buildGeminiCommand(prompt, resultFile, {
    model: attempt.model,
    allowedMcpServers: attempt.allowedMcpServers,
    excludeMcpServers: attempt.excludeMcpServers,
  });
  // PRD A1: lease.env 가 있으면 spawn env 에 적용 (예: GOOGLE_API_KEY 등 account-specific
  // 환경변수). lease 가 null 이면 default 동작 유지 (부모 env inherit).
  const spawnEnv =
    lease?.env && typeof lease.env === "object"
      ? { ...process.env, ...lease.env }
      : undefined;
  return runProcess(command, workdir, attempt.timeout, {
    resultFile,
    inferStallMode,
    spawnEnv,
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
    // Account-broker still stores this compatibility bucket as "gemini";
    // execution itself is routed to agy above.
    provider: "gemini",
    runFn: runGemini,
    preflightFn: (o) => runPreflight({ mcpServers: o.mcpServers }),
    buildAttemptsFn: buildAttempts,
    opts,
  });
}
