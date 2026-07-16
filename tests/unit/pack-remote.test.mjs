// tests/unit/pack-remote.test.mjs — remote package assembly regressions

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("remote package assembly", () => {
  it("copies the core Codex intervention dependency", () => {
    const packScript = readFileSync("scripts/pack.mjs", "utf8");
    assert.match(
      packScript,
      new RegExp(JSON.stringify("hub/team/intervention.mjs"), "u"),
    );
  });

  it("copies tray and CTO runtime dependencies into @triflux/remote", () => {
    const packScript = readFileSync("scripts/pack.mjs", "utf8");

    for (const requiredFile of [
      "hub/mac-tray.swift",
      "hub/mac-focus.mjs",
      "hub/promote-penalties.mjs",
      "hub/tray-runtime.mjs",
      "hub/tray-state.mjs",
      "cto/brief.mjs",
      "cto/collect.mjs",
      "cto/hygiene-actions.mjs",
      "cto/status.mjs",
      "cto/current.schema.json",
    ]) {
      assert.match(packScript, new RegExp(JSON.stringify(requiredFile), "u"));
    }
  });

  it("publishes the copied CTO files in the @triflux/remote tarball", () => {
    const packageJson = JSON.parse(
      readFileSync("packages/remote/package.json", "utf8"),
    );

    assert.ok(packageJson.files.includes("hub"));
    assert.ok(packageJson.files.includes("cto"));
    assert.ok(packageJson.files.includes("scripts/lib"));
  });

  it("declares runtime dependencies used by copied remote files", () => {
    const packageJson = JSON.parse(
      readFileSync("packages/remote/package.json", "utf8"),
    );
    const deps = {
      ...packageJson.peerDependencies,
      ...packageJson.dependencies,
    };

    for (const dependency of [
      "@modelcontextprotocol/sdk",
      "@triflux/core",
      "ajv",
      "better-sqlite3",
      "pino",
      "pino-pretty",
      "systray2",
      "zod",
    ]) {
      assert.ok(deps[dependency], `${dependency} must be declared`);
    }
  });
});
