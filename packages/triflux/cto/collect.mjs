import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { renderBrief } from "./brief.mjs";

const SCHEMA_VERSION = "cto-lake.v1";
const SOURCE_IDS = [
  "git",
  "tfx_hub",
  "tfx_swarm",
  "tfx_team",
  "tfx_synapse",
  "ultragoal_omx",
  "ultragoal_omc",
  "handoffs",
  "session_vault",
  "agy",
  "gbrain",
];

const SCHEMA_PATH = fileURLToPath(
  new URL("./current.schema.json", import.meta.url),
);

function isoNow(opts) {
  const value =
    opts.now instanceof Date
      ? opts.now
      : opts.now
        ? new Date(opts.now)
        : new Date();
  return value.toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sourceState(available, status, detail, collectedAt) {
  return {
    available,
    status,
    detail,
    collected_at: collectedAt,
  };
}

function missingSource(status, detail, collectedAt) {
  return sourceState(false, status, detail, collectedAt);
}

function relPath(rootDir, filePath) {
  const rel = relative(rootDir, filePath).replace(/\\/g, "/");
  return rel && !rel.startsWith("..") ? rel : filePath;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function readJsonLines(filePath, limit = 20) {
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-limit).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

function findFirstExisting(candidates) {
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function listDirFiles(dirPath, rootDir, limit = 10) {
  if (!existsSync(dirPath)) return [];
  try {
    return readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const filePath = join(dirPath, entry.name);
        return {
          path: relPath(rootDir, filePath),
          mtime: statSync(filePath).mtime.toISOString(),
        };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime))
      .slice(0, limit);
  } catch {
    return [];
  }
}

function safeSummary(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return { type: "array", count: value.length };
  if (typeof value === "object")
    return { type: "object", keys: Object.keys(value).slice(0, 20) };
  return String(value).slice(0, 200);
}

function execGit(args, rootDir, execFileSyncFn) {
  return execFileSyncFn("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

function collectGit(rootDir, collectedAt, execFileSyncFn) {
  try {
    const gitRoot = execGit(
      ["rev-parse", "--show-toplevel"],
      rootDir,
      execFileSyncFn,
    );
    const branch =
      execGit(["branch", "--show-current"], gitRoot, execFileSyncFn) || null;
    const head =
      execGit(["rev-parse", "--short=12", "HEAD"], gitRoot, execFileSyncFn) ||
      null;
    const porcelain = execGit(
      ["status", "--porcelain"],
      gitRoot,
      execFileSyncFn,
    );
    const dirty = porcelain.length > 0;
    const repo = { root: gitRoot, branch, head, dirty };
    return {
      repo,
      source: sourceState(
        true,
        dirty ? "dirty" : "clean",
        {
          branch,
          head,
          dirty,
          changed_entries: porcelain ? porcelain.split(/\r?\n/u).length : 0,
        },
        collectedAt,
      ),
    };
  } catch (error) {
    return {
      repo: { root: rootDir, branch: null, head: null, dirty: false },
      source: missingSource(
        "unavailable",
        `git status unavailable: ${error?.message || "unknown error"}`,
        collectedAt,
      ),
    };
  }
}

function collectJsonArtifact(
  id,
  candidates,
  rootDir,
  collectedAt,
  summarize = safeSummary,
) {
  const filePath = findFirstExisting(candidates);
  if (!filePath) {
    return missingSource(
      "no_shell_readable_artifact",
      "no durable artifact found",
      collectedAt,
    );
  }
  try {
    const parsed = readJson(filePath);
    return sourceState(
      true,
      "ok",
      {
        path: relPath(rootDir, filePath),
        summary: summarize(parsed),
      },
      collectedAt,
    );
  } catch (error) {
    return sourceState(
      true,
      "read_error",
      {
        path: relPath(rootDir, filePath),
        error: error?.message || `${id} artifact read failed`,
      },
      collectedAt,
    );
  }
}

function normalizeGoals(parsed) {
  const rawGoals = Array.isArray(parsed?.goals)
    ? parsed.goals
    : Array.isArray(parsed)
      ? parsed
      : [];
  return rawGoals.map((goal) => ({
    id: goal?.id || null,
    title: goal?.title || goal?.objective || goal?.summary || null,
    status: goal?.status || "unknown",
    updated_at: goal?.updatedAt || goal?.updated_at || null,
  }));
}

function collectUltragoal(dirPath, rootDir, collectedAt) {
  const goalsPath = join(dirPath, "goals.json");
  const ledgerPath = join(dirPath, "ledger.jsonl");
  const briefPath = join(dirPath, "brief.md");
  if (
    !existsSync(goalsPath) &&
    !existsSync(ledgerPath) &&
    !existsSync(briefPath)
  ) {
    return missingSource(
      "no_shell_readable_artifact",
      "no ultragoal files found",
      collectedAt,
    );
  }

  const detail = {
    paths: {},
    goals_count: 0,
    active_goals: [],
    ledger_tail: [],
    brief: null,
  };

  try {
    if (existsSync(goalsPath)) {
      detail.paths.goals = relPath(rootDir, goalsPath);
      const parsed = readJson(goalsPath);
      const goals = normalizeGoals(parsed);
      detail.goals_count = goals.length;
      detail.active_goals = goals
        .filter(
          (goal) =>
            !["complete", "completed", "done"].includes(
              String(goal.status).toLowerCase(),
            ),
        )
        .slice(0, 5);
    }
    if (existsSync(ledgerPath)) {
      detail.paths.ledger = relPath(rootDir, ledgerPath);
      detail.ledger_tail = readJsonLines(ledgerPath, 5);
    }
    if (existsSync(briefPath)) {
      detail.paths.brief = relPath(rootDir, briefPath);
      detail.brief = readFileSync(briefPath, "utf8")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300);
    }
    return sourceState(true, "ok", detail, collectedAt);
  } catch (error) {
    return sourceState(
      true,
      "read_error",
      {
        path: relPath(rootDir, dirPath),
        error: error?.message || "ultragoal read failed",
      },
      collectedAt,
    );
  }
}

function collectSwarm(rootDir, collectedAt) {
  const locksPath = join(rootDir, ".triflux", "swarm-locks.json");
  const logsDir = join(rootDir, ".triflux", "swarm-logs");
  if (!existsSync(locksPath) && !existsSync(logsDir)) {
    return missingSource(
      "no_shell_readable_artifact",
      "no swarm locks or logs found",
      collectedAt,
    );
  }
  try {
    const detail = { locks_path: null, locks: null, shards: [], log_runs: [] };
    if (existsSync(locksPath)) {
      const locks = readJson(locksPath);
      detail.locks_path = relPath(rootDir, locksPath);
      detail.locks = safeSummary(locks);
      if (Array.isArray(locks?.shards)) detail.shards = locks.shards;
      else if (Array.isArray(locks)) detail.shards = locks;
    }
    if (existsSync(logsDir)) {
      detail.log_runs = readdirSync(logsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("run-"))
        .map((entry) => {
          const path = join(logsDir, entry.name);
          return { id: entry.name, mtime: statSync(path).mtime.toISOString() };
        })
        .sort((a, b) => b.mtime.localeCompare(a.mtime))
        .slice(0, 5);
    }
    return sourceState(true, "ok", detail, collectedAt);
  } catch (error) {
    return sourceState(
      true,
      "read_error",
      error?.message || "swarm read failed",
      collectedAt,
    );
  }
}

function collectHandoffs(rootDir, collectedAt) {
  const dirPath = join(rootDir, ".omx", "handoffs");
  const files = listDirFiles(dirPath, rootDir, 10);
  if (files.length === 0) {
    return missingSource(
      "no_shell_readable_artifact",
      "no .omx/handoffs files found",
      collectedAt,
    );
  }
  return sourceState(
    true,
    "ok",
    { path: relPath(rootDir, dirPath), files },
    collectedAt,
  );
}

function collectDurableRefs(
  id,
  candidates,
  rootDir,
  collectedAt,
  unavailableStatus = "no_shell_readable_artifact",
) {
  const filePath = findFirstExisting(candidates);
  if (!filePath) {
    return missingSource(
      unavailableStatus,
      `${id} exposes no shell-readable durable artifact`,
      collectedAt,
    );
  }
  try {
    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      return sourceState(
        true,
        "ok",
        {
          path: relPath(rootDir, filePath),
          files: listDirFiles(filePath, rootDir, 10),
        },
        collectedAt,
      );
    }
    const parsed = basename(filePath).endsWith(".json")
      ? readJson(filePath)
      : readFileSync(filePath, "utf8");
    return sourceState(
      true,
      "ok",
      {
        path: relPath(rootDir, filePath),
        summary: safeSummary(parsed),
      },
      collectedAt,
    );
  } catch (error) {
    return sourceState(
      true,
      "read_error",
      {
        path: relPath(rootDir, filePath),
        error: error?.message || `${id} read failed`,
      },
      collectedAt,
    );
  }
}

function buildSummary(current) {
  const repo = current.repo;
  const omxGoals = current.sources.ultragoal_omx.detail?.active_goals || [];
  const omcGoals = current.sources.ultragoal_omc.detail?.active_goals || [];
  const swarmShards = current.sources.tfx_swarm.detail?.shards || [];
  const availableSources = Object.values(current.sources).filter(
    (source) => source.available,
  ).length;

  return {
    repo_state: `branch ${repo.branch || "unknown"} at ${repo.head || "unknown"} is ${repo.dirty ? "dirty" : "clean"}`,
    active_goals: [...omxGoals, ...omcGoals].slice(0, 5),
    swarm_shards: Array.isArray(swarmShards) ? swarmShards.slice(0, 5) : [],
    hub_status: current.sources.tfx_hub.status,
    available_sources: availableSources,
    missing_sources: SOURCE_IDS.length - availableSources,
  };
}

function readLedgerTail(lakeRoot, limit = 5) {
  return readJsonLines(join(lakeRoot, "ledger.jsonl"), limit);
}

function validateCurrent(current) {
  const schema = readJson(SCHEMA_PATH);
  for (const field of schema.required) {
    if (!Object.hasOwn(current, field))
      throw new Error(`current.json missing ${field}`);
  }
  if (current.schema_version !== SCHEMA_VERSION) {
    throw new Error(`current.json schema_version must be ${SCHEMA_VERSION}`);
  }
  for (const sourceId of schema.properties.sources.required) {
    const source = current.sources?.[sourceId];
    if (!source) throw new Error(`current.json missing source ${sourceId}`);
    for (const field of schema.$defs.sourceState.required) {
      if (!Object.hasOwn(source, field)) {
        throw new Error(`current.json source ${sourceId} missing ${field}`);
      }
    }
  }
  if (!Array.isArray(current.ledger_tail))
    throw new Error("current.json ledger_tail must be array");
  for (const entry of current.ledger_tail) {
    for (const field of schema.$defs.ledgerEntry.required) {
      if (!Object.hasOwn(entry, field))
        throw new Error(`ledger_tail entry missing ${field}`);
    }
  }
}

function writeAtomic(filePath, body) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  writeFileSync(tmpPath, body, "utf8");
  renameSync(tmpPath, filePath);
}

