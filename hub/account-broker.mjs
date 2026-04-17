// hub/account-broker.mjs — Multi-account CLI pool broker
// Manages lease/release/cooldown/circuit-breaker for Codex and Gemini accounts.
// Per-account circuit breaker: one bad account does not block others.
// Singleton export. All state changes create new objects (immutable pattern).

import { EventEmitter } from "node:events";
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as z from "zod";

import { isPathWithin } from "./platform.mjs";

// ── Zod schema ───────────────────────────────────────────────────

const AccountSchema = z
  .object({
    id: z.string().min(1),
    mode: z.enum(["profile", "env", "auth"]),
    profile: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    authFile: z.string().optional(),
    host: z.string().min(1).optional(),
    tier: z
      .enum(["pro", "plus", "free", "unknown"])
      .optional()
      .default("unknown"),
  })
  .superRefine((val, ctx) => {
    if (val.mode === "auth" && !val.authFile) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'authFile is required when mode is "auth"',
        path: ["authFile"],
      });
    }
  });

const ConfigSchema = z.object({
  defaults: z
    .object({
      cooldownMs: z.number().int().positive().optional(),
    })
    .optional(),
  codex: z.array(AccountSchema).optional(),
  gemini: z.array(AccountSchema).optional(),
});

const DEFAULT_COOLDOWN_MS = 300_000; // 5 minutes
const _QUOTA_COOLDOWN_MS = {
  codex: 5 * 60 * 60_000, // 5 hours (단기 쿼터)
  codex_weekly: 7 * 24 * 60 * 60_000, // 7 days (주간 쿼터)
  gemini: 24 * 60 * 60_000, // 24 hours
};
const TIER_PRIORITY = { pro: 0, plus: 1, unknown: 2, free: 3 };
const LEASE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CIRCUIT_WINDOW_MS = 10 * 60_000; // 10 minutes
const CIRCUIT_MAX_FAILURES = 3;
const AUTH_BASE_PATH = join(homedir(), ".claude", "cache", "tfx-hub");
const CODEX_AUTH_SOURCE_PATH = join(homedir(), ".codex", "auth.json");
const STATE_PERSIST_PATH = join(AUTH_BASE_PATH, "broker-state.json");
const AUTH_SYNC_LOCK_TIMEOUT_MS = 5_000;
const AUTH_SYNC_LOCK_RETRY_MS = 25;
const AUTH_SYNC_LOCK_STALE_MS = 30_000;
const AUTH_SYNC_SAB = new Int32Array(new SharedArrayBuffer(4));

// ── State persistence ────────────────────────────────────────────

function persistState(stateMap) {
  try {
    const now = Date.now();
    const entries = {};
    for (const [id, acct] of stateMap) {
      // 활성 쿨다운 또는 circuit open만 저장 (불필요한 데이터 제거)
      if (
        acct.cooldownUntil > now ||
        acct.circuitOpenedAt > 0 ||
        acct.totalSessions > 0
      ) {
        entries[id] = {
          cooldownUntil: acct.cooldownUntil,
          circuitOpenedAt: acct.circuitOpenedAt,
          failureTimestamps: acct.failureTimestamps,
          totalSessions: acct.totalSessions,
          lastUsedAt: acct.lastUsedAt,
        };
      }
    }
    mkdirSync(AUTH_BASE_PATH, { recursive: true });
    writeFileSync(STATE_PERSIST_PATH, JSON.stringify({ ts: now, entries }));
  } catch (err) {
    try {
      console.error("[account-broker] persistState failed:", err.message);
    } catch {}
  }
}

function loadPersistedState() {
  try {
    if (!existsSync(STATE_PERSIST_PATH)) return null;
    return JSON.parse(readFileSync(STATE_PERSIST_PATH, "utf8"));
  } catch {
    return null;
  }
}

// ── env var resolution ───────────────────────────────────────────

