import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { CACHE_TTL_MS, runPreflight } from "../../scripts/preflight-cache.mjs";

const READY_EXPIRY_MS = CACHE_TTL_MS + 120_000;

function makeHome({ antigravityAuth } = {}) {
  const homeDir = mkdtempSync(join(tmpdir(), "tfx-preflight-agy-"));
  mkdirSync(join(homeDir, ".claude", "scripts"), { recursive: true });
  writeFileSync(
    join(homeDir, ".claude", "scripts", "tfx-route.sh"),
    "",
    "utf8",
  );

  if (antigravityAuth) {
    mkdirSync(join(homeDir, ".gemini"), { recursive: true });
    const authText =
      typeof antigravityAuth === "string"
        ? antigravityAuth
        : JSON.stringify(antigravityAuth);
    writeFileSync(join(homeDir, ".gemini", "oauth_creds.json"), authText, "utf8");
  }

  return homeDir;
}

function makePreflightOptions(
  homeDir,
  helpText,
  { helpStderr = "", smoke = { status: 1, stdout: "", stderr: "" } } = {},
) {
  return {
    homeDir,
    probeClisFn: async () => ({
      codex: { ok: false },
      gemini: { ok: false },
      agy: { ok: true, path: "/fake/bin/agy" },
    }),
    checkHubFn: () => ({ ok: true, state: "healthy" }),
    detectCodexPlanFn: () => ({ plan: "pro", source: "test" }),
    spawnSyncFn: (_command, args) => {
      if (args.includes("--help")) {
        return { status: 0, stdout: helpText, stderr: helpStderr };
      }
      return smoke;
    },
  };
}

describe("preflight-cache Antigravity readiness", () => {
  it("marks Antigravity ready only when headless flags and auth file are present", async () => {
    const homeDir = makeHome({
      antigravityAuth: { expiry_date: Date.now() + READY_EXPIRY_MS },
    });
    try {
      const result = await runPreflight(
        makePreflightOptions(
          homeDir,
          "Usage: agy\n  --print\n  --dangerously-skip-permissions\n",
        ),
      );

      assert.deepEqual(result.antigravity, {
        ok: true,
        path: "/fake/bin/agy",
        reason: "ready",
      });
      assert.ok(result.available_agents.includes("antigravity"));
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("does not enable Antigravity auto fallback when auth expires within the readiness window", async () => {
    const homeDir = makeHome({
      antigravityAuth: { expiry_date: Date.now() + CACHE_TTL_MS - 1 },
    });
    try {
      const result = await runPreflight(
        makePreflightOptions(
          homeDir,
          "Usage: agy\n  --print\n  --dangerously-skip-permissions\n",
        ),
      );

      assert.equal(result.antigravity.ok, false);
      assert.equal(result.antigravity.reason, "auth_expired");
      assert.ok(!result.available_agents.includes("antigravity"));
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("accepts Antigravity headless help flags emitted on stderr", async () => {
    const homeDir = makeHome({
      antigravityAuth: { expiry_date: Date.now() + READY_EXPIRY_MS },
    });
    try {
      const result = await runPreflight(
        makePreflightOptions(homeDir, "", {
          helpStderr:
            "Usage: agy\n  --print\n  --dangerously-skip-permissions\n",
        }),
      );

      assert.equal(result.antigravity.ok, true);
      assert.equal(result.antigravity.reason, "ready");
      assert.ok(result.available_agents.includes("antigravity"));
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("accepts expired Antigravity auth when non-interactive smoke succeeds", async () => {
    const homeDir = makeHome({
      antigravityAuth: { expiry_date: Date.now() - 30_000 },
    });
    try {
      const result = await runPreflight(
        makePreflightOptions(
          homeDir,
          "Usage: agy\n  --print\n  --dangerously-skip-permissions\n",
          {
            smoke: {
              status: 0,
              stdout: "AGY_OK\nError: timed out waiting for response\n",
              stderr: "",
            },
          },
        ),
      );

      assert.equal(result.antigravity.ok, true);
      assert.equal(result.antigravity.reason, "ready");
      assert.ok(result.available_agents.includes("antigravity"));
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("does not accept non-sentinel smoke output as Antigravity readiness", async () => {
    const homeDir = makeHome({
      antigravityAuth: { expiry_date: Date.now() - 30_000 },
    });
    try {
      const result = await runPreflight(
        makePreflightOptions(
          homeDir,
          "Usage: agy\n  --print\n  --dangerously-skip-permissions\n",
          { smoke: { status: 0, stdout: "Welcome to agy\n", stderr: "" } },
        ),
      );

      assert.equal(result.antigravity.ok, false);
      assert.equal(result.antigravity.reason, "auth_expired");
      assert.ok(!result.available_agents.includes("antigravity"));
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("does not enable Antigravity auto fallback for auth files without expiry_date", async () => {
    const homeDir = makeHome({ antigravityAuth: {} });
    try {
      const result = await runPreflight(
        makePreflightOptions(
          homeDir,
          "Usage: agy\n  --print\n  --dangerously-skip-permissions\n",
        ),
      );

      assert.equal(result.antigravity.ok, false);
      assert.equal(result.antigravity.reason, "auth_expired");
      assert.ok(!result.available_agents.includes("antigravity"));
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("does not enable Antigravity auto fallback for malformed auth JSON", async () => {
    const homeDir = makeHome({ antigravityAuth: "{" });
    try {
      const result = await runPreflight(
        makePreflightOptions(
          homeDir,
          "Usage: agy\n  --print\n  --dangerously-skip-permissions\n",
        ),
      );

      assert.equal(result.antigravity.ok, false);
      assert.equal(result.antigravity.reason, "auth_invalid");
      assert.ok(!result.available_agents.includes("antigravity"));
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("does not enable Antigravity auto fallback without auth", async () => {
    const homeDir = makeHome();
    try {
      const result = await runPreflight(
        makePreflightOptions(
          homeDir,
          "Usage: agy\n  --print\n  --dangerously-skip-permissions\n",
        ),
      );

      assert.equal(result.antigravity.ok, false);
      assert.equal(result.antigravity.reason, "auth_missing");
      assert.ok(!result.available_agents.includes("antigravity"));
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("does not enable Antigravity auto fallback without headless flags", async () => {
    const homeDir = makeHome({
      antigravityAuth: { expiry_date: Date.now() + READY_EXPIRY_MS },
    });
    try {
      const result = await runPreflight(
        makePreflightOptions(homeDir, "Usage: agy\n  chat\n"),
      );

      assert.equal(result.antigravity.ok, false);
      assert.equal(result.antigravity.reason, "headless_unsupported");
      assert.ok(!result.available_agents.includes("antigravity"));
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