async function appendLedgerEvent(lakeRoot, event, stderr) {
  mkdirSync(lakeRoot, { recursive: true });
  const ledgerPath = join(lakeRoot, "ledger.jsonl");
  const lockPath = join(lakeRoot, "ledger.jsonl.lock");
  let fd = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fd = openSync(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (attempt < 2) await sleep(100);
    }
  }
  if (fd === null) {
    stderr.write(
      "[tfx cto collect] warning: ledger lock timeout; skipped ledger append\n",
    );
    return false;
  }

  try {
    appendFileSync(ledgerPath, `${JSON.stringify(event)}\n`, "utf8");
    return true;
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {}
  }
}

function collectSources(rootDir, collectedAt, execFileSyncFn, opts = {}) {
  const home = homedir();
  const hostArtifactCandidates =
    opts.includeHostArtifacts === false
      ? {
          hub: [],
          team: [],
          synapse: [],
        }
      : {
          hub: [
            join(home, ".claude", "cache", "tfx-hub", "hub.pid"),
            join(home, ".claude", "cache", "tfx-hub", "hub-state.json"),
          ],
          team: [
            join(
              home,
              ".claude",
              "cache",
              "tfx-hub",
              `team-state-${process.env.CLAUDE_SESSION_ID || ""}.json`,
            ),
            join(home, ".claude", "cache", "tfx-hub", "team-state.json"),
          ],
          synapse: [
            join(home, ".claude", "cache", "tfx-hub", "synapse-registry.json"),
            join(home, ".claude", "cache", "tfx-hub", "synapse-sessions.json"),
          ],
        };
  const git = collectGit(rootDir, collectedAt, execFileSyncFn);
  const sources = {
    git: git.source,
    tfx_hub: collectJsonArtifact(
      "tfx_hub",
      [
        join(rootDir, ".triflux", "hub", "status.json"),
        join(rootDir, ".triflux", "hub-state.json"),
        ...hostArtifactCandidates.hub,
      ],
      rootDir,
      collectedAt,
    ),
    tfx_swarm: collectSwarm(rootDir, collectedAt),
    tfx_team: collectJsonArtifact(
      "tfx_team",
      [
        join(rootDir, ".triflux", "team-state.json"),
        ...hostArtifactCandidates.team,
      ],
      rootDir,
      collectedAt,
    ),
    tfx_synapse: collectJsonArtifact(
      "tfx_synapse",
      [
        join(rootDir, ".triflux", "synapse-registry.json"),
        join(rootDir, ".triflux", "synapse", "registry.json"),
        ...hostArtifactCandidates.synapse,
      ],
      rootDir,
      collectedAt,
    ),
    ultragoal_omx: collectUltragoal(
      join(rootDir, ".omx", "ultragoal"),
      rootDir,
      collectedAt,
    ),
    ultragoal_omc: collectUltragoal(
      join(rootDir, ".omc", "ultragoal"),
      rootDir,
      collectedAt,
    ),
    handoffs: collectHandoffs(rootDir, collectedAt),
    session_vault: collectDurableRefs(
      "session_vault",
      [
        join(rootDir, ".triflux", "session-vault.json"),
        join(rootDir, "sessions_v2.db"),
        join(rootDir, ".session-vault"),
      ],
      rootDir,
      collectedAt,
      "not_shell_collectable",
    ),
    agy: collectDurableRefs(
      "agy",
      [join(rootDir, ".agy", "state.json"), join(rootDir, ".agy", "refs.json")],
      rootDir,
      collectedAt,
      "not_shell_collectable",
    ),
    gbrain: collectDurableRefs(
      "gbrain",
      [
        join(rootDir, ".gbrain", "refs.json"),
        join(rootDir, ".gbrain", "config.json"),
      ],
      rootDir,
      collectedAt,
      "not_shell_collectable",
    ),
  };

  return { repo: git.repo, sources };
}

