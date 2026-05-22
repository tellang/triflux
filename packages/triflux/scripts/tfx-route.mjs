#!/usr/bin/env node

// tfx-route.mjs — Node 단일 진입점 (Phase 1).
//
// 외부 인터페이스는 tfx-route.sh 와 동일한 positional 인자 (agent, prompt, [mcp], [timeout],
// [context]) + 동일한 플래그 (--async, --job-status, --job-result, --version). Phase 0 는
// 라우팅 결정 (agent → CLI 타입 → adapter plan) 만 Node 에서 수행하고, 실제 spawn 은
// TFX_ROUTE_NODE_BYPASS=1 로 tfx-route.sh 를 재호출하여 위임한다.
//
// 활성화: TFX_ROUTE_NODE=1 환경변수가 설정되면 tfx-route.sh 의 게이트웨이가 이 파일로
// exec 한다 (.triflux/plans/node-cli-single-entry-migration.md Phase 0).
//
// Phase 1 부터 timeout/TMP/PID/Async/Quota 등 16개 책임을 직접 흡수한다.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJob, getJobResult, getJobStatus } from "./lib/async.mjs";
import * as agyAdapter from "./lib/cli-agy.mjs";
import * as claudeAdapter from "./lib/cli-claude.mjs";
import * as codexAdapter from "./lib/cli-codex.mjs";
import { buildPreflightEnv } from "./lib/env.mjs";
import { resolveJobsDir, resolveTmpDir } from "./lib/tmp.mjs";
import { patchCodexConfigFile } from "./lib/toml.mjs";

export const MJS_VERSION = "0.2.0-phase1";
const MIN_NODE_MAJOR = 18;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const AGENT_MAP_PATH = join(REPO_ROOT, "hub/team/agent-map.json");

const ADAPTERS = {
  codex: codexAdapter,
  gemini: agyAdapter,
  claude: claudeAdapter,
  "claude-native": claudeAdapter,
  antigravity: agyAdapter,
  agy: agyAdapter,
};

const RESERVED_TFX_COMMANDS = new Set(["multi", "team", "codex-team"]);

function reservedCommandError(command) {
  return [
    `'${command}' is a tfx CLI subcommand, not a tfx-route agent.`,
    "Use `tfx multi ...` for team/headless dispatch.",
    "macOS/Linux headless uses tmux; Windows uses psmux.",
  ].join(" ");
}

export function preflightNodeVersion(versionString = process.versions.node) {
  const major = Number(versionString.split(".")[0]);
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    throw new Error(
      `Node.js v${MIN_NODE_MAJOR}+ required (current: v${versionString})`,
    );
  }
  return major;
}

