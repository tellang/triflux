import { existsSync } from "node:fs";

const GIT_BASH_PATHS = Object.freeze([
  "C:/Program Files/Git/bin/bash.exe",
  "C:/Program Files/Git/usr/bin/bash.exe",
  "C:/Program Files (x86)/Git/bin/bash.exe",
  "C:/Program Files (x86)/Git/usr/bin/bash.exe",
]);

/**
 * Resolve a Windows-safe bash executable.
 * On Windows we prefer Git Bash over bare `bash`, which may resolve to WSL.
 *
 * @param {object} [opts]
 * @param {string} [opts.platform=process.platform]
 * @param {(path: string) => boolean} [opts.exists=existsSync]
 * @returns {string}
 */
export function resolveBashExecutable(opts = {}) {
  const { platform = process.platform, exists = existsSync } = opts;

  if (platform !== "win32") {
    return "bash";
  }

  return GIT_BASH_PATHS.find((candidate) => exists(candidate)) || "bash";
}
