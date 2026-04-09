#!/usr/bin/env node

import readline from "node:readline";

const SESSION_ID = "11111111-1111-1111-1111-111111111111";
const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

let pendingToolRequest = null;

process.stdout.write(
  `${JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: SESSION_ID,
    model: "fake-claude-model",
  })}\n`,
);

function respond(text) {
  process.stdout.write(
    `${JSON.stringify({
      type: "assistant",
      session_id: SESSION_ID,
      message: {
        role: "assistant",
        session_id: SESSION_ID,
        content: [{ type: "text", text }],
      },
    })}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: SESSION_ID,
      result: text,
    })}\n`,
  );
}

function extractUserText(frame) {
  const content = frame?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => item?.text || "")
      .join("\n")
      .trim();
  }
  return "";
}

rl.on("line", (line) => {
  const frame = JSON.parse(line);

  if (frame.type === "user") {
    const text = extractUserText(frame);
    if (process.env.FAKE_CLAUDE_REQUIRE_CONTROL === "1") {
      pendingToolRequest = text;
      process.stdout.write(
        `${JSON.stringify({
          type: "control_request",
          subtype: "can_use_tool",
          request_id: "tool-1",
          tool_name: "Read",
          input: { file: "README.md" },
        })}\n`,
      );
      return;
    }
    respond(`claude:${text}`);
    return;
  }

  if (frame.type === "control_response" && pendingToolRequest) {
    respond(`claude:${pendingToolRequest}`);
    pendingToolRequest = null;
  }
});
