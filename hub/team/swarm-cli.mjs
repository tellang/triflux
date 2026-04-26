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

/**
 * #116-C: non-TTY background 환경에서 `tfx swarm` 실행 시 codex worker spawn 이
 * 무한 hang 가능성이 있다 (stdin TTY 대기 또는 hub MCP lease race).
 *
 * Policy (v10.15+):
 * - stdout 또는 stdin 중 하나라도 TTY → silent OK (기존 동작).
 * - 양측 non-TTY → warning + 진행 (기본, 사용자 친화 + CI/background 호환).
 * - `TFX_BLOCK_NON_TTY_SWARM=1` opt-out → fail-fast + 복구 경로 안내 (안전 망).
 * - `TFX_ALLOW_NON_TTY_SWARM=1` 은 silent OK (호환 유지, warning suppress).
 *
 * 기존 fail-fast 정책은 첫 사용자에게 묻기 효과 (실제 user terminal 은 TTY 인데
 * Claude Code run_in_background 같은 spawn 환경에서 child stdio 는 non-TTY).
 * 다른 사용자도 동일 마찰 → 기본 동작을 "proceed with warning" 으로 변경.
 *
 * @param {{
 *   stdoutIsTTY?: boolean,
 *   stdinIsTTY?: boolean,
 *   env?: Record<string,string|undefined>,
 * }} [deps]
 * @returns {{ ok: boolean, optIn: boolean, warnings: string[], reason?: string }}
 */
export function assertTtyForSwarm(deps = {}) {
  const stdoutIsTTY =
    typeof deps.stdoutIsTTY === "boolean"
      ? deps.stdoutIsTTY
      : Boolean(process.stdout.isTTY);
  const stdinIsTTY =
    typeof deps.stdinIsTTY === "boolean"
      ? deps.stdinIsTTY
      : Boolean(process.stdin.isTTY);
  const env = deps.env || process.env;
  const warnings = [];

  if (stdoutIsTTY || stdinIsTTY) {
    return { ok: true, optIn: false, warnings };
  }

  // 양측 non-TTY 부터 적용되는 정책.
  if (env.TFX_BLOCK_NON_TTY_SWARM === "1") {
    const reason =
      "tfx swarm 이 차단됨 — non-TTY 환경 + TFX_BLOCK_NON_TTY_SWARM=1 (#116-C).\n" +
      "  복구 경로:\n" +
      "    1) 터미널에서 직접 실행: tfx swarm <prd>\n" +
      "    2) TFX_BLOCK_NON_TTY_SWARM=0 (또는 unset) 으로 차단 해제 후 재시도";
    return { ok: false, optIn: false, warnings, reason };
  }

  if (env.TFX_ALLOW_NON_TTY_SWARM === "1") {
    // 명시 opt-in — silent OK (기존 호환, warning 미출력).
    return { ok: true, optIn: true, warnings };
  }

  warnings.push(
    "non-TTY 환경 감지 — codex worker spawn hang 가능성 존재 (#116-C). 차단하려면 TFX_BLOCK_NON_TTY_SWARM=1.",
  );
  return { ok: true, optIn: true, warnings };
}

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

  const ttyGate = assertTtyForSwarm();
  for (const w of ttyGate.warnings) {
    console.error(`  ${YELLOW}⚠${RESET} ${w}`);
  }
  if (!ttyGate.ok) {
    throw new Error(ttyGate.reason);
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
  const integratedCount = Array.isArray(ip.integrated)
    ? ip.integrated.length
    : 0;
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
