import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { normalizeRoleKey } from "@triflux/core/hub/role-contract.mjs";

const HUB_DEFAULT_PORT = 27888;
// Same token file as hub/bridge.mjs (HUB_TOKEN_FILE). Kept inline rather than
// imported so this helper stays dependency-free and byte-identical across the
// packages/core mirror (which cannot carry relative cross-package imports).
const HUB_TOKEN_FILE = join(homedir(), ".claude", ".tfx-hub-token");

// In-flight fire-and-forget POSTs. A short-lived caller (the SessionStart hook,
// which process.exit(0)s immediately after firing register) must be able to
// flush these before the process dies: Node's process.exit() abandons pending
// socket I/O, so an un-awaited loopback POST is created but never written.
// Callers on an exit budget drain this set via drainPendingSynapse() first.
const inFlightSynapse = new Set();

function normalizeToken(raw) {
  if (raw == null) return null;
  const token = String(raw).trim();
  return token || null;
}

function opaqueId(prefix, value) {
  return `${prefix}_${createHash("sha256")
    .update(String(value || ""))
    .digest("base64url")
    .slice(0, 22)}`;
}

function normalizedProjectId(value) {
  try {
    return normalizeRoleKey({ project_id: value, role_kind: "cto" }).project_id;
  } catch {
    return "";
  }
}

function resolveProjectId(cwd, meta, opts = {}) {
  const explicit = meta?.project_id || process.env.TFX_PROJECT_ID;
  if (explicit) return normalizedProjectId(explicit);
  if (typeof opts.resolveProjectId === "function") {
    return normalizedProjectId(opts.resolveProjectId(cwd));
  }
  let current = cwd;
  while (current) {
    const manifest = join(current, ".triflux", "project.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8"));
        if (parsed?.schema_version !== "tfx.project.v1") return "";
        return normalizedProjectId(parsed.project_id);
      } catch {
        return "";
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return "";
}

function inferSessionCli(meta, opts = {}) {
  const explicit = String(meta?.cli || meta?.actor_cli || "")
    .trim()
    .toLowerCase();
  if (explicit === "codex" || explicit === "claude") return explicit;
  const entrypoint = String(opts.entrypoint ?? process.argv[1] ?? "");
  if (entrypoint.includes("codex-session-hook")) return "codex";
  if (entrypoint.includes("agy-session-hook")) return "other";
  return "claude";
}

function resolveTmuxSession(meta, opts = {}) {
  const explicit =
    meta?.tmux_session || meta?.session_name || process.env.TFX_TMUX_SESSION;
  if (explicit) return String(explicit).trim();
  if (!process.env.TMUX) return "";
  try {
    const run =
      opts.tmuxSessionName ||
      (() =>
        execFileSync("tmux", ["display-message", "-p", "#{session_name}"], {
          encoding: "utf8",
          timeout: 200,
          windowsHide: true,
        }));
    return String(run() || "").trim();
  } catch {
    return "";
  }
}

export function buildSynapseRegistrationMeta(meta, opts = {}) {
  if (!meta || meta.sessionKind !== "interactive") return meta;
  const sessionId = String(meta.sessionId || "").trim();
  if (!sessionId) return meta;
  const cwd = typeof meta.cwd === "string" ? meta.cwd : process.cwd();
  const cli = inferSessionCli(meta, opts);
  const hostId = String(
    meta.host_id ||
      process.env.TFX_HOST_ID ||
      opaqueId("hst", opts.hostname?.() || hostname()),
  ).trim();
  const expiresAtMs = Number(opts.nowMs?.() ?? Date.now()) + 299000;
  const transportLocators = [];
  if (cli === "claude") {
    transportLocators.push({
      schema_version: "tfx.transport-locator.v1",
      transport_id: opaqueId("trn", `claude-uds:${hostId}:${sessionId}`),
      kind: "claude-uds",
      host_id: hostId,
      capabilities: ["probe", "wake", "activate", "interrupt"],
      priority: 100,
      expires_at_ms: expiresAtMs,
      locator: {
        session_id: sessionId,
        bridge_id: String(
          meta.bridge_id || process.env.TFX_BRIDGE_ID || "local-hub",
        ),
      },
    });
  }
  const tmuxSession = resolveTmuxSession(meta, opts);
  if (tmuxSession) {
    const muxServerSource =
      meta.mux_server_id ||
      process.env.TFX_MUX_SERVER_ID ||
      String(process.env.TMUX || "default").split(",", 1)[0];
    transportLocators.push({
      schema_version: "tfx.transport-locator.v1",
      transport_id: opaqueId("trn", `tmux:${hostId}:${tmuxSession}`),
      kind: "tmux",
      host_id: hostId,
      capabilities: ["probe", "wake", "activate", "interrupt"],
      priority: cli === "codex" ? 100 : 50,
      expires_at_ms: expiresAtMs,
      locator: {
        session_name: tmuxSession,
        mux_server_id: opaqueId("mux", muxServerSource),
      },
    });
  }
  const directAgentId = `session:${sessionId}`;
  return {
    ...meta,
    agent_id:
      meta.agent_id ||
      (directAgentId.length <= 64 && /^[a-zA-Z0-9._:-]+$/u.test(directAgentId)
        ? directAgentId
        : opaqueId("session", sessionId)),
    cli,
    project_id: resolveProjectId(cwd, meta, opts) || undefined,
    session_id: meta.session_id || sessionId,
    host_id: hostId,
    transport_locators_json:
      meta.transport_locators_json ?? JSON.stringify(transportLocators),
  };
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
    const tracked = Promise.resolve(fetchImpl(url, init))
      .catch(() => {})
      .finally(() => {
        if (timer) clearTimeout(timer);
        inFlightSynapse.delete(tracked);
      });
    inFlightSynapse.add(tracked);
    return true;
  } catch {
    return false;
  }
}

// Await any in-flight fire-and-forget Synapse POSTs, bounded by timeoutMs so a
// stalled hub can never hang the caller. The SessionStart hook calls this right
// before process.exit(0) so the register POST actually flushes to the socket.
export function drainPendingSynapse(timeoutMs = 1000) {
  if (inFlightSynapse.size === 0) return Promise.resolve();
  const settled = Promise.allSettled([...inFlightSynapse]);
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return settled;
  let timeout = null;
  const timeoutPromise = new Promise((resolve) => {
    // Keep this timer ref'ed: drainPendingSynapse() is awaited specifically
    // to hold the process open until either in-flight POSTs settle or the
    // bounded drain budget expires. An unref'ed timer can let Node's test
    // runner/process exit before the Promise resolves when no other handles
    // remain.
    timeout = setTimeout(resolve, ms);
  });
  return Promise.race([settled, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

export function registerSynapseSession(meta, opts = {}) {
  return fireAndForgetSynapse(
    "/synapse/register",
    buildSynapseRegistrationMeta(meta, opts),
    opts,
  );
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
