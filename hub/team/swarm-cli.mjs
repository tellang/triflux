// hub/team/swarm-cli.mjs — `tfx swarm` CLI handlers (#93)
// PRD를 planSwarm으로 분석하고 필요 시 createSwarmHypervisor로 실행한다.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createSwarmHypervisor } from "./swarm-hypervisor.mjs";
import { planSwarm } from "./swarm-planner.mjs";

const RESET = "\u001b[0m";
const BOLD = "\u001b[1m";
const GREEN = "\u001b[92m";
const RED = "\u001b[91m";
const YELLOW = "\u001b[93m";
const GRAY = "\u001b[90m";

export function parseFlags(args) {
  const flags = {
    dryRun: false,
    planOnly: false,
    json: false,
    filter: null,
    maxRestarts: 2,
    logsDir: null,
    baseBranch: "main",
  };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run" || a === "--plan-only") flags.dryRun = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--filter") flags.filter = args[++i];
    else if (a === "--max-restarts") flags.maxRestarts = Number(args[++i]) || 2;
    else if (a === "--logs-dir") flags.logsDir = args[++i];
    else if (a === "--base") {
      const v = args[++i];
      if (!v || /\s/.test(v)) {
        throw new Error(
          "--base requires a non-empty branch name without whitespace",
        );
      }
      flags.baseBranch = v;
    } else if (a.startsWith("--")) {
      // ignore unknown flags silently
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function planToJson(plan) {
  return {
    totalShards: plan.shards.length,
    shards: plan.shards.map((s) => ({
      name: s.name,
      agent: s.agent,
      host: s.host || null,
      files: s.files,
      depends: s.depends,
      critical: s.critical,
    })),
    leaseMap: Object.fromEntries(plan.leaseMap),
    mcpManifest: Object.fromEntries(plan.mcpManifest),
    mergeOrder: plan.mergeOrder,
    criticalShards: plan.criticalShards,
    conflicts: plan.conflicts,
    remoteSuggestion: plan.remoteSuggestion,
  };
}

function printPlan(plan) {
  console.log(`\n  ${BOLD}Swarm plan${RESET}: ${plan.shards.length} shards`);
  for (const s of plan.shards) {
    const hostStr = s.host ? `@${s.host}` : "";
    const critStr = s.critical ? ` ${YELLOW}[critical]${RESET}` : "";
    const depsStr = s.depends.length > 0 ? ` ← ${s.depends.join(", ")}` : "";
    console.log(
      `    - ${BOLD}${s.name}${RESET} [${s.agent}${hostStr}] files=${s.files.length}${critStr}${depsStr}`,
    );
  }
  console.log(`\n  ${GRAY}Merge order:${RESET} ${plan.mergeOrder.join(" → ")}`);
  if (plan.criticalShards.length > 0) {
    console.log(
      `  ${GRAY}Critical (redundant):${RESET} ${plan.criticalShards.join(", ")}`,
    );
  }
  if (plan.conflicts.length > 0) {
    console.log(`\n  ${YELLOW}⚠ File conflicts:${RESET}`);
    for (const c of plan.conflicts) {
      console.log(`    - ${c.file} → [${c.shards.join(", ")}]`);
    }
  }
}

/**
 * tfx swarm <prd-path> — PRD 실행
 */
export async function cmdSwarmRun(args, { json = false } = {}) {
  const { flags, positional } = parseFlags(args);
  flags.json = flags.json || json;

  const prdPath = positional[0];
  if (!prdPath) {
    throw new Error(
      "PRD path required. Usage: tfx swarm <prd-path> [--dry-run] [--filter <shard>] [--json] [--base <branch>]",
    );
  }
  const absPrd = resolve(prdPath);
  if (!existsSync(absPrd)) {
    throw new Error(`PRD file not found: ${absPrd}`);
  }

  const plan = planSwarm(absPrd, { repoRoot: process.cwd() });

  if (flags.dryRun) {
    if (flags.json) {
      process.stdout.write(JSON.stringify(planToJson(plan), null, 2) + "\n");
    } else {
      printPlan(plan);
    }
    return;
  }

  const logsDir =
    flags.logsDir ||
    join(process.cwd(), ".triflux", "swarm-logs", `run-${Date.now()}`);
  const hyper = createSwarmHypervisor({
    workdir: process.cwd(),
    logsDir,
    maxRestarts: flags.maxRestarts,
    baseBranch: flags.baseBranch,
  });

  hyper.on("shardLaunched", ({ shardName, sessionId, remote }) => {
    const tag = remote ? ` ${GRAY}(remote)${RESET}` : "";
    console.log(
      `  ${GREEN}▸${RESET} launched: ${shardName}${tag} [${sessionId}]`,
    );
  });
  hyper.on("shardCompleted", ({ shardName, sessionId, isRedundant }) => {
    const tag = isRedundant ? ` ${GRAY}(redundant)${RESET}` : "";
    console.log(`  ${GREEN}✓${RESET} ${shardName}${tag} [${sessionId}]`);
  });
  hyper.on("shardFailed", ({ shardName, failureMode, reason }) => {
    const reasonStr = reason ? ` ${GRAY}(${reason})${RESET}` : "";
    const modeStr = failureMode ? ` ${GRAY}[${failureMode}]${RESET}` : "";
    console.log(`  ${RED}✗${RESET} ${shardName}${modeStr}${reasonStr}`);
  });
  hyper.on("warning", ({ type, ...rest }) => {
    console.error(
      `  ${YELLOW}⚠${RESET} ${type}: ${JSON.stringify(rest).slice(0, 200)}`,
    );
  });

  console.log(
    `\n  ${BOLD}Launching swarm:${RESET} ${plan.shards.length} shards (logs: ${logsDir})`,
  );
  const run = await hyper.launch(plan);

  try {
    await run.done;
  } catch (err) {
    console.error(`  ${RED}integration failed:${RESET} ${err.message}`);
  }

  const status = hyper.getStatus();

  // #126: surface integration outcome in summary + exit code so silent
  // success failures (worker exit 0 + integration_failed) can't mask state.
  const ip = status.integrationPromise || {};
  const integratedCount = Array.isArray(ip.integrated) ? ip.integrated.length : 0;
  const integrationFailureCount = Array.isArray(ip.integrationFailures)
    ? ip.integrationFailures.length
    : 0;
  const finalState = status.state || "unknown";
  const isFailure =
    status.failedShards > 0 ||
    integrationFailureCount > 0 ||
    finalState === "failed";
  const stateColor = isFailure ? RED : GREEN;

  console.log(
    `\n  ${BOLD}Summary:${RESET} state=${stateColor}${finalState}${RESET} completed=${status.completedShards}/${status.totalShards} failed=${status.failedShards} integrated=${integratedCount} integration_failures=${integrationFailureCount}`,
  );

  if (integrationFailureCount > 0) {
    console.log(
      `  ${RED}integration failures:${RESET} ${ip.integrationFailures.join(", ")}`,
    );
  }

  if (flags.json) {
    process.stdout.write(JSON.stringify(status, null, 2) + "\n");
  }

  await hyper.shutdown("completed");
  if (isFailure) process.exitCode = 1;
}

/**
 * tfx swarm plan <prd-path> — dry-run (실행 없이 계획만 출력)
 */
export async function cmdSwarmPlan(args, { json = false } = {}) {
  return cmdSwarmRun(["--dry-run", ...args], { json });
}

/**
 * tfx swarm list — synapse status로 위임 (swarm 세션은 synapse registry에 등록)
 */
export async function cmdSwarmList(args, { json = false } = {}) {
  const { cmdSynapseStatus } = await import("./synapse-cli.mjs");
  return cmdSynapseStatus(args, { json });
}
