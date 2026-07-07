// cto/steward.mjs — collect + hygiene 주기 루프 (resident-cto-manager PRD T2 선행 슬라이스)
// 가드레일: TFX_CTO kill-switch 매 cycle 확인 + watch 루프는 lake당 단일 인스턴스 락.
import { utimesSync } from "node:fs";
import { join } from "node:path";

import { isCtoDisabled } from "../hub/lib/cto-env.mjs";
import { runCollect } from "./collect.mjs";
import { acquireCtoHygieneStewardLock, runHygiene } from "./hygiene.mjs";
import { resolveLakeRootDir } from "./lake-root.mjs";

const SCHEMA_VERSION = "cto-steward.v1";
const DEFAULT_INTERVAL_MS = 60_000;
const LOOP_LOCK_STALE_MS = 10 * 60_000;
const KNOWN_FLAGS_WITH_VALUES = new Set(["--max-runs", "--interval-ms"]);
const KNOWN_BOOLEAN_FLAGS = new Set([
  "--watch",
  "--apply",
  "--dry-run",
  "--json",
  "--no-collect",
]);

function writeJson(stdout, payload) {
  stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function parsePositiveInteger(name, value) {
  if (value === undefined || String(value).startsWith("--")) {
    throw new Error(`tfx cto steward ${name} requires a value`);
  }
  if (!/^\d+$/u.test(String(value))) {
    throw new Error(`tfx cto steward ${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`tfx cto steward ${name} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInteger(name, value) {
  if (value === undefined || String(value).startsWith("--")) {
    throw new Error(`tfx cto steward ${name} requires a value`);
  }
  if (!/^\d+$/u.test(String(value))) {
    throw new Error(`tfx cto steward ${name} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`tfx cto steward ${name} must be a non-negative integer`);
  }
  return parsed;
}

export function parseStewardArgs(args = []) {
  const parsed = {
    watch: false,
    maxRuns: null,
    intervalMs: DEFAULT_INTERVAL_MS,
    apply: false,
    dryRun: false,
    json: false,
    collectEnabled: true,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (KNOWN_FLAGS_WITH_VALUES.has(arg)) {
      const value = args[index + 1];
      if (arg === "--max-runs")
        parsed.maxRuns = parsePositiveInteger(arg, value);
      else parsed.intervalMs = parseNonNegativeInteger(arg, value);
      index += 1;
      continue;
    }
    if (KNOWN_BOOLEAN_FLAGS.has(arg)) {
      if (arg === "--watch") parsed.watch = true;
      else if (arg === "--apply") parsed.apply = true;
      else if (arg === "--dry-run") parsed.dryRun = true;
      else if (arg === "--json") parsed.json = true;
      else if (arg === "--no-collect") parsed.collectEnabled = false;
      continue;
    }
    throw new Error(`unknown tfx cto steward flag: ${arg}`);
  }

  if (parsed.apply && parsed.dryRun) {
    throw new Error("tfx cto steward accepts only one of --apply or --dry-run");
  }
  return parsed;
}

function createSilentStdout() {
  return {
    write() {
      return true;
    },
  };
}

function compactRun(index, collectResult, hygieneResult) {
  return {
    index,
    collected: collectResult !== null,
    collect: collectResult,
    hygiene: hygieneResult,
  };
}

function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

export function stewardLoopLockPath(lakeRoot) {
  return join(lakeRoot, "stewards", "steward-loop.lock");
}

export async function runSteward(args = [], opts = {}) {
  const parsed = parseStewardArgs(args);
  const jsonRequested = parsed.json || opts.json === true;
  if (parsed.watch && parsed.maxRuns === null && jsonRequested) {
    throw new Error(
      "tfx cto steward --watch --json requires --max-runs for a finite JSON summary",
    );
  }
  if (!parsed.watch && parsed.maxRuns !== null) {
    (opts.stderr || process.stderr).write(
      "tfx cto steward: --max-runs is ignored without --watch\n",
    );
  }

  // steward 전용 opts 는 여기서 걸러내고, 나머지(overlay, synapseReader 등)만
  // collect/hygiene 로 전달한다.
  const {
    collectFn: injectedCollectFn,
    hygieneFn: injectedHygieneFn,
    sleepFn: injectedSleepFn,
    onRun,
    json: _jsonOpt,
    stdout: injectedStdout,
    stderr: _stderrOpt,
    signal: externalSignal,
    isCtoDisabledFn: injectedGate,
    acquireLoopLockFn: injectedAcquireLoopLock,
    installSignalHandler,
    rootDir: _rootDirOpt,
    lakeRoot: _lakeRootOpt,
    ...innerOpts
  } = opts;

  const rootDir = opts.rootDir || resolveLakeRootDir(process.cwd());
  const lakeRoot = opts.lakeRoot || join(rootDir, ".triflux", "lake");
  const stdout = injectedStdout || process.stdout;
  const collectFn = injectedCollectFn || runCollect;
  const hygieneFn = injectedHygieneFn || runHygiene;
  const ctoDisabled = injectedGate || isCtoDisabled;

  const controller = new AbortController();
  const signal = controller.signal;
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else
      externalSignal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
  }

  const sleepFn =
    injectedSleepFn ||
    ((ms) =>
      new Promise((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      }));

  const mode = parsed.apply ? "apply" : "dry-run";
  const silentStdout = createSilentStdout();
  const runLimit = parsed.watch ? parsed.maxRuns : 1;
  const retainRuns = runLimit !== null;
  const runs = [];
  let latestRun = null;
  let lastCollect = null;
  let lastHygiene = null;
  let runCount = 0;
  let stoppedReason = null;

  // 가드레일 1 (PRD kill-switch): 루프 진입 전에도, 매 cycle에도 확인한다.
  if (ctoDisabled()) stoppedReason = "disabled";

  // 가드레일 2 (PRD single-instance): watch 루프는 lake당 하나만 돈다.
  const loopLockPath = stewardLoopLockPath(lakeRoot);
  const loopLockStaleMs = Math.max(LOOP_LOCK_STALE_MS, parsed.intervalMs * 3);
  let loopLock = null;
  let loopLockHeartbeat = null;
  if (!stoppedReason && parsed.watch) {
    const acquireLock =
      injectedAcquireLoopLock ||
      ((lockPath) =>
        acquireCtoHygieneStewardLock(rootDir, lakeRoot, {
          lockPath,
          timeoutMs: 0,
          staleMs: loopLockStaleMs,
        }));
    loopLock = await acquireLock(loopLockPath);
    // 한 cycle이 staleMs보다 길어져도 다른 인스턴스가 락을 stale로 오판해
    // 훔치지 못하도록, 작업 진행 중에도 주기적으로 mtime을 갱신한다.
    if (loopLock?.path) {
      const heartbeatMs = Math.max(30_000, Math.floor(loopLockStaleMs / 3));
      loopLockHeartbeat = setInterval(() => {
        try {
          const touch = new Date();
          utimesSync(loopLock.path, touch, touch);
        } catch {}
      }, heartbeatMs);
      loopLockHeartbeat.unref?.();
    }
  }

  let sigintHandler = null;
  if (!stoppedReason && parsed.watch && installSignalHandler !== false) {
    sigintHandler = () => controller.abort();
    process.once("SIGINT", sigintHandler);
  }

  try {
    while (!stoppedReason && (runLimit === null || runCount < runLimit)) {
      if (ctoDisabled()) {
        stoppedReason = "disabled";
        break;
      }
      if (signal.aborted) {
        stoppedReason = "signal";
        break;
      }

      const runIndex = runCount + 1;
      let collectResult = null;

      if (parsed.collectEnabled) {
        collectResult = await collectFn([], {
          ...innerOpts,
          rootDir,
          lakeRoot,
          stdout: silentStdout,
        });
        lastCollect = collectResult;
      }

      // collect 도중 중단/kill-switch가 들어왔으면 이번 cycle의 hygiene(특히
      // apply)을 시작하지 않는다 — 중단 요청 이후의 fs-mutation 금지.
      if (ctoDisabled()) {
        stoppedReason = "disabled";
        break;
      }
      if (signal.aborted) {
        stoppedReason = "signal";
        break;
      }

      const hygieneArgs = parsed.apply
        ? ["--apply", "--json"]
        : ["--dry-run", "--json"];
      const hygieneResult = await hygieneFn(hygieneArgs, {
        ...innerOpts,
        rootDir,
        lakeRoot,
        stdout: silentStdout,
        apply: parsed.apply,
        dryRun: !parsed.apply,
        json: true,
      });
      lastHygiene = hygieneResult;

      const run = compactRun(runIndex, collectResult, hygieneResult);
      latestRun = run;
      if (retainRuns) runs.push(run);
      runCount += 1;

      if (parsed.watch && !jsonRequested) {
        stdout.write(
          `cto steward run ${runIndex} (${mode}): collect=${
            collectResult !== null ? "ok" : "skipped"
          } hygiene=ok\n`,
        );
      }
      if (typeof onRun === "function") {
        await onRun(run, {
          run_count: runCount,
          rootDir,
          lakeRoot,
          mode,
        });
      }

      if (!parsed.watch) break;
      if (runLimit !== null && runCount >= runLimit) break;
      try {
        await sleepFn(parsed.intervalMs);
      } catch (error) {
        if (isAbortError(error)) {
          stoppedReason = "signal";
          break;
        }
        throw error;
      }
      if (signal.aborted) {
        stoppedReason = "signal";
        break;
      }
    }
  } finally {
    if (sigintHandler) process.off("SIGINT", sigintHandler);
    if (loopLockHeartbeat) clearInterval(loopLockHeartbeat);
    loopLock?.release?.();
  }

  if (!stoppedReason) stoppedReason = parsed.watch ? "max-runs" : "single-run";

  const summary = {
    schema_version: SCHEMA_VERSION,
    mode,
    watch: parsed.watch,
    interval_ms: parsed.intervalMs,
    max_runs: parsed.maxRuns,
    collect_enabled: parsed.collectEnabled,
    disabled: stoppedReason === "disabled",
    stopped_reason: stoppedReason,
    loop_lock_path: parsed.watch ? loopLockPath : null,
    run_count: runCount,
    retained_run_count: runs.length,
    runs,
    latest_run: latestRun,
    last_collect: lastCollect,
    last_hygiene: lastHygiene,
  };

  if (jsonRequested) writeJson(stdout, summary);
  else if (stoppedReason === "disabled") {
    stdout.write(
      `cto steward disabled by TFX_CTO kill-switch after ${runCount} run(s)\n`,
    );
  } else {
    stdout.write(
      `cto steward ${mode}: ${runCount} run(s), collect ${
        parsed.collectEnabled ? "enabled" : "disabled"
      }, stopped=${stoppedReason}\n`,
    );
  }

  return summary;
}
