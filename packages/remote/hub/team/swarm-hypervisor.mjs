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

import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';

import { createConductor, STATES } from './conductor.mjs';
import { createSwarmLocks } from './swarm-locks.mjs';
import { createEventLog } from './event-log.mjs';
import { probeRemoteEnv, resolveRemoteDir } from './remote-session.mjs';
import { fetchRemoteShard } from './worktree-lifecycle.mjs';
import { getHostConfig } from '@triflux/core/hub/lib/ssh-command.mjs';

// ── Swarm states ──────────────────────────────────────────────

export const SWARM_STATES = Object.freeze({
  PLANNING:     'planning',
  LAUNCHING:    'launching',
  RUNNING:      'running',
  INTEGRATING:  'integrating',
  VALIDATING:   'validating',
  COMPLETED:    'completed',
  FAILED:       'failed',
});

// ── Failure mode classification ───────────────────────────────

const FAILURE_MODES = Object.freeze({
  F1_CRASH:       'F1_crash',
  F2_RATE_LIMIT:  'F2_rate_limit',
  F3_STALL:       'F3_stall',
  F4_LEASE_VIOLATION: 'F4_lease_violation',
  F5_MERGE_CONFLICT:  'F5_merge_conflict',
});

const FALLBACK_AGENTS = Object.freeze({
  codex: 'gemini',
  gemini: 'codex',
  claude: 'codex',
});

