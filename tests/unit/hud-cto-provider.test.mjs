import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { readCtoStatus } from "../../hud/providers/cto.mjs";

describe("CTO HUD provider", () => {
  let rootDir;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "triflux-cto-hud-"));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("returns null without throwing when the current lake brief is missing", () => {
    assert.doesNotThrow(() => {
      assert.equal(
        readCtoStatus({ rootDir, env: { TFX_CTO_AUTO_COLLECT: "1" } }),
        null,
      );
    });
  });

  it("hides the CTO row unless auto-collect is enabled", () => {
    const lakeDir = join(rootDir, ".triflux", "lake");
    mkdirSync(lakeDir, { recursive: true });
    writeFileSync(join(lakeDir, "current.md"), "summary: old CTO state\n");

    assert.equal(readCtoStatus({ rootDir, env: {} }), null);
    assert.equal(
      readCtoStatus({ rootDir, env: { TFX_CTO_AUTO_COLLECT: "0" } }),
      null,
    );
    assert.equal(
      readCtoStatus({
        rootDir,
        env: { TFX_CTO: "0", TFX_CTO_AUTO_COLLECT: "1" },
      }),
      null,
    );
  });

  it("returns the current brief summary line and version tag when enabled", () => {
    const lakeDir = join(rootDir, ".triflux", "lake");
    mkdirSync(lakeDir, { recursive: true });
    writeFileSync(
      join(lakeDir, "current.md"),
      [
        "brief_version: cto-lake.v1",
        "repo_state",
        "summary: ship the CTO HUD row",
        "active_goals",
        "- G1 in_progress: keep operators aligned",
        "",
      ].join("\n"),
      "utf8",
    );

    const status = readCtoStatus({
      rootDir,
      env: { TFX_CTO_AUTO_COLLECT: "1" },
    });

    assert.deepEqual(status, {
      line: "ship the CTO HUD row",
      rightTag: "cto-lake.v1",
    });
  });
});
