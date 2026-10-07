import { IS_WINDOWS } from "@triflux/core/hub/platform.mjs";
import { powershellSingleQuote, shellQuote } from "./terminal-opener.mjs";

class ClaudeBackend {
  buildArgs(prompt, resultFile, { isWindows = IS_WINDOWS } = {}) {
    const quote = isWindows ? powershellSingleQuote : shellQuote;
    const args = ["--print", prompt, "--output-format", "text"];
    return `claude ${args.map(quote).join(" ")} > ${quote(resultFile)} 2>&1`;
  }
}

const claude = new ClaudeBackend();

export function getBackend(name) {
  if (name !== "claude") throw new Error(`지원하지 않는 CLI: ${name}`);
  return claude;
}
