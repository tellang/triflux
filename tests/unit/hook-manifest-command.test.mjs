import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const MANIFESTS = [
  "hooks/hooks.json",
  "packages/core/hooks/hooks.json",
  "packages/triflux/hooks/hooks.json",
];

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

function collectCommands(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const commands = [];
  for (const entries of Object.values(manifest.hooks || {})) {
    for (const entry of entries || []) {
      for (const hook of entry.hooks || []) {
        if (hook?.type === "command" && typeof hook.command === "string") {
          commands.push(hook.command);
        }
      }
    }
  }
  return commands;
}

describe("hook manifests", () => {
  let tempDir;
  let registryPath;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "triflux-hook-manifest-"));
    registryPath = join(tempDir, "hook-registry.json");
    writeFileSync(
      registryPath,
      JSON.stringify({ events: { PreToolUse: [] } }),
      "utf8",
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("do not shell-expand a missing CLAUDE_PLUGIN_ROOT into /hooks", () => {
    for (const manifest of MANIFESTS) {
      for (const command of collectCommands(manifest)) {
        assert.equal(
          command.includes("${CLAUDE_PLUGIN_ROOT}/hooks/hook-orchestrator.mjs"),
          false,
          `${manifest} still depends on shell expansion of CLAUDE_PLUGIN_ROOT`,
        );
      }
    }
  });

  it("can invoke the orchestrator from Codex-style env with no plugin root", () => {
    const [command] = collectCommands("hooks/hooks.json");
    const emptyHome = join(tempDir, "empty-home");
    const env = {
      ...process.env,
      HOME: emptyHome,
      USERPROFILE: emptyHome,
      TRIFLUX_HOOK_REGISTRY: registryPath,
    };
    delete env.CLAUDE_PLUGIN_ROOT;
    delete env.PLUGIN_ROOT;

    const result = spawnSync("sh", ["-lc", command], {
      cwd: repoRoot(),
      env,
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
      }),
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
  });

  it("still honors CLAUDE_PLUGIN_ROOT when the host provides it", () => {
    const [command] = collectCommands("hooks/hooks.json");
    const env = {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: repoRoot(),
      TRIFLUX_HOOK_REGISTRY: registryPath,
    };

    const result = spawnSync("sh", ["-lc", command], {
      cwd: tempDir,
      env,
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
      }),
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
  });

  it("prefers PLUGIN_ROOT over a stale CLAUDE_PLUGIN_ROOT", () => {
    const [command] = collectCommands("hooks/hooks.json");
    const env = {
      ...process.env,
      PLUGIN_ROOT: repoRoot(),
      CLAUDE_PLUGIN_ROOT: join(tempDir, "stale-claude-root"),
      TRIFLUX_HOOK_REGISTRY: registryPath,
    };

    const result = spawnSync("sh", ["-lc", command], {
      cwd: tempDir,
      env,
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
      }),
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
});
