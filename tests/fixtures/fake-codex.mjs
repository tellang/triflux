#!/usr/bin/env node
// tests/fixtures/fake-codex.mjs — Codex CLI/MCP 테스트 대역
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const mode = process.env.FAKE_CODEX_MODE || "mcp-ok";
const sessions = new Map();
let sequence = 0;

if (process.argv.includes("--version") || process.argv.includes("-V")) {
  process.stdout.write("codex 0.124.0\n");
  process.exit(0);
}

function nextThreadId() {
  sequence += 1;
  return `thread-${sequence}`;
}

function textResult(threadId, content) {
  return {
    content: [{ type: "text", text: content }],
    structuredContent: { threadId, content },
  };
}

function errorResult(message) {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function rememberFromPrompt(prompt) {
  if (prompt.includes("SHOW_CONFIG")) return "__SHOW_CONFIG__";
  const match = /^remember:(.+)$/i.exec(prompt.trim());
  if (match) return match[1].trim();
  return `MCP:${prompt}`;
}

async function runMcpServer() {
  if (mode === "mcp-fail") {
    console.error("fake codex mcp unavailable");
    process.exit(9);
  }

  const server = new Server(
    { name: "fake-codex-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "codex",
        description: "새 Codex 세션 시작",
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            profile: { type: "string" },
            cwd: { type: "string" },
            sandbox: { type: "string" },
            "approval-policy": { type: "string" },
            config: { type: "object" },
          },
          required: ["prompt"],
        },
        outputSchema: {
          type: "object",
          properties: {
            threadId: { type: "string" },
            content: { type: "string" },
          },
          required: ["threadId", "content"],
        },
      },
      {
        name: "codex-reply",
        description: "기존 Codex 세션에 후속 메시지 전송",
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            threadId: { type: "string" },
          },
          required: ["prompt"],
        },
        outputSchema: {
          type: "object",
          properties: {
            threadId: { type: "string" },
            content: { type: "string" },
          },
          required: ["threadId", "content"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const prompt = typeof args.prompt === "string" ? args.prompt : "";

    if (prompt.includes("FAIL_TOOL")) {
      return errorResult("fake tool failure");
    }

    if (mode === "mcp-empty") {
      if (name === "codex") {
        const threadId = nextThreadId();
        return textResult(threadId, "");
      }
      if (name === "codex-reply") {
        const threadId =
          typeof args.threadId === "string" && args.threadId
            ? args.threadId
            : nextThreadId();
        return textResult(threadId, "");
      }
    }

    if (name === "codex") {
      const threadId = nextThreadId();
      const memory = rememberFromPrompt(prompt);
      sessions.set(threadId, { memory, prompts: [prompt] });
      if (memory === "__SHOW_CONFIG__") {
        return textResult(threadId, JSON.stringify(args.config ?? null));
      }
      return textResult(threadId, memory);
    }

    if (name === "codex-reply") {
      const threadId = typeof args.threadId === "string" ? args.threadId : "";
      const session = sessions.get(threadId);
      if (!session) {
        return errorResult("unknown thread");
      }
      session.prompts.push(prompt);
      return textResult(threadId, session.memory);
    }

    return errorResult(`unknown tool: ${name}`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function runExec() {
  // PR #252: prompt 는 stdin redirect (Unix `< file`) / stdin pipe (Windows
  // `Get-Content -Raw | codex`) 로 전달될 수 있다. stdin 이 redirect 된 경우
  // 우선 사용하고, 아니면 마지막 argv (legacy 인라인) fallback.
  let stdinPrompt = "";
  try {
    stdinPrompt = readFileSync(0, "utf8");
  } catch {
    /* TTY 또는 권한 부족 — argv fallback */
  }
  const prompt = stdinPrompt || process.argv.at(-1) || "";
  const configFlags = [];
  let lastMessagePath = "";

  for (let i = 3; i < process.argv.length - 1; i += 1) {
    if (process.argv[i] === "-c" && process.argv[i + 1]) {
      configFlags.push(process.argv[i + 1]);
      i += 1;
    } else if (
      ["-o", "--output-last-message"].includes(process.argv[i]) &&
      process.argv[i + 1]
    ) {
      lastMessagePath = process.argv[i + 1];
      i += 1;
    }
  }

  const writeLastMessage = (content) => {
    if (lastMessagePath) writeFileSync(lastMessagePath, content, "utf8");
  };

  if (mode === "exec-fail") {
    console.error("fake codex exec failed");
    process.exit(5);
  }

  if (mode === "exec-empty") {
    process.exit(0);
  }

  if (mode === "exec-last-message") {
    writeLastMessage("FINAL:assistant message");
    process.stdout.write(
      [
        "RAW_TRACE:hook line",
        "exec",
        "/bin/zsh -lc echo fixture",
        '{"type":"thread.started","thread_id":"thr_last_message"}',
      ].join("\n"),
    );
    process.exit(0);
  }

  if (mode === "exec-long-last-message") {
    writeLastMessage(`HEAD-MARKER\n${"x".repeat(60_000)}\nTAIL-MARKER`);
    process.stdout.write("RAW_TRACE:long output");
    process.exit(0);
  }

  if (mode === "exec-stdin-notice") {
    writeLastMessage("FINAL:stdin notice is benign");
    process.stderr.write("Reading additional input from stdin...\n");
    process.exit(0);
  }

  if (
    mode === "exec-stderr-transcript" ||
    mode === "exec-stderr-tracing-error"
  ) {
    // codex 0.155 실측 형태: 안내 한 줄 + 배너 + 프롬프트 에코 + 실행 추적이 모두 stderr 로 나온다.
    writeLastMessage("FINAL:transcript on stderr is not a warning");
    process.stderr.write(
      [
        "Reading additional input from stdin...",
        "OpenAI Codex v0.155.1",
        "--------",
        "workdir: /tmp/fake",
        "model: gpt-5.6-luna",
        "approval: never",
        "--------",
        "user",
        "error: this word appears inside the echoed prompt and must not count",
        "exec",
        "/bin/zsh -lc 'echo trace-line'",
        ...(mode === "exec-stderr-tracing-error"
          ? [
              "2026-09-21T02:00:00.000Z ERROR codex_core::mcp: server context7 failed to start",
            ]
          : []),
        "tokens used",
        "1,234",
        "",
      ].join("\n"),
    );
    process.exit(0);
  }

  if (mode === "exec-stdin-notice-only") {
    process.stdout.write("Reading additional input from stdin...\n");
    process.exit(0);
  }

  // MCP transport 채널이 실행 중 죽는 케이스 재현: exit 0 + 빈 stdout +
  // stderr 크래시 노이즈. recover_codex_stdout 이 이 노이즈를 stdout 으로
  // backfill 해 옛 `! -s STDOUT_LOG` 가드를 무력화하던 버그를 재현한다(#result-verification).
  if (mode === "exec-mcp-crash") {
    process.stderr.write(
      [
        "OpenAI Codex",
        "mcp: connecting http://127.0.0.1:8101/mcp",
        "rmcp::transport worker quit with fatal: Transport channel closed",
        "workdir: /tmp/x",
        "tokens used",
        "1,234",
      ].join("\n") + "\n",
    );
    process.exit(0);
  }

  // 진짜 stdout 산출물 + stderr 에 transport 서명이 공존하는 경계 케이스: 채널
  // teardown 로그가 있어도 진짜 출력이 있으면 성공을 유지해야 한다(false-fail 방지,
  // #result-verification P3-2). recover 미진입(flag=0) → no_genuine_output=no → 미승격.
  if (mode === "exec-output-and-crash") {
    process.stderr.write(
      "rmcp::transport worker quit with fatal: Transport channel closed\n",
    );
    process.stdout.write(`EXEC:${prompt}`);
    process.exit(0);
  }

  let output = `EXEC:${prompt}`;
  if (process.env.FAKE_CODEX_ECHO_CONFIG === "1" && configFlags.length) {
    output += `\nCONFIG:${configFlags.join("|")}`;
  }
  process.stdout.write(output);
}

const subcommand = process.argv[2];

if (subcommand === "mcp-server") {
  await runMcpServer();
} else if (subcommand === "exec" || subcommand === "review") {
  runExec();
} else {
  console.error(`unknown fake codex subcommand: ${subcommand || "(none)"}`);
  process.exit(64);
}
