// hub/team/execution-mode.mjs — headless vs interactive execution mode selection

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";

import { whichCommand } from "../platform.mjs";

const WIN32_EXT_PRECEDENCE = [".cmd", ".exe", ".bat", ".ps1"];

// #128: parse npm-cmd-shim wrapper to extract the underlying .js entry point.
// codex.cmd / gemini.cmd end with: "%_prog%" "%dp0%\node_modules\...\<cli>.js" %*
// %* is cmd batch arg pass-through which mangles multi-line / fenced prompts.
// Bypass cmd entirely by spawning node + the .js directly.
export function unwrapCmdToJsScript(cmdPath, opts = {}) {
  const readFile = opts.readFile || readFileSync;
  const existsFn = opts.existsSyncFn || existsSync;
  try {
    const content = readFile(cmdPath, "utf8");
    const match = content.match(/"%dp0%[\\/]([^"]+\.[cm]?js)"/i);
    if (!match) return null;
    const dir = dirname(cmdPath);
    const jsPath = pathResolve(dir, match[1].replace(/\\/g, "/"));
    return existsFn(jsPath) ? jsPath : null;
  } catch {
    return null;
  }
}

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
  // (EINVAL). npm-installed Windows wrappers (e.g. codex.cmd) hit this.
  //
  // #128 (BUG-A): the cmd /c wrapper used to be the workaround, but cmd batch
  // %* arg pass-through mangles multi-line and fenced (```bash) prompts before
  // they reach the underlying .js. We now unwrap the .cmd to the node script
  // it launches and spawn `node <script>` directly, bypassing cmd entirely.
  // Falls back to cmd /c if the .cmd cannot be parsed.
  const needsCmdWrap =
    platform === "win32" && /\.(cmd|bat)$/i.test(resolvedCommand);
  const unwrappedJs = needsCmdWrap
    ? (opts.unwrapCmdFn || unwrapCmdToJsScript)(resolvedCommand)
    : null;
  const wrap = (args) => {
    if (unwrappedJs) {
      const nodeBin = opts.nodeExecPath || process.execPath;
      return { command: nodeBin, args: [unwrappedJs, ...args] };
    }
    if (needsCmdWrap) {
      return { command: "cmd", args: ["/c", resolvedCommand, ...args] };
    }
    return { command: resolvedCommand, args };
  };

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
