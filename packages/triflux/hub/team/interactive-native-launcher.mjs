import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildDaemonExecDispatchPayload,
  deriveClaudeDaemonPaths,
  dispatchClaudeDaemonJob,
  teardownClaudeDaemonJob,
} from "./claude-daemon-control.mjs";
import { encodeBridgeConfig } from "./daemon-pty-tmux-bridge.mjs";

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;

export async function launchAdoptedInteractiveWorker({
  cwd = process.cwd(),
  sessionName,
  launchCmd = "codex",
  cli = "codex",
  role = "interactive",
  configDir,
  pid = process.pid,
  env = {},
  cols = DEFAULT_COLS,
  rows = DEFAULT_ROWS,
  _deps = {},
} = {}) {
  const derivePaths = _deps.deriveClaudeDaemonPaths || deriveClaudeDaemonPaths;
  const encodeConfig = _deps.encodeBridgeConfig || encodeBridgeConfig;
  const buildPayload =
    _deps.buildDaemonExecDispatchPayload || buildDaemonExecDispatchPayload;
  const dispatchJob = _deps.dispatchClaudeDaemonJob || dispatchClaudeDaemonJob;
  const teardownJob = _deps.teardownClaudeDaemonJob || teardownClaudeDaemonJob;

  const resolvedCwd = path.resolve(cwd);
  const effectiveSessionName = sessionName || `tfx-${cli}-${role}-${pid}`;
  const paths = derivePaths({ configDir });
  const short = crypto.randomBytes(4).toString("hex");
  const displayName = `Triflux ${cli} ${role}`;
  const bridgePath = fileURLToPath(
    new URL("./daemon-pty-tmux-bridge.mjs", import.meta.url),
  );
  const bridgeConfig = encodeConfig({
    sessionName: effectiveSessionName,
    launchCmd,
    cwd: resolvedCwd,
    env,
    cols,
    rows,
  });
  const command = `${shellQuote(process.execPath)} ${shellQuote(
    bridgePath,
  )} --config ${bridgeConfig}`;
  const payload = buildPayload({
    short,
    cwd: resolvedCwd,
    command,
    name: displayName,
    cols,
    rows,
  });
  let dispatched;
  try {
    dispatched = await dispatchJob({
      paths,
      controlSock: paths.controlSock,
      payload,
      agent: cli,
      name: displayName,
      cwd: resolvedCwd,
      dispatchTimeoutMs: 5000,
    });
  } catch (error) {
    // dispatch may have started a daemon job (pid assigned) before a later
    // step (bridge-session resolve / projection write) threw. Tear down by
    // short + sessionId so a failed launch never leaks a running pty/tmux job.
    await teardownJob({
      controlSock: paths.controlSock,
      paths,
      short,
      sessionId: payload.sessionId,
    }).catch(() => {});
    throw error;
  }

  let closed = false;
  let closePromise = null;

  return {
    short,
    displayName,
    sessionId: dispatched.sessionId,
    pid: dispatched.pid,
    bridgeSessionId: dispatched.bridgeSessionId,
    sessionProjectionPath: dispatched.sessionProjectionPath,
    controlSock: paths.controlSock,
    close() {
      if (!closePromise) {
        closePromise = (async () => {
          if (closed) return;
          closed = true;
          await teardownJob({
            controlSock: paths.controlSock,
            paths,
            short,
            sessionProjectionPath: dispatched.sessionProjectionPath,
            sessionId: dispatched.sessionId,
          });
        })();
      }
      return closePromise;
    },
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
