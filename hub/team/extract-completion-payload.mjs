// hub/team/extract-completion-payload.mjs — worker stdout tail → completion JSON
//
// Workers emit a JSON completion marker on stdout before exit, per the
// Completion Protocol appendix that the swarm engine injects into each PRD
// prompt. This helper scans the tail of a worker's stdout for the last JSON
// object and returns it if it parses cleanly. The hypervisor's F7 guard
// (validateWorkerCompletion) decides whether the parsed payload is
// semantically valid — this layer only handles extraction.

/**
 * Scan the tail for every (openIdx, closeIdx) pair of `{`/`}` positions and
 * return the latest `}` whose substring parses as a plain JSON object. This
 * tolerates trailing noise that happens to contain `}` (e.g. log lines like
 * `noise } more` after the completion payload).
 *
 * @param {string} tail raw stdout tail
 * @returns {{payload: object} | null}
 */
export function extractCompletionPayload(tail) {
  if (typeof tail !== "string" || tail.length === 0) return null;

  const closes = [];
  const opens = [];
  for (let i = 0; i < tail.length; i += 1) {
    const ch = tail[i];
    if (ch === "}") closes.push(i);
    else if (ch === "{") opens.push(i);
  }
  if (closes.length === 0 || opens.length === 0) return null;

  // Iterate from the latest `}` backward. For each close, try every `{`
  // that sits before it, starting from the nearest (which is cheap and
  // typically the right match) and widening outward.
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
