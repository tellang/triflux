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

function shortHash(value) {
  const str = String(value ?? "");
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (h * 33) ^ str.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

function pathLabel(value) {
  const str = String(value ?? "").replace(/[/\\]+$/u, "");
  if (!str) return "";
  const segments = str.split(/[/\\]+/u);
  return segments[segments.length - 1] || "";
}

export function deriveRepoRootFromCwd(cwd) {
  if (typeof cwd !== "string" || !cwd) return "";
  if (cwd.includes("\\") || /^[A-Za-z]:/u.test(cwd)) return cwd;

  const normalized = cwd.replace(/\/+$/u, "");
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

function normalizeLiveSession(session) {
  const cwd = typeof session?.cwd === "string" ? session.cwd : "";
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
    ...redactedCwdFields(cwd),
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

// active_shards 의 source 는 live_sessions 와 다르다: live_sessions 는 synapse
// overlay(실시간 세션)에서, active_shards 는 collect 가 .triflux/swarm-locks.json 을
// snapshot 한 current.json(sources.tfx_swarm.detail.shards)에서 온다. synapse
// overlay 가 shard 를 채우는 경로가 생기면 그쪽을 우선하고, 없으면 snapshot 으로
// fallback 한다(현재 overlay 의 active_shards 는 항상 비어 snapshot 을 쓴다).
function deriveActiveShards(current, overlay) {
  // overlay(synapse)가 채운 shard 중 식별 가능한 것만 authoritative 로 본다.
  // normalizeSynapseOverlay 가 shard_name 을 null 로 정규화한 무효 행이 snapshot
  // fallback 을 가로채지 않도록 먼저 거른다.
  const overlayShards = Array.isArray(overlay?.active_shards)
    ? overlay.active_shards.filter((shard) => shard?.shard_name)
    : [];
  if (overlayShards.length > 0) return overlayShards;
  const shards = current?.sources?.tfx_swarm?.detail?.shards;
  if (!Array.isArray(shards)) return [];
  return shards.map(normalizeActiveShard).filter((shard) => shard.shard_name);
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
    active_shards: deriveActiveShards(current, overlay),
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
