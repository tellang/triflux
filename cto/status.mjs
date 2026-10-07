import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { compactHygieneCounts, projectCtoHygiene } from "./hygiene.mjs";
import {
  normalizeLiveSession,
  pathLabel,
  readSynapseSnapshot,
  resolveLakeRootDir,
  shortHash,
} from "./lake-root.mjs";

const SCHEMA_VERSION = "cto-lake.v1";
const SYNAPSE_TIMEOUT_MS = 1500;

function hasFlag(args, flag) {
  return Array.isArray(args) && args.includes(flag);
}

function writeJson(stdout, payload) {
  stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function deriveRepoRootFromCwd(cwd) {
  if (typeof cwd !== "string" || !cwd) return "";
  if (cwd.includes("\\") || /^[A-Za-z]:/u.test(cwd)) return cwd;

  const normalized = cwd.replace(/\/+$/u, "");
  const gitWorktreeMarker = "/.worktrees/";
  const gitWorktreeIndex = normalized.indexOf(gitWorktreeMarker);
  if (gitWorktreeIndex > 0) {
    const suffix = normalized.slice(
      gitWorktreeIndex + gitWorktreeMarker.length,
    );
    if (/^[^/]+(?:\/|$)/u.test(suffix)) {
      return normalized.slice(0, gitWorktreeIndex);
    }
  }

  const claudeMarker = "/.claude/worktrees/";
  const claudeIndex = normalized.indexOf(claudeMarker);
  if (claudeIndex > 0) {
    const suffix = normalized.slice(claudeIndex + claudeMarker.length);
    if (/^[^/]+(?:\/|$)/u.test(suffix)) {
      return normalized.slice(0, claudeIndex);
    }
  }

  const codexMarker = "/.codex-swarm/";
  const codexIndex = normalized.indexOf(codexMarker);
  if (codexIndex > 0) {
    const suffix = normalized.slice(codexIndex + codexMarker.length);
    if (/^wt-[^/]+(?:\/|$)/u.test(suffix)) {
      return normalized.slice(0, codexIndex);
    }
  }

  return cwd;
}

function redactedCwdFields(cwd) {
  if (typeof cwd !== "string" || !cwd) return {};
  const repoRoot = deriveRepoRootFromCwd(cwd);
  return {
    cwdLabel: pathLabel(cwd),
    cwdHash: shortHash(cwd),
    repoRootLabel: pathLabel(repoRoot),
    repoRootHash: shortHash(repoRoot),
  };
}

function normalizeSynapseOverlay(value) {
  const sessions = Array.isArray(value)
    ? value
    : Array.isArray(value?.sessions)
      ? value.sessions
      : Array.isArray(value?.live_sessions)
        ? value.live_sessions
        : [];

  return {
    live_sessions: sessions
      .map((session) => ({
        ...normalizeLiveSession(session),
        host: typeof session?.host === "string" ? session.host : "local",
        ...redactedCwdFields(session?.cwd),
      }))
      .filter((session) => session.sessionId),
  };
}

function withTimeout(promise, timeoutMs = SYNAPSE_TIMEOUT_MS) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("synapse read timeout")),
      timeoutMs,
    );
    if (typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function readSynapseOverlay(opts) {
  try {
    const reader = opts.synapseReader || readSynapseSnapshot;
    const raw = await withTimeout(
      reader({
        rootDir: opts.rootDir,
        lakeRoot: opts.lakeRoot,
        synapsePersistPath: opts.synapsePersistPath,
      }),
      opts.synapseTimeoutMs || SYNAPSE_TIMEOUT_MS,
    );
    return normalizeSynapseOverlay(raw);
  } catch {
    return { live_sessions: [] };
  }
}

function deriveLiveSessionGroups(liveSessions) {
  const groups = new Map();
  for (const session of liveSessions || []) {
    if (!session?.repoRootHash) continue;
    if (!groups.has(session.repoRootHash)) {
      groups.set(session.repoRootHash, {
        repoRootLabel: session.repoRootLabel || "",
        repoRootHash: session.repoRootHash,
        session_count: 0,
        sessions: [],
      });
    }
    const group = groups.get(session.repoRootHash);
    group.session_count += 1;
    group.sessions.push(session.sessionId);
  }
  return [...groups.values()];
}

function projectStatus(current, overlay) {
  const liveSessions = overlay.live_sessions;
  return {
    schema_version: current?.schema_version || SCHEMA_VERSION,
    generated_at: current?.generated_at || null,
    repo: current?.repo || {},
    sources: current?.sources || {},
    summary: current?.summary || {},
    ledger_tail: Array.isArray(current?.ledger_tail) ? current.ledger_tail : [],
    live_sessions: liveSessions,
    live_session_groups: deriveLiveSessionGroups(liveSessions),
    active_shards: [],
    hygiene: compactHygieneCounts(projectCtoHygiene({ current, overlay })),
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
    `active: ${status.live_sessions.length} sessions, ${status.active_shards.length} shards, ${activeGoals} goals`,
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
  const overlay = await readSynapseOverlay({
    ...opts,
    rootDir,
    lakeRoot,
  });
  const status = projectStatus(current, overlay);

  if (jsonOut) writeJson(stdout, status);
  else stdout.write(renderHumanStatus(status, opts.now ?? Date.now()));

  return status;
}
