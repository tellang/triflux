// hub/team/swarm-intent.mjs — X-Intent helper utilities for semantic merge awareness

const INTENT_TRAILER_REGEX = /^X-Intent:\s*(.+)$/m;

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTouches(touches) {
  if (!Array.isArray(touches)) return null;
  return touches
    .filter((item) => typeof item === "string")
    .map((item) => item.trim().replace(/\\/g, "/"))
    .filter(Boolean);
}

function normalizeIntent(intentObj) {
  if (!intentObj || typeof intentObj !== "object" || Array.isArray(intentObj)) {
    return null;
  }

  const scope = normalizeText(intentObj.scope);
  const action = normalizeText(intentObj.action);
  const reason = normalizeText(intentObj.reason);
  const touches = normalizeTouches(intentObj.touches);

  if (!scope || !action || !reason || !touches) {
    return null;
  }

  return {
    scope,
    action,
    reason,
    touches,
    invariant: normalizeText(intentObj.invariant),
    conflictsWith: normalizeText(intentObj.conflictsWith),
  };
}

function fallbackIntent(llmResponse) {
  const responseText = String(llmResponse ?? "");
  return {
    scope: "unknown",
    action: "unknown",
    reason: responseText.slice(0, 100),
    touches: [],
    invariant: "",
    conflictsWith: "",
  };
}

function includesEitherWay(a, b) {
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

function hasConflict(intentA, intentB) {
  const conflictsWith = normalizeText(intentA?.conflictsWith).toLowerCase();
  const scope = normalizeText(intentB?.scope).toLowerCase();
  const action = normalizeText(intentB?.action).toLowerCase();

  if (!conflictsWith) return false;
  return (
    includesEitherWay(conflictsWith, scope) ||
    includesEitherWay(conflictsWith, action)
  );
}

function getTouchesOverlap(intentA, intentB) {
  const touchesA = new Set(
    (normalizeTouches(intentA?.touches) ?? []).map((item) =>
      item.toLowerCase(),
    ),
  );
  const touchesB = (normalizeTouches(intentB?.touches) ?? []).map((item) =>
    item.toLowerCase(),
  );
  return touchesB.filter((item) => touchesA.has(item));
}

/**
 * Build prompts for an LLM to generate an X-Intent JSON object.
 * @param {string[]} changedFiles
 * @param {string} commitDiff
 * @param {string} taskContext
 * @returns {{ systemPrompt: string, userPrompt: string }}
 */
export function generateIntentPrompt(changedFiles, commitDiff, taskContext) {
  const files = Array.isArray(changedFiles)
    ? changedFiles.filter((filePath) => typeof filePath === "string")
    : [];
  const diffSnippet = String(commitDiff ?? "").slice(0, 4000);
  const context = String(taskContext ?? "").trim();

  return {
    systemPrompt:
      "You generate commit intent metadata for semantic merge awareness. Return only valid JSON with keys: scope, action, reason, touches, invariant, conflictsWith.",
    userPrompt: [
      "Create an intent object from the following commit context.",
      "- scope/action/reason must be concise strings.",
      "- touches must be an array of touched file paths.",
      "- invariant/conflictsWith should be strings (empty if unknown).",
      "- Return JSON only (no markdown).",
      "",
      `Task context:\n${context || "(none provided)"}`,
      "",
      `Changed files (${files.length}):\n${files.join("\n") || "(none)"}`,
      "",
      "Commit diff (first 4000 chars):",
      diffSnippet || "(empty)",
    ].join("\n"),
  };
}

/**
 * Format an intent object into an X-Intent commit trailer.
 * @param {object} intentObj
 * @returns {string}
 */
export function formatIntentTrailer(intentObj) {
  return `X-Intent: ${JSON.stringify(intentObj)}`;
}

/**
 * Parse an X-Intent trailer from a commit message.
 * @param {string} commitMessage
 * @returns {object | null}
 */
export function parseIntentTrailer(commitMessage) {
  const message = String(commitMessage ?? "");
  const match = message.match(INTENT_TRAILER_REGEX);
  if (!match) return null;

  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

/**
 * Classify the relation between two intents.
 * @param {object} intentA
 * @param {object} intentB
 * @returns {{ relation: "complementary" | "complementary-risky" | "contradictory" | "independent", reason: string }}
 */
export function classifyIntentPair(intentA, intentB) {
  if (hasConflict(intentA, intentB) || hasConflict(intentB, intentA)) {
    return {
      relation: "contradictory",
      reason:
        "conflictsWith on one intent matches the other intent scope/action",
    };
  }

  const scopeA = normalizeText(intentA?.scope).toLowerCase();
  const scopeB = normalizeText(intentB?.scope).toLowerCase();

  if (scopeA && scopeB && scopeA === scopeB) {
    const overlap = getTouchesOverlap(intentA, intentB);
    if (overlap.length > 0) {
      return {
        relation: "complementary-risky",
        reason: `same scope with overlapping touched files: ${overlap.join(", ")}`,
      };
    }

    return {
      relation: "complementary",
      reason:
        "same scope with no conflicting intent and no touched-file overlap",
    };
  }

  return {
    relation: "independent",
    reason: "different scopes and no conflictsWith match detected",
  };
}

/**
 * Build a validated intent object from raw LLM response text.
 * @param {string} llmResponse
 * @returns {{ scope: string, action: string, reason: string, touches: string[], invariant: string, conflictsWith: string }}
 */
export function buildIntentFromLLMResponse(llmResponse) {
  const responseText = String(llmResponse ?? "").trim();
  const candidates = [];

  const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of responseText.matchAll(codeBlockRegex)) {
    if (match[1]) candidates.push(match[1].trim());
  }

  candidates.push(responseText);

  const firstBrace = responseText.indexOf("{");
  const lastBrace = responseText.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(responseText.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      const normalized = normalizeIntent(parsed);
      if (normalized) return normalized;
    } catch {
      // ignore parse failures and continue trying other candidates
    }
  }

  return fallbackIntent(responseText);
}
