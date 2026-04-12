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

function shellQuote(command) {
  return `'${String(command).replace(/'/g, `'"'"'`)}'`;
}

/**
 * Wrap .sh script command strings so Windows always runs them through Bash.
 * This prevents shell:true child launches from treating a script path like an
 * openable file association instead of an executable script.
 *
 * @param {string} command
 * @param {object} [opts]
 * @param {string} [opts.bashCommand]
 * @returns {string}
 */
export function ensureBashScriptExecution(command, opts = {}) {
  const text = String(command || "").trim();
  if (!text) return text;

  if (!/\.sh(?:\s|$)/iu.test(text)) {
    return text;
  }

  if (
    /^(?:\s*[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*(?:bash(?:\.exe)?|sh)\b/iu.test(
      text,
    )
  ) {
    return text;
  }

  const bashCommand = opts.bashCommand || resolveBashExecutable();
  return `${bashCommand} -lc ${shellQuote(text)}`;
}
