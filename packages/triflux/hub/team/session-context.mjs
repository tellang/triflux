import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

// https://platform.claude.com/docs/en/build-with-claude/context-windows 2026-10-12
// https://developers.openai.com/api/docs/models 2026-10-08
const MODEL_CONTEXT = [
  {
    cli: "claude",
    model:
      /^(?:claude-)?(?:fable|opus|sonnet|haiku)-(?:[5-9]|[1-9]\d+)(?:[.-]\d+)*(?:$|[-[])/i,
    tokens: 1_000_000,
    source:
      "https://platform.claude.com/docs/en/build-with-claude/context-windows",
  },
  {
    cli: "codex",
    model: /^gpt-6(?:\.\d+)?(?:$|[-_])/i,
    tokens: 1_050_000,
    source: "https://developers.openai.com/api/docs/models",
  },
];

const CONTEXT_THRESHOLDS = {
  claude: { warnContextPct: 60, maxContextPct: 90 },
  codex: { warnContextPct: 60, maxContextPct: 85 },
};
// rollout 실행 창을 못 읽으면 1.05M 표 값이 분모라 실제 창보다 비율이 작게 나온다.
const CODEX_MODEL_WINDOW_THRESHOLDS = { warnContextPct: 15, maxContextPct: 22 };

const rolloutCache = new Map();

export function modelContext(
  cli,
  model,
  estimatedContextTokens = null,
  rolloutContextWindow = null,
) {
  const entry = MODEL_CONTEXT.find(
    (item) => item.cli === cli && item.model.test(model || ""),
  );
  const contextLimitTokens = entry?.tokens ?? null;
  const executionContextLimitTokens =
    cli === "claude" && process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT === "1"
      ? 200_000
      : rolloutContextWindow;
  // Codex 는 rollout 이 보고한 창이 실제 실행 한도라 표 값과 무관하게 그 창을 쓴다.
  const effectiveLimit =
    cli === "codex"
      ? (executionContextLimitTokens ?? contextLimitTokens)
      : contextLimitTokens &&
        Math.min(contextLimitTokens, executionContextLimitTokens ?? Infinity);
  return {
    estimatedContextTokens,
    contextLimitTokens,
    contextLimitSource: entry?.source ?? null,
    ...(executionContextLimitTokens ? { executionContextLimitTokens } : {}),
    contextPct:
      effectiveLimit && Number.isFinite(estimatedContextTokens)
        ? (estimatedContextTokens / effectiveLimit) * 100
        : null,
  };
}

export function contextGuard(
  cli,
  context,
  { warnContextPct, maxContextPct } = {},
) {
  const defaults =
    cli === "codex" && !context?.executionContextLimitTokens
      ? CODEX_MODEL_WINDOW_THRESHOLDS
      : CONTEXT_THRESHOLDS[cli];
  const warn = warnContextPct ?? defaults?.warnContextPct ?? 0;
  const max = maxContextPct ?? defaults?.maxContextPct ?? 0;
  const fields = {
    estimatedContextTokens: context?.estimatedContextTokens ?? null,
    contextLimitTokens: context?.contextLimitTokens ?? null,
    contextLimitSource: context?.contextLimitSource ?? null,
    executionContextLimitTokens: context?.executionContextLimitTokens ?? null,
    contextPct: context?.contextPct ?? null,
  };
  if (fields.contextPct === null) {
    return warn > 0
      ? {
          contextWarning: {
            ...fields,
            reason:
              fields.contextLimitTokens === null
                ? "unknown-model"
                : "usage-unavailable",
          },
        }
      : {};
  }
  if (max > 0 && fields.contextPct >= max) {
    return {
      ok: false,
      errorCode: "context-limit",
      inputSent: false,
      hint: "세션을 승계한 뒤 새 세션에 요청하라.",
      ...fields,
      thresholdPct: max,
    };
  }
  return warn > 0 && fields.contextPct >= warn
    ? { contextWarning: { ...fields, thresholdPct: warn } }
    : {};
}

export async function findCodexRollout(threadId) {
  if (!/^[a-zA-Z0-9-]+$/u.test(threadId || "")) return null;
  const root = path.join(
    process.env.CODEX_HOME || path.join(homedir(), ".codex"),
    "sessions",
  );
  for (const year of (await fs.readdir(root).catch(() => []))
    .sort()
    .reverse()) {
    if (!/^\d{4}$/u.test(year)) continue;
    for (const month of (
      await fs.readdir(path.join(root, year)).catch(() => [])
    )
      .sort()
      .reverse()) {
      if (!/^\d{2}$/u.test(month)) continue;
      for (const day of (
        await fs.readdir(path.join(root, year, month)).catch(() => [])
      )
        .sort()
        .reverse()) {
        if (!/^\d{2}$/u.test(day)) continue;
        const dir = path.join(root, year, month, day);
        const file = (await fs.readdir(dir).catch(() => [])).find((name) =>
          name.endsWith(`-${threadId}.jsonl`),
        );
        if (file) return path.join(dir, file);
      }
    }
  }
  return null;
}

function acceptCodexLine(state, line) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return false;
  }
  if (entry?.type === "compacted") {
    state.compactCount += 1;
    state.compact = { preTokens: state.tokens, postTokens: null };
  }
  if (entry?.type === "turn_context")
    state.model = entry.payload?.model || state.model;
  if (entry?.type === "event_msg" && entry.payload?.type === "token_count") {
    const info = entry.payload.info;
    if (Number.isFinite(info?.last_token_usage?.total_tokens)) {
      state.tokens = info.last_token_usage.total_tokens;
      if (state.compact && state.compact.postTokens === null)
        state.compact.postTokens = state.tokens;
    }
    if (Number.isFinite(info?.model_context_window))
      state.executionContextLimitTokens = info.model_context_window;
  }
  return true;
}

export async function readCodexContext(rolloutPath, threadId) {
  rolloutPath ||= await findCodexRollout(threadId);
  if (!rolloutPath) return { ...modelContext("codex", null), model: null };
  let stat;
  try {
    stat = await fs.stat(rolloutPath);
  } catch {
    return { ...modelContext("codex", null), model: null };
  }
  let state = rolloutCache.get(rolloutPath);
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
      model: null,
      tokens: null,
      compactCount: 0,
      compact: null,
      executionContextLimitTokens: null,
    };
  }
  try {
    if (stat.size > state.offset) {
      const stream = createReadStream(rolloutPath, {
        start: state.offset,
        end: stat.size - 1,
      });
      for await (const chunk of stream) {
        const lines = (state.pending + state.decoder.write(chunk)).split("\n");
        state.pending = lines.pop();
        for (const line of lines) acceptCodexLine(state, line);
      }
      if (state.pending && acceptCodexLine(state, state.pending))
        state.pending = "";
    }
  } catch {
    rolloutCache.delete(rolloutPath);
    return { ...modelContext("codex", null), model: null };
  }
  state.offset = stat.size;
  state.mtimeMs = stat.mtimeMs;
  rolloutCache.set(rolloutPath, state);
  return {
    ...modelContext(
      "codex",
      state.model,
      state.tokens,
      state.executionContextLimitTokens,
    ),
    model: state.model,
    compactCount: state.compactCount,
    compact: state.compact,
    executionContextLimitTokens: state.executionContextLimitTokens,
  };
}
