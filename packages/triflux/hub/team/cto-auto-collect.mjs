import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_DEBOUNCE_MS = 120_000;
const OFF_VALUES = new Set(["0", "false", "off", "no"]);

export function isCtoAutoCollectDisabled(env = process.env) {
  return OFF_VALUES.has(
    String(env?.TFX_CTO_AUTO_COLLECT ?? "")
      .trim()
      .toLowerCase(),
  );
}

function freshCurrentMd(projectRoot, now, debounceMs) {
  try {
    const currentMd = join(projectRoot, ".triflux", "lake", "current.md");
    if (!existsSync(currentMd)) return false;
    return now - statSync(currentMd).mtimeMs < debounceMs;
  } catch {
    return false;
  }
}

export function createCtoAutoCollector(opts = {}) {
  const registry = opts.registry;
  const runCollect = opts.runCollect;
  const logger = opts.logger || null;
  const debounceMs = Number(opts.debounceMs || DEFAULT_DEBOUNCE_MS);
  const now = opts.now || (() => Date.now());
  const env = opts.env || process.env;
  const lastCollectMs = opts.lastCollectMs || new Map();
  const inFlight = new Set();

  function handleSessionStarted({ sessionId, session } = {}) {
    if (isCtoAutoCollectDisabled(env))
      return { triggered: false, reason: "disabled" };
    if (!registry || typeof registry.querySessions !== "function") {
      return { triggered: false, reason: "missing-registry" };
    }
    if (typeof runCollect !== "function") {
      return { triggered: false, reason: "missing-runCollect" };
    }

    const cwd = typeof session?.cwd === "string" ? session.cwd : "";
    const worktree =
      typeof session?.worktreePath === "string" ? session.worktreePath : "";
    const projectRoot = worktree || cwd;
    if (!projectRoot)
      return { triggered: false, reason: "missing-project-root" };

    let peers = [];
    try {
      peers = registry.querySessions({
        cwd,
        worktree,
        excludeSessionId: sessionId,
      });
    } catch (error) {
      logger?.warn?.(
        { sessionId, err: String(error?.message || error) },
        "cto.auto_collect.query_failed",
      );
      return { triggered: false, reason: "query-failed" };
    }
    if (!Array.isArray(peers) || peers.length < 1) {
      return { triggered: false, reason: "no-peers" };
    }

    const currentTime = now();
    const last = lastCollectMs.get(projectRoot) || 0;
    if (currentTime - last < debounceMs) {
      return { triggered: false, reason: "debounced" };
    }
    if (freshCurrentMd(projectRoot, currentTime, debounceMs)) {
      lastCollectMs.set(projectRoot, currentTime);
      return { triggered: false, reason: "fresh-lake" };
    }

    lastCollectMs.set(projectRoot, currentTime);
    const promise = Promise.resolve()
      .then(() => runCollect([], { rootDir: projectRoot }))
      .catch((error) => {
        logger?.warn?.(
          { projectRoot, err: String(error?.message || error) },
          "cto.auto_collect.failed",
        );
      })
      .finally(() => {
        inFlight.delete(promise);
      });
    inFlight.add(promise);
    return {
      triggered: true,
      reason: "triggered",
      projectRoot,
      peerCount: peers.length,
    };
  }

  async function drain() {
    await Promise.allSettled([...inFlight]);
  }

  return Object.freeze({
    handleSessionStarted,
    drain,
  });
}
