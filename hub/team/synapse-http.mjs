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

/**
 * Synapse 이벤트 수신 (GET /synapse/events)
 * @param {object} [opts]
 * @param {number} [opts.since=0] - 이 ID 이후의 이벤트만 반환
 * @param {function} [opts.fetchImpl] - fetch 구현
 * @param {string} [opts.baseUrl] - Synapse 서버 URL
 * @returns {Promise<{events: object[]}|null>}
 */
export async function fetchSynapseEvents(opts = {}) {
  const fetchImpl = resolveSynapseFetch(opts.fetchImpl);
  if (!fetchImpl) return null;

  try {
    const url = new URL(
      "/synapse/events",
      opts.baseUrl || DEFAULT_SYNAPSE_BASE_URL,
    );
    url.searchParams.set("since", String(opts.since || 0));
    const res = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
