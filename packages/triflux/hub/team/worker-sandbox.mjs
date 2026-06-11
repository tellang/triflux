// hub/team/worker-sandbox.mjs — local worker HOME/APPDATA isolation helpers
//
// Team/swarm workers run untrusted task-specific CLIs. Keep their mutable user
// state under the worker worktree instead of the operator's real home/appdata,
// while preserving explicitly brokered auth homes such as CODEX_HOME.

import { mkdirSync } from "node:fs";
import { join, resolve, win32 } from "node:path";

const SAFE_SEGMENT_RE = /[^a-zA-Z0-9._-]/g;

function safeSegment(value, fallback = "worker") {
  const raw = String(value ?? "").trim();
  const cleaned = raw.replace(SAFE_SEGMENT_RE, "_").replace(/^_+|_+$/g, "");
  return cleaned || fallback;
}

function isDisabled(env = {}) {
  return /^(0|false|no|off)$/i.test(String(env.TFX_WORKER_SANDBOX ?? ""));
}

// Antigravity-family CLIs (agy/gemini) authenticate only via interactive OAuth and
// store credentials in the OS keyring plus HOME-relative ~/.gemini state bound to the
// logged-in user. They expose no headless-auth flag and no config-home env
// (antigravity-cli issues #223/#155/#316), so overriding HOME forces a re-auth that
// never completes in a headless swarm/team worker — the worker times out at the OAuth
// wait and does no work (the agy "no_commit" symptom). Keep the host HOME for these
// agents so the keyring and ~/.gemini resolve. Codex stays isolated via CODEX_HOME.
const AUTH_HOME_BOUND_AGENTS = new Set(["antigravity", "agy", "gemini"]);

function isAuthHomeBoundAgent(agent) {
  return AUTH_HOME_BOUND_AGENTS.has(
    String(agent ?? "")
      .trim()
      .toLowerCase(),
  );
}

function windowsHomeParts(home) {
  const normalized = String(home || "").replace(/\//g, "\\");
  const match = normalized.match(/^([a-zA-Z]:)(\\.*)$/);
  if (!match) return null;
  return { drive: match[1], path: match[2] || "\\" };
}

function mkdirAll(paths) {
  for (const path of paths) mkdirSync(path, { recursive: true });
}

/**
 * Build a deterministic sandbox home for a local team/swarm worker.
 *
 * @param {object} opts
 * @param {string} [opts.cwd] Worktree/current working directory for the worker.
 * @param {string} [opts.sessionId] Stable session/member id.
 * @param {string} [opts.agent] Worker CLI/agent; antigravity-family agents skip the
 *   HOME override so their keyring/OAuth credentials resolve (see note above).
 * @param {object} [opts.env] Existing env used for opt-out and explicit root.
 * @param {boolean} [opts.create=true] Create directories eagerly.
 * @returns {{env: object, root: string|null, home: string|null, disabled: boolean, reason?: string}}
 */
export function buildWorkerSandboxEnv(opts = {}) {
  const env = opts.env && typeof opts.env === "object" ? opts.env : {};
  if (isDisabled(env)) {
    return { env: {}, root: null, home: null, disabled: true };
  }
  if (isAuthHomeBoundAgent(opts.agent)) {
    return {
      env: {},
      root: null,
      home: null,
      disabled: true,
      reason: "auth-home-bound-agent",
    };
  }

  const cwd = resolve(opts.cwd || process.cwd());
  const sessionId = safeSegment(opts.sessionId, "worker");
  const home = resolve(
    env.TFX_WORKER_HOME || join(cwd, ".triflux", "worker-home", sessionId),
  );
  const appData = join(home, "AppData", "Roaming");
  const localAppData = join(home, "AppData", "Local");
  const xdgConfig = join(home, ".config");
  const xdgCache = join(home, ".cache");
  const xdgState = join(home, ".local", "state");

  if (opts.create !== false) {
    mkdirAll([home, appData, localAppData, xdgConfig, xdgCache, xdgState]);
  }

  const overlay = {
    TFX_WORKER_HOME: home,
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_CACHE_HOME: xdgCache,
    XDG_STATE_HOME: xdgState,
  };
  const hostHome = env.HOME || env.USERPROFILE;
  if (!env.CODEX_HOME && hostHome) {
    overlay.CODEX_HOME = join(hostHome, ".codex");
  }

  const winParts =
    windowsHomeParts(home) ||
    (process.platform === "win32"
      ? {
          drive: win32.parse(home).root.replace(/[\\/]$/, "") || "C:",
          path:
            win32
              .relative(win32.parse(home).root, home)
              .replace(/\//g, "\\")
              .replace(/^/, "\\") || "\\",
        }
      : null);
  if (winParts) {
    overlay.HOMEDRIVE = winParts.drive;
    overlay.HOMEPATH = winParts.path;
  }

  return { env: overlay, root: home, home, disabled: false };
}
