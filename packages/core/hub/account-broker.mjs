// hub/account-broker.mjs — Multi-account CLI pool broker
// Manages lease/release/cooldown for Codex and Gemini accounts.
// Singleton export. All state changes create new objects (immutable pattern).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as z from "zod";

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
const TIER_PRIORITY = { pro: 0, plus: 1, unknown: 2, free: 3 };
const LEASE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const AUTH_BASE_PATH = join(homedir(), ".claude", "cache", "tfx-hub");

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

// ── AccountBroker ────────────────────────────────────────────────

class AccountBroker {
  #config;
  #state; // Map<accountId, accountState>
  #roundRobinIndex; // Map<provider, number>

  constructor(config) {
    const parsed = ConfigSchema.parse(config);
    this.#config = parsed;

    this.#state = new Map();
    this.#roundRobinIndex = new Map();

    const allAccounts = [
      ...(parsed.codex || []).map((a) => ({ ...a, provider: "codex" })),
      ...(parsed.gemini || []).map((a) => ({ ...a, provider: "gemini" })),
    ];

    for (const account of allAccounts) {
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
        cooldownUntil: 0,
        failures: 0,
        lastUsedAt: 0,
        totalSessions: 0,
      });
    }
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

  lease({ provider, remote = false } = {}) {
    const now = Date.now();
    this.#pruneExpiredLeases(now);

    const wantsRemote = remote === true;
    const accounts = [...this.#state.values()].filter(
      (a) => a.provider === provider && isRemoteAccount(a) === wantsRemote,
    );
    if (!accounts.length) return null;

    // group available accounts by tier, preserving insertion order within each tier
    const available = accounts.filter((a) => !a.busy && a.cooldownUntil <= now);
    if (!available.length) return null;

    // sort by tier priority; stable sort preserves original order within same priority
    const sorted = [...available].sort(
      (a, b) => (TIER_PRIORITY[a.tier] ?? 2) - (TIER_PRIORITY[b.tier] ?? 2),
    );

    // pick the best tier, then apply round-robin within that tier's accounts
    const bestTier = sorted[0].tier;
    const sameTierAccounts = sorted.filter((a) => a.tier === bestTier);

    // use a per-provider+tier round-robin key to distribute within the tier
    const rrKey = `${provider}:${bestTier}:${wantsRemote ? "remote" : "local"}`;
    const rrCurrent = this.#roundRobinIndex.get(rrKey) ?? 0;
    const tierCount = sameTierAccounts.length;
    const idx = rrCurrent % tierCount;
    const acct = sameTierAccounts[idx];

    // advance round-robin index for this tier
    this.#roundRobinIndex.set(rrKey, (idx + 1) % tierCount);

    // update state (immutable)
    this.#state.set(acct.id, {
      ...acct,
      busy: true,
      leasedAt: now,
      lastUsedAt: now,
      totalSessions: acct.totalSessions + 1,
    });

    return {
      id: acct.id,
      mode: acct.mode,
      remote: isRemoteAccount(acct),
      host: acct.host,
      profile: acct.mode === "profile" ? acct.profile : undefined,
      env: acct.mode === "env" ? resolveEnvValues(acct.env) : undefined,
      authFile:
        acct.mode === "auth" ? join(AUTH_BASE_PATH, acct.authFile) : undefined,
    };
  }

  // ── release ───────────────────────────────────────────────────

  release(accountId, result) {
    const acct = this.#state.get(accountId);
    if (!acct || acct.busy === false) return;

    const ok = result?.ok === true;
    const newFailures = ok ? 0 : acct.failures + 1;
    const cooldownMs = this.#config.defaults?.cooldownMs ?? DEFAULT_COOLDOWN_MS;

    const updated = {
      ...acct,
      busy: false,
      leasedAt: null,
      failures: newFailures,
    };

    // consecutive failure guard: 3+ failures → auto-cooldown
    if (newFailures >= 3) {
      updated.cooldownUntil = Date.now() + cooldownMs;
      updated.failures = 0; // reset after cooldown triggered
    }

    this.#state.set(accountId, updated);
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
  }

  // ── snapshot ──────────────────────────────────────────────────

  snapshot() {
    const now = Date.now();
    this.#pruneExpiredLeases(now);
    return [...this.#state.values()].map((acct) => ({
      ...acct,
      remainingMs: getRemainingLeaseMs(acct, now),
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
  } catch {
    return null;
  }
}

// ── Singleton ────────────────────────────────────────────────────

function createBroker() {
  const config = loadConfig();
  if (!config) return null;
  try {
    return new AccountBroker(config);
  } catch {
    return null;
  }
}

export const broker = createBroker();
export { AccountBroker };
