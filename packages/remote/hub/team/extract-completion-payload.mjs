// hub/team/extract-completion-payload.mjs — worker stdout tail → completion JSON
//
// Two-tier extraction:
//   1) Sentinel-framed (preferred, #125): worker emits the payload between
//      `<<<TFX_COMPLETION_BEGIN>>>` and `<<<TFX_COMPLETION_END>>>` markers
//      that each occupy their own line. If a standalone-line BEGIN is present
//      but END is missing, this is a deterministic truncation signal and we
//      return null instead of falling back. Substring matches inside log
//      lines (e.g. `[debug] saw <<<TFX_COMPLETION_BEGIN>>> earlier`) do NOT
//      trigger Tier 1 (Codex R1 LOW finding).
//   2) Brace-scan fallback (legacy, #115): for workers that haven't adopted
//      the sentinel protocol yet (or for unit fixtures), scan the tail for
//      the latest `{...}` pair that parses as a JSON object.
//
// The hypervisor's F7 guard (validateWorkerCompletion) decides whether the
// parsed payload is semantically valid — this layer only handles extraction.

import { SENTINEL_BEGIN, SENTINEL_END } from "./sentinel-capture.mjs";

function isLineEdgeChar(ch) {
  return ch === "\n" || ch === "\r";
}

function findStandaloneMarkerLast(text, marker) {
  let from = 0;
  let last = -1;
  while (from <= text.length - marker.length) {
    const idx = text.indexOf(marker, from);
    if (idx === -1) return last;
    const before = idx === 0 || isLineEdgeChar(text[idx - 1]);
    const afterIdx = idx + marker.length;
    const after = afterIdx === text.length || isLineEdgeChar(text[afterIdx]);
    if (before && after) last = idx;
    from = idx + 1;
  }
  return last;
}

function findStandaloneMarkerFrom(text, marker, fromIdx) {
  let from = fromIdx;
  while (from <= text.length - marker.length) {
    const idx = text.indexOf(marker, from);
    if (idx === -1) return -1;
    const before = idx === 0 || isLineEdgeChar(text[idx - 1]);
    const afterIdx = idx + marker.length;
    const after = afterIdx === text.length || isLineEdgeChar(text[afterIdx]);
    if (before && after) return idx;
    from = idx + 1;
  }
  return -1;
}

/**
 * @param {string} tail raw stdout (sentinel snapshot or 16 KiB sliding tail)
 * @returns {{payload: object} | null}
 */
export function extractCompletionPayload(tail) {
  if (typeof tail !== "string" || tail.length === 0) return null;

  // Tier 1: sentinel-framed. Use last standalone-line BEGIN so a worker that
  // emitted multiple payloads (retry, debug log) yields the most recent one.
  const beginIdx = findStandaloneMarkerLast(tail, SENTINEL_BEGIN);
  if (beginIdx !== -1) {
    const innerStart = beginIdx + SENTINEL_BEGIN.length;
    const endIdx = findStandaloneMarkerFrom(tail, SENTINEL_END, innerStart);
    if (endIdx === -1) return null; // BEGIN without END → truncation/incomplete
    const inner = tail.slice(innerStart, endIdx).trim();
    try {
      const parsed = JSON.parse(inner);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { payload: parsed };
      }
    } catch {
      // Sentinel-framed but invalid JSON — do not fall back to brace scan,
      // because the worker explicitly tried (and failed) to use the protocol.
    }
    return null;
  }

  // Tier 2: brace-scan fallback. Iterate from the latest `}` backward; for
  // each close, try every `{` that sits before it (nearest first, widening
  // outward). Tolerates trailing noise containing `}` (`noise } more`) and
  // dangling `{` (`{ broken`) after the real payload.
  const closes = [];
  const opens = [];
  for (let i = 0; i < tail.length; i += 1) {
    const ch = tail[i];
    if (ch === "}") closes.push(i);
    else if (ch === "{") opens.push(i);
  }
  if (closes.length === 0 || opens.length === 0) return null;

  for (let c = closes.length - 1; c >= 0; c -= 1) {
    const closeIdx = closes[c];
    for (let o = opens.length - 1; o >= 0; o -= 1) {
      const openIdx = opens[o];
      if (openIdx >= closeIdx) continue;
      const candidate = tail.slice(openIdx, closeIdx + 1);
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return { payload: parsed };
        }
      } catch {
        // try an earlier `{` for this close, then an earlier `}`.
      }
    }
  }
  return null;
}
