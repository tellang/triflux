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

// tmux 세션 이름은 tmuxExec 명령 문자열에 직접 보간되므로 shell 메타문자가 들어오면 위험.
// 현 호출처는 모두 safe identifier (slug/uuid 류) 이지만 어댑터 export 가 contract 를
// 강제하지 않아 외부 호출자가 임의 문자열을 주입할 수 있다 → 보수적으로 검증.
const TMUX_SAFE_SESSION_NAME = /^[A-Za-z0-9_.:-]+$/;

function assertSafeTmuxSessionName(sessionName) {
  const value = String(sessionName ?? "");
  if (!TMUX_SAFE_SESSION_NAME.test(value)) {
    throw new Error(
      `Unsafe tmux session name: ${JSON.stringify(value)} (allowed: A-Za-z0-9_.:-)`,
    );
  }
  return value;
}

function tmuxSessionExists(sessionName) {
  const safe = assertSafeTmuxSessionName(sessionName);
  try {
    tmuxExec(`has-session -t ${safe}`);
    return true;
  } catch {
    return false;
  }
}

function createTmuxSession(sessionName, opts = {}) {
  const safe = assertSafeTmuxSessionName(sessionName);
  tmuxExec(`new-session -d -s ${safe} -x 220 -y 55`);
}

function sendPromptToTmuxSession(sessionName, prompt) {
  const safe = assertSafeTmuxSessionName(sessionName);
  const quotedPrompt = String(prompt).replace(/'/g, "'\\''");
  tmuxExec(`send-keys -t ${safe}:0.0 '${quotedPrompt}' Enter`);
}

function killTmuxSessionByName(sessionName) {
  let safe;
  try {
    safe = assertSafeTmuxSessionName(sessionName);
  } catch {
    return;
  }
  try {
    tmuxExec(`kill-session -t ${safe}`);
  } catch {
    // 이미 종료된 세션 — 무시
  }
}

const defaultTmuxAdapter = {
  createSession: createTmuxSession,
  sendPrompt: sendPromptToTmuxSession,
  killSession: killTmuxSessionByName,
  hasSession: tmuxSessionExists,
};

/**
 * @param {{
 *   createSession: typeof createTmuxSession,
 *   sendPrompt: typeof sendPromptToTmuxSession,
 *   killSession: typeof killTmuxSessionByName,
 *   hasSession: typeof tmuxSessionExists,
 * }} [opts.adapter]
 * @param {string} [opts.sessionName]
 * @returns {{
 *   name: "tmux",
 *   kind: "tmux",
 *   sessionName: string,
 *   createSession: (opts?: object) => unknown,
 *   sendPrompt: (prompt: string) => unknown,
 *   start: (sessionName: string, opts?: object) => unknown,
 *   stop: (sessionName: string) => void,
 *   isAlive: (sessionName: string) => boolean,
 *   getStatus: (sessionName: string) => RuntimeStatus,
 * }}
 */
export function createTmuxRuntime(opts = {}) {
  const { adapter = defaultTmuxAdapter, sessionName = "" } = opts;

  return {
    name: "tmux",
    kind: "tmux",
    sessionName,
    // start() 와 동일하게 첫 인자로 sessionName override 를 받는다.
    // 첫 인자가 string 이 아니면 (옵션 객체 등) closure sessionName 을 사용하는 legacy 형태로 폴백.
    createSession(sessionNameArg, opts) {
      if (typeof sessionNameArg === "string") {
        return adapter.createSession(sessionNameArg, opts ?? {});
      }
      return adapter.createSession(sessionName, sessionNameArg ?? {});
    },
    sendPrompt(prompt, sessionNameArg = sessionName) {
      return adapter.sendPrompt(sessionNameArg, prompt);
    },
    start(sessionNameArg = sessionName, opts = {}) {
      return adapter.createSession(sessionNameArg, opts);
    },
    stop(sessionNameArg = sessionName) {
      adapter.killSession(sessionNameArg);
    },
    isAlive(sessionNameArg = sessionName) {
      return adapter.hasSession(sessionNameArg);
    },
    getStatus(sessionNameArg = sessionName) {
      return {
        name: "tmux",
        sessionName: sessionNameArg,
        alive: adapter.hasSession(sessionNameArg),
      };
    },
  };
}

/**
 * @param {string} mode
 * @param {object} [opts]
 * @returns {TeamRuntime & { name: string }}
 */
export function createRuntime(mode, opts = {}) {
  const normalizedMode = String(mode || "")
    .trim()
    .toLowerCase();

  if (normalizedMode === "psmux") {
    return createPsmuxRuntime();
  }

  if (normalizedMode === "tmux") {
    return createTmuxRuntime(opts);
  }

  if (normalizedMode === "native" || normalizedMode === "wt") {
    throw new Error(`Runtime mode "${normalizedMode}" is not implemented yet.`);
  }

  throw new Error(`Unsupported runtime mode: ${mode}`);
}
