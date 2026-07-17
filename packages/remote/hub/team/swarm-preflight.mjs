// hub/team/swarm-preflight.mjs — PRD swarm preflight report/gate (#188)
// Predicts launch-time blockers before any worker session or worktree spawn.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { readHosts, resolveHost } from "@triflux/core/hub/lib/hosts-compat.mjs";
import { whichCommand } from "@triflux/core/hub/platform.mjs";
import { MCP_CATALOG } from "./mcp-selector.mjs";
import { DEFAULT_SENSITIVE_DENY } from "./swarm-locks.mjs";
import { planSwarm } from "./swarm-planner.mjs";

const AGENT_COMMANDS = Object.freeze({
  codex: "codex",
  gemini: "agy",
  antigravity: "agy",
  agy: "agy",
  claude: "claude",
});

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizePath(filePath) {
  return String(filePath || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//u, "");
}

function isSensitiveFile(filePath, sensitiveDeny = DEFAULT_SENSITIVE_DENY) {
  const path = normalizePath(filePath);
  const files = new Set(sensitiveDeny.files || []);
  const prefixes = sensitiveDeny.prefixes || [];
  return files.has(path) || prefixes.some((prefix) => path.startsWith(prefix));
}

function planToJson(plan) {
  return {
    totalShards: plan.shards.length,
    shards: plan.shards.map((s) => ({
      name: s.name,
      agent: s.agent,
      host: s.host || null,
      files: [...s.files],
      mcp: [...s.mcp],
      depends: [...s.depends],
      critical: s.critical,
    })),
    leaseMap: Object.fromEntries(plan.leaseMap),
    mcpManifest: Object.fromEntries(plan.mcpManifest),
    mergeOrder: [...plan.mergeOrder],
    criticalShards: [...plan.criticalShards],
    conflicts: [...plan.conflicts],
    remoteSuggestion: plan.remoteSuggestion,
  };
}

function makeCheck(name, ok, details = {}) {
  return { name, ok: Boolean(ok), ...details };
}

function buildLeaseTable(plan, repoRoot) {
  return plan.shards.map((shard) => ({
    shard: shard.name,
    host: shard.host || null,
    worktreePath: resolve(repoRoot, ".codex-swarm", `wt-${shard.name}`),
    files: [...shard.files],
  }));
}

function checkSensitive(plan, sensitiveDeny) {
  const matches = [];
  for (const shard of plan.shards) {
    for (const file of shard.files) {
      if (!isSensitiveFile(file, sensitiveDeny)) continue;
      matches.push({
        shard: shard.name,
        file,
        kind: "sensitive-planned-lease",
        severity: "warning",
      });
    }
  }
  return makeCheck("sensitiveDeny", true, { matches });
}

function parseTrackedStatus(rawStatus) {
  const files = [];
  const records = String(rawStatus || "").split("\0");
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    files.push(normalizePath(record.slice(3)));
    if (/[RC]/u.test(status) && records[index + 1]) {
      files.push(normalizePath(records[++index]));
    }
  }
  return unique(files);
}

function checkRootDirtyLease(plan, repoRoot, deps = {}) {
  const gitStatus =
    deps.gitStatus ||
    ((cwd) =>
      execFileSync(
        "git",
        ["status", "--porcelain=v1", "-z", "--untracked-files=no"],
        { cwd, encoding: "utf8", windowsHide: true },
      ));
  const dirtyFiles = parseTrackedStatus(gitStatus(repoRoot));
  const leasedFiles = unique(
    [...plan.leaseMap.values()].flat().map(normalizePath),
  );
  const leaseSet = new Set(leasedFiles);
  const overlappingFiles = dirtyFiles.filter((file) => leaseSet.has(file));

  return makeCheck("rootDirtyLease", overlappingFiles.length === 0, {
    dirtyFiles,
    leasedFiles,
    overlappingFiles,
  });
}

function checkHosts(plan, repoRoot) {
  const registry = readHosts(repoRoot);
  const missing = [];
  const capabilityWarnings = [];

  for (const shard of plan.shards) {
    if (!shard.host) continue;
    const resolvedHost = resolveHost(shard.host, repoRoot);
    if (!resolvedHost) {
      missing.push({ shard: shard.name, host: shard.host });
      continue;
    }
    const capabilities = resolvedHost.host.capabilities || [];
    if (shard.agent && !capabilities.includes(shard.agent)) {
      capabilityWarnings.push({
        shard: shard.name,
        host: shard.host,
        agent: shard.agent,
        capabilities,
      });
    }
  }

  return makeCheck("hosts", missing.length === 0, {
    registryPath: registry.path,
    missing,
    warnings: capabilityWarnings,
  });
}

function checkLocalWorkerClis(plan, deps = {}) {
  const which = deps.whichCommand || whichCommand;
  const missing = [];
  const present = [];
  const checked = new Map();

  for (const shard of plan.shards) {
    if (shard.host) continue;
    const command = AGENT_COMMANDS[shard.agent] || shard.agent;
    if (!command) {
      missing.push({ shard: shard.name, agent: shard.agent, command: null });
      continue;
    }
    if (!checked.has(command)) {
      checked.set(command, which(command, deps.whichOptions || {}));
    }
    const path = checked.get(command);
    if (path)
      present.push({ shard: shard.name, agent: shard.agent, command, path });
    else missing.push({ shard: shard.name, agent: shard.agent, command });
  }

  return makeCheck("workerCli", missing.length === 0, { present, missing });
}

