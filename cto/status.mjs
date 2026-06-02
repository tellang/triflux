import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

function firstExisting(paths) {
  return paths.filter(Boolean).find((path) => existsSync(path)) || null;
}

function toIsoTime(value) {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return null;
}

function normalizeLiveSession(session) {
  return {
    sessionId: String(session?.sessionId || ""),
    host: typeof session?.host === "string" ? session.host : "local",
    agent_id:
      typeof session?.agent_id === "string"
        ? session.agent_id
        : typeof session?.agentId === "string"
          ? session.agentId
          : null,
    phase:
      typeof session?.phase === "string"
        ? session.phase
        : typeof session?.status === "string"
          ? session.status
          : "active",
    started_at: toIsoTime(
      session?.started_at ?? session?.startedAt ?? session?.lastHeartbeat,
    ),
  };
}

function normalizeActiveShard(shard) {
  return {
    shard_name:
      typeof shard?.shard_name === "string"
        ? shard.shard_name
        : typeof shard?.shardName === "string"
          ? shard.shardName
          : typeof shard?.name === "string"
            ? shard.name
            : typeof shard?.id === "string"
              ? shard.id
              : null,
    phase:
      typeof shard?.phase === "string"
        ? shard.phase
        : typeof shard?.status === "string"
          ? shard.status
          : "active",
    members: Array.isArray(shard?.members)
      ? shard.members.map((member) => String(member))
      : [],
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
  const activeShards = Array.isArray(value?.active_shards)
    ? value.active_shards
    : Array.isArray(value?.activeShards)
      ? value.activeShards
      : [];

  return {
    live_sessions: sessions
      .map(normalizeLiveSession)
      .filter((session) => session.sessionId),
    active_shards: activeShards.map(normalizeActiveShard),
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

async function readSynapseWithRegistry(opts = {}) {
  const rootDir = opts.rootDir || process.cwd();
  const persistPath = firstExisting([
    opts.synapsePersistPath,
    join(rootDir, ".triflux", "synapse-registry.json"),
    join(rootDir, ".triflux", "synapse", "registry.json"),
    join(homedir(), ".claude", "cache", "tfx-hub", "synapse-sessions.json"),
    join(homedir(), ".claude", "cache", "tfx-hub", "synapse-registry.json"),
  ]);
  if (!persistPath) return { sessions: [], active_shards: [] };

  const { createSynapseRegistry } = await import(
    "../hub/team/synapse-registry.mjs"
  );
  const registry = createSynapseRegistry({ persistPath });
  return { sessions: registry.getActive(), active_shards: [] };
}

async function readSynapseOverlay(opts) {
  try {
    const reader = opts.synapseReader || readSynapseWithRegistry;
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
    return { live_sessions: [], active_shards: [] };
  }
}

function projectStatus(current, overlay) {
  return {
    schema_version: current?.schema_version || SCHEMA_VERSION,
    generated_at: current?.generated_at || null,
    repo: current?.repo || {},
    sources: current?.sources || {},
    summary: current?.summary || {},
    ledger_tail: Array.isArray(current?.ledger_tail) ? current.ledger_tail : [],
    live_sessions: overlay.live_sessions,
    active_shards: overlay.active_shards,
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

function renderHumanStatus(status) {
  const { available, total } = countAvailableSources(status.sources);
  const activeGoals = countActiveGoals(status);
  const recent = Array.isArray(status.ledger_tail)
    ? status.ledger_tail.slice(-2)
    : [];
  const lines = [
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
  const rootDir = opts.rootDir || process.cwd();
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
  else stdout.write(renderHumanStatus(status));

  return status;
}
