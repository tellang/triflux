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
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getHostConfig } from "../lib/ssh-command.mjs";
import { createConductor, STATES } from "./conductor.mjs";
import { ensureConductorRegistry } from "./conductor-registry.mjs";
import { createEventLog } from "./event-log.mjs";
import { probeRemoteEnv, resolveRemoteDir } from "./remote-session.mjs";
import { createSwarmLocks } from "./swarm-locks.mjs";
import {
  ensureWorktree,
  fetchRemoteShard,
  prepareIntegrationBranch,
  pruneWorktree,
  rebaseShardOntoIntegration,
} from "./worktree-lifecycle.mjs";

let ensureHubAliveFn = null;
try {
  ({ ensureHubAlive: ensureHubAliveFn } = await import(
    "./cli/services/hub-client.mjs"
  ));
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
});

const FALLBACK_AGENTS = Object.freeze({
  codex: "gemini",
  gemini: "codex",
  claude: "codex",
});

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

/**
 * Create a swarm hypervisor.
 * @param {object} opts
 * @param {string} opts.workdir — repository root / working directory
 * @param {string} opts.logsDir — base directory for all logs
 * @param {string} [opts.baseBranch='main'] — base branch for shard worktrees
 * @param {string} [opts.runId=`swarm-${Date.now()}`] — logical swarm run id
 * @param {number} [opts.maxRestarts=2] — per-shard max restarts
 * @param {number} [opts.graceMs=10000] — conductor shutdown grace period
 * @param {number} [opts.integrationTimeoutMs=60000] — max time for integration phase
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
    graceMs = 10_000,
    _integrationTimeoutMs = 60_000,
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
  const cleanupWorktreeImpl = _deps.cleanupWorktree || pruneWorktree;
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

    integrationResult = Object.freeze({
      integrated: Object.freeze([...(payload.integrated || [])]),
      failed: Object.freeze([...(payload.failed || [])]),
      integrationFailures: Object.freeze([
        ...(payload.integrationFailures || []),
      ]),
      skipped: Object.freeze([...(payload.skipped || [])]),
      integrationBranch: payload.integrationBranch || null,
      results: Object.freeze([...(payload.results || [])]),
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
      error: integrationResult.error,
    };

    resolveIntegrationPromise?.(integrationResult);
    return integrationResult;
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
          await git([
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
      evidence.headCommit = await git(["rev-parse", branchName]);
    } catch {
      /* best-effort */
    }

    if (worker?.worktreePath && !worker?.shardConfig?.host) {
      try {
        const rawStatus = await git(["status", "--short"], worker.worktreePath);
        evidence.dirtyFiles = rawStatus
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => line.slice(2).trim())
          .filter(Boolean);
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

  function buildSessionConfig(shard) {
    const config = {
      id: `swarm-${shard.name}-${Date.now()}`,
      agent: shard.agent,
      prompt: shard.prompt,
      workdir: shard.worktreePath || workdir,
      mcpServers: shard.mcp,
      worktreePath: shard.worktreePath || null,
      branchName: shard.branchName || null,
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
        onCompleted: (sessionId) =>
          handleShardCompleted(shard.name, sessionId, isRedundant),
      });

      const sessionConfig = buildSessionConfig(shard);
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

      const entry = {
        conductor,
        shardConfig: shard,
        sessionConfig,
        startedAt: Date.now(),
        worktreePath: sessionConfig.worktreePath,
        branchName: sessionConfig.branchName,
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
        try {
          await cleanupWorktreeImpl({
            worktreePath: shard.worktreePath,
            branchName: shard.branchName,
            rootDir: workdir,
            force: true,
          });
        } catch {
          /* best-effort */
        }
      }
      return null;
    }
  }

  // ── Completion handling ─────────────────────────────────────

  function handleShardCompleted(shardName, sessionId, isRedundant) {
    eventLog.append("shard_completed", {
      shard: shardName,
      sessionId,
      isRedundant,
    });

    completedShards.add(shardName);

    if (isRedundant) {
      // Redundant worker completed first — kill primary if still running
      const primary = workers.get(shardName);
      const redundant = redundantWorkers.get(shardName);
      if (redundant) {
        workers.set(shardName, redundant);
        redundantWorkers.delete(shardName);
      }
      if (primary && !isTerminal(primary)) {
        eventLog.append("redundant_wins", { shard: shardName });
        void primary.conductor.shutdown("redundant_completed_first");
      }
    } else {
      // Primary completed — kill redundant if exists
      const redundant = redundantWorkers.get(shardName);
      if (redundant) {
        void redundant.conductor.shutdown("primary_completed_first");
      }
    }

    emitter.emit("shardCompleted", { shardName, sessionId, isRedundant });
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
    checkAllShardsCompleted();
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

    const allDone = plan.mergeOrder.every((name) => {
      const w = workers.get(name);
      return (w && isTerminal(w)) || failures.has(name);
    });

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
    const violations = lockManager.validateChanges(shardName, changedFiles);

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
    const preIntegrationFailures = [...failures.keys()];
    let integrationBranch = null;

    try {
      ({ integrationBranch } = await prepareIntegrationBranchImpl({
        runId,
        baseBranch,
        rootDir: workdir,
      }));

      for (const shardName of plan.mergeOrder) {
        if (failures.has(shardName)) {
          eventLog.append("skip_failed_shard", { shard: shardName });
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
            await maybeCleanupWorktree(shardName, worker, shard);
            integrationFailures.push(shardName);
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
          await maybeCleanupWorktree(shardName, worker, shard);
          integrationFailures.push(shardName);
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
          await maybeCleanupWorktree(shardName, worker, shard);
          integrationFailures.push(shardName);
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
          await maybeCleanupWorktree(shardName, worker, shard);
          integrationFailures.push(shardName);
          continue;
        }

        results.set(shardName, {
          shard: shardName,
          changedFiles,
          branchName: shardBranch,
          worktreePath: worker.worktreePath || null,
          integrationBranch,
          headCommit: rebaseResult.headCommit,
          completedAt: Date.now(),
        });
        integrated.push(shardName);

        await maybeCleanupWorktree(shardName, worker, shard, shardBranch);
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

      eventLog.append("integration_complete", {
        integrated,
        failed,
        integrationFailures,
        integrationBranch,
        skipped,
        error: err.message,
      });

      setState(SWARM_STATES.FAILED, "integration_error");
      const payload = settleIntegrationPromise({
        integrated,
        failed,
        integrationFailures,
        integrationBranch,
        skipped,
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
    branchName = worker?.branchName,
  ) {
    if (!worker?.worktreePath || shard?.host) return;
    try {
      await cleanupWorktreeImpl({
        worktreePath: worker.worktreePath,
        branchName,
        rootDir: workdir,
      });
    } catch (err) {
      eventLog.append("worktree_cleanup_failed", {
        shard: shardName,
        worktreePath: worker.worktreePath,
        error: err.message,
      });
    }
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
  /** Hub keepalive — 스웜 실행 중 Hub idle timeout 방지 */
  let hubKeepaliveTimer = null;
  function startHubKeepalive() {
    // 5분마다 Hub /status 핑 (idle timeout 기본 10분)
    hubKeepaliveTimer = setInterval(
      async () => {
        try {
          const resp = await fetch("http://127.0.0.1:27888/status");
          if (!resp.ok && ensureHubAliveFn) {
            eventLog.append("hub_keepalive_restart", {});
            await ensureHubAliveFn();
          }
        } catch {
          // Hub 다운 — 재시작 시도
          if (ensureHubAliveFn) {
            eventLog.append("hub_keepalive_restart", {
              reason: "fetch_failed",
            });
            try {
              await ensureHubAliveFn();
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

  async function launch(swarmPlan) {
    if (state !== SWARM_STATES.PLANNING) {
      throw new Error(`Cannot launch in state "${state}"`);
    }

    plan = swarmPlan;
    markIntegrationPromisePending();

    // Hub alive 확인 — 죽어있으면 재시작
    if (ensureHubAliveFn) {
      ensureHubAliveFn()
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

        // Launch redundant worker for critical shards
        if (shard.critical) {
          const redundantShard = {
            ...shard,
            agent: FALLBACK_AGENTS[shard.agent] || shard.agent,
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
    eventLog.append("swarm_shutdown", { reason, state });

    const shutdowns = [];
    for (const [, w] of workers) {
      shutdowns.push(w.conductor.shutdown(reason));
    }
    for (const [, w] of redundantWorkers) {
      shutdowns.push(w.conductor.shutdown(reason));
    }

    await Promise.allSettled(shutdowns);

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
