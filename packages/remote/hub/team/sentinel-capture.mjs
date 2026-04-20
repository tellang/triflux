// hub/team/sentinel-capture.mjs — stdout sentinel-framed payload capture (#125)
//
// Workers emit completion payloads delimited by `<<<TFX_COMPLETION_BEGIN>>>`
// and `<<<TFX_COMPLETION_END>>>` (see swarm-hypervisor.mjs buildWorkerPrompt
// appendix). conductor.mjs feeds every stdout chunk through `push()`. After the
// child exits, `snapshot()` returns the captured slice (BEGIN..END inclusive)
// for `extractCompletionPayload`.
//
// Why this lives outside the 16 KiB stdoutTail buffer:
//   payloads with large `commits_made` arrays can exceed 16 KiB and a sliding
//   tail would head-truncate the BEGIN marker, leading to silent fallback to
//   brace-scan and an incorrect inner-object extraction (#115 Codex Finding 2).
//
// Pure module — no I/O, no timers — so it can be unit-tested directly.

export const SENTINEL_BEGIN = "<<<TFX_COMPLETION_BEGIN>>>";
export const SENTINEL_END = "<<<TFX_COMPLETION_END>>>";

const DEFAULT_MAX_BYTES = 1 << 20; // 1 MiB safety cap on captured region

// Per the worker prompt appendix, both markers must appear alone on their own
// line. Substring matches inside log lines / debug echoes must NOT trigger
// capture or terminate it. We treat `\n`, `\r`, and string boundaries (start
// or end of buffer) as line edges so Windows `\r\n` works without special-casing.
function isLineEdgeChar(ch) {
  return ch === "\n" || ch === "\r";
}

function findStandaloneMarker(text, marker, fromIdx = 0) {
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
 * Streaming sentinel capture state machine.
 *
 * @param {object} [opts]
 * @param {number} [opts.maxBytes=1048576] safety cap on the captured region.
 *   If the capture grows past this and head-truncation removes the BEGIN
 *   marker, `isOverflow()` becomes true so the conductor can deterministically
 *   reject instead of falling back to brace-scan on a runaway payload
 *   (Codex R1 MEDIUM finding).
 * @returns {{push: (text: string) => void, snapshot: () => string,
 *            isActive: () => boolean, isComplete: () => boolean,
 *            isOverflow: () => boolean}}
 */
export function createSentinelCapture({ maxBytes = DEFAULT_MAX_BYTES } = {}) {
  let capturing = false;
  let capture = "";
  let overlap = "";
  let done = false;
  let overflowed = false;

  // Boundary overlap covers the marker length plus one extra byte so we can
  // verify the line-edge character that precedes BEGIN across chunk seams.
  const overlapWindow = SENTINEL_BEGIN.length;

  function maybeFlagOverflow() {
    if (findStandaloneMarker(capture, SENTINEL_BEGIN) === -1) {
      overflowed = true;
      done = true;
      return true;
    }
    return false;
  }

  function push(text) {
    if (done || typeof text !== "string" || text.length === 0) return;

    if (!capturing) {
      const search = overlap + text;
      const idx = findStandaloneMarker(search, SENTINEL_BEGIN);
      if (idx !== -1) {
        capturing = true;
        capture = search.slice(idx);
        overlap = "";
        if (capture.length > maxBytes) {
          capture = capture.slice(-maxBytes);
          if (maybeFlagOverflow()) return;
        }
      } else {
        overlap = search.slice(-overlapWindow);
        return;
      }
    } else {
      capture += text;
      if (capture.length > maxBytes) {
        capture = capture.slice(-maxBytes);
        if (maybeFlagOverflow()) return;
      }
    }

    // Stop capturing once the standalone-line END marker is seen. Trim to the
    // first BEGIN..END pair so a worker that re-emitted (retry, debug log)
    // doesn't bloat the snapshot.
    const endIdx = findStandaloneMarker(capture, SENTINEL_END);
    if (endIdx !== -1) {
      done = true;
      capture = capture.slice(0, endIdx + SENTINEL_END.length);
    }
  }

  return {
    push,
    snapshot() {
      return capture;
    },
    isActive() {
      return capturing && !done;
    },
    isComplete() {
      return done && !overflowed;
    },
    isOverflow() {
      return overflowed;
    },
  };
}
