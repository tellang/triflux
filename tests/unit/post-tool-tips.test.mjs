import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";

const PROJECT_ROOT = resolve(new URL("../..", import.meta.url).pathname);
const HOOK_PATH = join(PROJECT_ROOT, "hooks", "post-tool-tips.mjs");

const tempDirs = [];

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "triflux-post-tool-tips-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    rmSync(dir, { recursive: true, force: true });
  }
});

function runHook(payload, env = {}) {
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function postToolPayload(toolName, toolInput) {
  return {
    hook_event_name: "PostToolUse",
    tool_name: toolName,
    cwd: PROJECT_ROOT,
    tool_input: toolInput,
  };
}

describe("post-tool-tips hook", () => {
  it("is opt-in and silently skips when TFX_POST_TOOL_TIPS is not enabled", () => {
    const output = runHook(
      postToolPayload("Edit", {
        file_path: join(PROJECT_ROOT, "hooks", "hook-registry.json"),
      }),
      {
        TRIFLUX_POST_TOOL_TIPS_STATE_DIR: makeTempDir(),
        TFX_POST_TOOL_TIPS: "",
      },
    );

    assert.equal(output, null);
  });

  it("emits hook lifecycle reminder for hooks registry edits", () => {
    const output = runHook(
      postToolPayload("Edit", {
        file_path: join(PROJECT_ROOT, "hooks", "hook-registry.json"),
      }),
      {
        TRIFLUX_POST_TOOL_TIPS_STATE_DIR: makeTempDir(),
        TFX_POST_TOOL_TIPS: "1",
      },
    );

    assert.ok(output?.systemMessage);
    assert.match(output.systemMessage, /\[post-tool-tips\]/);
    assert.match(output.systemMessage, /hook lifecycle/i);
    assert.match(output.systemMessage, /mirror/i);
    assert.match(output.systemMessage, /release:check-mirror/);
  });

  it("emits package mirror reminder for package hook edits", () => {
    const output = runHook(
      postToolPayload("Write", {
        file_path: join(
          PROJECT_ROOT,
          "packages",
          "triflux",
          "hooks",
          "session-end-cleanup.mjs",
        ),
      }),
      {
        TRIFLUX_POST_TOOL_TIPS_STATE_DIR: makeTempDir(),
        TFX_POST_TOOL_TIPS: "1",
      },
    );

    assert.ok(output?.systemMessage);
    assert.match(output.systemMessage, /package hook mirror/i);
    assert.match(output.systemMessage, /packages\/core/);
    assert.match(output.systemMessage, /packages\/triflux/);
  });

  it("emits team runtime reminder for hub team edits", () => {
    const output = runHook(
      postToolPayload("Edit", {
        file_path: join(PROJECT_ROOT, "hub", "team", "retry-state-machine.mjs"),
      }),
      {
        TRIFLUX_POST_TOOL_TIPS_STATE_DIR: makeTempDir(),
        TFX_POST_TOOL_TIPS: "1",
      },
    );

    assert.ok(output?.systemMessage);
    assert.match(output.systemMessage, /team runtime/i);
    assert.match(output.systemMessage, /swarm|retry|pipeline/i);
  });

  it("emits MCP reminder for mcp-related script edits", () => {
    const output = runHook(
      postToolPayload("Edit", {
        file_path: join(PROJECT_ROOT, "scripts", "mcp-gateway-start.mjs"),
      }),
      {
        TRIFLUX_POST_TOOL_TIPS_STATE_DIR: makeTempDir(),
        TFX_POST_TOOL_TIPS: "1",
      },
    );

    assert.ok(output?.systemMessage);
    assert.match(output.systemMessage, /MCP/i);
    assert.match(output.systemMessage, /stdio/i);
  });

  it("emits instruction-source reminder for AGENTS or rules edits", () => {
    const output = runHook(
      postToolPayload("Edit", { file_path: join(PROJECT_ROOT, "AGENTS.md") }),
      {
        TRIFLUX_POST_TOOL_TIPS_STATE_DIR: makeTempDir(),
        TFX_POST_TOOL_TIPS: "1",
      },
    );

    assert.ok(output?.systemMessage);
    assert.match(output.systemMessage, /instruction source/i);
    assert.match(output.systemMessage, /do not mix/i);
  });

  it("extracts conservative path tokens from Bash PostToolUse commands", () => {
    const output = runHook(
      postToolPayload("Bash", {
        command: "node scripts/mcp-gateway-start.mjs --help",
      }),
      {
        TRIFLUX_POST_TOOL_TIPS_STATE_DIR: makeTempDir(),
        TFX_POST_TOOL_TIPS: "1",
      },
    );

    assert.ok(output?.systemMessage);
    assert.match(output.systemMessage, /MCP/i);
  });

  it("extracts absolute repo-local path tokens from Bash PostToolUse commands", () => {
    const absolutePath = join(PROJECT_ROOT, "hooks", "hook-registry.json");
    const output = runHook(
      postToolPayload("Bash", { command: `node ${absolutePath}` }),
      {
        TRIFLUX_POST_TOOL_TIPS_STATE_DIR: makeTempDir(),
        TFX_POST_TOOL_TIPS: "1",
      },
    );

    assert.ok(output?.systemMessage);
    assert.match(output.systemMessage, /hook lifecycle/i);
  });

  it("skips unrelated paths", () => {
    const output = runHook(
      postToolPayload("Edit", { file_path: join(PROJECT_ROOT, "README.md") }),
      {
        TRIFLUX_POST_TOOL_TIPS_STATE_DIR: makeTempDir(),
        TFX_POST_TOOL_TIPS: "1",
      },
    );

    assert.equal(output, null);
  });

  it("dedupes repeated reminders for the same rule and real path", () => {
    const stateDir = makeTempDir();
    const env = {
      TRIFLUX_POST_TOOL_TIPS_STATE_DIR: stateDir,
      TFX_POST_TOOL_TIPS: "1",
    };
    const payload = postToolPayload("Edit", {
      file_path: join(PROJECT_ROOT, "hooks", "hook-registry.json"),
    });

    const first = runHook(payload, env);
    const second = runHook(payload, env);

    assert.ok(first?.systemMessage);
    assert.equal(second, null);
  });

  it("bounds output so reminders cannot bloat hook context", () => {
    const output = runHook(
      postToolPayload("Bash", {
        command:
          "node hooks/hook-registry.json packages/triflux/hooks/hooks.json packages/core/hooks/hooks.json hub/team/retry-state-machine.mjs scripts/mcp-gateway-start.mjs AGENTS.md",
      }),
      {
        TRIFLUX_POST_TOOL_TIPS_STATE_DIR: makeTempDir(),
        TFX_POST_TOOL_TIPS: "1",
      },
    );

    assert.ok(output?.systemMessage);
    assert.ok(output.systemMessage.length <= 1200, output.systemMessage.length);
  });

  it("is registered through hooks.json and hook-registry.json", () => {
    const hooks = JSON.parse(
      readFileSync(join(PROJECT_ROOT, "hooks", "hooks.json"), "utf8"),
    );
    const registry = JSON.parse(
      readFileSync(join(PROJECT_ROOT, "hooks", "hook-registry.json"), "utf8"),
    );

    assert.ok(
      hooks.hooks.PostToolUse.some(
        (entry) => entry.matcher === "Bash|Edit|Write",
      ),
      "hooks.json must expose PostToolUse for Bash|Edit|Write",
    );
    assert.ok(
      registry.events.PostToolUse.some(
        (entry) =>
          entry.id === "tfx-post-tool-tips" &&
          entry.matcher === "Bash|Edit|Write" &&
          entry.command.includes("post-tool-tips.mjs"),
      ),
      "hook-registry.json must register tfx-post-tool-tips",
    );
  });

  it("package hook mirrors include the hook script and registry entry", () => {
    for (const packageName of ["triflux", "core"]) {
      const hookPath = join(
        PROJECT_ROOT,
        "packages",
        packageName,
        "hooks",
        "post-tool-tips.mjs",
      );
      const registry = JSON.parse(
        readFileSync(
          join(
            PROJECT_ROOT,
            "packages",
            packageName,
            "hooks",
            "hook-registry.json",
          ),
          "utf8",
        ),
      );
      const hooks = JSON.parse(
        readFileSync(
          join(PROJECT_ROOT, "packages", packageName, "hooks", "hooks.json"),
          "utf8",
        ),
      );

      assert.ok(
        existsSync(hookPath),
        `${packageName} must mirror post-tool-tips.mjs`,
      );
      assert.ok(
        registry.events.PostToolUse.some(
          (entry) => entry.id === "tfx-post-tool-tips",
        ),
        `${packageName} registry must include tfx-post-tool-tips`,
      );
      assert.ok(
        hooks.hooks.PostToolUse.some(
          (entry) => entry.matcher === "Bash|Edit|Write",
        ),
        `${packageName} hooks.json must expose Bash|Edit|Write PostToolUse`,
      );
    }
  });
});
