import { readState } from "@triflux/core/hub/state.mjs";

const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_HEADLESS_POLL_MS = 1000;

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

function resolveHeadlessHubUrl(hubUrl) {
  const normalized = normalizeHubBaseUrl(hubUrl);
  if (normalized) return normalized;

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

async function dispatchHeadlessCommand(command, callbacks) {
  const callbackMap = {
    pause: callbacks.onPause,
    resume: callbacks.onResume,
    abort: callbacks.onAbort,
    reassign: callbacks.onReassign,
  };
  const handler = callbackMap[command?.command];
  if (typeof handler === "function") {
    await handler(command);
  }
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

function normalizeLeadCommandMessage(message) {
  const payload =
    message?.payload && typeof message.payload === "object"
      ? message.payload
      : {};
  const command = String(payload.command || "")
    .trim()
    .toLowerCase();
  if (!command) return null;
  return {
    messageId: message.id || null,
    topic: message.topic || "lead.control",
    fromAgent: message.from_agent || payload.issued_by || "lead",
    command,
    reason: payload.reason || "",
    payload,
    traceId: message.trace_id || null,
    correlationId: message.correlation_id || null,
    createdAtMs: message.created_at_ms || null,
  };
}

export async function subscribeToLeadCommands({
  hubUrl,
  agentId,
  maxMessages = 10,
  autoAck = true,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  topics = ["lead.control"],
  onCommand = null,
  fetchImpl,
} = {}) {
  const requestFetch = resolveFetch(fetchImpl);
  if (!requestFetch) {
    return { ok: false, error: "FETCH_UNAVAILABLE", commands: [] };
  }

  const hubBase = normalizeHubBaseUrl(hubUrl);
  if (!hubBase) {
    return { ok: false, error: "HUB_URL_REQUIRED", commands: [] };
  }

  const normalizedAgentId = String(agentId || "").trim();
  if (!normalizedAgentId) {
    return { ok: false, error: "AGENT_ID_REQUIRED", commands: [] };
  }

  try {
    const res = await requestFetch(`${hubBase}/bridge/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: normalizedAgentId,
        topics: Array.isArray(topics) ? topics : ["lead.control"],
        max_messages: maxMessages,
        auto_ack: autoAck,
      }),
      signal: safeAbortSignal(timeoutMs),
    });

    const body = await safeJson(res);
    const messages = Array.isArray(body?.data?.messages)
      ? body.data.messages
      : [];
    const commands = messages
      .filter((message) => message?.topic === "lead.control")
      .map(normalizeLeadCommandMessage)
      .filter(Boolean);

    if (typeof onCommand === "function") {
      for (const command of commands) {
        await onCommand(command);
      }
    }

    return {
      ok: res.ok && body?.ok !== false,
      status: res.status,
      commands,
      messageCount: messages.length,
      body,
    };
  } catch (error) {
    return {
      ok: false,
      error: "LEAD_COMMAND_SUBSCRIBE_FAILED",
      message: error?.message || "lead command subscribe failed",
      commands: [],
    };
  }
}

export function createHeadlessControlSubscriber(
  sessionName,
  {
    onPause,
    onResume,
    onAbort,
    onReassign,
    hubUrl,
    pollIntervalMs = DEFAULT_HEADLESS_POLL_MS,
    maxMessages = 10,
    autoAck = true,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl,
  } = {},
) {
  const sessionAgentId = toHeadlessSessionAgentId(sessionName);
  if (!sessionAgentId) {
    return { stop() {} };
  }

  const explicitHubUrl =
    normalizeHubBaseUrl(hubUrl) || normalizeHubBaseUrl(process.env.TFX_HUB_URL);
  if (!explicitHubUrl && !hasLiveHubState()) {
    return { stop() {} };
  }

  const resolvedHubUrl = explicitHubUrl || resolveHeadlessHubUrl(hubUrl);
  const callbacks = { onPause, onResume, onAbort, onReassign };
  const intervalMs = Math.max(
    50,
    Number(pollIntervalMs) || DEFAULT_HEADLESS_POLL_MS,
  );

  let stopped = false;
  let timer = null;
  let pending = false;

  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(tick, intervalMs);
    if (typeof timer?.unref === "function") timer.unref();
  };

  const tick = async () => {
    if (stopped || pending) {
      scheduleNext();
      return;
    }

    pending = true;
    try {
      const result = await subscribeToLeadCommands({
        hubUrl: resolvedHubUrl,
        agentId: sessionAgentId,
        maxMessages,
        autoAck,
        timeoutMs,
        fetchImpl,
        onCommand: async (command) => {
          await dispatchHeadlessCommand(command, callbacks);
        },
      });

      if (!result?.ok && result?.error === "LEAD_COMMAND_SUBSCRIBE_FAILED") {
        stop();
        return;
      }
    } finally {
      pending = false;
      scheduleNext();
    }
  };

  void tick();

  return { stop };
}

export async function getTeamStatus({
  hubUrl,
  scope = "hub",
  agentId,
  includeMetrics = true,
  method = "GET",
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

  const normalizedMethod =
    String(method || "GET").toUpperCase() === "POST" ? "POST" : "GET";
  const statusScope = String(scope || "hub").trim() || "hub";

  let endpoint = `${hubBase}/bridge/status`;
  const options = {
    method: normalizedMethod,
    headers: { "Content-Type": "application/json" },
    signal: safeAbortSignal(timeoutMs),
  };

  if (normalizedMethod === "GET") {
    const params = new URLSearchParams({ scope: statusScope });
    if (agentId) params.set("agent_id", String(agentId));
    if (!includeMetrics) params.set("include_metrics", "0");
    endpoint = `${endpoint}?${params.toString()}`;
  } else {
    options.body = JSON.stringify({
      scope: statusScope,
      agent_id: agentId || undefined,
      include_metrics: includeMetrics,
    });
  }

  try {
    const res = await requestFetch(endpoint, options);
    const body = await safeJson(res);
    return {
      ok: res.ok && body?.ok !== false,
      status: res.status,
      body,
      data: body?.data || null,
    };
  } catch (error) {
    return {
      ok: false,
      error: "TEAM_STATUS_FETCH_FAILED",
      message: error?.message || "team status fetch failed",
    };
  }
}
