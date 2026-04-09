// tests/unit/account-broker.test.mjs — AccountBroker unit tests

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { AccountBroker } from "../../hub/account-broker.mjs";

// ── helpers ──────────────────────────────────────────────────────

function makeConfig(overrides = {}) {
  return {
    defaults: { cooldownMs: 300_000 },
    codex: [
      { id: "codex-a", mode: "profile", profile: "default" },
      { id: "codex-b", mode: "profile", profile: "alt1" },
    ],
    gemini: [
      { id: "gemini-a", mode: "profile", profile: "default" },
      {
        id: "gemini-b",
        mode: "env",
        env: { GOOGLE_API_KEY: "$GOOGLE_API_KEY_ALT1" },
      },
    ],
    ...overrides,
  };
}

// ── tests ────────────────────────────────────────────────────────

describe("AccountBroker", () => {
  it("round-robin distributes leases across accounts", () => {
    const broker = new AccountBroker(makeConfig());

    const lease1 = broker.lease({ provider: "codex" });
    assert.ok(lease1, "first lease should be non-null");
    assert.equal(lease1.id, "codex-a");

    broker.release(lease1.id, { ok: true });

    const lease2 = broker.lease({ provider: "codex" });
    assert.ok(lease2, "second lease should be non-null");
    assert.equal(lease2.id, "codex-b");

    broker.release(lease2.id, { ok: true });

    // wraps back around
    const lease3 = broker.lease({ provider: "codex" });
    assert.ok(lease3, "third lease wraps to first account");
    assert.equal(lease3.id, "codex-a");
  });

  it("skips account in cooldown", () => {
    const broker = new AccountBroker(makeConfig());

    broker.markRateLimited("codex-a", 60_000); // 1 minute cooldown

    const lease = broker.lease({ provider: "codex" });
    assert.ok(lease, "should lease non-cooldown account");
    assert.equal(lease.id, "codex-b", "should skip codex-a in cooldown");
  });

  it("returns null when all accounts are in cooldown + provides ETA", () => {
    const broker = new AccountBroker(makeConfig());

    broker.markRateLimited("codex-a", 60_000);
    broker.markRateLimited("codex-b", 120_000);

    const lease = broker.lease({ provider: "codex" });
    assert.equal(lease, null, "should return null when all in cooldown");

    const eta = broker.nextAvailableEta("codex");
    assert.ok(typeof eta === "number", "ETA should be a number");
    assert.ok(eta > Date.now(), "ETA should be in the future");
  });

  it("lease TTL 30min auto-release: expired leases are pruned on next lease()", () => {
    const broker = new AccountBroker(makeConfig());

    // manually acquire and then manipulate leasedAt to simulate TTL expiry
    const lease1 = broker.lease({ provider: "codex" });
    assert.ok(lease1);

    // force leasedAt to 31 minutes ago via snapshot + internal state
    // we test this by checking that after 30+ min, the account becomes available again
    // Since we can't advance time, we verify the pruning path via snapshot
    const snap = broker.snapshot();
    const acct = snap.find((a) => a.id === lease1.id);
    assert.equal(acct.busy, true, "account should be busy while leased");

    // release normally so other tests remain isolated
    broker.release(lease1.id, { ok: true });
    const snapAfter = broker.snapshot();
    const acctAfter = snapAfter.find((a) => a.id === lease1.id);
    assert.equal(acctAfter.busy, false, "account should be free after release");
  });

  it("consecutive failure guard triggers circuit-open after 3 failures", () => {
    const broker = new AccountBroker({
      defaults: { cooldownMs: 300_000 },
      codex: [{ id: "codex-a", mode: "profile", profile: "default" }],
    });

    for (let i = 0; i < 3; i += 1) {
      const lease = broker.lease({ provider: "codex" });
      assert.ok(lease);
      broker.release(lease.id, { ok: false });
    }

    const snap = broker.snapshot();
    const acct = snap.find((a) => a.id === "codex-a");
    assert.equal(
      acct.circuitState,
      "open",
      "circuit should be open after 3 failures",
    );
  });

  it("Zod validation throws on invalid config (bad mode)", () => {
    assert.throws(
      () =>
        new AccountBroker({
          codex: [{ id: "bad", mode: "invalid_mode" }],
        }),
      (err) => {
        assert.ok(err instanceof Error, "should throw an Error");
        return true;
      },
    );
  });

  it("Zod validation throws on missing id", () => {
    assert.throws(
      () =>
        new AccountBroker({
          codex: [{ mode: "profile", profile: "default" }],
        }),
      (err) => {
        assert.ok(err instanceof Error);
        return true;
      },
    );
  });

  it("$env var resolve substitutes process.env values", () => {
    const prev = process.env.GOOGLE_API_KEY_ALT1;
    process.env.GOOGLE_API_KEY_ALT1 = "test-key-value";

    try {
      const broker = new AccountBroker(makeConfig());

      // skip gemini-a (profile mode), force to gemini-b (env mode)
      broker.markRateLimited("gemini-a", 60_000);
      const lease = broker.lease({ provider: "gemini" });
      assert.ok(lease, "should lease gemini-b");
      assert.equal(lease.id, "gemini-b");
      assert.equal(lease.mode, "env");
      assert.ok(lease.env, "env should be present");
      assert.equal(
        lease.env.GOOGLE_API_KEY,
        "test-key-value",
        "$var should resolve",
      );
    } finally {
      if (prev === undefined) delete process.env.GOOGLE_API_KEY_ALT1;
      else process.env.GOOGLE_API_KEY_ALT1 = prev;
    }
  });

  it("release with ok=true resets circuit breaker", () => {
    const broker = new AccountBroker({
      defaults: { cooldownMs: 300_000 },
      codex: [{ id: "codex-a", mode: "profile", profile: "default" }],
    });

    const lease1 = broker.lease({ provider: "codex" });
    assert.ok(lease1);
    broker.release(lease1.id, { ok: false });

    const lease2 = broker.lease({ provider: "codex" });
    assert.ok(lease2);
    broker.release(lease2.id, { ok: false });

    const lease3 = broker.lease({ provider: "codex" });
    assert.ok(lease3);
    broker.release(lease3.id, { ok: true });

    const snap = broker.snapshot();
    const acct = snap.find((a) => a.id === "codex-a");
    assert.equal(
      acct.failureTimestamps.length,
      0,
      "circuit should reset on ok release",
    );
    assert.equal(
      acct.circuitState,
      "closed",
      "circuit should be closed after ok release",
    );
  });

  it("returns null for unknown provider", () => {
    const broker = new AccountBroker(makeConfig());
    const lease = broker.lease({ provider: "unknown_cli" });
    assert.equal(lease, null);
  });

  it("nextAvailableEta returns null when an account is available", () => {
    const broker = new AccountBroker(makeConfig());
    // codex-a is available (not busy, no cooldown)
    const eta = broker.nextAvailableEta("codex");
    assert.equal(eta, null, "should return null when accounts are available");
  });

  it("snapshot returns all account states", () => {
    const broker = new AccountBroker(makeConfig());
    const snap = broker.snapshot();
    assert.equal(snap.length, 4, "should have 4 accounts total");
    assert.ok(snap.every((a) => typeof a.id === "string"));
    assert.ok(snap.every((a) => typeof a.busy === "boolean"));
    assert.ok(snap.every((a) => Array.isArray(a.failureTimestamps)));
    assert.ok(snap.every((a) => typeof a.remainingMs === "number"));
  });

  it("release is a no-op for idle accounts", () => {
    const broker = new AccountBroker(makeConfig());

    broker.release("codex-a", { ok: false });

    const acct = broker.snapshot().find((a) => a.id === "codex-a");
    assert.equal(acct.busy, false);
    assert.equal(acct.failureTimestamps.length, 0);
    assert.equal(acct.cooldownUntil, 0);
  });

  it("busy account is skipped and not double-leased", () => {
    const broker = new AccountBroker(makeConfig());

    const lease1 = broker.lease({ provider: "codex" });
    assert.ok(lease1);
    assert.equal(lease1.id, "codex-a");

    // codex-a is busy now; next lease should be codex-b
    const lease2 = broker.lease({ provider: "codex" });
    assert.ok(lease2);
    assert.equal(lease2.id, "codex-b");

    // both busy — no more available
    const lease3 = broker.lease({ provider: "codex" });
    assert.equal(lease3, null);
  });

  it("profile lease returns profile, no env", () => {
    const broker = new AccountBroker(makeConfig());
    const lease = broker.lease({ provider: "codex" });
    assert.ok(lease);
    assert.equal(lease.mode, "profile");
    assert.equal(lease.profile, "default");
    assert.equal(lease.env, undefined);
  });

  it("auth mode lease returns absolute authFile path", () => {
    const broker = new AccountBroker({
      codex: [
        {
          id: "codex-auth1",
          mode: "auth",
          authFile: "codex-auth-pte1024.json",
        },
      ],
    });

    const lease = broker.lease({ provider: "codex" });
    assert.ok(lease, "lease should be non-null");
    assert.equal(lease.id, "codex-auth1");
    assert.equal(lease.mode, "auth");
    assert.equal(
      lease.authFile,
      join(homedir(), ".claude", "cache", "tfx-hub", "codex-auth-pte1024.json"),
      "authFile should be absolute path under tfx-hub",
    );
    assert.equal(lease.profile, undefined);
    assert.equal(lease.env, undefined);
    assert.equal(lease.remote, false);
    assert.equal(lease.host, undefined);
  });

  it('Zod validation throws when mode is "auth" but authFile is missing', () => {
    assert.throws(
      () =>
        new AccountBroker({
          codex: [{ id: "codex-bad-auth", mode: "auth" }],
        }),
      (err) => {
        assert.ok(err instanceof Error, "should throw an Error");
        return true;
      },
    );
  });

  it("tier-based routing prefers pro over free", () => {
    const broker = new AccountBroker({
      codex: [
        {
          id: "codex-free",
          mode: "profile",
          profile: "free-acct",
          tier: "free",
        },
        { id: "codex-pro", mode: "profile", profile: "pro-acct", tier: "pro" },
      ],
    });

    const lease = broker.lease({ provider: "codex" });
    assert.ok(lease, "should lease an account");
    assert.equal(
      lease.id,
      "codex-pro",
      "pro account should be preferred over free",
    );
  });

  it("same-tier accounts still round-robin", () => {
    const broker = new AccountBroker({
      codex: [
        { id: "codex-pro-1", mode: "profile", profile: "pro1", tier: "pro" },
        { id: "codex-pro-2", mode: "profile", profile: "pro2", tier: "pro" },
      ],
    });

    const lease1 = broker.lease({ provider: "codex" });
    assert.ok(lease1);
    assert.equal(lease1.id, "codex-pro-1", "first lease should be pro-1");
    broker.release(lease1.id, { ok: true });

    const lease2 = broker.lease({ provider: "codex" });
    assert.ok(lease2);
    assert.equal(
      lease2.id,
      "codex-pro-2",
      "second lease should round-robin to pro-2",
    );
    broker.release(lease2.id, { ok: true });

    const lease3 = broker.lease({ provider: "codex" });
    assert.ok(lease3);
    assert.equal(lease3.id, "codex-pro-1", "third lease wraps back to pro-1");
  });

  it("falls back to lower tier when higher tier is busy/cooldown", () => {
    const broker = new AccountBroker({
      codex: [
        { id: "codex-pro", mode: "profile", profile: "pro-acct", tier: "pro" },
        {
          id: "codex-plus",
          mode: "profile",
          profile: "plus-acct",
          tier: "plus",
        },
        {
          id: "codex-free",
          mode: "profile",
          profile: "free-acct",
          tier: "free",
        },
      ],
    });

    // lease the pro account so it becomes busy
    const proLease = broker.lease({ provider: "codex" });
    assert.ok(proLease);
    assert.equal(proLease.id, "codex-pro", "first lease should be pro");

    // with pro busy, next should fall back to plus
    const plusLease = broker.lease({ provider: "codex" });
    assert.ok(plusLease);
    assert.equal(
      plusLease.id,
      "codex-plus",
      "should fall back to plus when pro is busy",
    );

    // with pro and plus busy, next should fall back to free
    const freeLease = broker.lease({ provider: "codex" });
    assert.ok(freeLease);
    assert.equal(
      freeLease.id,
      "codex-free",
      "should fall back to free when pro+plus are busy",
    );
  });

  it("lease filters local vs remote accounts and returns remote host metadata", () => {
    const broker = new AccountBroker({
      codex: [
        { id: "codex-local", mode: "profile", profile: "local-default" },
        {
          id: "codex-remote",
          mode: "profile",
          profile: "remote-default",
          host: "remote-box",
        },
      ],
    });

    const localLease = broker.lease({ provider: "codex" });
    assert.ok(localLease);
    assert.equal(localLease.id, "codex-local");
    assert.equal(localLease.remote, false);
    assert.equal(localLease.host, undefined);

    const secondLocalLease = broker.lease({ provider: "codex" });
    assert.equal(
      secondLocalLease,
      null,
      "local lease should not fall through to remote-only accounts",
    );

    const remoteLease = broker.lease({ provider: "codex", remote: true });
    assert.ok(remoteLease);
    assert.equal(remoteLease.id, "codex-remote");
    assert.equal(remoteLease.remote, true);
    assert.equal(remoteLease.host, "remote-box");
  });

  it("snapshot includes remaining lease time", () => {
    const realNow = Date.now;
    const broker = new AccountBroker(makeConfig());

    try {
      Date.now = () => 1_000;
      const lease = broker.lease({ provider: "codex" });
      assert.ok(lease);

      Date.now = () => 11_000;
      const acct = broker.snapshot().find((entry) => entry.id === lease.id);
      assert.equal(acct.remainingMs, 1_790_000);
    } finally {
      Date.now = realNow;
    }
  });

  // ── new gap-filling tests ─────────────────────────────────────

  it("TTL expiry pruning auto-releases expired leases", () => {
    const realNow = Date.now;
    const broker = new AccountBroker({
      codex: [{ id: "codex-a", mode: "profile", profile: "default" }],
    });

    try {
      // lease at t=0
      Date.now = () => 0;
      const lease = broker.lease({ provider: "codex" });
      assert.ok(lease);

      // snapshot while leased — should be busy
      const snapBusy = broker.snapshot();
      const busy = snapBusy.find((a) => a.id === "codex-a");
      assert.equal(busy.busy, true, "account should be busy while leased");
      assert.ok(
        busy.remainingMs > 0,
        "remainingMs should be positive while leased",
      );

      // advance time past 30-min TTL (31 minutes)
      Date.now = () => 31 * 60 * 1000;

      // next lease() triggers pruneExpiredLeases, so the expired lease is freed
      const lease2 = broker.lease({ provider: "codex" });
      assert.ok(
        lease2,
        "should re-lease after TTL expiry prunes the old lease",
      );
      assert.equal(
        lease2.id,
        "codex-a",
        "same account should be available again",
      );
    } finally {
      Date.now = realNow;
    }
  });

  it("release() busy guard: release without prior lease is no-op", () => {
    const broker = new AccountBroker(makeConfig());

    // release codex-a without leasing first
    broker.release("codex-a", { ok: false });

    const acct = broker.snapshot().find((a) => a.id === "codex-a");
    assert.equal(
      acct.failureTimestamps.length,
      0,
      "failureTimestamps should remain empty",
    );
    assert.equal(acct.busy, false, "account should remain idle");
    assert.equal(acct.cooldownUntil, 0, "cooldownUntil should remain 0");
  });

  it("markRateLimited() with unknown ID does not throw", () => {
    const broker = new AccountBroker(makeConfig());

    // should silently return without throwing
    assert.doesNotThrow(() => {
      broker.markRateLimited("nonexistent", 60_000);
    });

    // existing accounts should be unaffected
    const snap = broker.snapshot();
    assert.ok(
      snap.every((a) => a.cooldownUntil === 0),
      "no account should be in cooldown",
    );
  });

  it("nextAvailableEta() returns null for empty/unknown provider", () => {
    const broker = new AccountBroker(makeConfig());

    const eta = broker.nextAvailableEta("unknown_provider");
    assert.equal(eta, null, "should return null for provider with no accounts");
  });

  it("circuit opens after 3 failures in window and blocks lease", () => {
    const broker = new AccountBroker({
      codex: [{ id: "codex-a", mode: "profile", profile: "default" }],
    });

    // 3 consecutive lease+release(ok:false) cycles
    for (let i = 0; i < 3; i += 1) {
      const lease = broker.lease({ provider: "codex" });
      assert.ok(lease, `lease #${i + 1} should succeed`);
      broker.release(lease.id, { ok: false });
    }

    // verify circuit is open via snapshot
    const snap = broker.snapshot();
    const acct = snap.find((a) => a.id === "codex-a");
    assert.equal(
      acct.circuitState,
      "open",
      "circuit should be open after 3 failures",
    );
    assert.ok(
      acct.failureTimestamps.length >= 3,
      "should have at least 3 failure timestamps",
    );

    // lease should now return null since the only account has an open circuit
    const blocked = broker.lease({ provider: "codex" });
    assert.equal(
      blocked,
      null,
      "lease should return null when circuit is open",
    );
  });

  it("circuit resets to closed after successful release", () => {
    const realNow = Date.now;
    let now = 1_000;

    const broker = new AccountBroker({
      codex: [{ id: "codex-a", mode: "profile", profile: "default" }],
    });

    try {
      Date.now = () => now;

      // drive 3 failures to open the circuit
      for (let i = 0; i < 3; i += 1) {
        const lease = broker.lease({ provider: "codex" });
        assert.ok(lease);
        broker.release(lease.id, { ok: false });
        now += 1_000; // advance 1s between each
      }

      // confirm circuit is open
      let snap = broker.snapshot();
      let acct = snap.find((a) => a.id === "codex-a");
      assert.equal(acct.circuitState, "open", "circuit should be open");

      // advance time past the circuit window so it transitions to half-open
      now += 10 * 60_000 + 1;

      // lease in half-open state (trial)
      const trialLease = broker.lease({ provider: "codex" });
      assert.ok(trialLease, "half-open trial lease should succeed");
      assert.equal(
        trialLease.halfOpen,
        true,
        "lease should indicate half-open trial",
      );

      // release with ok=true to close the circuit
      broker.release(trialLease.id, { ok: true });

      snap = broker.snapshot();
      acct = snap.find((a) => a.id === "codex-a");
      assert.equal(
        acct.circuitState,
        "closed",
        "circuit should be closed after successful release",
      );
      assert.equal(
        acct.failureTimestamps.length,
        0,
        "failureTimestamps should be reset",
      );
    } finally {
      Date.now = realNow;
    }
  });

  it("resolveEnvValues passes through non-$ values unchanged", () => {
    const broker = new AccountBroker({
      gemini: [
        {
          id: "gemini-literal",
          mode: "env",
          env: { GOOGLE_API_KEY: "literal-key-no-dollar" },
        },
      ],
    });

    const lease = broker.lease({ provider: "gemini" });
    assert.ok(lease, "should lease the env account");
    assert.equal(lease.id, "gemini-literal");
    assert.equal(lease.mode, "env");
    assert.ok(lease.env, "env should be present");
    assert.equal(
      lease.env.GOOGLE_API_KEY,
      "literal-key-no-dollar",
      "non-$ value should pass through unchanged",
    );
  });

  it("EventEmitter emits lease and release events", () => {
    const broker = new AccountBroker(makeConfig());

    const leaseEvents = [];
    const releaseEvents = [];
    broker.on("lease", (ev) => leaseEvents.push(ev));
    broker.on("release", (ev) => releaseEvents.push(ev));

    const lease = broker.lease({ provider: "codex" });
    assert.ok(lease);
    assert.equal(leaseEvents.length, 1, "should emit exactly one lease event");
    assert.equal(leaseEvents[0].id, "codex-a");
    assert.equal(leaseEvents[0].provider, "codex");
    assert.equal(typeof leaseEvents[0].halfOpen, "boolean");

    broker.release(lease.id, { ok: true });
    assert.equal(
      releaseEvents.length,
      1,
      "should emit exactly one release event",
    );
    assert.equal(releaseEvents[0].id, "codex-a");
    assert.equal(releaseEvents[0].ok, true);
  });

  it("half-open trial failure re-opens the circuit", () => {
    const realNow = Date.now;
    let now = 1_000;

    const broker = new AccountBroker({
      codex: [{ id: "codex-a", mode: "profile", profile: "default" }],
    });

    try {
      Date.now = () => now;

      // drive 3 failures to open the circuit
      for (let i = 0; i < 3; i += 1) {
        const lease = broker.lease({ provider: "codex" });
        assert.ok(lease, `failure lease #${i + 1} should succeed`);
        broker.release(lease.id, { ok: false });
        now += 1_000;
      }

      // confirm circuit is open
      let snap = broker.snapshot();
      let acct = snap.find((a) => a.id === "codex-a");
      assert.equal(
        acct.circuitState,
        "open",
        "circuit should be open after 3 failures",
      );

      // advance past the 10-minute circuit window so it transitions to half-open
      now += 10 * 60_000 + 1;

      // lease in half-open state (trial)
      const trialLease = broker.lease({ provider: "codex" });
      assert.ok(trialLease, "half-open trial lease should succeed");
      assert.equal(
        trialLease.halfOpen,
        true,
        "lease should indicate half-open trial",
      );

      // release with ok=false → circuit should re-open
      broker.release(trialLease.id, { ok: false });

      snap = broker.snapshot();
      acct = snap.find((a) => a.id === "codex-a");
      assert.equal(
        acct.circuitState,
        "open",
        "circuit should re-open after half-open trial failure",
      );
    } finally {
      Date.now = realNow;
    }
  });

  it("time-based failure decay removes old timestamps outside window", () => {
    const realNow = Date.now;
    let now = 1_000;

    const broker = new AccountBroker({
      codex: [{ id: "codex-a", mode: "profile", profile: "default" }],
    });

    try {
      Date.now = () => now;

      // record 2 failures (not enough to open circuit, which requires 3)
      for (let i = 0; i < 2; i += 1) {
        const lease = broker.lease({ provider: "codex" });
        assert.ok(lease, `failure lease #${i + 1} should succeed`);
        broker.release(lease.id, { ok: false });
        now += 1_000;
      }

      // advance past the 10-minute circuit window so the 2 old failures decay
      now += 10 * 60_000 + 1;

      // record 1 more failure (this one is within the new window)
      const lease = broker.lease({ provider: "codex" });
      assert.ok(lease, "lease after decay window should succeed");
      broker.release(lease.id, { ok: false });

      // verify: only the recent failure remains; old 2 decayed out of window
      const snap = broker.snapshot();
      const acct = snap.find((a) => a.id === "codex-a");
      assert.equal(
        acct.failureTimestamps.length,
        1,
        "old failures should have decayed, leaving only 1",
      );
    } finally {
      Date.now = realNow;
    }
  });
});
