import { existsSync } from "node:fs";

const GIT_BASH_PATHS = Object.freeze([
  "C:/Program Files/Git/bin/bash.exe",
  "C:/Program Files/Git/usr/bin/bash.exe",
  "C:/Program Files (x86)/Git/bin/bash.exe",
  "C:/Program Files (x86)/Git/usr/bin/bash.exe",
]);

export function resolveGitBashExecutable(opts = {}) {
  const { platform = process.platform, exists = existsSync } = opts;

  if (platform !== "win32") {
    return null;
  }

  return GIT_BASH_PATHS.find((candidate) => exists(candidate)) || null;
}

export function resolveBashExecutable(opts = {}) {
  return resolveGitBashExecutable(opts) || "bash";
}

function shellQuote(command) {
  return `'${String(command).replace(/'/g, `'"'"'`)}'`;
}

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