function checkMcp(plan) {
  const catalog = new Map(MCP_CATALOG.map((entry) => [entry.name, entry]));
  const unknown = [];
  const incompatible = [];

  for (const shard of plan.shards) {
    for (const server of shard.mcp) {
      const entry = catalog.get(server);
      if (!entry) {
        unknown.push({ shard: shard.name, server });
        continue;
      }
      if (
        ["codex", "gemini"].includes(shard.agent) &&
        !entry.cli.includes(shard.agent)
      ) {
        incompatible.push({
          shard: shard.name,
          agent: shard.agent,
          server,
          supportedCli: [...entry.cli],
        });
      }
    }
  }

  return makeCheck("mcp", incompatible.length === 0, { unknown, incompatible });
}

function collectMessages(checks) {
  const errors = [];
  const warnings = [];

  const leases = checks.leases;
  for (const conflict of leases.conflicts || []) {
    errors.push(
      `lease conflict: ${conflict.file} assigned to ${conflict.shards.join(", ")}`,
    );
  }

  const hosts = checks.hosts;
  for (const missing of hosts.missing || []) {
    errors.push(
      `missing host: shard ${missing.shard} references ${missing.host}`,
    );
  }
  for (const warn of hosts.warnings || []) {
    warnings.push(
      `host capability warning: ${warn.host} does not advertise ${warn.agent} for shard ${warn.shard}`,
    );
  }

  const workerCli = checks.workerCli;
  for (const missing of workerCli.missing || []) {
    errors.push(
      `missing local worker CLI: shard ${missing.shard} requires ${missing.command || missing.agent}`,
    );
  }

  const mcp = checks.mcp;
  for (const item of mcp.incompatible || []) {
    errors.push(
      `MCP incompatibility: ${item.server} is not supported by ${item.agent} for shard ${item.shard}`,
    );
  }
  for (const item of mcp.unknown || []) {
    warnings.push(
      `unknown MCP server: ${item.server} requested by shard ${item.shard}`,
    );
  }

  const sensitive = checks.sensitiveDeny;
  for (const item of sensitive.matches || []) {
    warnings.push(
      `sensitive path planned lease: ${item.file} owned by shard ${item.shard}`,
    );
  }

  const rootDirtyLease = checks.rootDirtyLease;
  if (rootDirtyLease && !rootDirtyLease.ok) {
    errors.push(
      `rootDir tracked changes overlap shard leases: ${rootDirtyLease.overlappingFiles.join(", ")}`,
    );
  }

  return { errors: unique(errors), warnings: unique(warnings) };
}

/**
 * Build a no-side-effect preflight report for a swarm PRD.
 *
 * @param {string} prdPath
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @param {object} [opts.deps]
 * @returns {object}
 */
export function runSwarmPreflight(prdPath, opts = {}) {
  const repoRoot = opts.repoRoot || process.cwd();
  const absPrd = resolve(prdPath);
  const sensitiveDeny = opts.sensitiveDeny || DEFAULT_SENSITIVE_DENY;
  let plan;

  try {
    plan = (opts.deps?.planSwarm || planSwarm)(absPrd, { repoRoot });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      verdict: "no-go",
      prdPath: absPrd,
      repoRoot,
      checks: {
        plan: makeCheck("plan", false, { error: message }),
      },
      errors: [message],
      warnings: [],
      plan: null,
      leaseTable: [],
    };
  }

  const checks = {
    plan: makeCheck("plan", true),
    leases: makeCheck("leases", plan.conflicts.length === 0, {
      conflicts: [...plan.conflicts],
    }),
    rootDirtyLease: checkRootDirtyLease(plan, repoRoot, opts.deps),
    sensitiveDeny: checkSensitive(plan, sensitiveDeny),
    hosts: checkHosts(plan, repoRoot),
    workerCli: checkLocalWorkerClis(plan, opts.deps),
    mcp: checkMcp(plan),
  };
  const { errors, warnings } = collectMessages(checks);
  const ok = Object.values(checks).every((check) => check.ok);

  return {
    ok,
    verdict: ok ? "go" : "no-go",
    prdPath: absPrd,
    repoRoot,
    checks,
    errors,
    warnings,
    plan: planToJson(plan),
    leaseTable: buildLeaseTable(plan, repoRoot),
  };
}

export function formatPreflightReport(report) {
  const lines = [`SWARM PREFLIGHT: ${report.verdict.toUpperCase()}`];

  if (report.plan) {
    lines.push(`PRD: ${report.prdPath}`);
    lines.push(`Shards: ${report.plan.totalShards}`);
    lines.push("");
    lines.push("Lease table:");
    for (const lease of report.leaseTable) {
      const host = lease.host ? ` @${lease.host}` : "";
      lines.push(`  - ${lease.shard}${host}`);
      lines.push(`    worktree: ${lease.worktreePath}`);
      lines.push(
        `    files: ${lease.files.length ? lease.files.join(", ") : "(none)"}`,
      );
    }
  }

  lines.push("");
  lines.push("Checks:");
  for (const [name, check] of Object.entries(report.checks || {})) {
    lines.push(`  ${check.ok ? "✓" : "✗"} ${name}`);
  }

  if (report.errors?.length) {
    lines.push("");
    lines.push("Blocking errors:");
    for (const error of report.errors) lines.push(`  - ${error}`);
  }

  if (report.warnings?.length) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of report.warnings) lines.push(`  - ${warning}`);
  }

  return `${lines.join("\n")}\n`;
}
