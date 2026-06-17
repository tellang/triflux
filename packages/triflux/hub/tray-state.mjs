// hub/tray-state.mjs — normalize Hub/CTO/MCP state for the macOS tray UI

function toIsoTime(value) {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return null;
}

function statusRank(status) {
  switch (status) {
    case "active":
      return 0;
    case "idle":
      return 1;
    case "starting":
      return 2;
    case "stale":
      return 4;
    default:
      return 3;
  }
}

function readSynapseSessions(snapshot) {
  if (Array.isArray(snapshot)) return snapshot;
  if (Array.isArray(snapshot?.sessions)) return snapshot.sessions;
  if (snapshot && typeof snapshot === "object") {
    return Object.values(snapshot).filter(
      (entry) => entry && typeof entry === "object" && entry.sessionId,
    );
  }
  return [];
}

const MCP_CLIENTS = Object.freeze([
  { id: "claude", label: "Claude", icon: "C", color: "#d19a66" },
  { id: "codex", label: "Codex", icon: "X", color: "#ffffff" },
  { id: "antigravity", label: "Antigravity", icon: "A", color: "#61afef" },
]);

function normalizeAgentId(value) {
  const id = String(value || "")
    .trim()
    .toLowerCase();
  if (id === "agy" || id === "anti") return "antigravity";
  if (id === "claude" || id === "codex" || id === "antigravity") return id;
  return "";
}

