function firstString(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function maybeAssign(target, key, value) {
  if (value !== "" && value != null) target[key] = value;
}

export function normalizeClaudeAgentSession(row = {}) {
  const short = firstString(row.short, row.id, row.jobId, row.job_id);
  const sessionId = firstString(
    row.sessionId,
    row.session_id,
    row.dispatch?.sessionId,
    row.dispatch?.session_id,
    row.d?.sessionId,
    row.d?.session_id,
    row.session?.id,
  );
  const state = firstString(row.state, row.status, row.tempo, "unknown");
  const status = firstString(row.status, row.state, row.tempo, "unknown");

  const normalized = {
    ...row,
    short,
    id: firstString(row.id, short),
    sessionId,
    session_id: sessionId,
    state,
    status,
  };
  maybeAssign(normalized, "cwd", row.cwd);
  maybeAssign(normalized, "name", row.name);
  maybeAssign(normalized, "kind", row.kind);
  maybeAssign(normalized, "waitingFor", row.waitingFor ?? row.waiting_for);
  maybeAssign(normalized, "startedAt", row.startedAt ?? row.started_at);
  maybeAssign(normalized, "updatedAt", row.updatedAt ?? row.updated_at);
  maybeAssign(normalized, "pid", row.pid);
  return normalized;
}

export function extractClaudeAgentSessions(listResponse = {}) {
  const rows = Array.isArray(listResponse.jobs)
    ? listResponse.jobs
    : Array.isArray(listResponse.sessions)
      ? listResponse.sessions
      : [];
  return rows.map((row) => normalizeClaudeAgentSession(row));
}
