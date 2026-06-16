// hub/team/execution-mode.mjs — headless vs interactive execution mode selection

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";

import { whichCommand } from "@triflux/core/hub/platform.mjs";

const WIN32_EXT_PRECEDENCE = [".cmd", ".exe", ".bat", ".ps1"];

// #128: parse npm-cmd-shim wrapper to extract the underlying .js entry point.
// npm shim wrappers end with: "%_prog%" "%dp0%\node_modules\...\<cli>.js" %*
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

function asPrompt(prompt) {
  return typeof prompt === "string" ? prompt : "";
}

function pushFlag(args, flag, value) {
  if (typeof value === "string" && value.length > 0) {
    args.push(flag, value);
  }
}

// #116-C: codex headless 의 argv-inline prompt 가 macOS oh-my-codex hook
// SessionStart Failed 회귀를 유발 (codex CLI v0.130.0). cli-adapter-base 의
// buildExecCommand 가 shell command 형태에서 동일 fix 를 적용했고
// (TFX_CODEX_STDIN_PROMPT=0 opt-out), 본 함수의 spawn-args 형태에서도 같은
// 정신으로 prompt 를 stdin transport 로 분리한다. 동일 env var 를 재사용해
// 사용자가 한 곳만 끄면 양쪽 path 모두 비활성.
export function resolveStdinPromptMode(explicit, envSource) {
  if (typeof explicit === "boolean") return explicit;
  const env = (envSource || process.env).TFX_CODEX_STDIN_PROMPT;
  if (env === "0" || env === "false") return false;
  return true;
}

function normalizeCli(cli) {
  const value = String(cli || "codex").toLowerCase();
  if (value === "gemini" || value === "antigravity" || value === "agy") {
    return "antigravity";
  }
  return value;
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
  const cli = normalizeCli(opts.cli || "codex");
  const prompt = asPrompt(opts.prompt);
  const commandName = cli === "antigravity" ? "agy" : cli;
  const resolvedCommand = resolveCliExecutable(commandName, opts);
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

  if (cli === "antigravity") {
    const args = ["--print", "--dangerously-skip-permissions"];
    return {
      ...wrap(args),
      useExec: true,
      shell: false,
      stdinPrompt: prompt.length > 0,
      prompt,
    };
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
    const excludedMcpServers = new Set(
      (Array.isArray(opts.excludeMcpServers) ? opts.excludeMcpServers : [])
        .map((server) => String(server ?? "").trim())
        .filter(Boolean),
    );
    for (const rawServer of opts.mcpServers) {
      const server = String(rawServer ?? "").trim();
      if (!server) continue;
      if (excludedMcpServers.has(server)) {
        const message = `Skipping MCP server '${server}' because Codex preflight did not find an enabled config entry.`;
        if (typeof opts.onWarning === "function") {
          opts.onWarning(message, { type: "mcp_server_skipped", server });
        }
        continue;
      }
      args.push("-c", `mcp_servers.${server}.enabled=true`);
    }
  }

  // #116-C: codex headless 의 argv-inline prompt → macOS oh-my-codex hook
  // SessionStart Failed 회귀 (codex v0.130.0). default 가 stdin transport.
  // conductor.respawnSession 이 spec.prompt 를 child.stdin.write 로 주입한다.
  const useStdin =
    resolveStdinPromptMode(opts.stdinPrompt, opts.env) && prompt.length > 0;
  if (useStdin) {
    return {
      ...wrap(args),
      useExec: true,
      shell: false,
      stdinPrompt: true,
      prompt,
    };
  }

  args.push(prompt);
  return { ...wrap(args), useExec: true, shell: false };
}

/**
 * @param {{
 *   cli: "codex"|"gemini"|"antigravity"|"agy"|"claude",
 *   taskType?: "implement"|"review"|"research"|"test"|"analyze",
 *   needsInput?: boolean,
 *   estimatedDuration?: number,
 *   hasHub?: boolean,
 * }} opts
 * @returns {{ mode: string, reason: string }}
 */
export function selectExecutionMode(opts = {}) {
  const {
    cli: rawCli = "codex",
    taskType = "research",
    needsInput = false,
    estimatedDuration = 0,
    hasHub = false,
  } = opts;

  const cli = normalizeCli(rawCli);

  if (!hasHub) {
    return {
      mode: MODES.HEADLESS,
      reason: "interactive mode requires hub; falling back to headless",
    };
  }

  if (cli === "antigravity") {
    return {
      mode: MODES.HEADLESS,
      reason: "antigravity CLI uses headless stdin print mode",
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

// buildCommandForMode 는 caller 가 없어 제거됨 (v10.20.x). argv-inline 프롬프트와
// `-s danger-full-access` flag 가 PR #252 의 stdin redirect 패턴과 정합하지
// 않아 회귀 위험이 있었다. 실제 헤드리스 spawn 은 buildSpawnSpecForMode
// (conductor.mjs:544) 가 담당하며, 셸 명령 형태가 필요한 경우는
// hub/cli-adapter-base.mjs:buildExecCommand 를 사용한다.