function inferAgentId(value = {}) {
  const direct = normalizeAgentId(
    value.agent_id ??
      value.agentId ??
      value.client ??
      value.provider ??
      value.runtimeClient,
  );
  if (direct) return direct;
  const haystack = [
    value.sessionId,
    value.sessionKind,
    value.role,
    value.taskSummary,
    value.command,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  for (const id of ["claude", "codex", "antigravity"]) {
    if (haystack.includes(id)) return id;
  }
  if (haystack.includes("agy")) return "antigravity";
  return "";
}

function agentMeta(agentId) {
  const id = normalizeAgentId(agentId);
  const meta = MCP_CLIENTS.find((client) => client.id === id);
  return meta ? { ...meta } : null;
}

export function normalizeTraySessions(snapshot) {
  return readSynapseSessions(snapshot)
    .map((session) => {
      const agentId = inferAgentId(session);
      return {
        sessionId: String(session?.sessionId || ""),
        host: typeof session?.host === "string" ? session.host : "local",
        status:
          typeof session?.status === "string"
            ? session.status
            : typeof session?.phase === "string"
              ? session.phase
              : "active",
        sessionKind:
          typeof session?.sessionKind === "string"
            ? session.sessionKind
            : "interactive",
        cwd: typeof session?.cwd === "string" ? session.cwd : "",
        worktreePath:
          typeof session?.worktreePath === "string" ? session.worktreePath : "",
        branch: typeof session?.branch === "string" ? session.branch : "",
        taskSummary:
          typeof session?.taskSummary === "string" ? session.taskSummary : "",
        agent_id: agentId || null,
        agent: agentMeta(agentId),
        lastHeartbeat: Number.isFinite(Number(session?.lastHeartbeat))
          ? Number(session.lastHeartbeat)
          : null,
        started_at: toIsoTime(
          session?.started_at ?? session?.startedAt ?? session?.lastHeartbeat,
        ),
        isRemote: session?.isRemote === true,
      };
    })
    .filter((session) => session.sessionId)
    .sort((a, b) => {
      const rankDelta = statusRank(a.status) - statusRank(b.status);
      if (rankDelta !== 0) return rankDelta;
      return (b.lastHeartbeat || 0) - (a.lastHeartbeat || 0);
    });
}

function countBy(items, pickKey) {
  const counts = {};
  for (const item of Array.isArray(items) ? items : []) {
    const key = pickKey(item) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function sanitizeMcpRow(row) {
  return {
    type: String(row?.type || ""),
    name: String(row?.name || ""),
    client: String(row?.client || ""),
    label: String(row?.label || ""),
    filePath: String(row?.filePath || ""),
    expectedUrl: String(row?.expectedUrl || ""),
    expectedCommand: String(row?.expectedCommand || ""),
    actualUrl: String(row?.actualUrl || ""),
    actualCommand: String(row?.actualCommand || ""),
    status: String(row?.status || ""),
    headerStatus: String(row?.headerStatus || ""),
    expectedHeaderNames: Array.isArray(row?.expectedHeaderNames)
      ? row.expectedHeaderNames.map(String)
      : [],
    actualHeaderNames: Array.isArray(row?.actualHeaderNames)
      ? row.actualHeaderNames.map(String)
      : [],
    command: row?.command ? String(row.command) : "",
  };
}

function summarizeMcpClients(rows) {
  return MCP_CLIENTS.map((client) => {
    const clientRows = rows.filter(
      (row) => row.type === "registry" && row.client === client.id,
    );
    const present = clientRows.filter(
      (row) => row.status === "present" || row.status === "ok",
    ).length;
    const total = clientRows.length;
    let status = "off";
    if (total > 0 && present === total) status = "on";
    else if (present > 0) status = "partial";
    return {
      ...client,
      status,
      present,
      total,
    };
  });
}

function summarizeMcpServers(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (row.type !== "registry" || !row.name) continue;
    if (!grouped.has(row.name)) {
      grouped.set(row.name, {
        name: row.name,
        target:
          row.expectedUrl ||
          row.actualUrl ||
          row.expectedCommand ||
          row.actualCommand ||
          "",
        rows: [],
      });
    }
    const group = grouped.get(row.name);
    if (!group.target) {
      group.target =
        row.expectedUrl ||
        row.actualUrl ||
        row.expectedCommand ||
        row.actualCommand ||
        "";
    }
    group.rows.push(row);
  }

  return [...grouped.values()]
    .map((server) => {
      const clients = MCP_CLIENTS.map((client) => {
        const clientRows = server.rows.filter(
          (row) => row.client === client.id,
        );
        if (clientRows.length === 0) return null;
        const present = clientRows.filter(
          (row) => row.status === "present" || row.status === "ok",
        ).length;
        let status = "off";
        if (present === clientRows.length) status = "on";
        else if (present > 0) status = "partial";
        return {
          ...client,
          status,
          present,
          total: clientRows.length,
          labels: [
            ...new Set(clientRows.map((row) => row.label).filter(Boolean)),
          ],
        };
      }).filter(Boolean);
      const onCount = clients.filter((client) => client.status === "on").length;
      const partialCount = clients.filter(
        (client) => client.status === "partial",
      ).length;
      let status = "off";
      if (clients.length > 0 && onCount === clients.length) status = "on";
      else if (onCount > 0 || partialCount > 0) status = "partial";
      return {
        name: server.name,
        target: server.target,
        status,
        clients,
        client_count: clients.length,
        present_client_count: onCount,
      };
    })
    .sort((a, b) => {
      if (a.name === "tfx-hub") return -1;
      if (b.name === "tfx-hub") return 1;
      return a.name.localeCompare(b.name);
    });
}

function normalizeMcpStatus(mcpStatus = {}) {
  const rows = Array.isArray(mcpStatus?.rows)
    ? mcpStatus.rows.map(sanitizeMcpRow)
    : [];
  return {
    registry_path: String(
      mcpStatus?.registry_path || mcpStatus?.registryPath || "",
    ),
    server_count: Number.isFinite(Number(mcpStatus?.server_count))
      ? Number(mcpStatus.server_count)
      : Number.isFinite(Number(mcpStatus?.serverCount))
        ? Number(mcpStatus.serverCount)
        : 0,
    rows,
    clients: summarizeMcpClients(rows),
    servers: summarizeMcpServers(rows),
    summary: {
      total: rows.length,
      by_status: countBy(rows, (row) => row.status),
      by_client: countBy(rows, (row) => row.client || row.label),
    },
    ...(mcpStatus?.error ? { error: String(mcpStatus.error) } : {}),
  };
}

function normalizeHub(hub = {}) {
  const id = String(hub?.id ?? hub?.sessionId ?? hub?.session_id ?? "");
  return {
    id,
    pid: Number.isFinite(Number(hub?.pid)) ? Number(hub.pid) : null,
    port: Number.isFinite(Number(hub?.port)) ? Number(hub.port) : null,
    url: String(hub?.url || ""),
    projectRoot: String(hub?.projectRoot || hub?.project_root || ""),
  };
}

function numericPid(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const pid = Number(text);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function normalizeRuntimeStatus(runtimeStatus = {}) {
  const processes = Array.isArray(runtimeStatus?.processes)
    ? runtimeStatus.processes.map((process) => ({
        client: String(process?.client || ""),
        sessionId: String(process?.sessionId || ""),
        source: String(process?.source || ""),
        conversationId: String(process?.conversationId || ""),
        focusable: process?.focusable !== false,
        pid: numericPid(process?.pid),
        ppid: Number.isFinite(Number(process?.ppid))
          ? Number(process.ppid)
          : null,
        phase:
          typeof process?.phase === "string"
            ? process.phase
            : process?.source === "conversation"
              ? "idle"
              : "active",
        elapsed: String(process?.elapsed || ""),
        command: String(process?.command || ""),
        cwd: String(process?.cwd || ""),
        taskSummary: String(process?.taskSummary || process?.command || ""),
      }))
    : [];
  return {
    processes: processes.filter(
      (process) =>
        process.client &&
        (process.pid || process.sessionId || process.conversationId),
    ),
    summary: runtimeStatus?.summary || {
      total: processes.length,
      clients: [],
    },
    ...(runtimeStatus?.error ? { error: String(runtimeStatus.error) } : {}),
  };
}

function sessionsToLiveOverlay(sessions = []) {
  return sessions
    .filter((session) => session.status !== "stale")
    .map((session) => ({
      sessionId: session.sessionId,
      host: session.host,
      agent_id: session.agent_id,
      agent: session.agent,
      phase: session.status,
      started_at: session.started_at,
    }));
}

function runtimeToLiveOverlay(runtime) {
  return runtime.processes.map((process) => ({
    sessionId:
      process.sessionId ||
      (process.pid
        ? `${process.client}-${process.pid}`
        : `${process.client}-${process.conversationId || "session"}`),
    host: "local",
    agent_id: process.client,
    agent: agentMeta(process.client),
    phase: process.phase || "active",
    pid: process.pid,
    command: process.command,
    elapsed: process.elapsed,
    cwd: process.cwd,
    taskSummary: process.taskSummary || process.command || `PID ${process.pid}`,
    source: process.source,
    conversationId: process.conversationId,
    focusable: process.focusable,
    started_at: null,
  }));
}

function normalizeLiveSession(session = {}) {
  const agentId = inferAgentId(session);
  return {
    ...session,
    sessionId: String(session.sessionId || ""),
    host: typeof session.host === "string" ? session.host : "local",
    agent_id: agentId || null,
    agent: session.agent || agentMeta(agentId),
    phase:
      typeof session.phase === "string"
        ? session.phase
        : typeof session.status === "string"
          ? session.status
          : "active",
    started_at: toIsoTime(
      session.started_at ?? session.startedAt ?? session.lastHeartbeat,
    ),
  };
}

const CTO_HYGIENE_COUNT_KEYS = Object.freeze([
  "active_tasks",
  "completed_tasks",
  "stale_sessions",
  "orphan_worktrees",
  "superseded_checkpoints",
  "unknown_owner",
]);

function compactNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizeHygieneAction(action = {}) {
  return {
    kind: String(action.kind || ""),
    id: String(action.id || ""),
    status: String(action.status || ""),
    action: String(action.action || ""),
  };
}

function normalizeCtoHygiene(ctoStatus = {}) {
  const hygiene =
    ctoStatus?.hygiene && typeof ctoStatus.hygiene === "object"
      ? ctoStatus.hygiene
      : null;
  if (!hygiene) return null;

  const actionsSource = Array.isArray(hygiene.actions)
    ? hygiene.actions
    : Array.isArray(hygiene.rows)
      ? hygiene.rows
      : Array.isArray(ctoStatus?.hygiene_actions)
        ? ctoStatus.hygiene_actions
        : [];
  const actions = actionsSource
    .map(normalizeHygieneAction)
    .filter(
      (action) => action.kind || action.id || action.status || action.action,
    );

  return {
    ...Object.fromEntries(
      CTO_HYGIENE_COUNT_KEYS.map((key) => [key, compactNumber(hygiene[key])]),
    ),
    action_count: compactNumber(hygiene.action_count ?? actions.length),
    actions: actions.slice(0, 2),
  };
}

function normalizeCtoStatus(ctoStatus = {}, sessions = [], runtime = {}) {
  const explicitLive = Array.isArray(ctoStatus?.live_sessions)
    ? ctoStatus.live_sessions
    : null;
  const sessionLive = sessionsToLiveOverlay(sessions);
  const runtimeLive = runtimeToLiveOverlay(runtime);
  const overlayLive =
    explicitLive && explicitLive.length > 0
      ? explicitLive
      : sessionLive.length > 0
        ? sessionLive
        : runtimeLive;
  const liveSessions =
    runtimeLive.length > overlayLive.length ? runtimeLive : overlayLive;
  const normalizedLiveSessions = liveSessions
    .map(normalizeLiveSession)
    .filter((session) => session.sessionId);
  const activeShards = Array.isArray(ctoStatus?.active_shards)
    ? ctoStatus.active_shards
    : [];
  const hygiene = normalizeCtoHygiene(ctoStatus);
  return {
    schema_version: String(ctoStatus?.schema_version || "cto-lake.v1"),
    generated_at: ctoStatus?.generated_at || null,
    live_sessions: normalizedLiveSessions,
    active_shards: activeShards,
    ...(hygiene ? { hygiene } : {}),
    summary: {
      live_session_count: normalizedLiveSessions.length,
      active_shard_count: activeShards.length,
      tray_session_count: sessions.length,
      tray_sessions_by_status: countBy(sessions, (session) => session.status),
    },
    ...(ctoStatus?.error ? { error: String(ctoStatus.error) } : {}),
  };
}

export function buildTrayStatePayload({
  hub = {},
  qos = {},
  synapseSnapshot = {},
  broker = [],
  ctoStatus = {},
  mcpStatus = {},
  runtimeStatus = {},
  now = Date.now(),
} = {}) {
  const sessions = normalizeTraySessions(synapseSnapshot);
  const runtime = normalizeRuntimeStatus(runtimeStatus);
  return {
    ok: true,
    hub: normalizeHub(hub),
    qos,
    sessions,
    cto: normalizeCtoStatus(ctoStatus, sessions, runtime),
    mcp: normalizeMcpStatus(mcpStatus),
    runtime,
    broker: Array.isArray(broker) ? broker : [],
    ts: now,
  };
}
