import { writePromptToTmpFile } from "../lib/prompt-tmp.mjs";
import { IS_WINDOWS } from "../platform.mjs";
import { powershellSingleQuote, shellQuote } from "./terminal-opener.mjs";

class ClaudeBackend {
  // 프롬프트를 argv 로 넘기면 ps 에 보인다. claude --print 는 프롬프트 인자가 없으면 stdin 을 읽는다.
  buildArgs(prompt, resultFile, { isWindows = IS_WINDOWS, promptFile } = {}) {
    const file = promptFile || writePromptToTmpFile(prompt);
    const quote = isWindows ? powershellSingleQuote : shellQuote;
    const run = `claude --print --output-format text > ${quote(resultFile)} 2>&1`;
    return isWindows
      ? `Get-Content -Raw ${quote(file)} | ${run}`
      : `${run} < ${quote(file)}`;
  }
}

const claude = new ClaudeBackend();

export function getBackend(name) {
  if (name !== "claude") throw new Error(`지원하지 않는 CLI: ${name}`);
  return claude;
}