function resolveEnvValues(env) {
  if (!env) return undefined;
  const resolved = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && value.startsWith("$")) {
      const varName = value.slice(1);
      resolved[key] = process.env[varName] ?? "";
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

function isRemoteAccount(account) {
  return Boolean(account.host);
}

function getRemainingLeaseMs(account, now) {
  if (!account.busy || account.leasedAt === null) return 0;
  return Math.max(0, LEASE_TTL_MS - (now - account.leasedAt));
}

function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(AUTH_SYNC_SAB, 0, 0, ms);
}

function statOrNull(filePath) {
  try {
    return statSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function readAuthPayload(filePath) {
  const buffer = readFileSync(filePath);
  const parsed = JSON.parse(buffer.toString("utf8"));
  return {
    buffer,
    parsed,
    accountId:
      parsed?.tokens?.account_id ??
      parsed?.account_id ??
      parsed?.accountId ??
      null,
  };
}

function createSyncResult({
  accountId,
  direction,
  sourcePath,
  cachePath,
  copied = false,
  skipped = false,
  reason = "ok",
}) {
  return {
    ok: !skipped || reason === "up_to_date",
    accountId,
    direction,
    sourcePath,
    cachePath,
    copied,
    skipped,
    reason,
  };
}

function withLockFile(lockPath, opts, task) {
  const retryMs = opts.retryMs ?? AUTH_SYNC_LOCK_RETRY_MS;
  const timeoutMs = opts.timeoutMs ?? AUTH_SYNC_LOCK_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? AUTH_SYNC_LOCK_STALE_MS;
  const start = Date.now();

  while (true) {
    let fd;
    try {
      mkdirSync(dirname(lockPath), { recursive: true });
      fd = openSync(
        lockPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
        0o600,
      );
      writeFileSync(fd, `${process.pid}\n${Date.now()}`, "utf8");
      try {
        return task();
      } finally {
        closeSync(fd);
        try {
          unlinkSync(lockPath);
        } catch {}
      }
    } catch (error) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {}
      }
      if (error?.code !== "EEXIST") throw error;

      const lockStat = statOrNull(lockPath);
      if (lockStat && Date.now() - lockStat.mtimeMs > staleMs) {
        try {
          unlinkSync(lockPath);
          continue;
        } catch {}
      }

      if (Date.now() - start >= timeoutMs) {
        return { lockTimeout: true };
      }

      sleepSync(retryMs);
    }
  }
}

// ── AccountBroker ────────────────────────────────────────────────

class AccountBroker extends EventEmitter {
  #config;
  #state; // Map<accountId, accountState>
  #roundRobinIndex; // Map<provider, number>
  #persist; // boolean — disable persistence for tests
  #authBasePath;
  #codexAuthSourcePath;
  #authSyncLockOpts;
  #syncCopyDelayMs;

  constructor(
    config,
    {
      _skipPersistence = false,
      _authBasePath = AUTH_BASE_PATH,
      _codexAuthSourcePath = CODEX_AUTH_SOURCE_PATH,
      _authSyncLockTimeoutMs = AUTH_SYNC_LOCK_TIMEOUT_MS,
      _authSyncLockRetryMs = AUTH_SYNC_LOCK_RETRY_MS,
      _authSyncLockStaleMs = AUTH_SYNC_LOCK_STALE_MS,
      _syncCopyDelayMs = 0,
    } = {},
  ) {
    super();
    const parsed = ConfigSchema.parse(config);
    this.#config = parsed;
    this.#persist = !_skipPersistence;
    this.#authBasePath = _authBasePath;
    this.#codexAuthSourcePath = _codexAuthSourcePath;
    this.#authSyncLockOpts = {
      timeoutMs: _authSyncLockTimeoutMs,
      retryMs: _authSyncLockRetryMs,
      staleMs: _authSyncLockStaleMs,
    };
    this.#syncCopyDelayMs = _syncCopyDelayMs;

    this.#state = new Map();
    this.#roundRobinIndex = new Map();

    const allAccounts = [
      ...(parsed.codex || []).map((a) => ({ ...a, provider: "codex" })),
      ...(parsed.gemini || []).map((a) => ({ ...a, provider: "gemini" })),
    ];

    const persisted = this.#persist ? loadPersistedState() : null;
    const pEntries = persisted?.entries || {};

