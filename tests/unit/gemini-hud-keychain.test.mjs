import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const repoRoot = new URL("../..", import.meta.url);

// This suite exercises the Keychain spawn path with a fake `security` binary
// injected via PATH — including on non-darwin CI runners. Force-enable the
// platform-gated spawn in getAntigravityTokenFromKeychain (default-off seam);
// child processes inherit it via `env: process.env`.
process.env.TFX_HUD_KEYCHAIN_FORCE = "1";

async function importHudModule(relativePath) {
  const url = new URL(relativePath, repoRoot);
  url.searchParams.set("t", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

function buildGeminiAuthContextInChild(accountId) {
  const providerUrl = new URL("hud/providers/gemini.mjs", repoRoot);
  providerUrl.searchParams.set("t", `${Date.now()}-${Math.random()}`);
  const script = `
    const mod = await import(${JSON.stringify(providerUrl.href)});
    const context = mod.buildGeminiAuthContext(${JSON.stringify(accountId)});
    process.stdout.write(JSON.stringify(context));
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      encoding: "utf8",
      env: process.env,
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function makeKeychainHome(secretPayload, options = {}) {
  const exitStatus = options.exitStatus ?? 0;
  const homeDir = mkdtempSync(join(tmpdir(), "triflux-gemini-hud-"));
  const binDir = join(homeDir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, "security"),
    `#!/bin/sh
if [ "$1" = "find-generic-password" ] && [ "$2" = "-s" ] && [ "$3" = "gemini" ] && [ "$4" = "-a" ] && [ "$5" = "antigravity" ] && [ "$6" = "-w" ]; then
  printf '%s' '${secretPayload.replaceAll("'", "'\\''")}'
  exit ${exitStatus}
fi
exit 2
`,
    "utf8",
  );
  chmodSync(join(binDir, "security"), 0o755);
  return { homeDir, binDir };
}

function writeGeminiOauth(homeDir, oauth) {
  const geminiDir = join(homeDir, ".gemini");
  mkdirSync(geminiDir, { recursive: true });
  writeFileSync(
    join(geminiDir, "oauth_creds.json"),
    JSON.stringify(oauth),
    "utf8",
  );
}

describe("Gemini HUD Antigravity auth", () => {
  it("uses Antigravity Keychain JSON when oauth_creds.json has no access_token", async () => {
    const originalHome = process.env.HOME;
    const originalPath = process.env.PATH;
    const payload = JSON.stringify({
      accessToken: "keychain-access-token",
      expiryDate: Date.now() + 60_000,
    });
    const { homeDir, binDir } = makeKeychainHome(payload);

    try {
      process.env.HOME = homeDir;
      process.env.PATH = `${binDir}:${originalPath || ""}`;

      const context = buildGeminiAuthContextInChild("agy-main");

      assert.equal(context.oauth.access_token, "keychain-access-token");
      assert.equal(context.oauth.expiry_date > Date.now(), true);
      assert.equal(context.authSource, "antigravity-keychain");
      assert.equal(context.expiryMissing, false);
      assert.notEqual(context.tokenFingerprint, "none");
      assert.match(context.cacheKey, /^agy-main::/);
    } finally {
      process.env.HOME = originalHome;
      process.env.PATH = originalPath;
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("uses Antigravity Keychain raw token when security returns non-JSON", async () => {
    const originalHome = process.env.HOME;
    const originalPath = process.env.PATH;
    const { homeDir, binDir } = makeKeychainHome("raw-keychain-token");

    try {
      process.env.HOME = homeDir;
      process.env.PATH = `${binDir}:${originalPath || ""}`;

      const context = buildGeminiAuthContextInChild("agy-main");

      assert.equal(context.oauth.access_token, "raw-keychain-token");
      assert.equal(context.authSource, "antigravity-keychain");
      assert.equal(context.expiryMissing, true);
      assert.notEqual(context.tokenFingerprint, "none");
    } finally {
      process.env.HOME = originalHome;
      process.env.PATH = originalPath;
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("keeps file oauth when Keychain lookup fails", async () => {
    const originalHome = process.env.HOME;
    const originalPath = process.env.PATH;
    const { homeDir, binDir } = makeKeychainHome("", { exitStatus: 2 });
    writeGeminiOauth(homeDir, {
      access_token: "file-access-token",
      refresh_token: "file-refresh-token",
    });

    try {
      process.env.HOME = homeDir;
      process.env.PATH = `${binDir}:${originalPath || ""}`;

      const context = buildGeminiAuthContextInChild("agy-main");

      assert.equal(context.oauth.access_token, "file-access-token");
      assert.equal(context.oauth.refresh_token, "file-refresh-token");
      assert.equal(context.authSource, "gemini-file");
      assert.equal(context.expiryMissing, true);
    } finally {
      process.env.HOME = originalHome;
      process.env.PATH = originalPath;
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("uses Keychain token when file access token is expired", async () => {
    const originalHome = process.env.HOME;
    const originalPath = process.env.PATH;
    const staleExpiry = Date.now() - 60_000;
    const { homeDir, binDir } = makeKeychainHome("replacement-keychain-token");
    writeGeminiOauth(homeDir, {
      access_token: "expired-file-token",
      expiry_date: staleExpiry,
      refresh_token: "file-refresh-token",
    });

    try {
      process.env.HOME = homeDir;
      process.env.PATH = `${binDir}:${originalPath || ""}`;

      const context = buildGeminiAuthContextInChild("agy-main");

      assert.equal(context.oauth.access_token, "replacement-keychain-token");
      assert.equal(context.oauth.expiry_date, undefined);
      assert.equal(context.oauth.refresh_token, "file-refresh-token");
    } finally {
      process.env.HOME = originalHome;
      process.env.PATH = originalPath;
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("keeps valid file access token even when Keychain has Antigravity token", async () => {
    const originalHome = process.env.HOME;
    const originalPath = process.env.PATH;
    const { homeDir, binDir } = makeKeychainHome("keychain-token");
    writeGeminiOauth(homeDir, {
      access_token: "valid-file-token",
      expiry_date: Date.now() + 60_000,
    });

    try {
      process.env.HOME = homeDir;
      process.env.PATH = `${binDir}:${originalPath || ""}`;

      const context = buildGeminiAuthContextInChild("gemini-main");

      assert.equal(context.oauth.access_token, "valid-file-token");
      assert.equal(context.authSource, "gemini-file");
      assert.equal(context.expiryMissing, false);
    } finally {
      process.env.HOME = originalHome;
      process.env.PATH = originalPath;
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("does not keep stale file expiry when using Keychain raw token", async () => {
    const originalHome = process.env.HOME;
    const originalPath = process.env.PATH;
    const staleExpiry = Date.now() - 60_000;
    const { homeDir, binDir } = makeKeychainHome("fresh-keychain-raw-token");
    writeGeminiOauth(homeDir, {
      expiry_date: staleExpiry,
      refresh_token: "file-refresh-token",
    });

    try {
      process.env.HOME = homeDir;
      process.env.PATH = `${binDir}:${originalPath || ""}`;

      const context = buildGeminiAuthContextInChild("agy-main");

      assert.equal(context.oauth.access_token, "fresh-keychain-raw-token");
      assert.equal(context.oauth.expiry_date, undefined);
      assert.equal(context.oauth.refresh_token, "file-refresh-token");
    } finally {
      process.env.HOME = originalHome;
      process.env.PATH = originalPath;
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

describe("Gemini HUD unlimited quota", () => {
  it("classifies quota failures so expiry-less Keychain tokens produce auth-specific cache errors", async () => {
    const { classifyGeminiQuotaFailure } = await importHudModule(
      "hud/providers/gemini.mjs",
    );

    assert.equal(
      classifyGeminiQuotaFailure(
        { error: { code: 401, status: "UNAUTHENTICATED" } },
        { authSource: "antigravity-keychain", expiryMissing: true },
      ),
      "auth",
    );
    assert.equal(classifyGeminiQuotaFailure(null), "network");
    assert.equal(
      classifyGeminiQuotaFailure({ error: { code: 500, message: "backend" } }),
      "api",
    );
  });

  it("returns an unlimited sentinel instead of coercing Infinity into a percent", async () => {
    const { deriveGeminiLimits } = await importHudModule(
      "hud/providers/gemini.mjs",
    );

    const result = deriveGeminiLimits({
      modelId: "gemini-workspace",
      remainingFraction: Infinity,
      resetTime: null,
    });

    assert.deepEqual(result, {
      unlimited: true,
      usedPct: null,
      remaining: null,
      limit: null,
      resetTime: null,
      modelId: "gemini-workspace",
    });
  });

  it("renders unlimited Gemini quota as infinity in provider rows", async () => {
    const { getProviderRow } = await importHudModule("hud/renderers.mjs");
    const { geminiBlue } = await importHudModule("hud/colors.mjs");
    const { stripAnsi } = await importHudModule("hud/utils.mjs");

    const row = getProviderRow(
      "minimal",
      "gemini",
      "g",
      geminiBlue,
      {},
      {},
      {},
      {
        type: "gemini",
        pools: {
          pro: { modelId: "gemini-pro-workspace", remainingFraction: Infinity },
          flash: { modelId: "gemini-flash-workspace", unlimited: true },
        },
      },
      null,
      null,
      null,
    );

    const visible = stripAnsi(row.left);
    assert.equal(visible, "Pr:∞ Fl:∞");
    assert.doesNotMatch(visible, /--%|0%|100%/);
  });
});
