import assert from "node:assert/strict";
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

async function importHudModule(relativePath) {
  const url = new URL(relativePath, repoRoot);
  url.searchParams.set("t", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

function makeKeychainHome(secretPayload) {
  const homeDir = mkdtempSync(join(tmpdir(), "triflux-gemini-hud-"));
  const binDir = join(homeDir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, "security"),
    `#!/bin/sh
if [ "$1" = "find-generic-password" ] && [ "$2" = "-s" ] && [ "$3" = "gemini" ] && [ "$4" = "-a" ] && [ "$5" = "antigravity" ] && [ "$6" = "-w" ]; then
  printf '%s' '${secretPayload.replaceAll("'", "'\\''")}'
  exit 0
fi
exit 2
`,
    "utf8",
  );
  chmodSync(join(binDir, "security"), 0o755);
  return { homeDir, binDir };
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

      const { buildGeminiAuthContext } = await importHudModule(
        "hud/providers/gemini.mjs",
      );
      const context = buildGeminiAuthContext("agy-main");

      assert.equal(context.oauth.access_token, "keychain-access-token");
      assert.equal(context.oauth.expiry_date > Date.now(), true);
      assert.notEqual(context.tokenFingerprint, "none");
      assert.match(context.cacheKey, /^agy-main::/);
    } finally {
      process.env.HOME = originalHome;
      process.env.PATH = originalPath;
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

describe("Gemini HUD unlimited quota", () => {
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
