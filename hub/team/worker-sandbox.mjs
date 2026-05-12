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
 * @param {object} [opts.env] Existing env used for opt-out and explicit root.
 * @param {boolean} [opts.create=true] Create directories eagerly.
 * @returns {{env: object, root: string|null, home: string|null, disabled: boolean}}
 */
export function buildWorkerSandboxEnv(opts = {}) {
  const env = opts.env && typeof opts.env === "object" ? opts.env : {};
  if (isDisabled(env)) {
    return { env: {}, root: null, home: null, disabled: true };
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
