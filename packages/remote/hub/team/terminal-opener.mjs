import { exec as defaultExec, spawnSync } from "node:child_process";
import { platform as osPlatform } from "node:os";
import { psmuxExec as defaultPsmuxExec } from "./psmux.mjs";
import { tmuxExec as defaultTmuxExec, detectMultiplexer } from "./session.mjs";
import { createWtManager as defaultCreateWtManager } from "./wt-manager.mjs";

const TMUX_LIKE_MUXES = new Set(["tmux", "git-bash-tmux"]);

export function sanitizeTerminalTitle(value, fallback = "triflux") {
  const title = String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  return title || fallback;
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function powershellSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function buildCommandString({ cwd, command }) {
  const commandString = String(command ?? "");
  if (!cwd) return commandString;
  return `cd ${shellQuote(cwd)} && ${commandString}`;
}

function resolvePlatform(deps) {
  if (typeof deps.platform === "function") return deps.platform();
  return deps.platform || osPlatform();
}

function resolveMux(deps) {
  if (Object.hasOwn(deps, "mux")) return deps.mux;
  if (typeof deps.detectMultiplexer === "function")
    return deps.detectMultiplexer();
  return detectMultiplexer();
}

function createTabSpec(spec, title) {
  return {
    title,
    command: String(spec.command ?? ""),
    cwd: spec.cwd,
    profile: spec.profile ?? "triflux",
  };
}

function execOpenTerminal(execFn) {
  return new Promise((resolve) => {
    execFn("open -a Terminal", { timeout: 5000 }, (error) => {
      resolve(!error);
    });
  });
}

// psmux는 Windows에서 wt-manager 경유 (createTab/splitPane 등) — tmux 호환 unix 명령군과 다른 표면.
// 비-Windows(macOS/Linux) 환경에서는 psmux가 tmux-compatible new-window/select-pane 명령을 받아주므로
// tmux 어댑터와 동일하게 취급한다.
function isTmuxLikeMux(mux, platform) {
  return TMUX_LIKE_MUXES.has(mux) || (platform !== "win32" && mux === "psmux");
}

function shellCommandName(value) {
  const command = String(value);
  return /^[A-Za-z0-9_./:-]+$/u.test(command) ? command : shellQuote(command);
}

function powershellCommandName(value) {
  const command = String(value);
  return /^[A-Za-z0-9_.:-]+$/u.test(command)
    ? command
    : `& ${powershellSingleQuote(command)}`;
}

function getCommandVersion(command) {
  const r = spawnSync(command, ["-V"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 3000,
    windowsHide: true,
  });
  if ((r.status ?? 1) !== 0) return null;
  return `${r.stdout || ""}${r.stderr || ""}`.trim();
}

function defaultPsmuxBinaryExists(command) {
  try {
    return /\bpsmux\b/i.test(getCommandVersion(command) || "");
  } catch {
    return false;
  }
}

function buildAttachCommand(mux, sessionName, deps = {}) {
  if (mux === "psmux") {
    const command = process.env.PSMUX_BIN || "psmux";
    const psmuxBinaryExists =
      deps.psmuxBinaryExists || defaultPsmuxBinaryExists;
    if (!psmuxBinaryExists(command)) return null;
    return `${shellCommandName(command)} attach-session -t ${shellQuote(sessionName)}`;
  }
  return `tmux attach-session -t ${shellQuote(sessionName)}`;
}

// wt-manager.createTab은 (a) undefined/void 반환 — legacy success 의미 (b) {success:true|false, ...} 객체 반환의 두 형태가 공존.
// `result?.success !== false`는 undefined/null/{}을 모두 success로 취급하고 명시적 {success:false}만 실패로 본다.
function wtResultSucceeded(result) {
  return result?.success !== false;
}

export function createTerminalOpener(deps = {}) {
  const platform = resolvePlatform(deps);
  const tmuxExec = deps.tmuxExec || defaultTmuxExec;
  const psmuxExec = deps.psmuxExec || defaultPsmuxExec;
  const exec = deps.exec || defaultExec;
  const createWtManager = deps.createWtManager || defaultCreateWtManager;

  async function openCommand(spec = {}) {
    const title = sanitizeTerminalTitle(spec.title);

    if (platform === "win32") {
      const wt = createWtManager();
      try {
        return wtResultSucceeded(
          await wt.createTab(createTabSpec(spec, title)),
        );
      } catch {
        return false;
      }
    }

    const mux = resolveMux(deps);
    if (isTmuxLikeMux(mux, platform)) {
      tmuxExec(
        `new-window -n ${shellQuote(title)} ${shellQuote(
          buildCommandString(spec),
        )}`,
      );
      return true;
    }

    if (platform === "darwin") {
      return execOpenTerminal(exec);
    }

    return false;
  }

  async function openSession(sessionName, opts = {}) {
    if (platform === "win32") {
      const command = process.env.PSMUX_BIN || "psmux";
      const psmuxBinaryExists =
        deps.psmuxBinaryExists || defaultPsmuxBinaryExists;
      if (!psmuxBinaryExists(command)) return false;
      const wt = createWtManager();
      try {
        return wtResultSucceeded(
          await wt.createTab({
            title: sanitizeTerminalTitle(opts.title ?? sessionName),
            command: `${powershellCommandName(
              command,
            )} attach-session -t ${powershellSingleQuote(sessionName)}`,
            cwd: opts.cwd,
            profile: opts.profile ?? "triflux",
          }),
        );
      } catch {
        return false;
      }
    }

    const mux = resolveMux(deps);
    if (isTmuxLikeMux(mux, platform)) {
      const attachCommand = buildAttachCommand(mux, sessionName, deps);
      if (!attachCommand) return false;
      tmuxExec(
        `new-window -n ${shellQuote(opts.title ?? sessionName)} ${shellQuote(
          attachCommand,
        )}`,
      );
      return true;
    }

    return false;
  }

  function focusPane(sessionName, workerNumber) {
    const target = `${sessionName}:0.${workerNumber}`;
    const mux = resolveMux(deps);

    if (mux === "psmux") {
      psmuxExec(["select-pane", "-t", target]);
      return true;
    }

    if (isTmuxLikeMux(mux, platform)) {
      tmuxExec(`select-pane -t ${shellQuote(target)}`);
      return true;
    }

    return false;
  }

  return { openCommand, openSession, focusPane };
}

export function openSessionTarget(sessionName, opts = {}) {
  return createTerminalOpener(opts._deps).openSession(sessionName, opts);
}

export function focusSessionPane(sessionName, workerNumber, opts = {}) {
  return createTerminalOpener(opts._deps).focusPane(sessionName, workerNumber);
}
