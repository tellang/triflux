import { readState } from "@triflux/core/hub/state.mjs";

const DEFAULT_TIMEOUT_MS = 2500;
const CONTROL_COMMAND_ALIASES = Object.freeze({
  stop: "abort",
  interrupt: "abort",
});

export const LEAD_CONTROL_COMMANDS = Object.freeze([
  "pause",
  "resume",
  "abort",
  "reassign",
]);

function resolveFetch(fetchImpl) {
  if (typeof fetchImpl === "function") return fetchImpl;
  if (typeof globalThis.fetch === "function")
    return globalThis.fetch.bind(globalThis);
  return null;
}

function normalizeHubBaseUrl(hubUrl) {
  return String(hubUrl || "")
    .replace(/\/+$/, "")
    .replace(/\/mcp$/, "");
}

function normalizeCommand(command) {
  const raw = String(command || "")
    .trim()
    .toLowerCase();
  if (!raw) return "";
  return CONTROL_COMMAND_ALIASES[raw] || raw;
}

function safeAbortSignal(timeoutMs) {
  if (typeof AbortSignal?.timeout !== "function") return undefined;
  return AbortSignal.timeout(timeoutMs);
}

function isPidAlive(pid) {
  const resolvedPid = Number(pid);
  if (!Number.isFinite(resolvedPid) || resolvedPid <= 0) return false;
  try {
    process.kill(resolvedPid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveHeadlessHubUrl() {
  const stateUrl = normalizeHubBaseUrl(readState()?.url);
  if (stateUrl) return stateUrl;

  const envHubUrl = normalizeHubBaseUrl(process.env.TFX_HUB_URL);
  if (envHubUrl) return envHubUrl;

  const envPort = Number(process.env.TFX_HUB_PORT || "27888");
  const port = Number.isFinite(envPort) && envPort > 0 ? envPort : 27888;
  return `http://127.0.0.1:${port}`;
}

function hasLiveHubState() {
  const state = readState();
  return !!normalizeHubBaseUrl(state?.url) && isPidAlive(state?.pid);
}

function toHeadlessSessionAgentId(sessionName) {
  const normalizedSessionName = String(sessionName || "").trim();
  return normalizedSessionName ? `session:${normalizedSessionName}` : "";
}

function safeJson(res) {
  return res.json().catch(() => ({}));
}

export async function publishLeadControl({
  hubUrl,
  fromAgent = "lead",
  toAgent,
  command,
  reason = "",
  payload = {},
  traceId,
  correlationId,
  ttlMs = 3600000,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl,
} = {}) {
  const requestFetch = resolveFetch(fetchImpl);
  if (!requestFetch) {
    return { ok: false, error: "FETCH_UNAVAILABLE" };
  }

  const hubBase = normalizeHubBaseUrl(hubUrl);
  if (!hubBase) {
    return { ok: false, error: "HUB_URL_REQUIRED" };
  }

  const targetAgent = String(toAgent || "").trim();
  if (!targetAgent) {
    return { ok: false, error: "TARGET_AGENT_REQUIRED" };
  }

  const normalizedCommand = normalizeCommand(command);
  if (!LEAD_CONTROL_COMMANDS.includes(normalizedCommand)) {
    return {
      ok: false,
      error: "INVALID_COMMAND",
      allowed: LEAD_CONTROL_COMMANDS,
      command: normalizedCommand,
    };
  }

  try {
    const res = await requestFetch(`${hubBase}/bridge/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_agent: String(fromAgent || "lead"),
        to_agent: targetAgent,
        command: normalizedCommand,
        reason: String(reason || ""),
        payload: payload && typeof payload === "object" ? payload : {},
        ttl_ms: ttlMs,
        trace_id: traceId,
        correlation_id: correlationId,
      }),
      signal: safeAbortSignal(timeoutMs),
    });

    const body = await safeJson(res);
    return {
      ok: res.ok && body?.ok !== false,
      status: res.status,
      body,
      command: normalizedCommand,
    };
  } catch (error) {
    return {
      ok: false,
      error: "CONTROL_PUBLISH_FAILED",
      message: error?.message || "control publish failed",
      command: normalizedCommand,
    };
  }
}

export async function publishHeadlessControl(
  sessionName,
  command,
  targetWorker = "*",
) {
  const sessionAgentId = toHeadlessSessionAgentId(sessionName);
  if (!sessionAgentId) {
    return {
      ok: false,
      noop: true,
      error: "SESSION_NAME_REQUIRED",
      command: String(command || "")
        .trim()
        .toLowerCase(),
    };
  }

  if (!normalizeHubBaseUrl(process.env.TFX_HUB_URL) && !hasLiveHubState()) {
    return {
      ok: false,
      noop: true,
      error: "HUB_UNAVAILABLE",
      command: String(command || "")
        .trim()
        .toLowerCase(),
    };
  }

  return await publishLeadControl({
    hubUrl: resolveHeadlessHubUrl(),
    fromAgent: "lead",
    toAgent: sessionAgentId,
    command,
    payload: {
      session_name: String(sessionName || "").trim(),
      target_worker: String(targetWorker || "*").trim() || "*",
      issued_by: "lead",
      issued_at: Date.now(),
    },
  });
}
