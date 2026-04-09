import {
  createPsmuxSession,
  killPsmuxSession,
  psmuxSessionExists,
} from "./psmux.mjs";

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

  if (normalizedMode === "native" || normalizedMode === "wt") {
    throw new Error(`Runtime mode "${normalizedMode}" is not implemented yet.`);
  }

  throw new Error(`Unsupported runtime mode: ${mode}`);
}
