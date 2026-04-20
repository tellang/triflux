import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

describe("state-store — Issue #116-B auto-discover", () => {
  let tmpDir;
  const savedEnv = {};

  const ENV_KEYS = ["TFX_HUB_PID_DIR", "CLAUDE_SESSION_ID", "TFX_TEAM_PROFILE"];

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `tfx-state-store-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.TFX_HUB_PID_DIR = tmpDir;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function freshImport() {
    return await import(
      `../../hub/team/cli/services/state-store.mjs?t=${Date.now()}-${Math.random()}`
    );
  }

  it("returns null when no state files exist", async () => {
    delete process.env.CLAUDE_SESSION_ID;
    const mod = await freshImport();
    assert.equal(mod.loadTeamState(), null);
  });

  it("auto-discovers the latest team-state-*.json when CLAUDE_SESSION_ID is unset", async () => {
    delete process.env.CLAUDE_SESSION_ID;
    writeFileSync(
      join(tmpDir, "team-state-tfx-multi-aaaa.json"),
      JSON.stringify({
        sessionName: "older",
        startedAt: 1000,
        profile: "team",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(
      join(tmpDir, "team-state-tfx-multi-bbbb.json"),
      JSON.stringify({
        sessionName: "newer",
        startedAt: 2000,
        profile: "team",
      }),
    );
    const mod = await freshImport();
    const state = mod.loadTeamState();
    assert.equal(state?.sessionName, "newer");
  });

  it("returns the explicit session file when a sessionId is passed", async () => {
    writeFileSync(
      join(tmpDir, "team-state-wanted.json"),
      JSON.stringify({
        sessionName: "explicit",
        profile: "team",
      }),
    );
    writeFileSync(
      join(tmpDir, "team-state-other.json"),
      JSON.stringify({
        sessionName: "decoy",
        profile: "team",
      }),
    );
    const mod = await freshImport();
    assert.equal(mod.loadTeamState("wanted").sessionName, "explicit");
  });

  it("does NOT auto-discover when an explicit sessionId is passed but missing", async () => {
    writeFileSync(
      join(tmpDir, "team-state-tfx-multi-xyz.json"),
      JSON.stringify({ sessionName: "other", profile: "team" }),
    );
    const mod = await freshImport();
    assert.equal(mod.loadTeamState("nonexistent"), null);
  });

  it("skips auto-discovered files with a mismatched profile", async () => {
    delete process.env.CLAUDE_SESSION_ID;
    process.env.TFX_TEAM_PROFILE = "team";
    writeFileSync(
      join(tmpDir, "team-state-codex.json"),
      JSON.stringify({ sessionName: "codex", profile: "codex-team" }),
    );
    const mod = await freshImport();
    assert.equal(mod.loadTeamState(), null);
  });

  it("falls back to legacy team-state.json before auto-discovering", async () => {
    process.env.CLAUDE_SESSION_ID = "missing-session";
    writeFileSync(
      join(tmpDir, "team-state.json"),
      JSON.stringify({ sessionName: "legacy", profile: "team" }),
    );
    writeFileSync(
      join(tmpDir, "team-state-tfx-multi-other.json"),
      JSON.stringify({ sessionName: "other", profile: "team" }),
    );
    const mod = await freshImport();
    assert.equal(mod.loadTeamState().sessionName, "legacy");
  });

  it("honors TFX_HUB_PID_DIR override", async () => {
    const mod = await freshImport();
    assert.equal(mod.HUB_PID_DIR, tmpDir);
  });
});
