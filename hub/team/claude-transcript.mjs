import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { modelContext } from "./session-context.mjs";

export async function findClaudeTranscript({
  configDir,
  sourceConfigDir,
  sessionId,
  cwd,
}) {
  if (!configDir || !sessionId || /[/\\]/u.test(sessionId)) return null;
  for (const dir of new Set([configDir, sourceConfigDir].filter(Boolean))) {
    const projectsDir = path.join(dir, "projects");
    const projects = cwd
      ? [path.resolve(cwd).replace(/[/.]/gu, "-")]
      : await fs.readdir(projectsDir).catch(() => []);
    for (const project of projects) {
      const candidate = path.join(projectsDir, project, `${sessionId}.jsonl`);
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // Continue looking for this session.
      }
    }
  }
  return null;
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

export async function readClaudeTranscript(transcriptPath, { requestId } = {}) {
  if (!transcriptPath) return null;
  const marker = requestId ? `[tfx-live req=${requestId}]` : null;
  let userSeen = false;
  let response = "";
  let turnEnded = false;
  let sectionClosed = false;
  let estimatedContextTokens = null;
  let model = null;
  let measuredAt = null;
  let compactCount = 0;
  let compact = null;

  try {
    const lines = readline.createInterface({
      input: createReadStream(transcriptPath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const message = entry?.message;
      if (entry?.type === "system" && entry.subtype === "compact_boundary") {
        compactCount += 1;
        compact = {
          preTokens: entry.compactMetadata?.preTokens ?? null,
          postTokens: entry.compactMetadata?.postTokens ?? null,
        };
        estimatedContextTokens = compact.postTokens;
        measuredAt = entry.timestamp || null;
      }
      if (entry?.type === "assistant") {
        const usage = message?.usage;
        if (usage) {
          estimatedContextTokens =
            (usage.input_tokens || 0) +
            (usage.cache_read_input_tokens || 0) +
            (usage.cache_creation_input_tokens || 0);
          model = message.model || model;
          measuredAt = entry.timestamp || measuredAt;
        }
        if (userSeen && !sectionClosed) {
          const text = messageText(message?.content);
          if (text) response = text;
          if (message?.stop_reason === "end_turn") turnEnded = true;
        }
      } else if (entry?.type === "user") {
        const content = message?.content;
        // Tool results are not a new human turn.
        const humanText =
          typeof content === "string" ||
          (Array.isArray(content) &&
            content.some((part) => part?.type === "text"))
            ? messageText(content)
            : "";
        if (humanText) {
          if (!marker || humanText.includes(marker)) {
            userSeen = true;
            response = "";
            turnEnded = false;
            sectionClosed = false;
          } else if (userSeen) {
            sectionClosed = true;
          }
        }
      } else if (
        userSeen &&
        !sectionClosed &&
        entry?.type === "system" &&
        entry?.subtype === "turn_duration"
      ) {
        turnEnded = true;
      }
    }
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  return {
    context:
      estimatedContextTokens === null && model === null
        ? null
        : {
            ...modelContext("claude", model, estimatedContextTokens),
            model,
            measuredAt,
          },
    userSeen,
    response,
    turnEnded,
    sectionClosed,
    compactCount,
    compact,
  };
}