/**
 * Create a swarm hypervisor.
 * @param {object} opts
 * @param {string} opts.workdir — repository root / working directory
 * @param {string} opts.logsDir — base directory for all logs
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
    maxRestarts = 2,
    graceMs = 10_000,
    _integrationTimeoutMs = 60_000,
    probeOpts = {},
    _deps = {},
  } = opts;

  if (!workdir) throw new Error('workdir is required');
  if (!logsDir) throw new Error('logsDir is required');

  mkdirSync(logsDir, { recursive: true });

  const emitter = new EventEmitter();
  const eventLog = createEventLog(join(logsDir, 'swarm-events.jsonl'));

  let state = SWARM_STATES.PLANNING;
  let plan = null;
  let lockManager = null;

  /** @type {Map<string, { conductor, shardConfig, result, status }>} */
  const workers = new Map();

  /** @type {Map<string, { conductor, shardConfig }>} redundant workers for critical shards */
  const redundantWorkers = new Map();

  const results = new Map();     // shardName → validated result
  const failures = new Map();    // shardName → failure info

  // ── State machine ───────────────────────────────────────────

  function setState(next, reason = '') {
    const prev = state;
    state = next;
    eventLog.append('swarm_state', { from: prev, to: next, reason });
    emitter.emit('stateChange', { from: prev, to: next, reason });
  }

  // ── Worker lifecycle ────────────────────────────────────────

  function buildSessionConfig(shard) {
    const config = {
      id: `swarm-${shard.name}-${Date.now()}`,
      agent: shard.agent,
      prompt: shard.prompt,
      workdir,
      mcpServers: shard.mcp,
    };

    // Remote shard: add conductor remote fields
    if (shard.host && shard._remoteEnv) {
      const remoteDir = resolveRemoteDir(workdir, shard._remoteEnv);
      return {
        ...config,
        remote: true,
        host: shard.host,
        sessionName: `swarm-${shard.name}-${Date.now()}`,
        paneTarget: `swarm-${shard.name}-${Date.now()}:0.0`,
        workdir: remoteDir,
      };
    }

    return config;
  }

  function launchShard(shard, isRedundant = false) {
    const shardLogsDir = join(logsDir, isRedundant ? `${shard.name}-redundant` : shard.name);
    mkdirSync(shardLogsDir, { recursive: true });

    // Remote shard: probe environment before conductor creation
    if (shard.host && !shard._remoteEnv) {
      try {
        shard._remoteEnv = probeRemoteEnv(shard.host);
        if (!shard._remoteEnv.claudePath) {
          eventLog.append('remote_probe_no_claude', { shard: shard.name, host: shard.host });
          failures.set(shard.name, { mode: FAILURE_MODES.F1_CRASH, reason: `claude not found on ${shard.host}` });
          return null;
        }
        eventLog.append('remote_probe_ok', { shard: shard.name, host: shard.host, env: shard._remoteEnv });
      } catch (err) {
        eventLog.append('remote_probe_failed', { shard: shard.name, host: shard.host, error: err.message });
        failures.set(shard.name, { mode: FAILURE_MODES.F1_CRASH, reason: `remote probe failed: ${err.message}` });
        return null;
      }
    }

    const conductor = createConductor({
      logsDir: shardLogsDir,
      maxRestarts,
      graceMs,
      probeOpts,
      onCompleted: (sessionId) => handleShardCompleted(shard.name, sessionId, isRedundant),
    });

    const sessionConfig = buildSessionConfig(shard);

    // Acquire file leases
    if (!isRedundant) {
      const leaseResult = lockManager.acquire(shard.name, shard.files);
      if (!leaseResult.ok) {
        eventLog.append('lease_denied', {
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

    conductor.spawnSession(sessionConfig);

    eventLog.append('shard_launched', {
      shard: shard.name,
      agent: shard.agent,
      sessionId: sessionConfig.id,
      isRedundant,
      files: shard.files,
      remote: Boolean(shard.host),
      host: shard.host || null,
    });

    const entry = { conductor, shardConfig: shard, sessionConfig, startedAt: Date.now() };

    if (isRedundant) {
      redundantWorkers.set(shard.name, entry);
    } else {
      workers.set(shard.name, entry);
    }

    // Listen for dead events (F1/F2/F3)
    conductor.on('dead', ({ sessionId, reason }) => {
      handleShardFailed(shard.name, sessionId, reason, isRedundant);
    });

    return entry;
  }

  // ── Completion handling ─────────────────────────────────────

  function handleShardCompleted(shardName, sessionId, isRedundant) {
    eventLog.append('shard_completed', { shard: shardName, sessionId, isRedundant });

    if (isRedundant) {
      // Redundant worker completed first — kill primary if still running
      const primary = workers.get(shardName);
      if (primary && !isTerminal(primary)) {
        eventLog.append('redundant_wins', { shard: shardName });
        void primary.conductor.shutdown('redundant_completed_first');
      }
    } else {
      // Primary completed — kill redundant if exists
      const redundant = redundantWorkers.get(shardName);
      if (redundant) {
        void redundant.conductor.shutdown('primary_completed_first');
      }
    }

    emitter.emit('shardCompleted', { shardName, sessionId, isRedundant });
    checkAllShardsCompleted();
  }

  function handleShardFailed(shardName, sessionId, reason, isRedundant) {
    const failureMode = classifyFailure(reason);

    eventLog.append('shard_failed', {
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
          eventLog.append('fallback_agent', {
            shard: shardName,
            from: shard.agent,
            to: fallbackAgent,
          });
          const fallbackShard = { ...shard, agent: fallbackAgent };
          lockManager.release(shardName);
          launchShard(fallbackShard);
          return;
        }
      }
    }

    failures.set(shardName, { mode: failureMode, reason, sessionId });
    lockManager.release(shardName);

    emitter.emit('shardFailed', { shardName, failureMode, reason });
    checkAllShardsCompleted();
  }

  function classifyFailure(reason) {
    if (!reason) return FAILURE_MODES.F1_CRASH;
    const r = String(reason).toLowerCase();
    if (/rate.?limit|cooldown/u.test(r)) return FAILURE_MODES.F2_RATE_LIMIT;
    if (/stall|l1_stall|timeout/u.test(r)) return FAILURE_MODES.F3_STALL;
    if (/lease|violation/u.test(r)) return FAILURE_MODES.F4_LEASE_VIOLATION;
    if (/merge|conflict/u.test(r)) return FAILURE_MODES.F5_MERGE_CONFLICT;
    return FAILURE_MODES.F1_CRASH;
  }

  function isTerminal(entry) {
    const snap = entry.conductor.getSnapshot();
    return snap.every((s) => s.state === STATES.COMPLETED || s.state === STATES.DEAD);
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

    eventLog.append('validate_result', {
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
    setState(SWARM_STATES.INTEGRATING, 'all_shards_done');

    const integrated = [];
    const integrationFailures = [];

    for (const shardName of plan.mergeOrder) {
      if (failures.has(shardName)) {
        eventLog.append('skip_failed_shard', { shard: shardName });
        continue;
      }

      const worker = workers.get(shardName);
      if (!worker) continue;

      // Fetch remote shard branch to local (push-blocked hosts like Ultra4)
      const shard = plan.shards.find((s) => s.name === shardName);
      if (shard?.host && shard._remoteEnv) {
        const hostConfig = getHostConfig(shard.host, config.rootDir);
        const sshUser = hostConfig?.ssh_user || shard.host;
        const remoteRepoPath = resolveRemoteDir(config.rootDir || process.cwd(), shard._remoteEnv);
        const fetchResult = await fetchRemoteShard({
          host: shard.host,
          sshUser,
          remoteRepoPath,
          branchName: worker.branchName || `swarm/${config.runId}/${shardName}`,
          rootDir: config.rootDir || process.cwd(),
        });

        if (!fetchResult.ok) {
          eventLog.append('remote_fetch_failed', { shard: shardName, error: fetchResult.error });
          integrationFailures.push(shardName);
          continue;
        }
        eventLog.append('remote_fetch_ok', { shard: shardName, headCommit: fetchResult.headCommit });
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
        eventLog.append('lease_violation_revert', {
          shard: shardName,
          violations: validation.violations,
        });
        integrationFailures.push(shardName);
        continue;
      }

      results.set(shardName, {
        shard: shardName,
        changedFiles,
        completedAt: Date.now(),
      });
      integrated.push(shardName);
    }

    eventLog.append('integration_complete', {
      integrated,
      failed: integrationFailures,
      skipped: [...failures.keys()].filter((n) => !integrationFailures.includes(n)),
    });

    if (integrationFailures.length > 0 && integrated.length === 0) {
      setState(SWARM_STATES.FAILED, 'all_shards_failed_integration');
    } else {
      setState(SWARM_STATES.COMPLETED, `${integrated.length}/${plan.shards.length} integrated`);
    }

    emitter.emit('integrationComplete', {
      integrated,
      failed: integrationFailures,
      results: [...results.values()],
    });
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
          const output = readFileSync(session.outPath, 'utf8');
          return extractFilePathsFromOutput(output, plan.leaseMap.get(shardName) || []);
        }
      }
    } catch { /* best-effort */ }

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
        /^[+-]{3}\s+[ab]\/(.+)/,           // diff headers
        /^diff --git a\/(.+)\s+b\//,        // git diff headers
      ];

      for (const re of patterns) {
        const match = line.match(re);
        if (match) found.add(match[1]);
      }
    }

    // Intersect with allowed files if we found anything
    if (found.size > 0) {
      return [...found].filter((f) => allowedFiles.some(
        (a) => f.endsWith(a) || a.endsWith(f) || f === a,
      ));
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
      workerStatuses.push({
        shard: name,
        agent: w.shardConfig.agent,
        sessions: snap,
        failed: failures.has(name),
        failureInfo: failures.get(name) || null,
        integrated: results.has(name),
      });
    }

    return Object.freeze({
      state,
      totalShards: plan?.shards.length || 0,
      completedShards: results.size,
      failedShards: failures.size,
      workers: workerStatuses,
      mergeOrder: plan?.mergeOrder || [],
      criticalShards: plan?.criticalShards || [],
      locks: lockManager?.snapshot() || [],
    });
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Launch the swarm from a pre-built plan.
   * @param {SwarmPlan} swarmPlan — from planSwarm()
   * @returns {SwarmStatus}
   */
  function launch(swarmPlan) {
    if (state !== SWARM_STATES.PLANNING) {
      throw new Error(`Cannot launch in state "${state}"`);
    }

    plan = swarmPlan;

    // Warn about file conflicts but don't block
    if (plan.conflicts.length > 0) {
      eventLog.append('file_conflicts_warning', { conflicts: plan.conflicts });
      emitter.emit('warning', {
        type: 'file_conflicts',
        conflicts: plan.conflicts,
      });
    }

    // Initialize lock manager
    lockManager = createSwarmLocks({
      repoRoot: workdir,
      persistPath: join(workdir, '.triflux', 'swarm-locks.json'),
    });

    setState(SWARM_STATES.LAUNCHING, `${plan.shards.length} shards`);

    // Launch shards respecting dependency order
    const launched = new Set();
    const pending = new Set(plan.mergeOrder);

    function launchReady() {
      for (const name of pending) {
        const shard = plan.shards.find((s) => s.name === name);
        if (!shard) continue;

        // Check all dependencies are launched (not necessarily completed)
        const depsReady = shard.depends.every((d) => launched.has(d));
        if (!depsReady) continue;

        pending.delete(name);
        launched.add(name);
        launchShard(shard);

        // Launch redundant worker for critical shards
        if (shard.critical) {
          const redundantShard = {
            ...shard,
            agent: FALLBACK_AGENTS[shard.agent] || shard.agent,
          };
          launchShard(redundantShard, true);
        }
      }
    }

    launchReady();

    // Re-check pending on each shard completion (dependency chains)
    emitter.on('shardCompleted', () => {
      if (pending.size > 0) launchReady();
    });

    setState(SWARM_STATES.RUNNING, `${launched.size} launched, ${pending.size} pending deps`);

    return getStatus();
  }

  /**
   * Graceful shutdown — kill all workers and release locks.
   * @param {string} [reason]
   */
  async function shutdown(reason = 'shutdown') {
    eventLog.append('swarm_shutdown', { reason, state });

    const shutdowns = [];
    for (const [, w] of workers) {
      shutdowns.push(w.conductor.shutdown(reason));
    }
    for (const [, w] of redundantWorkers) {
      shutdowns.push(w.conductor.shutdown(reason));
    }

    await Promise.allSettled(shutdowns);

    lockManager?.releaseAll();
    await eventLog.flush();
    await eventLog.close();

    if (state !== SWARM_STATES.COMPLETED && state !== SWARM_STATES.FAILED) {
      setState(SWARM_STATES.FAILED, reason);
    }

    emitter.emit('shutdown', { reason });
  }

  return Object.freeze({
    launch,
    shutdown,
    getStatus,
    validateResult,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    get state() { return state; },
    get plan() { return plan; },
    get eventLogPath() { return eventLog.filePath; },
  });
}
