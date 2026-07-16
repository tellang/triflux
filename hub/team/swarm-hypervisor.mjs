// hub/team/swarm-hypervisor.mjs — Multi-model swarm orchestration hypervisor
// Consumes a SwarmPlan (from swarm-planner.mjs) and orchestrates parallel
// conductor sessions with file-lease enforcement, result validation,
// and ordered integration.
//
// Failure modes handled:
//   F1: Worker crash         → conductor auto-restart (maxRestarts)
//   F2: Rate limit           → account-broker cooldown + fallback agent
//   F3: Stall                → health probe L1 detection + kill + restart
//   F4: File lease violation  → revert worker changes, flag shard as failed
//   F5: Merge conflict        → retry integration with conflict resolution

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createDynamicRouter,
  isDynamicRoutingEnabled,
} from "../dynamic-routing-engine.mjs";
import { cleanupShardProcesses } from "../lib/process-utils.mjs";
import { getHostConfig } from "../lib/ssh-command.mjs";
import { DEFAULT_SWARM_LOCK_TTL_MS } from "../lib/timeout-defaults.mjs";
import { buildWorkerPrompt } from "./build-worker-prompt.mjs";
import { registerSwarmShard } from "./claude-native-bridge.mjs";
import { createConductor, STATES } from "./conductor.mjs";
import { ensureConductorRegistry } from "./conductor-registry.mjs";
import { createEventLog } from "./event-log.mjs";
import { preserveWorktreePatch } from "./recovery-store.mjs";
import { probeRemoteEnv, resolveRemoteDir } from "./remote-session.mjs";
import { createSwarmLocks } from "./swarm-locks.mjs";
import { validateWorkerCompletion } from "./worker-completion-validator.mjs";
import {
  cleanupWorktree,
  EXPECTED_WORKTREE_DELETIONS,
  ensureWorktree,
  extractDirtyFiles,
  fetchRemoteShard,
  prepareIntegrationBranch,
  pruneWorktree,
  rebaseShardOntoIntegration,
} from "./worktree-lifecycle.mjs";

let ensureHubAliveFn = null;
let getHubInfoFn = null;
try {
  ({ ensureHubAlive: ensureHubAliveFn, getHubInfo: getHubInfoFn } =
    await import("./cli/services/hub-client.mjs"));
} catch {
  // hub-client 미설치 환경 — Hub 수동 관리 필요
}

let importedCreateRegistry = null;
let meshRegistryImportError = null;
try {
  ({ createRegistry: importedCreateRegistry } = await import(
    "../../mesh/mesh-registry.mjs"
  ));
} catch (err) {
  meshRegistryImportError = err;
}

// ── Swarm states ──────────────────────────────────────────────

export const SWARM_STATES = Object.freeze({
  PLANNING: "planning",
  LAUNCHING: "launching",
  RUNNING: "running",
  INTEGRATING: "integrating",
  VALIDATING: "validating",
  COMPLETED: "completed",
  FAILED: "failed",
});

// ── Failure mode classification ───────────────────────────────

const FAILURE_MODES = Object.freeze({
  F1_CRASH: "F1_crash",
  F2_RATE_LIMIT: "F2_rate_limit",
  F3_STALL: "F3_stall",
  F4_LEASE_VIOLATION: "F4_lease_violation",
  F5_MERGE_CONFLICT: "F5_merge_conflict",
  F6_NO_COMMIT: "F6_no_commit",
  F7_WORKER_DID_NOT_COMMIT: "F7_worker_did_not_commit",
});

const FALLBACK_AGENTS = Object.freeze({
  codex: "gemini",
  gemini: "codex",
  claude: "codex",
});

function resolveRedundantAgent(shard) {
  const mode = shard?.redundancy;
  if (!mode) return null;
  if (mode === "same-cli") return shard.agent;
  if (mode === true || mode === "fallback") {
    return FALLBACK_AGENTS[shard.agent] || shard.agent;
  }
  return null;
}

function createNoopRegistry() {
  return Object.freeze({
    register() {},
    unregister() {},
    discover() {
      return [];
    },
    getAgent() {
      return null;
    },
    listAll() {
      return [];
    },
    clear() {},
  });
}

function createSharedRegistry(factory) {
  if (typeof factory !== "function") {
    return {
      registry: createNoopRegistry(),
      fallbackReason: meshRegistryImportError
        ? `mesh_import_failed:${meshRegistryImportError.message}`
        : "mesh_registry_unavailable",
    };
  }

  try {
    return { registry: factory(), fallbackReason: null };
  } catch (err) {
    return {
      registry: createNoopRegistry(),
      fallbackReason: `mesh_registry_init_failed:${err.message}`,
    };
  }
}

function hasOwnDep(deps, key) {
  return Object.hasOwn(deps, key);
}

function formatHubHostForUrl(host) {
  return host.includes(":") ? `[${host}]` : host;
}

function resolveHubStatusUrl(hub) {
  if (!hub) return null;

  if (typeof hub.url === "string" && hub.url.trim()) {
    try {
      const url = new URL(hub.url);
      url.pathname = "/status";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return null;
    }
  }

  const host = typeof hub.host === "string" ? hub.host.trim() : "";
  const port = Number(hub.port);
  if (!host || !Number.isFinite(port) || port <= 0) return null;
  return `http://${formatHubHostForUrl(host)}:${port}/status`;
}

function isTruthyConfigValue(value) {
  if (typeof value === "boolean") return value;
  return /^(true|yes|1|interactive)$/i.test(String(value || "").trim());
}

function isInteractiveNativeBridgeShard(shard) {
  return (
    isTruthyConfigValue(shard?.interactive) ||
    isTruthyConfigValue(shard?.nativeBridgeInteractive) ||
    String(shard?.workerType || "").toLowerCase() === "interactive"
  );
}

/**
 * Create a swarm hypervisor.
 * @param {object} opts
 * @param {string} opts.workdir — repository root / working directory
 * @param {string} opts.logsDir — base directory for all logs
 * @param {string} [opts.baseBranch='main'] — base branch for shard worktrees
 * @param {string} [opts.runId=`swarm-${Date.now()}`] — logical swarm run id
 * @param {number} [opts.maxRestarts=2] — per-shard max restarts
 * @param {boolean} [opts.nativeBridge=false] — expose local shards in Claude agents
 * @param {number} [opts.graceMs=10000] — conductor shutdown grace period
 * @param {boolean} [opts.keepFailedWorktrees=false] — preserve failed shard worktrees for debugging
 * @param {object} [opts.probeOpts] — health probe overrides
 * @param {object} [opts.deps] — dependency injection for testing
 * @returns {SwarmHypervisor}
 */
