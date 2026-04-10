import { execFileSync } from "node:child_process";
import path from "node:path";

const EXEC_OPTIONS = {
  encoding: "utf8",
  timeout: 3000,
  stdio: "pipe",
  windowsHide: true,
};

let _cached = null;

function safeExec(file, args) {
  try {
    return execFileSync(file, args, EXEC_OPTIONS);
  } catch {
    return null;
  }
}

function firstLine(output) {
  return (
    String(output ?? "")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean) || null
  );
}

function lookupCommand(name) {
  const locator = process.platform === "win32" ? "where" : "which";
  return firstLine(safeExec(locator, [name]));
}

function normalizeShellName(shellPath) {
  const base = path
    .basename(String(shellPath ?? ""))
    .replace(/\.exe$/iu, "")
    .toLowerCase();

  if (base === "pwsh") return "pwsh";
  if (base === "powershell") return "powershell";
  if (base === "bash") return "bash";
  if (base === "zsh") return "zsh";
  return process.platform === "win32" ? "powershell" : "sh";
}

function detectShellVersion(name, shellPath) {
  if (!shellPath) return null;

  if (name === "pwsh" || name === "powershell") {
    return firstLine(
      safeExec(shellPath, [
        "-NoLogo",
        "-NoProfile",
        "-Command",
        "$PSVersionTable.PSVersion.ToString()",
      ]),
    );
  }

  if (name === "bash" || name === "zsh" || name === "sh") {
    return firstLine(safeExec(shellPath, ["--version"]));
  }

  return null;
}

function hasUsablePosixShell(shellPath) {
  if (!shellPath) return false;
  return safeExec(shellPath, ["-c", "exit 0"]) !== null;
}

function getShellInstallHint(name) {
  if (name === "pwsh" || name === "powershell") {
    return process.platform === "win32"
      ? "pwsh: winget install Microsoft.PowerShell"
      : "pwsh: https://learn.microsoft.com/powershell/scripting/install/installing-powershell";
  }
  if (name === "bash") return "bash: install a POSIX shell package";
  if (name === "zsh") return "zsh: brew install zsh";
  return "sh: install a POSIX shell";
}

function detectShellInternal() {
  if (process.platform === "win32") {
    const pwshPath = lookupCommand("pwsh.exe");
    if (pwshPath) {
      return {
        name: "pwsh",
        path: pwshPath,
        version: detectShellVersion("pwsh", pwshPath),
      };
    }

    const powershellPath = lookupCommand("powershell.exe");
    if (powershellPath) {
      return {
        name: "powershell",
        path: powershellPath,
        version: detectShellVersion("powershell", powershellPath),
      };
    }

    return {
      name: "powershell",
      path: "",
      version: null,
      installHint: getShellInstallHint("powershell"),
    };
  }

  const shellEnv = String(process.env.SHELL ?? "").trim();
  const fallbackPath = shellEnv || "/bin/sh";
  const resolvedPath = fallbackPath.includes(path.sep)
    ? fallbackPath
    : lookupCommand(fallbackPath);
  const shellPath = resolvedPath || fallbackPath;
  const name = normalizeShellName(shellPath);
  const shellAvailable = hasUsablePosixShell(shellPath);

  return {
    name,
    path: shellPath,
    version: detectShellVersion(name, resolvedPath || shellPath),
    ...(shellAvailable
      ? {}
      : {
          installHint: getShellInstallHint(name),
        }),
  };
}

function detectTerminalInternal() {
  if (process.platform === "win32") {
    const wtPath = lookupCommand("wt.exe");
    if (wtPath) {
      return {
        name: "windows-terminal",
        hasWt: true,
      };
    }

    return {
      name: "unknown",
      hasWt: false,
      installHint: "wt: winget install Microsoft.WindowsTerminal",
    };
  }

  if (process.platform === "darwin") {
    const termProgram = String(process.env.TERM_PROGRAM ?? "")
      .trim()
      .toLowerCase();

    if (termProgram === "iterm.app") {
      return {
        name: "iterm2",
        hasWt: false,
      };
    }

    if (termProgram === "apple_terminal") {
      return {
        name: "terminal-app",
        hasWt: false,
      };
    }
  }

  return {
    name: "unknown",
    hasWt: false,
  };
}

function getTmuxInstallHint() {
  if (process.platform === "win32") {
    return "tmux: install tmux in WSL or MSYS2";
  }
  if (process.platform === "darwin") {
    return "tmux: brew install tmux";
  }
  return "tmux: sudo apt install tmux";
}

function detectMultiplexerInternal() {
  const tmuxPath = lookupCommand("tmux");

  if (tmuxPath) {
    return {
      name: "tmux",
      path: tmuxPath,
    };
  }

  return {
    name: "none",
    path: null,
    installHint: getTmuxInstallHint(),
  };
}

export function getEnvironment() {
  if (_cached) return _cached;

  _cached = {
    shell: detectShellInternal(),
    terminal: detectTerminalInternal(),
    multiplexer: detectMultiplexerInternal(),
    platform: process.platform,
  };

  return _cached;
}

export function detectShell() {
  return getEnvironment().shell;
}

export function detectTerminal() {
  return getEnvironment().terminal;
}

export function detectMultiplexer() {
  return getEnvironment().multiplexer;
}
