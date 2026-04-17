// hub/lib/env-detect.mjs — 쉘/터미널/멀티플렉서 환경 감지
import { execFileSync } from "node:child_process";
import { platform as osPlatform } from "node:os";

let _cached = null;
let _shellCache = null;
let _terminalCache = null;
let _multiplexerCache = null;

const PIPE_OPTS = { encoding: "utf8", timeout: 3000, stdio: "pipe" };

/**
 * 기본 쉘 감지
 * Windows: pwsh → powershell (full path + version)
 * Unix: $SHELL → /bin/sh (+ version)
 */
export function detectShell() {
  if (_shellCache) return _shellCache;

  const platform = osPlatform();

  if (platform === "win32") {
    try {
      const path = execFileSync("where", ["pwsh.exe"], PIPE_OPTS)
        .trim()
        .split(/\r?\n/)[0];
      let version = null;
      try {
        version = execFileSync(
          path,
          [
            "-NoLogo",
            "-NoProfile",
            "-Command",
            "$PSVersionTable.PSVersion.ToString()",
          ],
          PIPE_OPTS,
        ).trim();
      } catch {}
      _shellCache = { name: "pwsh", path, version };
    } catch {
      try {
        const path = execFileSync("where", ["powershell.exe"], PIPE_OPTS)
          .trim()
          .split(/\r?\n/)[0];
        _shellCache = { name: "powershell", path, version: null };
      } catch {
        _shellCache = {
          name: "powershell",
          path: "",
          version: null,
          installHint: "pwsh: winget install Microsoft.PowerShell",
        };
      }
    }
    return _shellCache;
  }

  const shellPath = process.env.SHELL || "/bin/sh";
  const name = shellPath.split("/").pop() || "sh";
  let version = null;
  try {
    version = execFileSync(shellPath, ["--version"], PIPE_OPTS).trim();
  } catch {}
  _shellCache = { name, path: shellPath, version };
  return _shellCache;
}

/**
 * 터미널 에뮬레이터 감지
 */
export function detectTerminal() {
  if (_terminalCache) return _terminalCache;

  const platform = osPlatform();
  if (platform === "win32") {
    try {
      execFileSync("where", ["wt.exe"], PIPE_OPTS);
      _terminalCache = { name: "windows-terminal", hasWt: true };
    } catch {
      _terminalCache = {
        name: "unknown",
        hasWt: false,
        installHint: "wt: winget install Microsoft.WindowsTerminal",
      };
    }
    return _terminalCache;
  }

  if (process.env.TERM_PROGRAM === "WarpTerminal") {
    _terminalCache = { name: "warp", hasWt: false };
  } else if (process.env.TERM_PROGRAM === "Alacritty") {
    _terminalCache = { name: "alacritty", hasWt: false };
  } else if (process.env.KITTY_WINDOW_ID) {
    _terminalCache = { name: "kitty", hasWt: false };
  } else if (process.env.TERM_PROGRAM === "iTerm.app") {
    _terminalCache = { name: "iterm2", hasWt: false };
  } else if (process.env.TERM_PROGRAM === "Apple_Terminal") {
    _terminalCache = { name: "terminal-app", hasWt: false };
  } else {
    _terminalCache = { name: "unknown", hasWt: false };
  }
  return _terminalCache;
}

/**
 * 멀티플렉서 감지 (tmux)
 */
export function detectMultiplexer() {
  if (_multiplexerCache) return _multiplexerCache;

  try {
    const cmd = osPlatform() === "win32" ? "where" : "which";
    const path = execFileSync(cmd, ["tmux"], PIPE_OPTS).trim();
    _multiplexerCache = { name: "tmux", path };
  } catch {
    const hint =
      osPlatform() === "win32"
        ? "tmux: install tmux in WSL or MSYS2"
        : undefined;
    _multiplexerCache = {
      name: "none",
      path: null,
      ...(hint ? { installHint: hint } : {}),
    };
  }
  return _multiplexerCache;
}

/**
 * 통합 환경 정보 조회 (레이지 싱글톤 캐시)
 * @returns {{ shell: object, terminal: object, multiplexer: object, platform: string }}
 */
export function getEnvironment() {
  if (_cached) return _cached;

  _cached = Object.freeze({
    shell: detectShell(),
    terminal: detectTerminal(),
    multiplexer: detectMultiplexer(),
    platform: osPlatform(),
  });

  return _cached;
}
