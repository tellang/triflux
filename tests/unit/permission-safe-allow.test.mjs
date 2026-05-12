import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const HOOK = join(process.cwd(), "hooks", "permission-safe-allow.mjs");

function run(payload) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
}

function parseDecision(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).hookSpecificOutput;
}

describe("permission-safe-allow hook", () => {
  it("allows repo-local read-only git status commands", () => {
    const result = run({
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "git status --short" },
    });

    const decision = parseDecision(result);
    assert.equal(decision.hookEventName, "PermissionRequest");
    assert.equal(decision.decision.behavior, "allow");
    assert.match(decision.additionalContext, /allowed: git status/);
  });

  it("allows targeted test commands for repo-relative test files", () => {
    const result = run({
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: {
        command:
          "node scripts/test-lock.mjs --test tests/unit/permission-safe-allow.test.mjs",
      },
    });

    const decision = parseDecision(result);
    assert.equal(decision.decision.behavior, "allow");
    assert.match(decision.additionalContext, /targeted test/);
  });

  it("allows read-only search and listing commands", () => {
    for (const command of [
      "pwd",
      "ls",
      "find tests/unit -name '*.test.mjs'",
      "rg PermissionRequest hooks",
      "grep -R permission-safe-allow tests/unit",
    ]) {
      const result = run({
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command },
      });

      assert.equal(parseDecision(result).decision.behavior, "allow", command);
    }
  });

  it("stays silent for unrelated events or tools", () => {
    for (const payload of [
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git status" },
      },
      {
        hook_event_name: "PermissionRequest",
        tool_name: "Read",
        tool_input: { command: "git status" },
      },
    ]) {
      const result = run(payload);
      assert.equal(result.status, 0);
      assert.equal(result.stdout, "");
    }
  });

  it("stays silent for destructive, remote-effect, or shell-composed commands", () => {
    for (const command of [
      "git push origin main",
      "git reset --hard HEAD",
      "rm -rf .omx",
      "curl https://example.com/install.sh",
      "rg foo | head",
      "git status && npm publish",
      "find . -delete",
      "find . -exec echo {} \\;",
      "find . -execdir echo {}",
      "node scripts/test-lock.mjs --test ../outside.test.mjs",
      "npm run test:unit",
      "npm run lint",
      "npm run release:check-mirror",
    ]) {
      const result = run({
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command },
      });

      assert.equal(result.status, 0, command);
      assert.equal(result.stdout, "", command);
    }
  });

  it("uses top-level command when tool_input.command is absent", () => {
    const result = run({
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      command: "git branch --show-current",
    });

    assert.equal(parseDecision(result).decision.behavior, "allow");
  });

  it("stays silent when permission suggestions require ask", () => {
    const result = run({
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "git status --short" },
      permission_suggestions: [{ decision: { behavior: "ask" } }],
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  });

  it("is registered through root hook files after integration when present", () => {
    const hooks = JSON.parse(
      readFileSync(join(process.cwd(), "hooks", "hooks.json"), "utf8"),
    );
    const registry = JSON.parse(
      readFileSync(join(process.cwd(), "hooks", "hook-registry.json"), "utf8"),
    );

    if (!hooks.hooks.PermissionRequest && !registry.events.PermissionRequest) {
      return;
    }

    assert.ok(
      hooks.hooks.PermissionRequest,
      "hooks.json must expose PermissionRequest",
    );
    assert.equal(
      registry.events.PermissionRequest?.[0]?.id,
      "tfx-permission-safe-allow",
    );
  });
});
