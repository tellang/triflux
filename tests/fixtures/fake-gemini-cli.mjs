#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);

function getArgValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

function getArgValues(name) {
  const index = args.indexOf(name);
  if (index < 0) return [];
  const values = [];
  for (let i = index + 1; i < args.length; i += 1) {
    if (args[i].startsWith("--")) break;
    values.push(args[i]);
  }
  return values;
}

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});

process.stdin.on("end", async () => {
  const promptText = `${stdin}${getArgValue("--prompt") || ""}`.trim();
  const model = getArgValue("--model") || "fake-gemini-model";
  const outputFormat = getArgValue("--output-format");
  const allowedMcpServerNames = getArgValues("--allowed-mcp-server-names");

  if (process.env.FAKE_GEMINI_SILENT_CRASH) {
    // 출력 없이 즉시 종료 — health check crash 감지 테스트용
    process.exit(Number(process.env.FAKE_GEMINI_SILENT_CRASH));
    return;
  }

  if (process.env.FAKE_GEMINI_EXIT_CODE) {
    process.stderr.write("fake gemini failure\n");
    process.exit(Number(process.env.FAKE_GEMINI_EXIT_CODE));
    return;
  }

  if (process.env.FAKE_GEMINI_429 === "1") {
    const markerDir =
      process.env.FAKE_GEMINI_429_DIR ||
      process.env.TMPDIR ||
      process.env.TMP ||
      process.env.TEMP ||
      tmpdir();
    const markerPath =
      process.env.FAKE_GEMINI_429_MARKER ||
      join(markerDir, "fake-gemini-429-once.marker");

    if (!existsSync(markerPath)) {
      mkdirSync(markerDir, { recursive: true });
      writeFileSync(markerPath, String(Date.now()), "utf8");
      process.stderr.write(
        "Error 429: RESOURCE_EXHAUSTED quota exceeded rate limit\n",
      );
      process.exit(1);
      return;
    }
  }

  if (process.env.FAKE_GEMINI_DELAY_MS) {
    await new Promise((resolve) =>
      setTimeout(resolve, Number(process.env.FAKE_GEMINI_DELAY_MS)),
    );
  }

  if (outputFormat !== "stream-json" && !process.env.FAKE_GEMINI_LEGACY_OK) {
    process.stderr.write("expected stream-json\n");
    process.exit(2);
    return;
  }

  const responseText =
    process.env.FAKE_GEMINI_ECHO_ALLOWED_MCP === "1"
      ? `gemini:${promptText}\nallowed:${allowedMcpServerNames.join(",")}`
      : `gemini:${promptText}`;

  process.stdout.write(`${JSON.stringify({ type: "init", model })}\n`);
  process.stdout.write(
    `${JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: responseText }],
      },
    })}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({
      type: "result",
      response: responseText,
      usage: { totalTokens: promptText.length },
    })}\n`,
  );
});
