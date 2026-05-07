import { exec as defaultExec } from "node:child_process";
import { platform as osPlatform } from "node:os";
import { psmuxExec as defaultPsmuxExec } from "./psmux.mjs";
import { tmuxExec as defaultTmuxExec, detectMultiplexer } from "./session.mjs";
import { createWtManager as defaultCreateWtManager } from "./wt-manager.mjs";

const TMUX_LIKE_MUXES = new Set(["tmux", "wsl-tmux", "git-bash-tmux"]);

export function sanitizeTerminalTitle(value, fallback = "triflux") {
  const title = String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  return title || fallback;
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
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
      await wt.createTab(createTabSpec(spec, title));
      return true;
    }

    const mux = resolveMux(deps);
    if (TMUX_LIKE_MUXES.has(mux)) {
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
      const wt = createWtManager();
      await wt.createTab({
        title: sanitizeTerminalTitle(opts.title ?? sessionName),
        command: `psmux attach-session -t ${sessionName}`,
        cwd: opts.cwd,
        profile: opts.profile ?? "triflux",
      });
      return true;
    }

    const mux = resolveMux(deps);
    if (TMUX_LIKE_MUXES.has(mux)) {
      tmuxExec(`attach-session -t ${shellQuote(sessionName)}`);
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

    if (TMUX_LIKE_MUXES.has(mux)) {
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
