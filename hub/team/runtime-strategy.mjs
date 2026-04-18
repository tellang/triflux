import {
  createPsmuxSession,
  killPsmuxSession,
  psmuxSessionExists,
} from "./psmux.mjs";
import { tmuxExec } from "./session.mjs";

/**
 * @typedef {object} RuntimeStatus
 * @property {string} name
 * @property {string} sessionName
 * @property {boolean} alive
 */

/**
 * @typedef {object} TeamRuntime
 * @property {(sessionName: string, opts?: object) => unknown} start
 * @property {(sessionName: string) => void} stop
 * @property {(sessionName: string) => boolean} isAlive
 * @property {(sessionName: string) => RuntimeStatus} getStatus
 */

const defaultPsmuxAdapter = {
  createSession: createPsmuxSession,
  killSession: killPsmuxSession,
  hasSession: psmuxSessionExists,
};

/**
 * @param {{
 *   createSession: typeof createPsmuxSession,
 *   killSession: typeof killPsmuxSession,
 *   hasSession: typeof psmuxSessionExists,
 * }} [adapter]
 * @returns {TeamRuntime & { name: "psmux" }}
 */
export function createPsmuxRuntime(adapter = defaultPsmuxAdapter) {
  return {
    name: "psmux",
    start(sessionName, opts = {}) {
      return adapter.createSession(sessionName, opts);
    },
    stop(sessionName) {
      adapter.killSession(sessionName);
    },
    isAlive(sessionName) {
      return adapter.hasSession(sessionName);
    },
    getStatus(sessionName) {
      return {
        name: "psmux",
        sessionName,
        alive: adapter.hasSession(sessionName),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// tmux 어댑터
// ---------------------------------------------------------------------------

function tmuxSessionExists(sessionName) {
  try {
    tmuxExec(`has-session -t ${sessionName}`);
    return true;
  } catch {
    return false;
  }
}

function createTmuxSession(sessionName, opts = {}) {
  tmuxExec(`new-session -d -s ${sessionName} -x 220 -y 55`);
}

function killTmuxSessionByName(sessionName) {
  try {
    tmuxExec(`kill-session -t ${sessionName}`);
  } catch {
    // 이미 종료된 세션 — 무시
  }
}

const defaultTmuxAdapter = {
  createSession: createTmuxSession,
  killSession: killTmuxSessionByName,
  hasSession: tmuxSessionExists,
};

/**
 * @param {{
 *   createSession: typeof createTmuxSession,
 *   killSession: typeof killTmuxSessionByName,
 *   hasSession: typeof tmuxSessionExists,
 * }} [adapter]
 * @returns {TeamRuntime & { name: "tmux" }}
 */
export function createTmuxRuntime(adapter = defaultTmuxAdapter) {
  return {
    name: "tmux",
    start(sessionName, opts = {}) {
      return adapter.createSession(sessionName, opts);
    },
    stop(sessionName) {
      adapter.killSession(sessionName);
    },
    isAlive(sessionName) {
      return adapter.hasSession(sessionName);
    },
    getStatus(sessionName) {
      return {
        name: "tmux",
        sessionName,
        alive: adapter.hasSession(sessionName),
      };
    },
  };
}

/**
 * @param {string} mode
 * @returns {TeamRuntime & { name: string }}
 */
export function createRuntime(mode) {
  const normalizedMode = String(mode || "")
    .trim()
    .toLowerCase();

  if (normalizedMode === "psmux") {
    return createPsmuxRuntime();
  }

  if (normalizedMode === "tmux") {
    return createTmuxRuntime();
  }

  if (normalizedMode === "native" || normalizedMode === "wt") {
    throw new Error(`Runtime mode "${normalizedMode}" is not implemented yet.`);
  }

  throw new Error(`Unsupported runtime mode: ${mode}`);
}
