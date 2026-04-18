// hub/team/execution-mode.mjs — headless vs interactive execution mode selection

import { existsSync } from "node:fs";

import { whichCommand } from "../platform.mjs";

const WIN32_EXT_PRECEDENCE = [".cmd", ".exe", ".bat", ".ps1"];

export const MODES = Object.freeze({
  HEADLESS: "headless",
  INTERACTIVE: "interactive",
  AUTO: "auto",
});

function quotePrompt(prompt) {
  return JSON.stringify(typeof prompt === "string" ? prompt : "");
}

function asPrompt(prompt) {
  return typeof prompt === "string" ? prompt : "";
}

function pushFlag(args, flag, value) {
  if (typeof value === "string" && value.length > 0) {
    args.push(flag, value);
  }
}

export function resolveCliExecutable(cli, opts = {}) {
  const name = String(cli || "codex");
  const resolveCommand = opts.resolveCommand || whichCommand;
  const resolved = resolveCommand(name) || name;

  // Windows: Node spawn({ shell: false }) calls CreateProcess directly and does NOT
  // search PATHEXT. npm-installed CLIs (codex, gemini) live at `<npm>/codex` (Git Bash
  // shell script) alongside `<npm>/codex.cmd` (Windows batch wrapper). whichCommand
  // returns the extensionless path, which Windows cannot execute → ENOENT "The system
  // cannot find the file specified." Append the correct extension when the resolved
  // path has none.
  const platform = opts.platform || process.platform;
  if (platform === "win32" && resolved) {
    const hasExt = /\.[^\\/.]+$/.test(resolved);
    if (!hasExt) {
      const existsFn = opts.existsSyncFn || existsSync;
      for (const ext of WIN32_EXT_PRECEDENCE) {
        const candidate = `${resolved}${ext}`;
        try {
          if (existsFn(candidate)) return candidate;
        } catch {
          // ignore stat failures, try next extension
        }
      }
    }
  }

  return resolved;
}

export function buildSpawnSpecForMode(mode, opts = {}) {
  const cli = opts.cli || "codex";
  const prompt = asPrompt(opts.prompt);
  const resolvedCommand = resolveCliExecutable(cli, opts);
  const platform = opts.platform || process.platform;

  // Node v20.12+ (CVE-2024-27980) rejects spawn of .cmd/.bat files with shell:false
  // (EINVAL). npm-installed Windows wrappers (e.g. codex.cmd) hit this. Wrap via
  // cmd.exe /c to keep shell:false while still launching the batch wrapper.
  const needsCmdWrap =
    platform === "win32" && /\.(cmd|bat)$/i.test(resolvedCommand);
  const wrap = (args) =>
    needsCmdWrap
      ? { command: "cmd", args: ["/c", resolvedCommand, ...args] }
      : { command: resolvedCommand, args };

  if (cli === "gemini") {
    const args = [];
    pushFlag(args, "--model", opts.model);
    args.push("--yolo", "--prompt", prompt, "--output-format", "text");
    return { ...wrap(args), useExec: true, shell: false };
  }

  if (mode === MODES.INTERACTIVE || mode === MODES.AUTO) {
    return { ...wrap([]), useExec: false, shell: false };
  }

  if (cli === "claude") {
    const args = [];
    pushFlag(args, "--model", opts.model);
    args.push("-p", prompt);
    return { ...wrap(args), useExec: true, shell: false };
  }

  const args = [];
  pushFlag(args, "--profile", opts.profile);
  args.push(
    "exec",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "--color",
    "never",
  );
  if (Array.isArray(opts.mcpServers)) {
    for (const server of opts.mcpServers) {
      args.push("-c", `mcp_servers.${server}.enabled=true`);
    }
  }
  args.push(prompt);
  return { ...wrap(args), useExec: true, shell: false };
}

/**
 * @param {{
 *   cli: "codex"|"gemini"|"claude",
 *   taskType?: "implement"|"review"|"research"|"test"|"analyze",
 *   needsInput?: boolean,
 *   estimatedDuration?: number,
 *   hasHub?: boolean,
 * }} opts
 * @returns {{ mode: string, reason: string }}
 */
export function selectExecutionMode(opts = {}) {
  const {
    cli = "codex",
    taskType = "research",
    needsInput = false,
    estimatedDuration = 0,
    hasHub = false,
  } = opts;

  if (!hasHub) {
    return {
      mode: MODES.HEADLESS,
      reason: "interactive mode requires hub; falling back to headless",
    };
  }

  if (cli === "gemini") {
    return {
      mode: MODES.HEADLESS,
      reason: "gemini CLI only supports headless prompt mode",
    };
  }

  if (taskType === "implement" && !needsInput) {
    return {
      mode: MODES.HEADLESS,
      reason: "implementation without expected input fits headless execution",
    };
  }

  if (taskType === "review" || taskType === "analyze") {
    return {
      mode: MODES.HEADLESS,
      reason: "review and analyze tasks default to headless execution",
    };
  }

  if (needsInput === true) {
    return {
      mode: MODES.INTERACTIVE,
      reason: "task may require operator input during execution",
    };
  }

  if (estimatedDuration > 300) {
    return {
      mode: MODES.INTERACTIVE,
      reason: "long-running work benefits from monitored interactive mode",
    };
  }

  return {
    mode: MODES.HEADLESS,
    reason: "defaulting to headless execution",
  };
}

/**
 * @param {string} mode
 * @param {{ cli?: "codex"|"gemini"|"claude", prompt?: string }} opts
 * @returns {{ command: string, useExec: boolean }}
 */
export function buildCommandForMode(mode, opts = {}) {
  const cli = opts.cli || "codex";
  const prompt = quotePrompt(opts.prompt);

  if (cli === "gemini") {
    return { command: `gemini -p ${prompt}`, useExec: true };
  }

  if (mode === MODES.INTERACTIVE || mode === MODES.AUTO) {
    return { command: cli === "claude" ? "claude" : "codex", useExec: false };
  }

  if (cli === "claude") {
    return { command: `claude --print ${prompt}`, useExec: true };
  }

  return {
    command: `codex exec ${prompt} -s danger-full-access --dangerously-bypass-approvals-and-sandbox`,
    useExec: true,
  };
}