export function createSwarmHypervisor(opts) {
  const {
    workdir,
    logsDir,
    baseBranch = "main",
    runId = `swarm-${Date.now()}`,
    maxRestarts = 2,
    nativeBridge = false,
    graceMs = 10_000,
    keepFailedWorktrees = false,
    probeOpts = {},
    _deps = {},
  } = opts;

  if (!workdir) throw new Error("workdir is required");
  if (!logsDir) throw new Error("logsDir is required");

  mkdirSync(logsDir, { recursive: true });
  ensureConductorRegistry();

  const createConductorImpl = _deps.createConductor || createConductor;
  const createRegistryImpl = _deps.createRegistry || importedCreateRegistry;
  const ensureWorktreeImpl = _deps.ensureWorktree || ensureWorktree;
  const prepareIntegrationBranchImpl =
    _deps.prepareIntegrationBranch || prepareIntegrationBranch;
  const rebaseShardOntoIntegrationImpl =
    _deps.rebaseShardOntoIntegration || rebaseShardOntoIntegration;
  const cleanupWorktreeImpl =
    _deps.cleanupWorktree || cleanupWorktree || pruneWorktree;
  const cleanupShardProcessesImpl =
    _deps.cleanupShardProcesses || cleanupShardProcesses;
  const registerSwarmShardImpl = _deps.registerSwarmShard || registerSwarmShard;
  const preserveWorktreePatchImpl =
    _deps.preserveWorktreePatch || preserveWorktreePatch;
  const ensureHubAliveImpl = hasOwnDep(_deps, "ensureHubAlive")
    ? _deps.ensureHubAlive
    : ensureHubAliveFn;
  const getHubInfoImpl = hasOwnDep(_deps, "getHubInfo")
    ? _deps.getHubInfo
    : getHubInfoFn;
  const emitter = new EventEmitter();
  const eventLog = createEventLog(join(logsDir, "swarm-events.jsonl"));
  const { registry: sharedRegistry, fallbackReason: meshRegistryFallback } =
    createSharedRegistry(createRegistryImpl);

  let state = SWARM_STATES.PLANNING;
  let plan = null;
  let lockManager = null;

  /** @type {Map<string, { conductor, shardConfig, result, status }>} */
  const workers = new Map();

  /** @type {Map<string, { conductor, shardConfig }>} redundant workers for critical shards */
  const redundantWorkers = new Map();

  /** @type {Set<string>} shards that have fully completed (not just launched) */
  const completedShards = new Set();
  const cleanedWorktreePaths = new Set();
  const processCleanupTotals = {
    totalKilled: 0,
    byCategory: {},
  };

  const results = new Map(); // shardName → validated result
  const failures = new Map(); // shardName → failure info
  let integrationResult = null;
  let resolveIntegrationPromise = null;
  let integrationPromiseState = {
    state: "idle",
    startedAt: null,
    settledAt: null,
    partial: false,
    integrated: [],
    failed: [],
    integrationFailures: [],
    skipped: [],
    integrationBranch: null,
    report: [],
    processCleanup: {
      totalKilled: 0,
      byCategory: {},
    },
    error: null,
  };
  const integrationPromise = new Promise((resolve) => {
    resolveIntegrationPromise = resolve;
  });

  if (meshRegistryFallback) {
    eventLog.append("mesh_registry_fallback", { reason: meshRegistryFallback });
  }

  // ── State machine ───────────────────────────────────────────

  function setState(next, reason = "") {
    const prev = state;
    state = next;
    eventLog.append("swarm_state", { from: prev, to: next, reason });
    emitter.emit("stateChange", { from: prev, to: next, reason });
    // Best-effort phase tracking via phase-manager
    void writeSwarmPhaseSafely(
      plan?.runId || plan?.id || `swarm-${Date.now()}`,
      next,
    );
  }

  async function writeSwarmPhaseSafely(runId, swarmState) {
    if (!runId) return;
    const mapping = {
      [SWARM_STATES.LAUNCHING]: ["Execution", "active"],
      [SWARM_STATES.RUNNING]: ["Execution", "active"],
      [SWARM_STATES.INTEGRATING]: ["Validation", "active"],
      [SWARM_STATES.VALIDATING]: ["Validation", "active"],
      [SWARM_STATES.COMPLETED]: ["Validation", "complete"],
      [SWARM_STATES.FAILED]: ["Validation", "failed"],
    };
    const target = mapping[swarmState];
    if (!target) return;
    try {
      const mod = await import("../lib/phase-manager.mjs");
      if (typeof mod?.writePhase === "function") {
        await mod.writePhase(runId, target[0], target[1]);
      }
      if (typeof mod?.syncToGstack === "function") {
        const slug = process.cwd().split(/[\\/]/).pop();
        await mod.syncToGstack(runId, slug);
      }
    } catch {
      /* silent — phase tracking is best-effort */
    }
  }

  function markIntegrationPromisePending() {
    if (integrationPromiseState.state !== "idle") return;
    integrationPromiseState = {
      ...integrationPromiseState,
      state: "pending",
      startedAt: Date.now(),
    };
  }

  function settleIntegrationPromise(payload) {
    if (integrationPromiseState.state === "fulfilled" && integrationResult) {
      return integrationResult;
    }

    const processCleanup = payload.processCleanup || getProcessCleanupSummary();

    integrationResult = Object.freeze({
      integrated: Object.freeze([...(payload.integrated || [])]),
      failed: Object.freeze([...(payload.failed || [])]),
      integrationFailures: Object.freeze([
        ...(payload.integrationFailures || []),
      ]),
      skipped: Object.freeze([...(payload.skipped || [])]),
      integrationBranch: payload.integrationBranch || null,
      report: Object.freeze(
        (payload.report || []).map((row) => Object.freeze({ ...row })),
      ),
      results: Object.freeze([...(payload.results || [])]),
      processCleanup: Object.freeze({
        totalKilled: processCleanup.totalKilled || 0,
        byCategory: Object.freeze({ ...(processCleanup.byCategory || {}) }),
      }),
      partial:
        payload.partial ??
        (Array.isArray(payload.failed) && payload.failed.length > 0),
      error: payload.error || null,
    });

    integrationPromiseState = {
      state: "fulfilled",
      startedAt: integrationPromiseState.startedAt ?? Date.now(),
      settledAt: Date.now(),
      partial: integrationResult.partial,
      integrated: [...integrationResult.integrated],
      failed: [...integrationResult.failed],
      integrationFailures: [...integrationResult.integrationFailures],
      skipped: [...integrationResult.skipped],
      integrationBranch: integrationResult.integrationBranch,
      report: integrationResult.report.map((row) => ({ ...row })),
      processCleanup: integrationResult.processCleanup,
      error: integrationResult.error,
    };

    resolveIntegrationPromise?.(integrationResult);
    return integrationResult;
  }

  function getProcessCleanupSummary() {
    return {
      totalKilled: processCleanupTotals.totalKilled,
      byCategory: { ...processCleanupTotals.byCategory },
    };
  }

  function recordProcessCleanup(result) {
    if (!result) return getProcessCleanupSummary();

    const killed = Number(result.killed ?? result.totalKilled ?? 0);
    if (Number.isFinite(killed) && killed > 0) {
      processCleanupTotals.totalKilled += killed;
    }

    for (const [category, count] of Object.entries(result.byCategory || {})) {
      const numeric = Number(count);
      if (!Number.isFinite(numeric) || numeric <= 0) continue;
      processCleanupTotals.byCategory[category] =
        (processCleanupTotals.byCategory[category] || 0) + numeric;
    }

    return getProcessCleanupSummary();
  }

  function normalizeIntegrationReportRow(row) {
    return {
      shard: row.shard,
      strategy: row.strategy || "failed",
      commits:
        Number.isFinite(Number(row.commits)) && row.commits !== null
          ? Number(row.commits)
          : null,
      finalSha: row.finalSha || null,
      notes: row.notes || "",
      recoveryPatch: row.recoveryPatch || null,
    };
  }

  function git(args, cwd = workdir) {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        args,
        { cwd, windowsHide: true, timeout: 30_000 },
        (err, stdout, stderr) => {
          if (err) {
            reject(
              new Error(
                `git ${args[0]} failed: ${stderr?.trim() || err.message}`,
              ),
            );
            return;
          }
          resolve(stdout.trim());
        },
      );
    });
  }

  // Injectable git seam (#394). Defaults to the execFile closure above; tests
  // override via `_deps.git` to drive the redundant-win commit-evidence gate
  // deterministically without provisioning a real worktree.
  const gitRun = _deps.git || git;

  function computeAuthoritativeStatus(shardName, workerEntry, sessions) {
    const failureInfo = failures.get(shardName) || null;
    if (failureInfo) {
      return {
        status: "failed",
        reason: failureInfo.mode || failureInfo.reason || "failed",
      };
    }

    if (results.has(shardName)) {
      return { status: "done", reason: "integrated" };
    }

    if (!sessions.length) {
      if (completedShards.has(shardName)) {
        return { status: "done", reason: "awaiting_integration" };
      }
      return { status: "running", reason: "no_sessions" };
    }

    const states = sessions.map((session) => session.state);
    if (states.every((stateValue) => stateValue === STATES.COMPLETED)) {
      return { status: "done", reason: "awaiting_integration" };
    }
    if (states.some((stateValue) => stateValue === STATES.INPUT_WAIT)) {
      return { status: "blocked", reason: "user_input" };
    }
    if (states.some((stateValue) => stateValue === STATES.STALLED)) {
      return { status: "stalled", reason: "health_probe_stall" };
    }
    if (
      states.some(
        (stateValue) =>
          stateValue === STATES.FAILED || stateValue === STATES.DEAD,
      )
    ) {
      return { status: "failed", reason: "session_terminal" };
    }
    if (
      states.some(
        (stateValue) =>
          stateValue === STATES.STARTING ||
          stateValue === STATES.RESTARTING ||
          stateValue === STATES.INIT,
      )
    ) {
      return { status: "running", reason: "starting" };
    }

    return { status: "running", reason: "healthy" };
  }

  async function collectCommitEvidence(worker, integrationBranch) {
    const branchName = worker?.branchName || null;
    const evidence = {
      branchName,
      integrationBranch,
      commitsAhead: 0,
      dirty: false,
      dirtyFiles: [],
      headCommit: null,
      ok: false,
      error: null,
    };

    if (!branchName) {
      evidence.error = "missing_branch_name";
      return evidence;
    }

    try {
      evidence.commitsAhead =
        Number.parseInt(
          await gitRun([
            "rev-list",
            "--count",
            `${integrationBranch}..${branchName}`,
          ]),
          10,
        ) || 0;
    } catch (err) {
      evidence.error = err.message;
      return evidence;
    }

    try {
      evidence.headCommit = await gitRun(["rev-parse", branchName]);
    } catch {
      /* best-effort */
    }

    if (worker?.worktreePath && !worker?.shardConfig?.host) {
      try {
        const rawStatus = await gitRun(
          ["status", "--short"],
          worker.worktreePath,
        );
        // Only explicitly expected lifecycle deletions are filtered. Plugin
        // metadata deletions remain dirty because Codex workers need them.
        evidence.dirtyFiles = extractDirtyFiles(
          rawStatus,
          EXPECTED_WORKTREE_DELETIONS,
        );
        evidence.dirty = evidence.dirtyFiles.length > 0;
      } catch (err) {
        evidence.error = evidence.error || err.message;
        return evidence;
      }
    }

    evidence.ok = evidence.commitsAhead > 0 && evidence.dirty === false;
    return evidence;
  }

  // ── Worker lifecycle ────────────────────────────────────────

  function safeSessionPart(value) {
    return String(value || "unknown")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
  }

  function buildSwarmSessionId(shard) {
    const short8 = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    return `swarm-${safeSessionPart(runId)}-${safeSessionPart(shard.name)}-${short8}`;
  }

  function getShardDisplayPosition(shard) {
    const shardIndex = plan?.shards?.findIndex(
      (item) => item.name === shard.name,
    );
    if (!plan?.shards?.length || shardIndex < 0) return {};
    return {
      shardIndex: shardIndex + 1,
      shardCount: plan.shards.length,
    };
  }

  async function closeNativeBridgeRegistration(worker, shardName, reason) {
    if (worker?.nativeBridgeClosePromise) {
      await worker.nativeBridgeClosePromise;
      return;
    }
    const registration = worker?.nativeBridgeRegistration;
    if (!registration || typeof registration.close !== "function") return;
    worker.nativeBridgeClosePromise = (async () => {
      let closed = false;
      try {
        await registration.close();
        closed = true;
        eventLog.append("native_bridge_registration_closed", {
          shard: shardName,
          reason,
        });
      } catch (err) {
        eventLog.append("native_bridge_registration_close_failed", {
          shard: shardName,
          reason,
          error: err.message,
        });
      } finally {
        worker.nativeBridgeClosePromise = null;
        if (closed) worker.nativeBridgeRegistration = null;
      }
    })();
    await worker.nativeBridgeClosePromise;
  }

  async function maybeRegisterNativeBridgeShard(shard, sessionConfig) {
    if (!nativeBridge) return null;
    try {
      const interactive = !shard.host && isInteractiveNativeBridgeShard(shard);
      const registration = await registerSwarmShardImpl({
        sessionId: sessionConfig.id,
        cli: shard.agent,
        role: shard.role || "worker",
        swarmName: runId,
        ...getShardDisplayPosition(shard),
        shardName: shard.name,
        cwd: interactive
          ? shard.worktreePath || sessionConfig.workdir || workdir
          : workdir,
        host: shard.host || "local",
        interactive,
        _deps: {
          warn(message) {
            emitter.emit("warning", {
              type: "native_bridge_registration_skipped",
              shard: shard.name,
              host: shard.host || "local",
              message,
            });
          },
        },
      });
      eventLog.append(
        registration?.skipped
          ? "native_bridge_registration_skipped"
          : "native_bridge_registration",
        {
          shard: shard.name,
          sessionId: sessionConfig.id,
          host: shard.host || "local",
          displayName: registration?.displayName || null,
        },
      );
      return registration;
    } catch (err) {
      eventLog.append("native_bridge_registration_failed", {
        shard: shard.name,
        sessionId: sessionConfig.id,
        host: shard.host || "local",
        error: err.message,
      });
      emitter.emit("warning", {
        type: "native_bridge_registration_failed",
        shard: shard.name,
        host: shard.host || "local",
        error: err.message,
      });
      return null;
    }
  }

  function buildSessionConfig(shard) {
    const config = {
      id: buildSwarmSessionId(shard),
      agent: shard.agent,
      role: shard.role,
      // #125: append Completion Protocol appendix so workers emit a
      // sentinel-framed JSON payload that conductor can reliably capture.
      prompt: buildWorkerPrompt(shard.prompt, {
        leaseFiles: shard.files,
        worktreePath: shard.worktreePath,
      }),
      workdir: shard.worktreePath || workdir,
      mcpServers: shard.mcp,
      worktreePath: shard.worktreePath || null,
      branchName: shard.branchName || null,
      // #90: shard는 worktree 격리가 본질. main 직접 커밋 방지 가드 env 주입.
      branchGuard: true,
    };

    if (shard.worktreePath) {
      return shard.host
        ? {
            ...config,
            remote: true,
            host: shard.host,
          }
        : config;
    }

    // Remote shard: use host's default_dir from hosts.json
    if (shard.host && shard._remoteEnv) {
      const hostConfig = getHostConfig(shard.host);
      const remoteSrc = hostConfig?.default_dir || workdir;
      const remoteDir = resolveRemoteDir(remoteSrc, shard._remoteEnv);
      return {
        ...config,
        remote: true,
        host: shard.host,
        workdir: remoteDir,
      };
    }

    return config;
  }

  async function launchShard(shard, isRedundant = false) {
    // Clone frozen shard so we can attach mutable runtime state (_remoteEnv)
    shard = { ...shard };
    let nativeBridgeRegistration = null;

    const shardLogsDir = join(
      logsDir,
      isRedundant ? `${shard.name}-redundant` : shard.name,
    );
    mkdirSync(shardLogsDir, { recursive: true });

    try {
      // Remote shard: probe environment before conductor creation
      if (shard.host && !shard._remoteEnv) {
        try {
          shard._remoteEnv = probeRemoteEnv(shard.host);
          if (!shard._remoteEnv.claudePath) {
            eventLog.append("remote_probe_no_claude", {
              shard: shard.name,
              host: shard.host,
            });
            if (!isRedundant) {
              failures.set(shard.name, {
                mode: FAILURE_MODES.F1_CRASH,
                reason: `claude not found on ${shard.host}`,
              });
            }
            return null;
          }
          eventLog.append("remote_probe_ok", {
            shard: shard.name,
            host: shard.host,
            env: shard._remoteEnv,
          });
        } catch (err) {
          eventLog.append("remote_probe_failed", {
            shard: shard.name,
            host: shard.host,
            error: err.message,
          });
          if (!isRedundant) {
            failures.set(shard.name, {
              mode: FAILURE_MODES.F1_CRASH,
              reason: `remote probe failed: ${err.message}`,
            });
          }
          return null;
        }
      }

      // Acquire file leases
      if (!isRedundant) {
        const leaseResult = lockManager.acquire(shard.name, shard.files);
        if (!leaseResult.ok) {
          eventLog.append("lease_denied", {
            shard: shard.name,
            conflicts: leaseResult.conflicts,
          });
          failures.set(shard.name, {
            mode: FAILURE_MODES.F4_LEASE_VIOLATION,
            conflicts: leaseResult.conflicts,
          });
          return null;
        }
      }

      const worktreeMeta = await ensureWorktreeImpl({
        slug: isRedundant ? `${shard.name}-redundant` : shard.name,
        runId,
        rootDir: workdir,
        baseBranch,
        host: shard.host,
        remoteEnv: shard._remoteEnv,
      });
      shard.worktreePath = worktreeMeta.worktreePath;
      shard.branchName = worktreeMeta.branchName;

      const conductor = createConductorImpl({
        logsDir: shardLogsDir,
        maxRestarts,
        graceMs,
        probeOpts,
        meshRegistry: sharedRegistry,
        enableMesh: true,
      });

      // NOTE: conductor 는 `session.config.onCompleted({ sessionId })` 형태로
      // 세션별 콜백만 호출한다 (factory 옵션은 무시). 따라서 sessionConfig 에
      // 직접 주입해야 shardCompleted 이벤트가 발화된다. 2026-04-17 세션에서
      // follow-up swarm 이 여기서 hang 했던 원인.
      const sessionConfig = buildSessionConfig(shard);
      nativeBridgeRegistration = await maybeRegisterNativeBridgeShard(
        shard,
        sessionConfig,
      );
      sessionConfig.onCompleted = ({ sessionId, completionPayload } = {}) =>
        handleShardCompleted(
          shard.name,
          sessionId,
          isRedundant,
          completionPayload,
        );
      conductor.spawnSession(sessionConfig);

      eventLog.append("shard_launched", {
        shard: shard.name,
        agent: shard.agent,
        sessionId: sessionConfig.id,
        isRedundant,
        files: shard.files,
        remote: Boolean(shard.host),
        host: shard.host || null,
        worktreePath: sessionConfig.worktreePath,
        branchName: sessionConfig.branchName,
      });

      emitter.emit("shardLaunched", {
        shardName: shard.name,
        sessionId: sessionConfig.id,
        agent: shard.agent,
        isRedundant,
        remote: Boolean(shard.host),
        host: shard.host || null,
      });

      const entry = {
        conductor,
        shardConfig: shard,
        sessionConfig,
        startedAt: Date.now(),
        worktreePath: sessionConfig.worktreePath,
        branchName: sessionConfig.branchName,
        nativeBridgeRegistration,
      };

      if (isRedundant) {
        redundantWorkers.set(shard.name, entry);
      } else {
        workers.set(shard.name, entry);
      }

      // Listen for dead events (F1/F2/F3)
      conductor.on("dead", ({ sessionId, reason }) => {
        handleShardFailed(shard.name, sessionId, reason, isRedundant);
      });

      return entry;
    } catch (err) {
      if (nativeBridgeRegistration) {
        await closeNativeBridgeRegistration(
          { nativeBridgeRegistration },
          shard.name,
          "launch_failed",
        );
      }
      eventLog.append("shard_launch_failed", {
        shard: shard.name,
        isRedundant,
        error: err.message,
      });
      if (!isRedundant) {
        failures.set(shard.name, {
          mode: FAILURE_MODES.F1_CRASH,
          reason: err.message,
        });
      }
      if (!isRedundant) {
        lockManager.release(shard.name);
      }
      if (shard.worktreePath) {
        await maybeCleanupWorktree(
          shard.name,
          {
            worktreePath: shard.worktreePath,
            branchName: shard.branchName,
          },
          shard,
          {
            branchName: shard.branchName,
            force: true,
            failureReason: `launch_failed:${err.message}`,
          },
        );
      }
      return null;
    }
  }

  // ── Completion handling ─────────────────────────────────────

  function handleShardCompleted(
    shardName,
    sessionId,
    isRedundant,
    completionPayload,
  ) {
    eventLog.append("shard_completed", {
      shard: shardName,
      sessionId,
      isRedundant,
      hasPayload: completionPayload !== undefined,
    });
    const completedWorker = isRedundant
      ? redundantWorkers.get(shardName)
      : workers.get(shardName);

    // F7 — worker self-reported completion must include commits_made.
    // Only enforce when payload is actually provided; legacy workers that
    // don't emit a structured payload keep the F6 integration-time guard.
    if (completionPayload !== undefined) {
      const verdict = validateWorkerCompletion(completionPayload);
      if (!verdict.ok) {
        const reason = verdict.reason || "invalid_completion_payload";

        if (isRedundant) {
          eventLog.append("redundant_completion_rejected", {
            shard: shardName,
            sessionId,
            reason,
          });
          redundantWorkers.delete(shardName);
          if (completedWorker) {
            void closeNativeBridgeRegistration(
              completedWorker,
              shardName,
              "failed",
            );
          }
          checkAllShardsCompleted();
          return;
        }

        eventLog.append("no_worker_commit_report", {
          shard: shardName,
          sessionId,
          reason,
        });
        if (completedWorker) {
          void closeNativeBridgeRegistration(
            completedWorker,
            shardName,
            "failed",
          );
        }
        failures.set(shardName, {
          mode: FAILURE_MODES.F7_WORKER_DID_NOT_COMMIT,
          reason,
          sessionId,
          completionPayload,
        });
        lockManager.release(shardName);

        const worker = workers.get(shardName);
        const shard = plan?.shards.find((item) => item.name === shardName);
        if (worker && shard) {
          const cleanupPromise = maybeCleanupWorktree(
            shardName,
            worker,
            shard,
            {
              force: true,
              failureReason: FAILURE_MODES.F7_WORKER_DID_NOT_COMMIT,
            },
          );
          worker.cleanupPromise = cleanupPromise;
          void cleanupPromise
            .finally(() => {
              if (worker.cleanupPromise === cleanupPromise) {
                worker.cleanupPromise = null;
              }
            })
            .catch(() => {});
        }

        const redundant = redundantWorkers.get(shardName);
        if (redundant) {
          void redundant.conductor.shutdown("primary_failed_f7");
        }

        emitter.emit("shardFailed", {
          shardName,
          failureMode: FAILURE_MODES.F7_WORKER_DID_NOT_COMMIT,
          reason,
        });

        cascadeDependencyFailure(shardName);
        checkAllShardsCompleted();
        return;
      }

      if (
        completionPayload?.status === "failed" ||
        completionPayload?.status === "blocked"
      ) {
        const detail =
          typeof completionPayload.reason === "string" &&
          completionPayload.reason.length > 0
            ? completionPayload.reason
            : "unspecified";
        const reason = `worker_reported_${completionPayload.status}:${detail}`;

        if (isRedundant) {
          eventLog.append("redundant_completion_rejected", {
            shard: shardName,
            sessionId,
            reason,
          });
          redundantWorkers.delete(shardName);
          if (completedWorker) {
            void closeNativeBridgeRegistration(
              completedWorker,
              shardName,
              "failed",
            );
          }
          checkAllShardsCompleted();
          return;
        }

        eventLog.append("worker_reported_non_ok_completion", {
          shard: shardName,
          sessionId,
          status: completionPayload.status,
          reason,
        });
        if (completedWorker) {
          void closeNativeBridgeRegistration(
            completedWorker,
            shardName,
            "failed",
          );
        }
        failures.set(shardName, {
          mode: classifyFailure(reason),
          reason,
          sessionId,
          completionPayload,
        });
        lockManager.release(shardName);

        const redundant = redundantWorkers.get(shardName);
        if (redundant) {
          void redundant.conductor.shutdown("primary_reported_non_ok");
        }

        emitter.emit("shardFailed", {
          shardName,
          failureMode: classifyFailure(reason),
          reason,
        });

        cascadeDependencyFailure(shardName);
        checkAllShardsCompleted();
        return;
      }
    }

    if (isRedundant) {
      // #394: a redundant worker may only "win" (and SIGKILL the still-running
      // primary) once it has produced real, integratable commits. The earlier
      // F7 payload check trusts a self-report; agy/gemini redundant workers are
      // known to signal completion with zero commits (and legacy workers emit
      // no payload at all, bypassing F7). Gate the win on authoritative git
      // evidence collected now — before any kill — so a phantom completion can
      // never kill the worker that is doing the actual work.
      void finalizeRedundantWin(shardName, sessionId, completedWorker);
      return;
    }

    if (completedWorker) {
      void closeNativeBridgeRegistration(
        completedWorker,
        shardName,
        "completed",
      );
    }

    completedShards.add(shardName);

    // Primary completed — kill redundant if exists
    const redundant = redundantWorkers.get(shardName);
    if (redundant) {
      void redundant.conductor.shutdown("primary_completed_first");
    }

    emitter.emit("shardCompleted", { shardName, sessionId, isRedundant });
    checkAllShardsCompleted();
  }

  /**
   * Gate a redundant worker's completion on authoritative git commit evidence
   * before it is allowed to win the shard and SIGKILL the primary (#394).
   *
   * A redundant worker with no commits ahead of the base branch is NOT a valid
   * winner: it is rejected, the primary is left running, and the shard is not
   * marked complete. Only a worker with `commitsAhead > 0` promotes itself and
   * terminates the primary.
   *
   * @param {string} shardName
   * @param {string} sessionId
   * @param {object} redundantWorker — entry fetched before this async hop
   */
  async function finalizeRedundantWin(shardName, sessionId, redundantWorker) {
    const redundant = redundantWorker || redundantWorkers.get(shardName);
    if (!redundant) {
      // The primary already completed/failed and cleared the redundant entry
      // (primary_completed_first / primary_failed_f7). Nothing to promote.
      checkAllShardsCompleted();
      return;
    }

    // A redundant worker may win only while the shard is still undecided. This
    // is checked TWICE — once up front (a cheap early-out before the git
    // round-trip) and again AFTER the async evidence hop. The second check is
    // the load-bearing one: the primary can complete/fail while
    // collectCommitEvidence() is in flight, and without re-checking, a slow git
    // probe would resume and flip an already-decided winner via
    // `workers.set(shardName, redundant)` (#394 TOCTOU race).
    const retireSupersededRedundant = (phase) => {
      eventLog.append("redundant_win_superseded", {
        shard: shardName,
        sessionId,
        phase,
      });
      redundantWorkers.delete(shardName);
      void closeNativeBridgeRegistration(redundant, shardName, "failed");
      checkAllShardsCompleted();
    };

    if (completedShards.has(shardName) || failures.has(shardName)) {
      retireSupersededRedundant("before_evidence");
      return;
    }

    let evidence;
    try {
      evidence = await collectCommitEvidence(redundant, baseBranch);
    } catch (err) {
      evidence = { commitsAhead: 0, dirty: false, error: err.message };
    }

    // Re-check after the await: the primary may have won while we waited.
    if (completedShards.has(shardName) || failures.has(shardName)) {
      retireSupersededRedundant("after_evidence");
      return;
    }

    // A redundant worker may win only with CLEAN, integratable commits — the
    // exact bar integration applies (collectCommitEvidence.ok =
    // commitsAhead > 0 && !dirty). A weaker gate (commits-only) would promote a
    // dirty-but-committed redundant, kill the primary, then fail integration on
    // that same dirty evidence (F6) — losing the shard the primary could have
    // delivered (#394 re-review). Reject anything integration would not accept.
    if (!evidence?.ok) {
      const reason = evidence?.error
        ? "evidence_error"
        : evidence?.dirty
          ? "dirty_worktree"
          : "no_commit";
      eventLog.append("redundant_win_rejected", {
        shard: shardName,
        sessionId,
        reason,
        commitsAhead: evidence?.commitsAhead || 0,
        dirty: Boolean(evidence?.dirty),
        error: evidence?.error || null,
      });
      redundantWorkers.delete(shardName);
      void closeNativeBridgeRegistration(redundant, shardName, "failed");
      // Re-check in case the primary already reached a terminal state while we
      // were collecting evidence.
      checkAllShardsCompleted();
      return;
    }

    // Clean, integratable commit evidence — promote the redundant worker and
    // kill the primary if it is still running.
    const primary = workers.get(shardName);
    workers.set(shardName, redundant);
    redundantWorkers.delete(shardName);
    completedShards.add(shardName);
    void closeNativeBridgeRegistration(redundant, shardName, "completed");
    if (primary && !isTerminal(primary)) {
      eventLog.append("redundant_wins", {
        shard: shardName,
        commitsAhead: evidence.commitsAhead,
      });
      void primary.conductor.shutdown("redundant_completed_first");
    }

    emitter.emit("shardCompleted", {
      shardName,
      sessionId,
      isRedundant: true,
    });
    checkAllShardsCompleted();
  }

  function handleShardFailed(shardName, sessionId, reason, isRedundant) {
    const failureMode = classifyFailure(reason);

    eventLog.append("shard_failed", {
      shard: shardName,
      sessionId,
      reason,
      failureMode,
      isRedundant,
    });

    if (isRedundant) return; // redundant failure is non-critical
    const failedWorker = workers.get(shardName);
    if (failedWorker) {
      void closeNativeBridgeRegistration(failedWorker, shardName, "failed");
    }

    // F2: Rate limit — try fallback agent
    if (failureMode === FAILURE_MODES.F2_RATE_LIMIT) {
      const shard = plan.shards.find((s) => s.name === shardName);
      if (shard) {
        const fallbackAgent = FALLBACK_AGENTS[shard.agent];
        if (fallbackAgent) {
          eventLog.append("fallback_agent", {
            shard: shardName,
            from: shard.agent,
            to: fallbackAgent,
          });
          const fallbackShard = { ...shard, agent: fallbackAgent };
          lockManager.release(shardName);
          void launchShard(fallbackShard);
          return;
        }
      }
    }

    failures.set(shardName, { mode: failureMode, reason, sessionId });
    lockManager.release(shardName);

    emitter.emit("shardFailed", { shardName, failureMode, reason });

    // Cascade failure to dependents so they do not hold integration hostage
    // (BFS over plan.shards). Without this, a dead shard keeps dependents in
    // `pending` forever and integrateResults is never reachable.
    cascadeDependencyFailure(shardName);

    checkAllShardsCompleted();
  }

  function cascadeDependencyFailure(rootFailedShard) {
    const queue = [rootFailedShard];
    const visited = new Set([rootFailedShard]);
    while (queue.length > 0) {
      const failedName = queue.shift();
      for (const candidate of plan.shards) {
        if (visited.has(candidate.name)) continue;
        if (failures.has(candidate.name)) continue;
        if (completedShards.has(candidate.name)) continue;
        if (!candidate.depends?.includes(failedName)) continue;

        visited.add(candidate.name);
        failures.set(candidate.name, {
          mode: FAILURE_MODES.F1_CRASH,
          reason: `dep_failed:${failedName}`,
          sessionId: null,
        });
        lockManager.release(candidate.name);
        eventLog.append("shard_blocked", {
          shard: candidate.name,
          failedDep: failedName,
        });
        emitter.emit("shardFailed", {
          shardName: candidate.name,
          failureMode: FAILURE_MODES.F1_CRASH,
          reason: `dep_failed:${failedName}`,
        });
        queue.push(candidate.name);
      }
    }
  }

  function classifyFailure(reason) {
    if (!reason) return FAILURE_MODES.F1_CRASH;
    const r = String(reason).toLowerCase();
    if (/rate.?limit|cooldown/u.test(r)) return FAILURE_MODES.F2_RATE_LIMIT;
    if (/stall|l1_stall|timeout/u.test(r)) return FAILURE_MODES.F3_STALL;
    if (/lease|violation/u.test(r)) return FAILURE_MODES.F4_LEASE_VIOLATION;
    if (/merge|conflict/u.test(r)) return FAILURE_MODES.F5_MERGE_CONFLICT;
    if (/no.?commit|dirty_worktree/u.test(r)) return FAILURE_MODES.F6_NO_COMMIT;
    return FAILURE_MODES.F1_CRASH;
  }

  function isTerminal(entry) {
    const snap = entry.conductor.getSnapshot();
    return snap.every(
      (s) => s.state === STATES.COMPLETED || s.state === STATES.DEAD,
    );
  }

  // ── Integration ─────────────────────────────────────────────

  function checkAllShardsCompleted() {
    if (state !== SWARM_STATES.RUNNING) return;

    // `completedShards` + `failures` are set synchronously inside
    // handleShardCompleted / handleShardFailed, so they are the authoritative
    // terminal signal. `isTerminal(w)` queries conductor.getSnapshot() which
    // lags because the snapshot state transition is applied asynchronously
    // after the onCompleted callback chain that invoked this check. Using the
    // snapshot here races with its own producer and leaves integrateResults
    // unreachable (2026-04-17 swarm hang — required manual cherry-pick).
    const allDone = plan.mergeOrder.every(
      (name) => completedShards.has(name) || failures.has(name),
    );

    if (allDone) {
      void integrateResults();
    }
  }

  /**
   * Validate a shard's output — check for file lease violations.
   * @param {string} shardName
   * @param {string[]} changedFiles — files the shard actually modified
   * @returns {{ ok: boolean, violations: Array }}
   */
  function validateResult(shardName, changedFiles) {
    // Pass the shard's own lease so validateChanges can flag out-of-lease
    // writes to distribution-critical paths (regression of #115/#34 —
    // recovery patches were carrying `+++ /dev/null` deletions of
    // .claude-plugin/marketplace.json, undetected by lease-only checks).
    const ownLease = plan.leaseMap.get(shardName) || [];
    const violations = lockManager.validateChanges(shardName, changedFiles, {
      ownLease,
    });

    eventLog.append("validate_result", {
      shard: shardName,
      changedFiles,
      violations,
      ok: violations.length === 0,
    });

    return {
      ok: violations.length === 0,
      violations,
    };
  }

  /**
   * Integrate results from all completed shards in merge order.
   * Uses git operations for conflict detection.
   */
  async function integrateResults() {
    setState(SWARM_STATES.INTEGRATING, "all_shards_done");

    const integrated = [];
    const integrationFailures = [];
    const integrationReport = [];
    const preIntegrationFailures = [...failures.keys()];
    let integrationBranch = null;

    const appendIntegrationReport = (row) => {
      const normalized = normalizeIntegrationReportRow(row);
      integrationReport.push(normalized);
      eventLog.append("integration_shard_report", normalized);
      return normalized;
    };

    const failureNotes = (shardName, fallback = "failed") => {
      const info = failures.get(shardName);
      if (!info) return fallback;
      return info.reason || info.mode || fallback;
    };

    try {
      ({ integrationBranch } = await prepareIntegrationBranchImpl({
        runId,
        baseBranch,
        rootDir: workdir,
      }));

      for (const shardName of plan.mergeOrder) {
        if (failures.has(shardName)) {
          const worker = workers.get(shardName);
          if (worker?.cleanupPromise) await worker.cleanupPromise;
          eventLog.append("skip_failed_shard", { shard: shardName });
          appendIntegrationReport({
            shard: shardName,
            strategy: "failed",
            notes: `skipped: ${failureNotes(shardName)}`,
          });
          continue;
        }

        const worker = workers.get(shardName);
        if (!worker) continue;

        // Fetch remote shard branch to local (push-blocked hosts like Ultra4)
        const shard = plan.shards.find((s) => s.name === shardName);
        if (shard?.host && shard._remoteEnv) {
          const hostConfig = getHostConfig(shard.host, workdir);
          const sshUser = hostConfig?.ssh_user || shard.host;
          const remoteRepoPath = resolveRemoteDir(workdir, shard._remoteEnv);
          const fetchResult = await fetchRemoteShard({
            host: shard.host,
            sshUser,
            remoteRepoPath,
            branchName: worker.branchName || `swarm/${runId}/${shardName}`,
            rootDir: workdir,
          });

          if (!fetchResult.ok) {
            eventLog.append("remote_fetch_failed", {
              shard: shardName,
              error: fetchResult.error,
            });
            const cleanup = await maybeCleanupWorktree(
              shardName,
              worker,
              shard,
              {
                force: true,
                failureReason: "remote_fetch_failed",
              },
            );
            integrationFailures.push(shardName);
            appendIntegrationReport({
              shard: shardName,
              strategy: "failed",
              notes: `remote_fetch_failed: ${fetchResult.error || "unknown"}`,
              recoveryPatch: cleanup?.recoveryPatch?.patchPath || null,
            });
            continue;
          }
          eventLog.append("remote_fetch_ok", {
            shard: shardName,
            headCommit: fetchResult.headCommit,
          });
        }

        // Read shard output log for changed files
        const commitEvidence = await collectCommitEvidence(
          worker,
          integrationBranch,
        );
        worker.commitEvidence = commitEvidence;
        eventLog.append("commit_evidence", {
          shard: shardName,
          ...commitEvidence,
        });

        const expectsCommitEvidence =
          Array.isArray(shard?.files) && shard.files.length > 0;
        if (expectsCommitEvidence && !commitEvidence.ok) {
          failures.set(shardName, {
            mode: FAILURE_MODES.F6_NO_COMMIT,
            reason: commitEvidence.error
              ? `no_commit_evidence:${commitEvidence.error}`
              : commitEvidence.dirty
                ? "dirty_worktree_without_commit"
                : "no_commit_evidence",
            commitEvidence,
          });
          eventLog.append("no_commit_guard_failed", {
            shard: shardName,
            ...commitEvidence,
          });
          const cleanup = await maybeCleanupWorktree(shardName, worker, shard, {
            force: true,
            failureReason:
              failures.get(shardName)?.mode || "no_commit_evidence",
          });
          integrationFailures.push(shardName);
          appendIntegrationReport({
            shard: shardName,
            strategy: "failed",
            commits: commitEvidence.commitsAhead,
            finalSha: commitEvidence.headCommit,
            notes: failureNotes(shardName, "no_commit_evidence"),
            recoveryPatch: cleanup?.recoveryPatch?.patchPath || null,
          });
          continue;
        }

        // Read shard output log for changed files
        const changedFiles = detectChangedFiles(shardName, worker);

        // Validate against lease map
        const validation = validateResult(shardName, changedFiles);
        if (!validation.ok) {
          failures.set(shardName, {
            mode: FAILURE_MODES.F4_LEASE_VIOLATION,
            violations: validation.violations,
          });
          eventLog.append("lease_violation_revert", {
            shard: shardName,
            violations: validation.violations,
          });
          const cleanup = await maybeCleanupWorktree(shardName, worker, shard, {
            force: true,
            failureReason:
              failures.get(shardName)?.mode || "lease_violation_revert",
          });
          integrationFailures.push(shardName);
          appendIntegrationReport({
            shard: shardName,
            strategy: "failed",
            notes: failureNotes(shardName, "lease_violation_revert"),
            recoveryPatch: cleanup?.recoveryPatch?.patchPath || null,
          });
          continue;
        }

        const shardBranch = worker.branchName || `swarm/${runId}/${shardName}`;
        const rebaseResult = await rebaseShardOntoIntegrationImpl({
          shardBranch,
          integrationBranch,
          rootDir: workdir,
        });
        if (!rebaseResult.ok) {
          eventLog.append("integration_rebase_failed", {
            shard: shardName,
            shardBranch,
            integrationBranch,
            error: rebaseResult.error,
          });
          const cleanup = await maybeCleanupWorktree(shardName, worker, shard, {
            force: true,
            failureReason:
              rebaseResult.error || FAILURE_MODES.F5_MERGE_CONFLICT,
          });
          integrationFailures.push(shardName);
          appendIntegrationReport({
            shard: shardName,
            strategy: "failed",
            commits: rebaseResult.commits ?? commitEvidence.commitsAhead,
            notes: rebaseResult.error || FAILURE_MODES.F5_MERGE_CONFLICT,
            recoveryPatch: cleanup?.recoveryPatch?.patchPath || null,
          });
          continue;
        }

        results.set(shardName, {
          shard: shardName,
          changedFiles,
          branchName: shardBranch,
          worktreePath: worker.worktreePath || null,
          integrationBranch,
          headCommit: rebaseResult.headCommit,
          integrationStrategy: rebaseResult.strategy || "cherry-pick",
          commits: rebaseResult.commits ?? commitEvidence.commitsAhead,
          notes: rebaseResult.notes || "",
          completedAt: Date.now(),
        });
        integrated.push(shardName);
        appendIntegrationReport({
          shard: shardName,
          strategy: rebaseResult.strategy || "cherry-pick",
          commits: rebaseResult.commits ?? commitEvidence.commitsAhead,
          finalSha: rebaseResult.headCommit,
          notes: rebaseResult.notes || "",
        });

        await maybeCleanupWorktree(shardName, worker, shard, {
          branchName: shardBranch,
        });
      }
    } catch (err) {
      const unresolved = plan.mergeOrder.filter(
        (name) =>
          !integrated.includes(name) &&
          !preIntegrationFailures.includes(name) &&
          !integrationFailures.includes(name),
      );
      const failed = [
        ...new Set([
          ...preIntegrationFailures,
          ...integrationFailures,
          ...unresolved,
        ]),
      ];
      const skipped = preIntegrationFailures.filter(
        (name) => !integrationFailures.includes(name),
      );
      const reported = new Set(integrationReport.map((row) => row.shard));
      for (const shardName of failed) {
        if (reported.has(shardName)) continue;
        appendIntegrationReport({
          shard: shardName,
          strategy: "failed",
          notes: `integration_error: ${err.message}`,
        });
      }

      eventLog.append("integration_complete", {
        integrated,
        failed,
        integrationFailures,
        integrationBranch,
        skipped,
        report: integrationReport,
        error: err.message,
      });

      setState(SWARM_STATES.FAILED, "integration_error");
      const payload = settleIntegrationPromise({
        integrated,
        failed,
        integrationFailures,
        integrationBranch,
        skipped,
        report: integrationReport,
        results: [...results.values()],
        partial: true,
        error: err.message,
      });
      emitter.emit("integrationComplete", payload);
      return payload;
    }

    const skipped = preIntegrationFailures.filter(
      (name) => !integrationFailures.includes(name),
    );
    const failed = [...new Set([...skipped, ...integrationFailures])];

    eventLog.append("integration_complete", {
      integrated,
      failed,
      integrationFailures,
      integrationBranch,
      skipped,
      report: integrationReport,
    });

    if (failed.length > 0 && integrated.length === 0) {
      setState(SWARM_STATES.FAILED, "all_shards_failed_integration");
    } else {
      setState(
        SWARM_STATES.COMPLETED,
        `${integrated.length}/${plan.shards.length} integrated`,
      );
    }

    const payload = settleIntegrationPromise({
      integrated,
      failed,
      integrationFailures,
      integrationBranch,
      skipped,
      report: integrationReport,
      results: [...results.values()],
      partial: failed.length > 0,
    });
    emitter.emit("integrationComplete", payload);
    return payload;
  }

  async function maybeCleanupWorktree(
    shardName,
    worker,
    shard,
    {
      branchName = worker?.branchName,
      force = false,
      failureReason = null,
    } = {},
  ) {
    const outcome = { recoveryPatch: null, processCleanup: null };
    if (!worker?.worktreePath || shard?.host) return outcome;
    if (failureReason && keepFailedWorktrees) return outcome;
    if (cleanedWorktreePaths.has(worker.worktreePath)) return outcome;

    await closeNativeBridgeRegistration(
      worker,
      shardName,
      "before_worktree_cleanup",
    );

    // Best-effort: preserve any uncommitted worker changes before removing the
    // worktree, on BOTH the failure and success teardown paths (#394). A worker
    // can exit 0 yet leave dirty, uncommitted work (the hub-observability case:
    // exit 0, commits_made []), and the success cleanup carries no
    // failureReason — without this it would silently delete that work.
    // preserveWorktreePatchImpl self-skips when the worktree is clean, so a
    // properly-committed shard saves nothing here.
    try {
      const preservation = await preserveWorktreePatchImpl({
        worktreePath: worker.worktreePath,
        shardId: shardName,
        recoveryDir: join(workdir, ".codex-swarm", "recovery"),
      });
      if (preservation?.ok && !preservation.skipped) {
        outcome.recoveryPatch = {
          patchPath: preservation.patchPath,
          manifestPath: preservation.manifestPath || null,
        };
        eventLog.append("recovery_patch_saved", {
          shard: shardName,
          worktreePath: worker.worktreePath,
          patchPath: preservation.patchPath,
          reason: failureReason || "dirty_on_cleanup",
        });
      }
    } catch {
      /* silent: preservation failures must not block cleanup */
    }

    try {
      const snapshot = worker.conductor?.getSnapshot?.();
      const processCleanup = await cleanupShardProcessesImpl({
        worktreePath: worker.worktreePath,
        sessionIds: [worker.sessionId || worker.sessionConfig?.id].filter(
          Boolean,
        ),
        topPids: snapshot?.topPids ?? [],
        runId: plan?.runId || runId,
        shardName,
      });
      outcome.processCleanup = processCleanup;
      worker.processCleanup = processCleanup;
      recordProcessCleanup(processCleanup);
      eventLog.append("process_cleanup", {
        shard: shardName,
        worktreePath: worker.worktreePath,
        killed: processCleanup?.killed ?? 0,
        byCategory: processCleanup?.byCategory || {},
      });
    } catch (err) {
      eventLog.append("process_cleanup_failed", {
        shard: shardName,
        worktreePath: worker.worktreePath,
        error: err.message,
      });
    }

    try {
      await cleanupWorktreeImpl({
        worktreePath: worker.worktreePath,
        branchName,
        rootDir: workdir,
        force,
      });
      cleanedWorktreePaths.add(worker.worktreePath);
      if (failureReason) {
        eventLog.append("worktree_auto_cleanup", {
          shard: shardName,
          worktreePath: worker.worktreePath,
          reason: failureReason,
        });
      }
    } catch (err) {
      eventLog.append("worktree_cleanup_failed", {
        shard: shardName,
        worktreePath: worker.worktreePath,
        reason: failureReason || null,
        error: err.message,
      });
    }

    return outcome;
  }

  /**
   * Detect which files a shard modified by reading its output logs.
   * Falls back to an empty list if detection fails.
   * @param {string} shardName
   * @param {object} worker
   * @returns {string[]}
   */
  function detectChangedFiles(shardName, worker) {
    // Best-effort: parse output log for file paths
    const _outPath = join(logsDir, shardName);
    try {
      const snap = worker.conductor.getSnapshot();
      for (const session of snap) {
        if (session.outPath && existsSync(session.outPath)) {
          const output = readFileSync(session.outPath, "utf8");
          return extractFilePathsFromOutput(
            output,
            plan.leaseMap.get(shardName) || [],
          );
        }
      }
    } catch {
      /* best-effort */
    }

    // Fallback: trust the lease map (shard was allowed these files)
    return plan.leaseMap.get(shardName) || [];
  }

  /**
   * Extract modified file paths from worker output text.
   * Looks for common patterns: "wrote file.mjs", "modified file.mjs", diff headers.
   * @param {string} output
   * @param {string[]} allowedFiles — lease map files to match against
   * @returns {string[]}
   */
  function extractFilePathsFromOutput(output, allowedFiles) {
    if (!output) return allowedFiles;

    const found = new Set();
    const lines = output.split(/\r?\n/);

    for (const line of lines) {
      // Match common patterns
      const patterns = [
        /(?:wrote|created|modified|updated|edited)\s+['"]?([^\s'"]+\.\w+)/i,
        /^[+-]{3}\s+[ab]\/(.+)/, // diff headers
        /^diff --git a\/(.+)\s+b\//, // git diff headers
      ];

      for (const re of patterns) {
        const match = line.match(re);
        if (match) found.add(match[1]);
      }
    }

    // Intersect with allowed files if we found anything
    if (found.size > 0) {
      return [...found].filter((f) =>
        allowedFiles.some((a) => f.endsWith(a) || a.endsWith(f) || f === a),
      );
    }

    return allowedFiles;
  }

  // ── Status monitor ──────────────────────────────────────────

  /**
   * Get current swarm status snapshot.
   * @returns {SwarmStatus}
   */
  function getStatus() {
    const workerStatuses = [];

    for (const [name, w] of workers) {
      const snap = w.conductor.getSnapshot();
      const authoritative = computeAuthoritativeStatus(name, w, snap);
      workerStatuses.push({
        shard: name,
        agent: w.shardConfig.agent,
        sessions: snap,
        failed: failures.has(name),
        failureInfo: failures.get(name) || null,
        integrated: results.has(name),
        authoritativeStatus: authoritative.status,
        authoritativeReason: authoritative.reason,
        commitEvidence: w.commitEvidence || null,
      });
    }

    return Object.freeze({
      state,
      totalShards: plan?.shards.length || 0,
      completedShards: completedShards.size,
      failedShards: failures.size,
      workers: workerStatuses,
      mergeOrder: plan?.mergeOrder || [],
      criticalShards: plan?.criticalShards || [],
      locks: lockManager?.snapshot() || [],
      integrationPromise: Object.freeze({
        state: integrationPromiseState.state,
        startedAt: integrationPromiseState.startedAt,
        settledAt: integrationPromiseState.settledAt,
        partial: integrationPromiseState.partial,
        integrated: [...integrationPromiseState.integrated],
        failed: [...integrationPromiseState.failed],
        integrationFailures: [...integrationPromiseState.integrationFailures],
        skipped: [...integrationPromiseState.skipped],
        integrationBranch: integrationPromiseState.integrationBranch,
        report: integrationPromiseState.report.map((row) => ({ ...row })),
        processCleanup: Object.freeze({
          totalKilled: integrationPromiseState.processCleanup.totalKilled,
          byCategory: Object.freeze({
            ...integrationPromiseState.processCleanup.byCategory,
          }),
        }),
        error: integrationPromiseState.error,
      }),
    });
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Launch the swarm from a pre-built plan.
   * @param {SwarmPlan} swarmPlan — from planSwarm()
   * @returns {Promise<SwarmStatus>}
   */
  /** Hub keepalive — Hub crash recovery (idle timeout은 기본 비활성이므로 crash 복구 용도) */
  let hubKeepaliveTimer = null;
  let lockRenewTimer = null;
  function startHubKeepalive() {
    // 5분마다 Hub /status 핑 — crash 감지 시 ensureHubAlive로 재시작
    hubKeepaliveTimer = setInterval(
      async () => {
        try {
          const hub = getHubInfoImpl ? await getHubInfoImpl() : null;
          const statusUrl = resolveHubStatusUrl(hub);
          if (!statusUrl) {
            if (ensureHubAliveImpl) {
              eventLog.append("hub_keepalive_restart", {
                reason: "hub_url_unresolved",
              });
              await ensureHubAliveImpl();
            }
            return;
          }

          const resp = await fetch(statusUrl, {
            signal: AbortSignal.timeout(5000),
          });
          if (!resp.ok && ensureHubAliveImpl) {
            eventLog.append("hub_keepalive_restart", {});
            await ensureHubAliveImpl();
          }
        } catch {
          // Hub 다운 — 재시작 시도
          if (ensureHubAliveImpl) {
            eventLog.append("hub_keepalive_restart", {
              reason: "fetch_failed",
            });
            try {
              await ensureHubAliveImpl();
            } catch {
              eventLog.append("hub_restart_failed", {});
            }
          }
        }
      },
      5 * 60 * 1000,
    );
  }

  function stopHubKeepalive() {
    if (hubKeepaliveTimer) {
      clearInterval(hubKeepaliveTimer);
      hubKeepaliveTimer = null;
    }
  }

  function startLockRenewal() {
    lockRenewTimer = setInterval(() => {
      if (!lockManager) return;
      for (const shardName of workers.keys()) {
        if (!completedShards.has(shardName) && !failures.has(shardName))
          lockManager.renew(shardName);
      }
    }, DEFAULT_SWARM_LOCK_TTL_MS / 2);
    lockRenewTimer.unref?.();
  }

  function stopLockRenewal() {
    if (lockRenewTimer) clearInterval(lockRenewTimer);
    lockRenewTimer = null;
  }

  async function launch(swarmPlan) {
    if (state !== SWARM_STATES.PLANNING) {
      throw new Error(`Cannot launch in state "${state}"`);
    }

    plan = swarmPlan;
    markIntegrationPromisePending();

    // Phase 1 dynamic routing wire-up (opt-in env TRIFLUX_DYNAMIC_ROUTING).
    // launch() 는 plan-time, 이미 async 라 D-1 facade 의 await routeRequest 를
    // 그대로 사용한다 (conductor.spawnSession 의 sync invariant 충돌 없음).
    // team_size = plan.shards.length 매핑 → S5 leaseMany 시나리오 자연 매핑.
    // decision.shards[i].cli 가 plan.shards[i].agent 와 다르면 1:1 override.
    if (
      isDynamicRoutingEnabled(process.env) &&
      Array.isArray(plan?.shards) &&
      plan.shards.length > 0
    ) {
      try {
        const router = createDynamicRouter();
        const decision = await router.routeRequest({
          task_id: runId,
          team_size: plan.shards.length,
          agent_hint: plan.shards[0]?.agent || "codex",
        });
        eventLog.append("dynamic_route_plan_decision", {
          decisionId: decision.decisionId ?? null,
          scenario: decision.scenario ?? "unknown",
          lane: decision.lane ?? null,
          mode: decision.mode ?? null,
          shardCount: decision.shards?.length ?? 0,
          planShardCount: plan.shards.length,
          snapshotAgeMs: decision.snapshotAgeMs ?? null,
        });
        const overrides = [];
        const decShards = Array.isArray(decision.shards) ? decision.shards : [];
        for (let i = 0; i < plan.shards.length; i++) {
          const shard = plan.shards[i];
          const decShard = decShards[i];
          if (decShard?.cli && decShard.cli !== shard.agent) {
            overrides.push({
              shard: shard.name,
              original: shard.agent,
              override: decShard.cli,
              accountId: decShard.accountId ?? null,
            });
            shard.agent = decShard.cli;
          }
        }
        if (overrides.length > 0) {
          eventLog.append("dynamic_route_plan_overrides", {
            decisionId: decision.decisionId ?? null,
            count: overrides.length,
            overrides,
          });
        }
      } catch (err) {
        eventLog.append("dynamic_route_plan_error", {
          error: err?.message || String(err),
        });
      }
    }

    // Hub alive 확인 — 죽어있으면 재시작
    if (ensureHubAliveImpl) {
      ensureHubAliveImpl()
        .then((hub) => {
          eventLog.append("hub_ensured", { port: hub?.port });
        })
        .catch((err) => {
          eventLog.append("hub_ensure_failed", { error: err.message });
          emitter.emit("warning", {
            type: "hub_unavailable",
            error: err.message,
          });
        });
    }

    // Warn about file conflicts but don't block
    if (plan.conflicts.length > 0) {
      eventLog.append("file_conflicts_warning", { conflicts: plan.conflicts });
      emitter.emit("warning", {
        type: "file_conflicts",
        conflicts: plan.conflicts,
      });
    }

    // Initialize lock manager
    lockManager = createSwarmLocks({
      repoRoot: workdir,
      persistPath: join(workdir, ".triflux", "swarm-locks.json"),
    });

    startLockRenewal();
    // Hub keepalive 시작
    startHubKeepalive();

    setState(SWARM_STATES.LAUNCHING, `${plan.shards.length} shards`);

    // Launch shards respecting dependency order
    const launched = new Set();
    const pending = new Set(plan.mergeOrder);

    async function launchReady() {
      for (const name of pending) {
        const shard = plan.shards.find((s) => s.name === name);
        if (!shard) continue;

        // Check all dependencies are completed (not just launched)
        const depsReady = shard.depends.every((d) => completedShards.has(d));
        if (!depsReady) continue;

        pending.delete(name);
        launched.add(name);
        await launchShard(shard);

        // Launch redundant worker only when explicitly requested.
        const redundantAgent = resolveRedundantAgent(shard);
        if (redundantAgent) {
          const redundantShard = {
            ...shard,
            agent: redundantAgent,
          };
          await launchShard(redundantShard, true);
        }
      }
    }

    await launchReady();

    // Re-check pending on each shard completion (dependency chains)
    emitter.on("shardCompleted", () => {
      if (pending.size > 0) void launchReady();
    });

    setState(
      SWARM_STATES.RUNNING,
      `${launched.size} launched, ${pending.size} pending deps`,
    );

    return { ...getStatus(), done: integrationPromise };
  }

  /**
   * Graceful shutdown — kill all workers and release locks.
   * @param {string} [reason]
   */
  async function shutdown(reason = "shutdown") {
    stopHubKeepalive();
    stopLockRenewal();
    eventLog.append("swarm_shutdown", { reason, state });

    const shutdowns = [];
    for (const [, w] of workers) {
      shutdowns.push(w.conductor.shutdown(reason));
      shutdowns.push(
        closeNativeBridgeRegistration(w, w.shardConfig?.name, reason),
      );
    }
    for (const [, w] of redundantWorkers) {
      shutdowns.push(w.conductor.shutdown(reason));
      shutdowns.push(
        closeNativeBridgeRegistration(w, w.shardConfig?.name, reason),
      );
    }

    await Promise.allSettled(shutdowns);

    if (!keepFailedWorktrees) {
      const cleanupCandidates = new Map();
      for (const [shardName, worker] of workers) {
        cleanupCandidates.set(shardName, worker);
      }
      for (const [shardName, worker] of redundantWorkers) {
        cleanupCandidates.set(`${shardName}:redundant`, worker);
      }

      for (const [candidateName, worker] of cleanupCandidates) {
        const shardName = worker?.shardConfig?.name || candidateName;
        const failureInfo = failures.get(shardName);
        const shard =
          worker?.shardConfig ||
          plan?.shards.find((item) => item.name === shardName);
        if (!worker?.worktreePath) continue;
        await maybeCleanupWorktree(shardName, worker, shard, {
          force: true,
          failureReason: failureInfo?.mode || failureInfo?.reason || reason,
        });
      }
    }

    sharedRegistry.clear();
    lockManager?.releaseAll();
    await eventLog.flush();
    await eventLog.close();

    if (state !== SWARM_STATES.COMPLETED && state !== SWARM_STATES.FAILED) {
      setState(SWARM_STATES.FAILED, reason);
    }

    emitter.emit("shutdown", { reason });
  }

  return Object.freeze({
    launch,
    shutdown,
    getStatus,
    integrationComplete() {
      return integrationPromise;
    },
    getMeshRegistry() {
      return sharedRegistry;
    },
    validateResult,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    get state() {
      return state;
    },
    get plan() {
      return plan;
    },
    get eventLogPath() {
      return eventLog.filePath;
    },
  });
}
