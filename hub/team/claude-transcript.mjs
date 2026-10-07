import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { modelContext } from "./session-context.mjs";

const transcriptCache = new Map();

export async function findClaudeTranscript({
  configDir,
  sourceConfigDir,
  sessionId,
  cwd,
}) {
  if (!configDir || !sessionId || /[/\\]/u.test(sessionId)) return null;
  for (const dir of new Set([configDir, sourceConfigDir].filter(Boolean))) {
    const projectsDir = path.join(dir, "projects");
    const preferred = cwd
      ? path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-")
      : null;
    const projects = [
      ...(preferred ? [preferred] : []),
      ...(await fs.readdir(projectsDir).catch(() => [])).filter(
        (project) => project !== preferred,
      ),
    ];
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

function beginTurn(state) {
  state.userSeen = true;
  state.queued = false;
  state.response = "";
  state.error = null;
  state.turnEnded = false;
  state.sectionClosed = false;
}

function acceptEntry(state, entry, marker) {
  if (entry?.isSidechain) return;
  const message = entry?.message;
  if (entry?.type === "system" && entry.subtype === "compact_boundary") {
    state.compactCount += 1;
    state.compact = {
      preTokens: entry.compactMetadata?.preTokens ?? null,
      postTokens: entry.compactMetadata?.postTokens ?? null,
    };
    state.estimatedContextTokens = state.compact.postTokens;
    state.measuredAt = entry.timestamp || null;
  }
  if (entry?.type === "assistant") {
    if (entry.isApiErrorMessage === true || message?.model === "<synthetic>") {
      if (state.userSeen && !state.sectionClosed && entry.isApiErrorMessage) {
        state.error = messageText(message?.content) || "Claude API error";
        state.turnEnded = true;
      }
      return;
    }
    const usage = message?.usage;
    if (usage) {
      state.estimatedContextTokens =
        (usage.input_tokens || 0) +
        (usage.cache_read_input_tokens || 0) +
        (usage.cache_creation_input_tokens || 0);
      state.model = message.model || state.model;
      state.measuredAt = entry.timestamp || state.measuredAt;
    }
    if (state.userSeen && !state.sectionClosed) {
      const text = messageText(message?.content);
      if (text) state.response = text;
      if (message?.stop_reason === "end_turn") state.turnEnded = true;
    }
    return;
  }
  if (entry?.type === "user") {
    const content = message?.content;
    // Tool results are not a new human turn.
    const humanText =
      typeof content === "string" ||
      (Array.isArray(content) && content.some((part) => part?.type === "text"))
        ? messageText(content)
        : "";
    const marked =
      marker &&
      (humanText.includes(marker) ||
        JSON.stringify(
          entry.attachments ?? message?.attachments ?? [],
        ).includes(marker));
    if (humanText || marked) {
      if (!marker || marked) beginTurn(state);
      else if (state.userSeen) state.sectionClosed = true;
    }
    return;
  }
  if (
    entry?.type === "attachment" &&
    entry.attachment?.type === "queued_command" &&
    marker &&
    JSON.stringify(entry.attachment).includes(marker)
  ) {
    beginTurn(state);
    return;
  }
  if (entry?.type === "queue-operation") {
    const marked =
      marker &&
      typeof entry.content === "string" &&
      entry.content.includes(marker);
    if (marked && entry.operation === "enqueue") {
      state.queued = true;
      state.queuedContent = entry.content;
    } else if (
      state.queued &&
      (marked || entry.content === state.queuedContent)
    ) {
      if (entry.operation === "remove") beginTurn(state);
    } else if (marked && entry.operation === "remove") {
      beginTurn(state);
    }
    return;
  }
  if (
    state.userSeen &&
    !state.sectionClosed &&
    entry?.type === "system" &&
    entry.subtype === "turn_duration"
  ) {
    state.turnEnded = true;
  }
}

function acceptLine(state, line, marker) {
  try {
    acceptEntry(state, JSON.parse(line), marker);
    return true;
  } catch {
    return false;
  }
}

export async function readClaudeTranscript(transcriptPath, { requestId } = {}) {
  if (!transcriptPath) return null;
  const marker = requestId ? `[tfx-live req=${requestId}]` : null;
  const key = `${transcriptPath}\0${requestId || ""}`;
  let stat;
  try {
    stat = await fs.stat(transcriptPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let state = transcriptCache.get(key);
  if (
    !state ||
    state.ino !== stat.ino ||
    stat.size < state.offset ||
    (stat.size === state.offset && stat.mtimeMs !== state.mtimeMs)
  ) {
    state = {
      ino: stat.ino,
      offset: 0,
      pending: "",
      decoder: new StringDecoder("utf8"),
      userSeen: false,
      queued: false,
      queuedContent: null,
      response: "",
      error: null,
      turnEnded: false,
      sectionClosed: false,
      estimatedContextTokens: null,
      model: null,
      measuredAt: null,
      compactCount: 0,
      compact: null,
    };
  }
  try {
    if (stat.size > state.offset) {
      const stream = createReadStream(transcriptPath, {
        start: state.offset,
        end: stat.size - 1,
      });
      for await (const chunk of stream) {
        const lines = (state.pending + state.decoder.write(chunk)).split("\n");
        state.pending = lines.pop();
        for (const line of lines) acceptLine(state, line, marker);
      }
      if (state.pending && acceptLine(state, state.pending, marker))
        state.pending = "";
    }
  } catch (error) {
    transcriptCache.delete(key);
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  state.offset = stat.size;
  state.mtimeMs = stat.mtimeMs;
  transcriptCache.set(key, state);
  return {
    context:
      state.estimatedContextTokens === null && state.model === null
        ? null
        : {
            ...modelContext(
              "claude",
              state.model,
              state.estimatedContextTokens,
            ),
            model: state.model,
            measuredAt: state.measuredAt,
          },
    userSeen: state.userSeen,
    response: state.response,
    error: state.error,
    turnEnded: state.turnEnded,
    sectionClosed: state.sectionClosed,
    compactCount: state.compactCount,
    compact: state.compact,
  };
}
