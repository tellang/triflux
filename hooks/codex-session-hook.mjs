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
// ERR_MODULE_NOT_FOUND at load time. The core copy is published-but-dormant — the
// live codex hook always runs from the installed triflux package where the path
// resolves. This mirrors session-start-fast.mjs's dynamic script-import pattern.
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

function normalizeMode(mode, payload) {
  const direct = String(mode || "")
    .trim()
    .toLowerCase();
  if (direct === "register" || direct === "heartbeat") return direct;

  const eventName = String(payload?.hook_event_name || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  if (eventName === "session_start" || eventName === "sessionstart") {
    return "register";
  }
  if (eventName === "user_prompt_submit" || eventName === "userpromptsubmit") {
    return "heartbeat";
  }
  return "";
}

function swallowStdoutWrite(_chunk, encodingOrCallback, callback) {
  const done =
    typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
  if (typeof done === "function") done();
  return true;
}

async function runHookSideEffectsWithStdoutSuppressed(fn) {
  const originalStdoutWrite = stdout.write;
  const originalConsoleDebug = console.debug;
  const originalConsoleInfo = console.info;
  const originalConsoleLog = console.log;

  stdout.write = swallowStdoutWrite;
  console.debug = () => {};
  console.info = () => {};
  console.log = () => {};
  try {
    return await fn();
  } finally {
    stdout.write = originalStdoutWrite;
    console.debug = originalConsoleDebug;
    console.info = originalConsoleInfo;
    console.log = originalConsoleLog;
  }
}

export async function runCodexSessionHook(stdinData, opts = {}) {
  const output = "{}\n";
  const parsed = parsePayload(stdinData);
  const mode = parsed.ok
    ? normalizeMode(opts.argvMode ?? argv[2], parsed.payload)
    : "";
  const hubEnsureRun = opts.hubEnsureRun || defaultHubEnsureRun;
  const registerInteractiveSession =
    opts.registerInteractiveSession || defaultRegisterInteractiveSession;
  const heartbeatInteractiveSession =
    opts.heartbeatInteractiveSession || defaultHeartbeatInteractiveSession;
  const drainPendingSynapse =
    opts.drainPendingSynapse || defaultDrainPendingSynapse;

  try {
    await runHookSideEffectsWithStdoutSuppressed(async () => {
      if (mode === "register") {
        try {
          await hubEnsureRun(stdinData);
        } catch {}
        try {
          await Promise.resolve(registerInteractiveSession(stdinData));
        } catch {}
        try {
          await drainPendingSynapse(1000);
        } catch {}
      } else if (mode === "heartbeat") {
        try {
          heartbeatInteractiveSession(stdinData);
        } catch {}
        try {
          await drainPendingSynapse(500);
        } catch {}
      }
    });
  } catch {
    // Codex session hooks are observational and must never block the session.
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
  await runCodexSessionHook(stdinData);
  exit(0);
}
