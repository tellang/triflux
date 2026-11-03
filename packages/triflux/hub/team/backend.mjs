import { writeFileSync } from "node:fs";
import { writePromptToTmpFile } from "../lib/prompt-tmp.mjs";
import { WORKER_MCP_LAUNCHER } from "../lib/worker-mcp.mjs";
import { IS_WINDOWS } from "../platform.mjs";
import { powershellSingleQuote, shellQuote } from "./terminal-opener.mjs";

class ClaudeBackend {
  // 프롬프트를 argv 로 넘기면 ps 에 보인다. claude --print 는 프롬프트 인자가 없으면 stdin 을 읽는다.
  buildArgs(
    prompt,
    resultFile,
    {
      isWindows = IS_WINDOWS,
      promptFile,
      model,
      effort,
      workerModel,
      mcpRecommendation,
      mcp,
      cwd,
      mcpConfig,
      strictMcpConfig,
      extraArgs = [],
    } = {},
  ) {
    const file = promptFile || writePromptToTmpFile(prompt);
    const quote = isWindows ? powershellSingleQuote : shellQuote;
    const selectedModel = workerModel ? workerModel.model : model;
    const selectedEffort = workerModel ? workerModel.effort : effort;
    const modelArgs = selectedModel ? ` --model ${quote(selectedModel)}` : "";
    const effortArgs = selectedEffort
      ? ` --effort ${quote(selectedEffort === "ultra" ? "max" : selectedEffort)}`
      : "";
    const explicitArgs = [
      ...(mcpConfig ? ["--mcp-config", mcpConfig] : []),
      ...(strictMcpConfig ? ["--strict-mcp-config"] : []),
      ...extraArgs,
    ];
    let launcher = "claude";
    if (mcpRecommendation) {
      const requestFile = `${file}.mcp-request.json`;
      writeFileSync(
        requestFile,
        JSON.stringify({
          cli: "claude",
          cwd,
          recommendation: mcpRecommendation,
          profileWasAuto: !mcp || mcp === "auto",
          explicitConfig: Boolean(
            mcpConfig ||
              strictMcpConfig ||
              extraArgs.some((arg) =>
                /^--(?:mcp-config|strict-mcp-config)(?:=|$)/.test(arg),
              ),
          ),
        }),
        { mode: 0o600, flag: "wx" },
      );
      launcher = `${isWindows ? "& " : ""}${quote(process.execPath)} ${quote(WORKER_MCP_LAUNCHER)} ${quote(requestFile)} ${quote(`${resultFile}.mcp.json`)} claude`;
    }
    const run = `${launcher} --print --output-format text${modelArgs}${effortArgs}${explicitArgs.map((arg) => ` ${quote(arg)}`).join("")} > ${quote(resultFile)} 2>&1`;
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
