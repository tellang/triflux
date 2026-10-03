import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { resolveLakeRootDir } from "../../cto/lake-root.mjs";
import { resolveRoleControlSnapshot } from "../lib/cto-env.mjs";

const DEFAULT_DEBOUNCE_MS = 120_000;

export function isCtoAutoCollectDisabled(env = process.env) {
  return !resolveRoleControlSnapshot(env).auto_collect_enabled;
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
    const projectRoot = resolveLakeRootDir(worktree || cwd);
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
      // peer 조회 실패는 collect 를 막지 않는다 — peer 정보는 이제 라벨 용도뿐이라
      // registry 일시 장애에도 solo 로 진행해 collect 회복력을 유지한다.
      peers = [];
    }
    // 단일 세션(peer 0개)도 허용한다 — 사용자 선택. peer 유무와 무관하게
    // 아래 debounce + fresh-lake 게이트가 collect 빈도를 제어한다.
    //
    // 주의: peerCount 는 best-effort 라벨이다. querySessions 는 raw
    // cwd/worktreePath 로 매칭하지만 projectRoot 는 resolved git toplevel 이라,
    // 같은 repo 의 다른 하위 폴더 세션은 peer 로 안 잡혀 triggered-solo 로 보고될
    // 수 있다. 즉 라벨은 repo-scoped 가 아니라 exact-cwd-scoped 다 — 향후 peer
    // 기반 로직을 이 라벨 위에 다시 올릴 때 주의한다.
    const peerCount = Array.isArray(peers) ? peers.length : 0;

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
      reason: peerCount > 0 ? "triggered" : "triggered-solo",
      projectRoot,
      peerCount,
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
