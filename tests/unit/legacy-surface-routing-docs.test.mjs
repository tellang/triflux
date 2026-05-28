import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();

function read(relPath) {
  return readFileSync(resolve(repoRoot, relPath), "utf8");
}

function setupHelpBlock() {
  const setup = read("scripts/setup.mjs");
  const match = setup.match(/\$\{B\}Skills \(Claude Code\):[\s\S]*?\$\{Y\}!/u);
  assert.ok(match, "scripts/setup.mjs help block not found");
  return match[0];
}

const STALE_PRIMARY_SURFACES = [
  "tfx-auto-codex",
  "tfx-codex-swarm",
  "tfx-codex",
  "tfx-gemini",
  "tfx-deep-plan",
  "tfx-deep-review",
  "tfx-deep-qa",
  "tfx-deep-research",
  "tfx-deep-*",
];

describe("legacy TFX surface routing docs", () => {
  it("setup help advertises canonical tfx-auto flag forms, not removed primary skills", () => {
    const help = setupHelpBlock();

    assert.doesNotMatch(help, /\/tfx-auto-codex/u);
    assert.doesNotMatch(help, /\/tfx-codex\b/u);
    assert.doesNotMatch(help, /\/tfx-gemini\b/u);

    assert.match(help, /\/tfx-auto.*--cli codex/u);
    assert.match(help, /\/tfx-auto.*--cli antigravity/u);
    assert.match(help, /\/tfx-auto.*--mode deep/u);
  });

  it("tfx-auto skill docs route legacy intents through canonical flags", () => {
    const files = [
      "skills/tfx-auto/SKILL.md",
      "packages/triflux/skills/tfx-auto/SKILL.md",
    ];

    for (const file of files) {
      const content = read(file);
      assert.doesNotMatch(
        content,
        /Skill\("tfx-(?:codex|gemini)"\)/u,
        `${file} should not dispatch removed CLI-specific skills`,
      );
      assert.doesNotMatch(
        content,
        /tfx-deep-\*\s+dispatch/u,
        `${file} should not dispatch tfx-deep-* as a primary route`,
      );
      assert.match(
        content,
        /--cli codex/u,
        `${file} should mention --cli codex`,
      );
      assert.match(
        content,
        /--cli antigravity/u,
        `${file} should mention --cli antigravity`,
      );
      assert.match(
        content,
        /--mode deep/u,
        `${file} should mention --mode deep`,
      );
    }
  });

  it("routing and convention docs do not present stale legacy surfaces as primary paths", () => {
    const files = [
      ".claude/rules/tfx-routing.md",
      ".claude/rules/tfx-stack-coexistence.md",
      "docs/codex-conventions.md",
    ];

    for (const file of files) {
      const content = read(file);
      for (const stale of STALE_PRIMARY_SURFACES) {
        assert.equal(
          content.includes(stale),
          false,
          `${file} still exposes stale primary surface: ${stale}`,
        );
      }
    }
  });
});