    for (const account of allAccounts) {
      const saved = pEntries[account.id];
      this.#state.set(account.id, {
        id: account.id,
        provider: account.provider,
        mode: account.mode,
        profile: account.profile,
        env: account.env,
        authFile: account.authFile,
        host: account.host,
        tier: account.tier ?? "unknown",
        busy: false,
        leasedAt: null,
        cooldownUntil: saved?.cooldownUntil ?? 0,
        failureTimestamps: saved?.failureTimestamps ?? [],
        circuitOpenedAt: saved?.circuitOpenedAt ?? 0,
        circuitTrialInFlight: false,
        lastUsedAt: saved?.lastUsedAt ?? 0,
        totalSessions: saved?.totalSessions ?? 0,
      });
    }
  }

  #resolveCacheAuthPath(acct) {
    if (!acct?.authFile) return null;
    const resolved = join(this.#authBasePath, acct.authFile);
    if (
      !isPathWithin(resolved, this.#authBasePath) ||
      resolved === this.#authBasePath
    ) {
      return null;
    }
    return resolved;
  }

  #getSourceAuthPath(acct) {
    if (!acct || acct.mode !== "auth") return null;
    if (acct.provider === "codex") return this.#codexAuthSourcePath;
    return null;
  }

  #getLockPath(acct) {
    return join(this.#authBasePath, `codex-auth-sync-${acct.id}.lock`);
  }

  #copyAuthPayload(sourcePath, destPath) {
    const payload = readFileSync(sourcePath);
    if (this.#syncCopyDelayMs > 0) {
      sleepSync(this.#syncCopyDelayMs);
    }
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, payload);
  }

  #syncAuth(accountId, direction) {
    const acct = this.#state.get(accountId);
    const sourcePath = this.#getSourceAuthPath(acct);
    const cachePath = this.#resolveCacheAuthPath(acct);

    if (!acct || acct.mode !== "auth" || acct.provider !== "codex") {
      return createSyncResult({
        accountId,
        direction,
        sourcePath,
        cachePath,
        skipped: true,
        reason: "unsupported_account",
      });
    }

    if (!cachePath) {
      this.emit("securityViolation", {
        id: acct.id,
        authFile: acct.authFile,
      });
      return createSyncResult({
        accountId,
        direction,
        sourcePath,
        cachePath,
        skipped: true,
        reason: "invalid_cache_path",
      });
    }

    if (!sourcePath) {
      return createSyncResult({
        accountId,
        direction,
        sourcePath,
        cachePath,
        skipped: true,
        reason: "unsupported_source",
      });
    }

    const locked = withLockFile(
      this.#getLockPath(acct),
      this.#authSyncLockOpts,
      () => {
        try {
          if (direction === "from-source") {
            const sourceStat = statOrNull(sourcePath);
            if (!sourceStat) {
              return createSyncResult({
                accountId,
                direction,
                sourcePath,
                cachePath,
                skipped: true,
                reason: "source_missing",
              });
            }

            const sourceAuth = readAuthPayload(sourcePath);
            if (!sourceAuth.accountId) {
              return createSyncResult({
                accountId,
                direction,
                sourcePath,
                cachePath,
                skipped: true,
                reason: "source_account_unknown",
              });
            }
            if (sourceAuth.accountId !== accountId) {
              return createSyncResult({
                accountId,
                direction,
                sourcePath,
                cachePath,
                skipped: true,
                reason: "source_account_mismatch",
              });
            }

            const cacheStat = statOrNull(cachePath);
            if (cacheStat && sourceStat.mtimeMs <= cacheStat.mtimeMs) {
              return createSyncResult({
                accountId,
                direction,
                sourcePath,
                cachePath,
                skipped: true,
                reason: "up_to_date",
              });
            }

            this.#copyAuthPayload(sourcePath, cachePath);
            return createSyncResult({
              accountId,
              direction,
              sourcePath,
              cachePath,
              copied: true,
              reason: cacheStat ? "cache_updated" : "cache_created",
            });
          }

          const cacheStat = statOrNull(cachePath);
          if (!cacheStat) {
            return createSyncResult({
              accountId,
              direction,
              sourcePath,
              cachePath,
              skipped: true,
              reason: "cache_missing",
            });
          }

          const cacheAuth = readAuthPayload(cachePath);
          if (!cacheAuth.accountId) {
            return createSyncResult({
              accountId,
              direction,
              sourcePath,
              cachePath,
              skipped: true,
              reason: "cache_account_unknown",
            });
          }
          if (cacheAuth.accountId !== accountId) {
            return createSyncResult({
              accountId,
              direction,
              sourcePath,
              cachePath,
              skipped: true,
              reason: "cache_account_mismatch",
            });
          }

          const sourceStat = statOrNull(sourcePath);
          if (sourceStat && cacheStat.mtimeMs <= sourceStat.mtimeMs) {
            return createSyncResult({
              accountId,
              direction,
              sourcePath,
              cachePath,
              skipped: true,
              reason: "up_to_date",
            });
          }

          this.#copyAuthPayload(cachePath, sourcePath);
          return createSyncResult({
            accountId,
            direction,
            sourcePath,
            cachePath,
            copied: true,
            reason: sourceStat ? "source_updated" : "source_created",
          });
        } catch (error) {
          return createSyncResult({
            accountId,
            direction,
            sourcePath,
            cachePath,
            skipped: true,
            reason: error?.code === "ENOENT" ? "file_missing" : "read_error",
          });
        }
      },
    );

    if (locked?.lockTimeout) {
      return createSyncResult({
        accountId,
        direction,
        sourcePath,
        cachePath,
        skipped: true,
        reason: "lock_timeout",
      });
    }

    return locked;
  }

  syncAuthFromSource(accountId) {
    return this.#syncAuth(accountId, "from-source");
  }

  syncAuthToSource(accountId) {
    return this.#syncAuth(accountId, "to-source");
  }

  // ── per-account circuit breaker ─────────────────────────────────

  #getCircuitState(acct, now) {
    const validFailures = acct.failureTimestamps.filter(
      (ts) => now - ts < CIRCUIT_WINDOW_MS,
    );
    const withinWindow =
      acct.circuitOpenedAt && now - acct.circuitOpenedAt < CIRCUIT_WINDOW_MS;
    if (withinWindow) return { state: "open", failures: validFailures };
    if (acct.circuitOpenedAt)
      return { state: "half-open", failures: validFailures };
    return { state: "closed", failures: validFailures };
  }

  #isCircuitBlocked(acct, now) {
    const circuit = this.#getCircuitState(acct, now);
    if (circuit.state === "open") return true;
    if (circuit.state === "half-open" && acct.circuitTrialInFlight) return true;
    return false;
  }

  #recordCircuitFailure(acct, isHalfOpen, now) {
    const validFailures = [
      ...acct.failureTimestamps.filter((ts) => now - ts < CIRCUIT_WINDOW_MS),
      now,
    ];
    const shouldOpen =
      isHalfOpen || validFailures.length >= CIRCUIT_MAX_FAILURES;
    return {
      failureTimestamps: validFailures,
      circuitOpenedAt: shouldOpen ? now : acct.circuitOpenedAt,
      circuitTrialInFlight: false,
    };
  }

  #resetCircuit() {
    return {
      failureTimestamps: [],
      circuitOpenedAt: 0,
      circuitTrialInFlight: false,
    };
  }

  // ── lease TTL pruning ──────────────────────────────────────────

  #pruneExpiredLeases(now) {
    for (const [id, acct] of this.#state) {
      if (
        acct.busy &&
        acct.leasedAt !== null &&
        now - acct.leasedAt > LEASE_TTL_MS
      ) {
        this.#state.set(id, { ...acct, busy: false, leasedAt: null });
      }
    }
  }

  // ── lease ─────────────────────────────────────────────────────

  lease({ provider, remote = false, autoSync = true } = {}) {
    const now = Date.now();
    this.#pruneExpiredLeases(now);

    const wantsRemote = remote === true;
    const accounts = [...this.#state.values()].filter(
      (a) => a.provider === provider && isRemoteAccount(a) === wantsRemote,
    );
    if (!accounts.length) return null;

    // filter: not busy, not in cooldown, circuit not blocked
    const available = accounts.filter(
      (a) =>
        !a.busy && a.cooldownUntil <= now && !this.#isCircuitBlocked(a, now),
    );

    if (!available.length) {
      // check if any accounts exist but all are blocked by circuit
      const circuitBlocked = accounts.filter(
        (a) =>
          !a.busy && a.cooldownUntil <= now && this.#isCircuitBlocked(a, now),
      );
      if (circuitBlocked.length) {
        this.emit("noAvailableAccounts", {
          provider,
          count: circuitBlocked.length,
        });
      }
      return null;
    }

    // sort by tier priority; stable sort preserves original order within same priority
    const sorted = [...available].sort(
      (a, b) => (TIER_PRIORITY[a.tier] ?? 2) - (TIER_PRIORITY[b.tier] ?? 2),
    );

    // pick the best tier, then apply round-robin within that tier's accounts
    const bestTier = sorted[0].tier;
    const sameTierAccounts = sorted.filter((a) => a.tier === bestTier);

    // detect tier fallback
    const highestTier = accounts.reduce(
      (best, a) => Math.min(best, TIER_PRIORITY[a.tier] ?? 2),
      Infinity,
    );
    if ((TIER_PRIORITY[bestTier] ?? 2) > highestTier) {
      this.emit("tierFallback", {
        provider,
        from: Object.entries(TIER_PRIORITY).find(
          ([, v]) => v === highestTier,
        )?.[0],
        to: bestTier,
      });
    }

    // use a per-provider+tier round-robin key to distribute within the tier
    const rrKey = `${provider}:${bestTier}:${wantsRemote ? "remote" : "local"}`;
    const rrCurrent = this.#roundRobinIndex.get(rrKey) ?? 0;
    const tierCount = sameTierAccounts.length;
    const idx = rrCurrent % tierCount;
    const acct = sameTierAccounts[idx];

    // advance round-robin index for this tier
    this.#roundRobinIndex.set(rrKey, (idx + 1) % tierCount);

    let authFile;
    if (acct.mode === "auth") {
      const resolved = this.#resolveCacheAuthPath(acct);
      if (!resolved) {
        this.emit("securityViolation", {
          id: acct.id,
          authFile: acct.authFile,
        });
        return null;
      }
      authFile = resolved;
      if (autoSync !== false) {
        try {
          const syncResult = this.syncAuthFromSource(acct.id);
          this.emit("authSync", syncResult);
        } catch (error) {
          this.emit("authSyncError", {
            accountId: acct.id,
            direction: "from-source",
            error: error?.message || String(error),
          });
        }
      }
    }

    // mark half-open trial if applicable
    const circuit = this.#getCircuitState(acct, now);
    const isHalfOpen = circuit.state === "half-open";

    // update state (immutable)
    this.#state.set(acct.id, {
      ...acct,
      busy: true,
      leasedAt: now,
      lastUsedAt: now,
      totalSessions: acct.totalSessions + 1,
      circuitTrialInFlight: isHalfOpen ? true : acct.circuitTrialInFlight,
    });

    this.emit("lease", {
      id: acct.id,
      provider,
      tier: acct.tier,
      halfOpen: isHalfOpen,
    });

    return {
      id: acct.id,
      mode: acct.mode,
      remote: isRemoteAccount(acct),
      host: acct.host,
      halfOpen: isHalfOpen,
      profile: acct.mode === "profile" ? acct.profile : undefined,
      env: acct.mode === "env" ? resolveEnvValues(acct.env) : undefined,
      authFile,
    };
  }

  // ── release ───────────────────────────────────────────────────

  release(accountId, result) {
    const acct = this.#state.get(accountId);
    if (!acct?.busy) return;

    const now = Date.now();
    const ok = result?.ok === true;
    const circuit = this.#getCircuitState(acct, now);
    const isHalfOpen = circuit.state === "half-open";

    let circuitUpdate;
    if (ok) {
      circuitUpdate = this.#resetCircuit();
      if (isHalfOpen) {
        this.emit("circuitClose", { id: accountId });
      }
    } else if (result?.skipCircuit) {
      // 인프라 에러 — circuit/cooldown에 카운트하지 않음
      circuitUpdate = {
        failureTimestamps: acct.failureTimestamps,
        circuitOpenedAt: acct.circuitOpenedAt,
        circuitTrialInFlight: acct.circuitTrialInFlight,
      };
    } else {
      circuitUpdate = this.#recordCircuitFailure(acct, isHalfOpen, now);
      if (circuitUpdate.circuitOpenedAt !== acct.circuitOpenedAt) {
        this.emit("circuitOpen", {
          id: accountId,
          failures: circuitUpdate.failureTimestamps.length,
        });
      }
    }

    const cooldownMs = this.#config.defaults?.cooldownMs ?? DEFAULT_COOLDOWN_MS;

    // rate-limit style cooldown: if circuit just opened, also set cooldown
    const shouldCooldown =
      !ok && circuitUpdate.circuitOpenedAt !== acct.circuitOpenedAt;

    const updated = {
      ...acct,
      busy: false,
      leasedAt: null,
      ...circuitUpdate,
      cooldownUntil: shouldCooldown ? now + cooldownMs : acct.cooldownUntil,
    };

    this.#state.set(accountId, updated);
    if (this.#persist) persistState(this.#state);
    this.emit("release", { id: accountId, ok });
  }

  // ── markRateLimited ───────────────────────────────────────────

  markRateLimited(id, coolMs) {
    const acct = this.#state.get(id);
    if (!acct) return;
    this.#state.set(id, {
      ...acct,
      busy: false,
      leasedAt: null,
      cooldownUntil: Date.now() + coolMs,
    });
    if (this.#persist) persistState(this.#state);
  }

  // ── snapshot ──────────────────────────────────────────────────

  snapshot() {
    const now = Date.now();
    this.#pruneExpiredLeases(now);
    return [...this.#state.values()].map((acct) => ({
      ...acct,
      failureTimestamps: [...acct.failureTimestamps],
      remainingMs: getRemainingLeaseMs(acct, now),
      circuitState: this.#getCircuitState(acct, now).state,
    }));
  }

  // ── nextAvailableEta ──────────────────────────────────────────

  nextAvailableEta(provider) {
    const now = Date.now();
    this.#pruneExpiredLeases(now);

    const accounts = [...this.#state.values()].filter(
      (a) => a.provider === provider,
    );
    if (!accounts.length) return null;

    // find minimum cooldownUntil among accounts that are in cooldown or busy
    let earliest = null;
    for (const acct of accounts) {
      if (!acct.busy && acct.cooldownUntil <= now) {
        // this account is available now — no ETA needed
        return null;
      }
      const eta = acct.busy
        ? (acct.leasedAt ?? now) + LEASE_TTL_MS
        : acct.cooldownUntil;
      if (earliest === null || eta < earliest) {
        earliest = eta;
      }
    }
    return earliest;
  }
}

// ── Config loader ────────────────────────────────────────────────

function loadConfig() {
  const configPath = join(
    homedir(),
    ".claude",
    "cache",
    "tfx-hub",
    "accounts.json",
  );
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    console.error(
      "[account-broker] Failed to parse accounts.json:",
      err.message,
    );
    return null;
  }
}

// ── Singleton ────────────────────────────────────────────────────

function createBroker() {
  const config = loadConfig();
  if (!config) return null;
  try {
    return new AccountBroker(config);
  } catch (err) {
    console.error("[account-broker] Failed to create broker:", err.message);
    return null;
  }
}

/** Re-read config and replace the module-level singleton. ESM live binding propagates to all importers. */
function reloadBroker() {
  const config = loadConfig();
  if (!config) return { ok: false, error: "Config not found or invalid" };
  try {
    broker = new AccountBroker(config);
    return { ok: true, broker };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export let broker = createBroker();
export { AccountBroker, reloadBroker };