export function loadAgentMap(path = AGENT_MAP_PATH) {
  if (!existsSync(path)) {
    throw new Error(`agent-map.json not found at ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

export function resolveCliTypeForAgent(agent, agentMap) {
  if (RESERVED_TFX_COMMANDS.has(String(agent || "").toLowerCase())) {
    throw new Error(reservedCommandError(agent));
  }
  const raw = agentMap[agent];
  if (!raw) {
    throw new Error(`Unknown agent type: ${agent}`);
  }
  return raw === "claude" ? "claude-native" : raw;
}

export function selectAdapter(cliType) {
  const adapter = ADAPTERS[cliType];
  if (!adapter) {
    throw new Error(`No adapter registered for CLI type: ${cliType}`);
  }
  return adapter;
}

export function parseArgs(argv) {
  const args = [...argv];
  const result = { mode: "run", dryRun: false };

  // -h shorthand 는 short-flag 라 아래 `--` while 루프에 안 잡힌다.
  if (args[0] === "-h") {
    return { ...result, mode: "help" };
  }

  while (args.length > 0 && args[0].startsWith("--")) {
    const flag = args.shift();
    switch (flag) {
      case "--version":
        return { ...result, mode: "version" };
      case "--help":
        return { ...result, mode: "help" };
      case "--async":
        result.mode = "async";
        break;
      case "--job-status":
        return { ...result, mode: "job-status", jobId: args.shift() };
      case "--job-result":
        return { ...result, mode: "job-result", jobId: args.shift() };
      case "--route-print":
        result.mode = "route-print";
        result.dryRun = true;
        break;
      default:
        throw new Error(`Unknown flag: ${flag}`);
    }
  }

  if (result.mode === "version" || result.mode === "help") {
    return result;
  }

  const [
    agent,
    prompt,
    mcpProfile = "auto",
    timeoutRaw = "",
    contextFile = "",
  ] = args;

  if (!agent) {
    throw new Error("Agent type required (executor, debugger, designer, ...)");
  }
  if (prompt === undefined || prompt === null) {
    throw new Error("Prompt required");
  }
  if (mcpProfile.startsWith("--")) {
    throw new Error(`MCP profile (3rd arg) cannot be a flag: ${mcpProfile}`);
  }

  const timeoutSec = timeoutRaw === "" ? undefined : Number(timeoutRaw);
  if (timeoutRaw !== "" && !Number.isFinite(timeoutSec)) {
    throw new Error(`timeout_sec must be numeric, got: ${timeoutRaw}`);
  }

  return {
    ...result,
    agent,
    prompt,
    mcpProfile,
    timeoutSec,
    contextFile: contextFile || undefined,
  };
}

export function buildRoutePlan(request, agentMap) {
  const cliType = resolveCliTypeForAgent(request.agent, agentMap);
  const adapter = selectAdapter(cliType);
  const adapterPlan = adapter.plan({
    agent: request.agent,
    prompt: request.prompt ?? "",
    mcpProfile: request.mcpProfile ?? "auto",
    timeoutSec: request.timeoutSec,
    contextFile: request.contextFile,
  });
  return {
    agent: request.agent,
    cliType,
    adapter: adapter.id,
    ...adapterPlan,
  };
}

function helpText() {
  return [
    `tfx-route.mjs ${MJS_VERSION} — Phase 0 PoC (Node single entry)`,
    "",
    "Usage:",
    "  tfx-route.mjs <agent_type> <prompt> [mcp_profile] [timeout_sec] [context_file]",
    "  tfx-route.mjs --async <agent_type> <prompt> [mcp_profile] [timeout_sec] [context_file]",
    "  tfx-route.mjs --job-status <job_id>",
    "  tfx-route.mjs --job-result <job_id>",
    "  tfx-route.mjs --route-print <agent_type> <prompt> ...   (dry-run, prints JSON plan)",
    "  tfx-route.mjs --version",
    "",
    "Phase 1: cross-cutting process concerns live in Node; detailed CLI dispatch",
    "is still delegated to tfx-route.sh until Phase 2.",
    "",
  ].join("\n");
}

function delegateToBash(argv) {
  const bashScript = join(SCRIPT_DIR, "tfx-route.sh");
  if (!existsSync(bashScript)) {
    process.stderr.write(
      `[tfx-route.mjs] bash entry not found at ${bashScript}\n`,
    );
    process.exit(2);
  }
  const env = { ...process.env, TFX_ROUTE_NODE_BYPASS: "1" };
  const child = spawn("bash", [bashScript, ...argv], {
    stdio: "inherit",
    env,
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      try {
        process.kill(process.pid, signal);
      } catch {
        process.exit(1);
      }
    } else {
      process.exit(code ?? 1);
    }
  });
  child.on("error", (err) => {
    process.stderr.write(
      `[tfx-route.mjs] bash delegate failed: ${err.message}\n`,
    );
    process.exit(1);
  });
}

async function main(argv) {
  preflightNodeVersion();
  const request = parseArgs(argv);

  if (request.mode === "version") {
    process.stdout.write(`tfx-route.mjs ${MJS_VERSION}\n`);
    return;
  }
  if (request.mode === "help") {
    process.stdout.write(helpText());
    return;
  }

  if (request.mode === "job-status" || request.mode === "job-result") {
    const tmpDir = resolveTmpDir();
    const jobsDir = resolveJobsDir({ tmpDir });
    if (!request.jobId) {
      throw new Error("job_id required");
    }
    if (request.mode === "job-status") {
      const status = getJobStatus(request.jobId, { jobsDir });
      process.stdout.write(`${status.text}\n`);
      if (status.state === "error") process.exit(1);
      return;
    }
    const result = getJobResult(request.jobId, { jobsDir });
    process.stdout.write(result.stdout);
    process.exitCode = result.exitCode;
    return;
  }

  if (request.mode === "async") {
    const tmpDir = resolveTmpDir();
    const jobsDir = resolveJobsDir({ tmpDir });
    const childArgv = argv.filter((arg) => arg !== "--async");
    const job = createJob({
      jobsDir,
      command: process.execPath,
      args: [fileURLToPath(import.meta.url), ...childArgv],
      env: { ...buildPreflightEnv(process.env), TFX_ROUTE_NODE: "1" },
      cwd: process.cwd(),
      timeoutMs: request.timeoutSec ? request.timeoutSec * 1000 : 0,
    });
    process.stdout.write(`${job.id}\n`);
    return;
  }

  const agentMap = loadAgentMap();
  const plan = buildRoutePlan(request, agentMap);

  if (request.mode === "route-print") {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }

  patchCodexConfigFile(join(homedir(), ".codex", "config.toml"));

  process.stderr.write(
    `[tfx-route.mjs] Phase 1: agent=${plan.agent} cli=${plan.cliType} effort=${plan.effort} — bash lane retained for CLI dispatch\n`,
  );
  delegateToBash(argv);
}

const invokedDirectly =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    await main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`[tfx-route.mjs] ${err.message}\n`);
    process.exit(1);
  }
}
