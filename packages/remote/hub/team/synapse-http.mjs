import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HUB_DEFAULT_PORT = 27888;
// Same token file as hub/bridge.mjs (HUB_TOKEN_FILE). Kept inline rather than
// imported so this helper stays dependency-free and byte-identical across the
// packages/core mirror (which cannot carry relative cross-package imports).
const HUB_TOKEN_FILE = join(homedir(), ".claude", ".tfx-hub-token");

function normalizeToken(raw) {
  if (raw == null) return null;
  const token = String(raw).trim();
  return token || null;
}

// Mirrors hub/bridge.mjs:readHubToken — env override first, then the token file.
// Missing token → null (backward-compatible with token-less hubs).
function readHubToken() {
  const envToken = normalizeToken(process.env.TFX_HUB_TOKEN);
  if (envToken) return envToken;
  try {
    return normalizeToken(readFileSync(HUB_TOKEN_FILE, "utf8"));
  } catch {
    return null;
  }
}

// Wrap IPv6 hosts in [...] so they form a valid URL authority (cf. bridge.mjs).
function formatHostForUrl(host) {
  return String(host).includes(":") ? `[${host}]` : host;
}

// Resolve the hub base URL from env (TFX_HUB_URL / TFX_HUB_PORT) before falling
// back to the loopback default, so a cascaded / non-default hub port is hit
// instead of silently posting to 127.0.0.1:27888 and missing the live hub.
function resolveSynapseBaseUrl() {
  const envUrl = normalizeToken(process.env.TFX_HUB_URL);
  if (envUrl) return envUrl.replace(/\/mcp$/, "");

  const envPort = Number.parseInt(String(process.env.TFX_HUB_PORT ?? ""), 10);
  if (Number.isFinite(envPort) && envPort > 0) {
    return `http://${formatHostForUrl("127.0.0.1")}:${envPort}`;
  }
  return `http://${formatHostForUrl("127.0.0.1")}:${HUB_DEFAULT_PORT}`;
}

function resolveSynapseFetch(fetchImpl) {
  if (fetchImpl === null) return null;
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
    const baseUrl = opts.baseUrl || resolveSynapseBaseUrl();
    const url = new URL(path, baseUrl).toString();
    const headers = { "content-type": "application/json" };
    // token: false explicitly skips auth; otherwise reuse the hub token so a
    // token-required hub does not 401 (the failure would be swallowed silently).
    if (opts.token !== false) {
      const token =
        typeof opts.token === "string" && opts.token.trim()
          ? opts.token.trim()
          : readHubToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    const init = {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    };
    // Optional bounded timeout so callers on a teardown budget (e.g. SessionEnd)
    // cannot hang the host process if the hub stalls. The timer is unref'd so it
    // never keeps the event loop (and thus the hook process) alive on its own.
    let timer = null;
    const timeoutMs = Number(opts.timeoutMs);
    if (
      Number.isFinite(timeoutMs) &&
      timeoutMs > 0 &&
      typeof AbortController === "function"
    ) {
      const controller = new AbortController();
      init.signal = controller.signal;
      timer = setTimeout(() => controller.abort(), timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    }
    Promise.resolve(fetchImpl(url, init))
      .catch(() => {})
      .finally(() => {
        if (timer) clearTimeout(timer);
      });
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
  // The live route reads `{ sessionId, partial }` (hub/server.mjs
  // /synapse/heartbeat → synapseRegistry.heartbeat(sessionId, partial)), so the
  // helper must nest the meta under `partial` rather than spreading it top-level.
  return fireAndForgetSynapse(
    "/synapse/heartbeat",
    {
      sessionId,
      partial:
        partialMeta && typeof partialMeta === "object" ? partialMeta : {},
    },
    opts,
  );
}

export function unregisterSynapseSession(sessionId, opts = {}) {
  return fireAndForgetSynapse("/synapse/unregister", { sessionId }, opts);
}
