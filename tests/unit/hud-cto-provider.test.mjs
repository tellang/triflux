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
      assert.equal(readCtoStatus({ rootDir }), null);
    });
  });

  it("returns the current brief summary line and version tag", () => {
    const lakeDir = join(rootDir, ".triflux", "lake");
    mkdirSync(lakeDir, { recursive: true });
    writeFileSync(
      join(lakeDir, "current.md"),
      [
        "brief_version: cto-lake.v1",
        "repo_state",
        "summary: ship the always-on HUD row",
        "active_goals",
        "- G1 in_progress: keep operators aligned",
        "",
      ].join("\n"),
      "utf8",
    );

    const status = readCtoStatus({ rootDir });

    assert.deepEqual(status, {
      line: "ship the always-on HUD row",
      rightTag: "cto-lake.v1",
    });
  });
});
