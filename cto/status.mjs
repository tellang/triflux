import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { compactHygieneCounts, projectCtoHygiene } from "./hygiene.mjs";
import { resolveLakeRootDir } from "./lake-root.mjs";

const SCHEMA_VERSION = "cto-lake.v1";

function hasFlag(args, flag) {
  return Array.isArray(args) && args.includes(flag);
}

function writeJson(stdout, payload) {
  stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function projectStatus(current) {
  return {
    schema_version: current?.schema_version || SCHEMA_VERSION,
    generated_at: current?.generated_at || null,
    repo: current?.repo || {},
    sources: current?.sources || {},
    summary: current?.summary || {},
    ledger_tail: Array.isArray(current?.ledger_tail) ? current.ledger_tail : [],
    hygiene: compactHygieneCounts(projectCtoHygiene({ current })),
  };
}

function countAvailableSources(sources) {
  const values = Object.values(sources || {});
  return {
    available: values.filter((source) => source?.available === true).length,
    total: values.length,
  };
}

function countActiveGoals(current) {
  const sources = current?.sources || {};
  return Object.values(sources).reduce((count, source) => {
    const goals = source?.detail?.active_goals;
    return count + (Array.isArray(goals) ? goals.length : 0);
  }, 0);
}

function formatRepo(repo) {
  const branch = repo?.branch || "unknown";
  const head = repo?.head ? String(repo.head).slice(0, 12) : "unknown";
  const dirty = repo?.dirty ? "dirty" : "clean";
  return `${repo?.root || "unknown"} (${branch}@${head}, ${dirty})`;
}

function formatLedgerEntry(entry) {
  const ts = entry?.ts || "?";
  const event = entry?.event || "event";
  const summary = entry?.summary ? ` - ${entry.summary}` : "";
  return `${ts} ${event}${summary}`;
}

function formatSnapshotAge(generatedAt, now) {
  const ageMs = new Date(now).getTime() - Date.parse(generatedAt);
  if (!Number.isFinite(ageMs)) return "unknown age";
  if (ageMs < 0) return "in the future";
  for (const [unit, ms] of [
    ["d", 86400000],
    ["h", 3600000],
    ["m", 60000],
    ["s", 1000],
  ]) {
    if (ageMs >= ms || unit === "s")
      return `${Math.floor(ageMs / ms)}${unit} ago`;
  }
}

function renderHumanStatus(status, now) {
  const { available, total } = countAvailableSources(status.sources);
  const activeGoals = countActiveGoals(status);
  const recent = Array.isArray(status.ledger_tail)
    ? status.ledger_tail.slice(-2)
    : [];
  const lines = [
    `generated_at: ${status.generated_at || "unknown"} (${formatSnapshotAge(status.generated_at, now)})`,
    `repo: ${formatRepo(status.repo)}`,
    `sources: ${available}/${total} available`,
    `active: ${activeGoals} goals`,
  ];
  if (recent.length) {
    lines.push("ledger:");
    for (const entry of recent) lines.push(`- ${formatLedgerEntry(entry)}`);
  } else {
    lines.push("ledger: no recent events");
  }
  return `${lines.join("\n")}\n`;
}

export async function runStatus(args = [], opts = {}) {
  const rootDir = opts.rootDir || resolveLakeRootDir(process.cwd());
  const lakeRoot = opts.lakeRoot || join(rootDir, ".triflux", "lake");
  const stdout = opts.stdout || process.stdout;
  const jsonOut = opts.json === true || hasFlag(args, "--json");
  const currentPath = join(lakeRoot, "current.json");

  if (!existsSync(currentPath)) {
    const missing = {
      schema_version: SCHEMA_VERSION,
      available: false,
      hint: "run tfx cto collect",
    };
    if (jsonOut) writeJson(stdout, missing);
    else stdout.write("cto status unavailable: run tfx cto collect\n");
    return missing;
  }

  const current = readJson(currentPath);
  const status = projectStatus(current);

  if (jsonOut) writeJson(stdout, status);
  else stdout.write(renderHumanStatus(status, opts.now ?? Date.now()));

  return status;
}
