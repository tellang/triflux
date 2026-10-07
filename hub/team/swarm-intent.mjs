const INTENT_TRAILER_REGEX = /^X-Intent:\s*(.+)$/m;

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
