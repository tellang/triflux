import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildAll,
  resolveTargetPath,
} from "../../scripts/cache-warmup.mjs";

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function setupFixture() {
  const homeDir = makeTempDir("tfx-cache-warmup-home-");
  const cwd = makeTempDir("tfx-cache-warmup-project-");

  mkdirSync(join(homeDir, ".codex", "skills", "custom-plan"), { recursive: true });
  writeFileSync(join(homeDir, ".codex", "skills", "custom-plan", "SKILL.md"), `---
name: custom-plan
description: plan the work
---
`, "utf8");

  mkdirSync(join(homeDir, ".claude", "cache"), { recursive: true });
  writeFileSync(join(homeDir, ".claude", "cache", "mcp-inventory.json"), JSON.stringify({
    codex: {
      servers: [
        { name: "brave-search", status: "enabled", tool_count: 2, domain_tags: ["search", "web"] },
      ],
    },
  }, null, 2), "utf8");

  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(join(cwd, ".claude", "mcp.json"), JSON.stringify({
    mcpServers: {
      tavily: { url: "http://example.test" },
    },
  }, null, 2), "utf8");

  writeFileSync(join(cwd, "package.json"), JSON.stringify({
    name: "warmup-fixture",
    description: "fixture project",
    scripts: { test: "node --test" },
  }, null, 2), "utf8");

  return { homeDir, cwd };
}

function cleanupFixture({ homeDir, cwd }) {
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}

function execSyncStub(command) {
  if (command.startsWith("git rev-parse")) return `${process.cwd()}\n`;
  if (command.startsWith("psmux --version")) return "psmux 1.0.0\n";
  if (command.startsWith("where wt.exe")) return "C:\\Windows\\System32\\wt.exe\n";
  throw new Error(`unexpected command: ${command}`);
}

describe("cache-warmup", () => {
  it("4개 캐시를 생성하고 TTL 내에서는 스킵한다", () => {
    const fixture = setupFixture();
    try {
      const preflight = {
        codex: { ok: true, path: "codex" },
        gemini: { ok: false },
        hub: { ok: true, state: "healthy" },
        codex_plan: { plan: "pro", source: "jwt" },
      };

      const first = buildAll({
        cwd: fixture.cwd,
        homeDir: fixture.homeDir,
        force: true,
        preflight,
        execSyncFn: execSyncStub,
      });

      assert.equal(first.ok, true);
      assert.equal(first.built, 4);

      for (const target of ["codexSkills", "tierEnvironment", "projectMeta", "searchEngines"]) {
        assert.equal(existsSync(resolveTargetPath(target, { cwd: fixture.cwd })), true);
      }

      const searchPayload = JSON.parse(readFileSync(resolveTargetPath("searchEngines", { cwd: fixture.cwd }), "utf8"));
      assert.equal(searchPayload.primary_engine, "brave-search");

      const second = buildAll({
        cwd: fixture.cwd,
        homeDir: fixture.homeDir,
        ttlMs: 60_000,
        preflight,
        execSyncFn: execSyncStub,
      });

      assert.equal(second.ok, true);
      assert.equal(second.skipped, 4);
    } finally {
      cleanupFixture(fixture);
    }
  });
});
