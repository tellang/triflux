// hub/lib/env-detect.mjs — 쉘/터미널/멀티플렉서 환경 감지
import { execFileSync } from "node:child_process";
import { platform as osPlatform } from "node:os";

let _cached = null;

/**
 * 기본 쉘 감지
 * Windows: pwsh → powershell
 * Unix: $SHELL → /bin/sh
 */
export function detectShell() {
  const platform = osPlatform();
  if (platform === "win32") {
    try {
      execFileSync("where", ["pwsh.exe"], { stdio: "ignore", timeout: 3000 });
      return { name: "pwsh", path: "pwsh.exe", version: null };
    } catch {
      try {
        execFileSync("where", ["powershell.exe"], { stdio: "ignore", timeout: 3000 });
        return { name: "powershell", path: "powershell.exe", version: null };
      } catch {
        return { name: "cmd", path: "cmd.exe", version: null, installHint: "pwsh: winget install Microsoft.PowerShell" };
      }
    }
  }

  const shellPath = process.env.SHELL || "/bin/sh";
  const name = shellPath.split("/").pop() || "sh";
  return { name, path: shellPath, version: null };
}

/**
 * 터미널 에뮬레이터 감지
 */
export function detectTerminal() {
  const platform = osPlatform();
  if (platform === "win32") {
    try {
      execFileSync("where", ["wt.exe"], { stdio: "ignore", timeout: 3000 });
      return { name: "windows-terminal", hasWt: true };
    } catch {
      return { name: "conhost", hasWt: false, installHint: "Windows Terminal: winget install Microsoft.WindowsTerminal" };
    }
  }

  if (process.env.TERM_PROGRAM === "iTerm.app") {
    return { name: "iterm2", hasWt: false };
  }
  if (process.env.TERM_PROGRAM === "Apple_Terminal") {
    return { name: "terminal-app", hasWt: false };
  }

  return { name: "unknown", hasWt: false };
}

/**
 * 멀티플렉서 감지 (tmux)
 */
export function detectMultiplexer() {
  try {
    const cmd = osPlatform() === "win32" ? "where" : "which";
    const path = execFileSync(cmd, ["tmux"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return { name: "tmux", path };
  } catch {
    return { name: "none", path: null };
  }
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
