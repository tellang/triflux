import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";

// https://platform.claude.com/docs/en/build-with-claude/context-windows 2026-10-08
// https://developers.openai.com/api/docs/models 2026-10-08
// https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash 2026-10-08
const MODEL_CONTEXT = [
  {
    cli: "claude",
    model: /^(?:claude-)?(?:fable-5[.-]1|opus-5[.-]5|sonnet-5[.-]5)(?:$|[-[])/i,
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
  {
    cli: "agy",
    model: /^gemini-3\.8-flash(?:$|-preview)/i,
    tokens: 1_048_576,
    source: "https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash",
  },
];

export const CONTEXT_THRESHOLDS = {
  claude: { warnContextPct: 60, maxContextPct: 90 },
  codex: { warnContextPct: 15, maxContextPct: 22 },
  agy: { warnContextPct: 12, maxContextPct: 18 },
};

export function modelContext(cli, model, estimatedContextTokens = null) {
  const entry = MODEL_CONTEXT.find(
    (item) => item.cli === cli && item.model.test(model || ""),
  );
  const contextLimitTokens = entry?.tokens ?? null;
  return {
    estimatedContextTokens,
    contextLimitTokens,
    contextLimitSource: entry?.source ?? null,
    contextPct:
      contextLimitTokens && Number.isFinite(estimatedContextTokens)
        ? (estimatedContextTokens / contextLimitTokens) * 100
        : null,
  };
}

export function contextGuard(
  cli,
  context,
  { warnContextPct, maxContextPct } = {},
) {
  const defaults = CONTEXT_THRESHOLDS[cli];
  const warn = warnContextPct ?? defaults?.warnContextPct ?? 0;
  const max = maxContextPct ?? defaults?.maxContextPct ?? 0;
  const fields = {
    estimatedContextTokens: context?.estimatedContextTokens ?? null,
    contextLimitTokens: context?.contextLimitTokens ?? null,
    contextLimitSource: context?.contextLimitSource ?? null,
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
    };
  }
  return warn > 0 && fields.contextPct >= warn
    ? { contextWarning: { ...fields, thresholdPct: warn } }
    : {};
}

async function findCodexRollout(threadId) {
  if (!/^[a-zA-Z0-9-]+$/u.test(threadId || "")) return null;
  const root = path.join(
    process.env.CODEX_HOME || path.join(homedir(), ".codex"),
    "sessions",
  );
  for (const year of await fs.readdir(root).catch(() => [])) {
    if (!/^\d{4}$/u.test(year)) continue;
    for (const month of await fs
      .readdir(path.join(root, year))
      .catch(() => [])) {
      if (!/^\d{2}$/u.test(month)) continue;
      for (const day of await fs
        .readdir(path.join(root, year, month))
        .catch(() => [])) {
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

export async function readCodexContext(rolloutPath, threadId) {
  rolloutPath ||= await findCodexRollout(threadId);
  if (!rolloutPath) return { ...modelContext("codex", null), model: null };
  let model = null;
  let tokens = null;
  let executionContextLimitTokens = null;
  try {
    const lines = readline.createInterface({
      input: createReadStream(rolloutPath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.type === "turn_context") model = entry.payload?.model || model;
      if (
        entry?.type === "event_msg" &&
        entry.payload?.type === "token_count"
      ) {
        const info = entry.payload.info;
        if (Number.isFinite(info?.last_token_usage?.total_tokens))
          tokens = info.last_token_usage.total_tokens;
        if (Number.isFinite(info?.model_context_window))
          executionContextLimitTokens = info.model_context_window;
      }
    }
  } catch {
    tokens = null;
  }
  return {
    ...modelContext("codex", model, tokens),
    model,
    executionContextLimitTokens,
  };
}
