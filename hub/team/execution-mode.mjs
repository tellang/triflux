// hub/team/execution-mode.mjs — headless vs interactive execution mode selection

export const MODES = Object.freeze({
  HEADLESS: "headless",
  INTERACTIVE: "interactive",
  AUTO: "auto",
});

function quotePrompt(prompt) {
  return JSON.stringify(typeof prompt === "string" ? prompt : "");
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
