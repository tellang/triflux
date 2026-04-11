const DEFAULT_SYNAPSE_BASE_URL = "http://127.0.0.1:27888";

function resolveSynapseFetch(fetchImpl) {
  if (typeof fetchImpl === "function") return fetchImpl;
  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch.bind(globalThis);
  }
  return null;
}

export function buildSynapseTaskSummary(prompt, maxLength = 100) {
  if (maxLength <= 0) return "";
  return String(prompt ?? "").slice(0, maxLength);
}

export function fireAndForgetSynapse(path, payload, opts = {}) {
  const fetchImpl = resolveSynapseFetch(opts.fetchImpl);
  if (!fetchImpl) return false;

  try {
    const url = new URL(
      path,
      opts.baseUrl || DEFAULT_SYNAPSE_BASE_URL,
    ).toString();
    Promise.resolve(
      fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    ).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

export function registerSynapseSession(meta, opts = {}) {
  return fireAndForgetSynapse("/synapse/register", meta, opts);
}

export function heartbeatSynapseSession(
  sessionId,
  partialMeta = {},
  opts = {},
) {
  return fireAndForgetSynapse(
    "/synapse/heartbeat",
    {
      sessionId,
      ...(partialMeta && typeof partialMeta === "object" ? partialMeta : {}),
    },
    opts,
  );
}

export function unregisterSynapseSession(sessionId, opts = {}) {
  return fireAndForgetSynapse("/synapse/unregister", { sessionId }, opts);
}
