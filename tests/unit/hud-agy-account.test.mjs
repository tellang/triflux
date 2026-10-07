import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

const providerUrl = new URL("../../hud/providers/gemini.mjs", import.meta.url);

function accountLabel(homeDir) {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { getAntigravityAccountLabel } from ${JSON.stringify(providerUrl.href)}; process.stdout.write(getAntigravityAccountLabel() || "");`,
    ],
    { encoding: "utf8", env: { ...process.env, HOME: homeDir } },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

it("shows the GCP project when Antigravity authenticates with a project", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "triflux-agy-hud-"));
  try {
    const agyDir = join(homeDir, ".gemini", "antigravity-cli");
    mkdirSync(agyDir, { recursive: true });
    writeFileSync(
      join(agyDir, "settings.json"),
      JSON.stringify({ gcp: { project: "test-project" } }),
    );
    writeFileSync(
      join(agyDir, "oauth_creds.json"),
      JSON.stringify({ email: "user@example.test" }),
    );
    assert.equal(accountLabel(homeDir), "test-project");
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

it("shows the Antigravity OAuth email when no GCP project is configured", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "triflux-agy-hud-"));
  try {
    const agyDir = join(homeDir, ".gemini", "antigravity-cli");
    mkdirSync(agyDir, { recursive: true });
    writeFileSync(
      join(agyDir, "oauth_creds.json"),
      JSON.stringify({ email: "user@example.test" }),
    );
    assert.equal(accountLabel(homeDir), "user@example.test");
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
