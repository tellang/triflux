import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import {
  buildNativeWorkerRosterEntry,
  deriveClaudeDaemonPaths,
  mergeRosterWorkers,
  removeRosterWorkers,
} from "./claude-native-bridge.mjs";
import { startInteractiveNativeWorker } from "./interactive-native-worker.mjs";

function buildWorkerSocketPaths({ configDir, sessionName, pid, short }) {
  const hash = crypto
    .createHash("sha256")
    .update(`${configDir || ""}:${sessionName}:${pid}:${crypto.randomUUID()}`)
    .digest("hex")
    .slice(0, 10);
  const socketRoot = path.join(os.tmpdir(), `tfx-in-${hash}`);
  return {
    rvSock: path.join(socketRoot, `${short}.rv.sock`),
    ptySock: path.join(socketRoot, `${short}.pty.sock`),
  };
}

export async function launchAdoptedInteractiveWorker({
  cwd = process.cwd(),
  sessionName,
  launchCmd = "codex",
  cli = "codex",
  role = "interactive",
  configDir,
  pid = process.pid,
  _deps = {},
} = {}) {
  const startWorker =
    _deps.startInteractiveNativeWorker || startInteractiveNativeWorker;
  const buildRosterEntry =
    _deps.buildNativeWorkerRosterEntry || buildNativeWorkerRosterEntry;
  const mergeWorkers = _deps.mergeRosterWorkers || mergeRosterWorkers;
  const derivePaths = _deps.deriveClaudeDaemonPaths || deriveClaudeDaemonPaths;

  const resolvedCwd = path.resolve(cwd);
  const effectiveSessionName =
    sessionName || `tfx-${cli}-${role}-${process.pid}`;
  const paths = derivePaths({ configDir });
  const short = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  const { rvSock, ptySock } = buildWorkerSocketPaths({
    configDir,
    sessionName: effectiveSessionName,
    pid,
    short,
  });
  const displayName = `Triflux ${cli} ${role}`;

  let worker;
  let closed = false;
  let closePromise = null;

  try {
    worker = await startWorker({
      short,
      rvSock,
      ptySock,
      sessionName: effectiveSessionName,
      cwd: resolvedCwd,
      launchCmd,
      pid,
    });
    const workerShort = worker.short || short;
    const workerPid = worker.pid || pid;
    const entry = buildRosterEntry({
      short: workerShort,
      pid: workerPid,
      cwd: resolvedCwd,
      rendezvousSock: worker.rvSock,
      ptySock: worker.ptySock,
      name: displayName,
      prompt: displayName,
    });
    await mergeWorkers(paths.rosterPath, { [workerShort]: entry });

    return {
      short: workerShort,
      displayName,
      rosterPath: paths.rosterPath,
      close() {
        if (!closePromise) {
          closePromise = (async () => {
            if (closed) return;
            closed = true;
            try {
              await worker.close();
            } finally {
              await removeRosterWorkers(paths.rosterPath, [workerShort]);
            }
          })();
        }
        return closePromise;
      },
    };
  } catch (error) {
    if (worker) await worker.close().catch(() => {});
    throw error;
  }
}
