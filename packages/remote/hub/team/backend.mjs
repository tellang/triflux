import { writePromptToTmpFile } from "@triflux/core/hub/lib/prompt-tmp.mjs";
import { IS_WINDOWS } from "@triflux/core/hub/platform.mjs";
import { powershellSingleQuote, shellQuote } from "./terminal-opener.mjs";

class ClaudeBackend {
  // 프롬프트를 argv 로 넘기면 ps 에 보인다. claude --print 는 프롬프트 인자가 없으면 stdin 을 읽는다.
  buildArgs(prompt, resultFile, { isWindows = IS_WINDOWS, promptFile } = {}) {
    const file = promptFile || writePromptToTmpFile(prompt);
    const quote = isWindows ? powershellSingleQuote : shellQuote;
    const run = `claude --print --output-format text > ${quote(resultFile)} 2>&1`;
    // PowerShell 5.1 은 BOM 없는 파일을 ANSI 로 읽고 파이프를 ASCII 로 보내서 UTF-8 을 명시한다.
    // -LiteralPath 는 경로의 [] 를 와일드카드로 읽지 않게 한다.
    return isWindows
      ? `$OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-Content -LiteralPath ${quote(file)} -Raw -Encoding UTF8 | ${run}`
      : `${run} < ${quote(file)}`;
  }
}

const claude = new ClaudeBackend();

export function getBackend(name) {
  if (name !== "claude") throw new Error(`지원하지 않는 CLI: ${name}`);
  return claude;
}