function hasFlag(args, flag) {
  return Array.isArray(args) && args.includes(flag);
}

export async function runCollect(args = [], opts = {}) {
  const rootDir = opts.rootDir || process.cwd();
  const lakeRoot = opts.lakeRoot || join(rootDir, ".triflux", "lake");
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  const execFileSyncFn = opts.execFileSyncFn || execFileSync;
  const generatedAt = isoNow(opts);

  mkdirSync(lakeRoot, { recursive: true });

  const { repo, sources } = collectSources(
    rootDir,
    generatedAt,
    execFileSyncFn,
    opts,
  );
  const current = {
    schema_version: SCHEMA_VERSION,
    generated_at: generatedAt,
    repo,
    sources,
    summary: {},
    ledger_tail: readLedgerTail(lakeRoot),
  };
  current.summary = buildSummary(current);

  const event = {
    ts: generatedAt,
    event: "collect",
    source: "tfx_cto_collect",
    summary: `collected ${current.summary.available_sources}/${SOURCE_IDS.length} durable sources`,
    ref: {
      current_json: "current.json",
      current_md: "current.md",
    },
  };
  const appended = await appendLedgerEvent(lakeRoot, event, stderr);
  if (appended) current.ledger_tail = readLedgerTail(lakeRoot);

  validateCurrent(current);
  writeAtomic(
    join(lakeRoot, "current.json"),
    `${JSON.stringify(current, null, 2)}\n`,
  );
  writeAtomic(join(lakeRoot, "current.md"), renderBrief(current));

  if (opts.json === true || hasFlag(args, "--json")) {
    stdout.write(`${JSON.stringify(current, null, 2)}\n`);
  } else {
    stdout.write(`wrote ${join(lakeRoot, "current.json")} and current.md\n`);
  }

  return current;
}
