const BRIEF_VERSION = "cto-lake.v1";
const MAX_BRIEF_BYTES = 2048;
const TRUNCATION_MARKER = "... truncated";

function oneLine(value, fallback = "n/a") {
  const text =
    typeof value === "string"
      ? value
      : value === null || value === undefined
        ? fallback
        : JSON.stringify(value);
  return String(text).replace(/\s+/g, " ").trim() || fallback;
}

function compactDetail(value) {
  const text = oneLine(value);
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}

function formatGoal(goal) {
  const id = oneLine(goal?.id, "goal");
  const status = oneLine(goal?.status, "unknown");
  const title = oneLine(
    goal?.title || goal?.objective || goal?.summary,
    "untitled",
  );
  return `- ${id} ${status}: ${title}`;
}

function formatShard(shard) {
  const id = oneLine(shard?.id || shard?.name || shard?.sessionId, "shard");
  const status = oneLine(shard?.status || shard?.state, "unknown");
  const detail = oneLine(shard?.summary || shard?.objective || shard?.task, "");
  return detail ? `- ${id} ${status}: ${detail}` : `- ${id} ${status}`;
}

function formatEvent(event) {
  const ts = oneLine(event?.ts, "unknown_ts");
  const name = oneLine(event?.event, "event");
  const summary = oneLine(event?.summary, "");
  return summary ? `- ${ts} ${name}: ${summary}` : `- ${ts} ${name}`;
}

function enforceCap(text) {
  if (Buffer.byteLength(text, "utf8") <= MAX_BRIEF_BYTES) return text;
  const marker = `\n${TRUNCATION_MARKER}`;
  let candidate = text;
  while (
    candidate.length > 0 &&
    Buffer.byteLength(`${candidate}${marker}`, "utf8") > MAX_BRIEF_BYTES
  ) {
    candidate = candidate.slice(0, -1);
  }
  return `${candidate.replace(/\s+$/u, "")}${marker}`;
}

export function renderBrief(current) {
  const repo = current?.repo || {};
  const summary = current?.summary || {};
  const hub = current?.sources?.tfx_hub || {};
  const activeGoals = Array.isArray(summary.active_goals)
    ? summary.active_goals.slice(0, 3)
    : [];
  const swarmShards = Array.isArray(summary.swarm_shards)
    ? summary.swarm_shards.slice(0, 2)
    : [];
  const recentEvents = Array.isArray(current?.ledger_tail)
    ? current.ledger_tail.slice(-2)
    : [];

  const lines = [
    `brief_version: ${BRIEF_VERSION}`,
    "repo_state",
    `branch: ${oneLine(repo.branch, "unknown")} head: ${oneLine(repo.head, "unknown")} dirty: ${repo.dirty === true}`,
    `summary: ${oneLine(summary.repo_state, "no repo summary")}`,
    "active_goals",
    ...(activeGoals.length > 0 ? activeGoals.map(formatGoal) : ["- none"]),
    "swarm_shards",
    ...(swarmShards.length > 0 ? swarmShards.map(formatShard) : ["- none"]),
    "hub_status",
    `status: ${oneLine(hub.status, "unknown")} available: ${hub.available === true} detail: ${compactDetail(hub.detail)}`,
    "recent_events",
    ...(recentEvents.length > 0 ? recentEvents.map(formatEvent) : ["- none"]),
    "generated_at",
    oneLine(current?.generated_at, "unknown"),
    "injection_note",
    "read by agent hooks; align to this north-star",
  ];

  return enforceCap(`${lines.join("\n")}\n`);
}

export { BRIEF_VERSION, MAX_BRIEF_BYTES };
