#!/usr/bin/env node
// tests/fixtures/fake-codex.mjs — Codex CLI/MCP 테스트 대역
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
  const prompt = process.argv.at(-1) || "";
  const configFlags = [];

  for (let i = 3; i < process.argv.length - 1; i += 1) {
    if (process.argv[i] === "-c" && process.argv[i + 1]) {
      configFlags.push(process.argv[i + 1]);
      i += 1;
    }
  }

  if (mode === "exec-fail") {
    console.error("fake codex exec failed");
    process.exit(5);
  }

  if (mode === "exec-empty") {
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
