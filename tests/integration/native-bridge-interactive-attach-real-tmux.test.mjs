/**
 * Opt-in tmux E2E for the native-bridge interactive-attach path.
 *
 * The companion unit test (tests/unit/native-bridge-interactive-attach.test.mjs)
 * proves the facade routes kind-0 frames to `onInput`, but it injects a fake
 * transport whose `writeInput` only records to an in-memory array. The actual
 * hop from `transport.writeInput` → `tmux send-keys` → real pane stdin →
 * captured back via `pipe-pane` is therefore never exercised in CI.
 *
 * This test closes that gap end-to-end against real tmux:
 *
 *   ptySock kind-0 frame
 *     → ptyServer.on("data")              [hub/team/claude-native-bridge.mjs]
 *     → handlePtyInput()                  [interactive workerType]
 *     → onInput()                          [interactive-native-worker.mjs]
 *     → transport.writeInput()             [REAL interactive-tui-transport.mjs]
 *     → tmux send-keys -l -- <text>        [REAL tmux]
 *     → pane stdin                         [REAL pty]
 *     → awk UPPERCASES the line to stdout  [REAL process reads its stdin]
 *     → pipe-pane captures pane output
 *     → onData() → facade.writeOutput
 *     → kind-0 OUTPUT frame back on ptySock
 *
 * Round-tripping a unique marker through that loop is the strongest evidence
 * triflux can produce without invoking the external `claude agents` runtime.
 * What this test deliberately does NOT cover is whether the external claude
 * daemon writes kind-0 to the worker ptySock when a human keystroke happens
 * (no triflux code connects to the worker ptySock as a writer — the producer
 * is Claude Code's own daemon). That remaining hop is exercised manually via
 *   experiments/native-bridge-feasibility/interactive-attach-live-probe.mjs
 *
 * Opt-in gate (mirrors tests/integration/agy-stdout-pipe.test.mjs):
 *   TFX_NATIVE_BRIDGE_E2E=1 npm run test:integration -- \
 *     --test-name-pattern='real tmux'
 * Default `npm test` skips this so the test-lock + concurrency=8 envelope
 * is not disturbed (see §C-4 test-lock flakiness note).
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  buildPtyDataFrame,
  extractPtyFrames,
} from "../../hub/team/claude-native-bridge.mjs";
import { startInteractiveNativeWorker } from "../../hub/team/interactive-native-worker.mjs";

const execFileAsync = promisify(execFile);

const E2E_ENABLED =
  process.env.TFX_NATIVE_BRIDGE_E2E === "1" ||
  process.env.TFX_NATIVE_BRIDGE_E2E === "true";

async function tmuxAvailable() {
  try {
    await execFileAsync("tmux", ["-V"], { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

// Resolve gating once before registering the test so node:test's `skip`
// option can be a synchronous boolean/string.
const TMUX_PRESENT = E2E_ENABLED ? await tmuxAvailable() : false;
const SKIP_REASON = !E2E_ENABLED
  ? "TFX_NATIVE_BRIDGE_E2E not set (opt-in tmux E2E)"
  : !TMUX_PRESENT
    ? "tmux not available on PATH"
    : false;

// Print "›" (U+203A) then exec an awk filter that uppercases each line and
// flushes it immediately. Two reasons:
//  1. The "›" line makes the transport's dismissStartupPrompts() match
//     isCodexMainPrompt() on its next poll and return in <1s instead of
//     looping ~9s waiting for a codex prompt that never appears. If that
//     heuristic ever changes this degrades to the ~9s scan (still passes),
//     it does not break correctness.
//  2. Uppercasing is what makes the assertion meaningful: a round-tripped
//     UPPERCASE marker can only have come from the launched process reading
//     its stdin. The pane's verbatim TTY echo of our (lowercase) input would
//     not match, so this rules out "echo only" false positives and proves
//     the kind-0 input actually reached the process stdin. fflush() avoids
//     stdio block-buffering on the pty so each line surfaces promptly.
const FAST_TRANSFORM_LAUNCH = `sh -c 'printf "\\342\\200\\272 "; exec awk "{ print toupper(\\$0); fflush() }"'`;

function createFrameCollector(socket) {
  const frames = [];
  let buffer = Buffer.alloc(0);
  // Persistent collector avoids losing chunks between successive awaits, which
  // matters for real-tmux output that can stream in several rapid chunks.
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const result = extractPtyFrames(buffer);
    buffer = result.rest;
    frames.push(...result.frames);
  });
  // Swallow teardown errors (EPIPE/ECONNRESET) once we destroy our end.
  socket.on("error", () => {});

  let cursor = 0;
  return {
    async waitFor(predicate, { timeoutMs }) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        while (cursor < frames.length) {
          const frame = frames[cursor];
          cursor += 1;
          if (predicate(frame)) return frame;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("timed out waiting for expected frame");
    },
  };
}

test("interactive native worker round-trips kind-0 through real tmux into a real pane", {
  skip: SKIP_REASON,
}, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-c8-e2e-"));
  const sessionName = `tfx-c8-e2e-${process.pid}-${Math.floor(
    Math.random() * 1_000_000_000,
  )}`;

  let worker = null;
  let socket = null;

  const forceKillTmux = async () => {
    try {
      await execFileAsync("tmux", ["kill-session", "-t", sessionName], {
        timeout: 3000,
      });
    } catch {
      // Already gone, or tmux server stopped.
    }
  };

  try {
    // 1. Start the worker with the REAL transport (default factory).
    worker = await startInteractiveNativeWorker({
      short: "c8e2e01",
      rvSock: path.join(tmp, "worker.rv.sock"),
      ptySock: path.join(tmp, "worker.pty.sock"),
      sessionName,
      cwd: tmp,
      launchCmd: FAST_TRANSFORM_LAUNCH,
      env: {},
    });

    // 2. Connect as an attach client. In production this socket is opened
    //    by the external `claude agents` daemon; here we play that role
    //    so we can both inject input and observe the output frames.
    socket = net.connect(worker.ptySock);
    await once(socket, "connect");
    socket.unref();
    const collector = createFrameCollector(socket);

    // 3. Drain the connection prologue: hello + (transcript) + live.
    await collector.waitFor(
      (frame) => frame.kind === 1 && frame.ctrl?.t === "live",
      { timeoutMs: 5000 },
    );

    // 4. Inject a unique kind-0 marker as lowercase. Byte-identical to what
    //    the external daemon writes when a human types in the row.
    const marker = `c8-marker-${Math.random().toString(36).slice(2, 10)}`;
    const expected = marker.toUpperCase();
    socket.write(buildPtyDataFrame(`${marker}\n`));

    // 5. Wait for the UPPERCASED marker to come back as an OUTPUT frame.
    //    The launched awk process uppercases its stdin, so an uppercase match
    //    proves the input reached the process stdin through real tmux — the
    //    pane's verbatim lowercase TTY echo alone would not satisfy it.
    const outputFrame = await collector.waitFor(
      (frame) =>
        frame.kind === 0 && frame.payload.includes(Buffer.from(expected)),
      { timeoutMs: 8000 },
    );

    assert.ok(
      outputFrame.payload.toString("utf8").includes(expected),
      `expected uppercased marker ${expected} to round-trip through real tmux`,
    );
  } finally {
    // Close the worker first so the facade tears down its servers while our
    // socket is still connected (avoids the facade writing an exit frame to
    // an already-destroyed peer, which would surface as an unhandled EPIPE).
    if (worker) {
      await worker.close({ exitCode: 0 }).catch(() => {});
    }
    if (socket) {
      socket.destroy();
    }
    await forceKillTmux();
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});
