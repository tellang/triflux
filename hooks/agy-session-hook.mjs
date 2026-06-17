#!/usr/bin/env node

import { argv, exit, stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { drainPendingSynapse as defaultDrainPendingSynapse } from "../hub/team/synapse-http.mjs";
import {
  heartbeatInteractiveSession as defaultHeartbeatInteractiveSession,
  registerInteractiveSession as defaultRegisterInteractiveSession,
} from "./session-start-fast.mjs";

// hub-ensure is loaded lazily so the byte-identical packages/core mirror of this
// file loads cleanly. packages/core mirrors scripts/lib only (not scripts/*), so a
// static `../scripts/hub-ensure.mjs` import would make the core copy throw
// ERR_MODULE_NOT_FOUND at load time. Mirrors codex-session-hook.mjs's pattern.
async function defaultHubEnsureRun(stdinData) {
  const { run } = await import(
    new URL("../scripts/hub-ensure.mjs", import.meta.url).href
  );
  return run(stdinData);
}

function parsePayload(stdinData) {
  try {
    const raw = typeof stdinData === "string" ? stdinData : "";
    return raw.trim()
      ? { ok: true, payload: JSON.parse(raw) }
      : { ok: false, payload: {} };
  } catch {
    return { ok: false, payload: {} };
  }
}

// Antigravity hook payloads use camelCase system metadata (conversationId,
// workspacePaths) rather than Codex's session_id/cwd. registerInteractiveSession
// and heartbeatInteractiveSession parse the Codex shape, so we adapt the agy
// payload into that shape before delegating. conversationId is the stable
// per-conversation UUID (== session identity); the first mounted workspace path
// is the effective cwd.
export function toSessionPayload(payload) {
  const sessionId = String(payload?.conversationId || "").trim();
  const workspacePaths = Array.isArray(payload?.workspacePaths)
    ? payload.workspacePaths
    : [];
  const cwd =
    typeof workspacePaths[0] === "string" && workspacePaths[0]
      ? workspacePaths[0]
      : process.cwd();
  return JSON.stringify({ session_id: sessionId, cwd, actor_cli: "agy" });
}

// agy has no distinct SessionStart / UserPromptSubmit events. PreInvocation
// fires before every model call, so the per-conversation invocationNum gates
// register (first call == session start) vs heartbeat (subsequent calls).
// An explicit argv mode (register|heartbeat) overrides, mirroring the codex hook.
export function normalizeMode(argvMode, payload) {
  const direct = String(argvMode || "")
    .trim()
    .toLowerCase();
  if (direct === "register" || direct === "heartbeat") return direct;

  const invocationNum = Number(payload?.invocationNum);
  if (Number.isFinite(invocationNum)) {
    return invocationNum <= 1 ? "register" : "heartbeat";
  }
  // Unknown invocation index: register is idempotent and also ensures the hub,
  // so it is the safe default for a first-contact payload.
  return "register";
}

export async function runAgySessionHook(stdinData, opts = {}) {
  const output = "{}\n";
  const parsed = parsePayload(stdinData);
  if (!parsed.ok) {
    if (opts.writeStdout !== false) stdout.write(output);
    return output;
  }

  const sessionPayload = toSessionPayload(parsed.payload);
  const sessionId = JSON.parse(sessionPayload).session_id;
  // No conversation id means nothing to register; stay a silent no-op.
  if (!sessionId) {
    if (opts.writeStdout !== false) stdout.write(output);
    return output;
  }

  const mode = normalizeMode(opts.argvMode ?? argv[2], parsed.payload);
  const hubEnsureRun = opts.hubEnsureRun || defaultHubEnsureRun;
  const registerInteractiveSession =
    opts.registerInteractiveSession || defaultRegisterInteractiveSession;
  const heartbeatInteractiveSession =
    opts.heartbeatInteractiveSession || defaultHeartbeatInteractiveSession;
  const drainPendingSynapse =
    opts.drainPendingSynapse || defaultDrainPendingSynapse;

  try {
    if (mode === "register") {
      try {
        await hubEnsureRun(sessionPayload);
      } catch {}
      try {
        await Promise.resolve(registerInteractiveSession(sessionPayload));
      } catch {}
      try {
        await drainPendingSynapse(1000);
      } catch {}
    } else if (mode === "heartbeat") {
      try {
        heartbeatInteractiveSession(sessionPayload);
      } catch {}
      try {
        await drainPendingSynapse(500);
      } catch {}
    }
  } catch {
    // agy session hooks are observational and must never block the session.
  }

  if (opts.writeStdout !== false) {
    stdout.write(output);
  }
  return output;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk) => {
      data += chunk;
    });
    stdin.on("end", () => resolve(data));
    stdin.on("error", () => resolve(data));
  });
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  const stdinData = await readStdin();
  await runAgySessionHook(stdinData);
  exit(0);
}
