import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const HOOK_PATH = join(process.cwd(), "hooks", "pre-compact-snapshot.mjs");

describe("pre-compact-snapshot hook", () => {
  let sandboxDir;

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), "tfx-precompact-"));
    execFileSync("git", ["init"], {
      cwd: sandboxDir,
      stdio: ["ignore", "ignore", "ignore"],
    });
    execFileSync("git", ["checkout", "-b", "feature/precompact"], {
      cwd: sandboxDir,
      stdio: ["ignore", "ignore", "ignore"],
    });
  });

  afterEach(() => {
    rmSync(sandboxDir, { recursive: true, force: true });
  });

  it("emits bounded PreCompact additionalContext without sensitive payload", () => {
    mkdirSync(join(sandboxDir, ".omx", "state"), { recursive: true });
    writeFileSync(join(sandboxDir, "changed.txt"), "dirty", "utf8");
    writeFileSync(
      join(sandboxDir, ".omx", "state", "ultrawork-state.json"),
      JSON.stringify({
        mode: "ultrawork",
        active: true,
        current_phase: "verify",
      }),
      "utf8",
    );

    const result = spawnSync(process.execPath, [HOOK_PATH], {
      cwd: sandboxDir,
      input: JSON.stringify({
        hook_event_name: "PreCompact",
        session_id: "session-a",
      }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CWD: sandboxDir },
    });

    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    const context = output.hookSpecificOutput.additionalContext;
    assert.equal(output.hookSpecificOutput.hookEventName, "PreCompact");
    assert.match(context, /git: feature\/precompact; dirty=2/u);
    assert.match(context, /active_modes: ultrawork:verify/u);
    assert.ok(Buffer.byteLength(context, "utf8") <= 3000);
    assert.doesNotMatch(context, /TOKEN|SECRET|AUTH/u);
  });

  it("is registered through hooks.json and hook-registry.json", () => {
    const hooks = JSON.parse(
      readFileSync(join(process.cwd(), "hooks", "hooks.json"), "utf8"),
    );
    const registry = JSON.parse(
      readFileSync(join(process.cwd(), "hooks", "hook-registry.json"), "utf8"),
    );

    assert.ok(hooks.hooks.PreCompact, "hooks.json must expose PreCompact");
    assert.equal(
      registry.events.PreCompact?.[0]?.id,
      "tfx-pre-compact-snapshot",
    );
    assert.ok(existsSync(HOOK_PATH), "snapshot hook script must exist");
  });
});
