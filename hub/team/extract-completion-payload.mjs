// hub/team/extract-completion-payload.mjs — worker stdout tail → completion JSON
//
// Workers emit a JSON completion marker on stdout before exit, per the
// Completion Protocol appendix that the swarm engine injects into each PRD
// prompt. This helper scans the tail of a worker's stdout for the last JSON
// object and returns it if it parses cleanly. The hypervisor's F7 guard
// (validateWorkerCompletion) decides whether the parsed payload is
// semantically valid — this layer only handles extraction.

/**
 * Try each `{` position in tail from latest to earliest; for each, attempt
 * to parse the substring through the last `}`. Returns the innermost/latest
 * object that parses as a plain JSON object.
 *
 * @param {string} tail raw stdout tail
 * @returns {{payload: object} | null}
 */
export function extractCompletionPayload(tail) {
  if (typeof tail !== "string" || tail.length === 0) return null;
  const lastClose = tail.lastIndexOf("}");
  if (lastClose < 0) return null;

  const openPositions = [];
  for (let i = 0; i <= lastClose; i += 1) {
    if (tail[i] === "{") openPositions.push(i);
  }
  for (let k = openPositions.length - 1; k >= 0; k -= 1) {
    const candidate = tail.slice(openPositions[k], lastClose + 1);
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { payload: parsed };
      }
    } catch {
      // try an earlier `{`
    }
  }
  return null;
}
