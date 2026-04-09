import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fixCaches, verifyCaches } from "../../scripts/cache-doctor.mjs";
import { buildAll, resolveTargetPath } from "../../scripts/cache-warmup.mjs";

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function setupFixture() {
  const homeDir = makeTempDir("tfx-cache-doctor-home-");
  const cwd = makeTempDir("tfx-cache-doctor-project-");

  mkdirSync(join(homeDir, ".codex", "skills", "custom-review"), {
    recursive: true,
  });
  writeFileSync(
    join(homeDir, ".codex", "skills", "custom-review", "SKILL.md"),
    `---
name: custom-review
description: review the result
---
`,
    "utf8",
  );

  mkdirSync(join(homeDir, ".claude", "cache"), { recursive: true });
  writeFileSync(
    join(homeDir, ".claude", "cache", "mcp-inventory.json"),
    JSON.stringify(
      {
        codex: {
          servers: [
            {
              name: "exa",
              status: "enabled",
              tool_count: 2,
              domain_tags: ["search", "code"],
            },
          ],
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify(
      {
        name: "doctor-fixture",
        description: "doctor fixture project",
        scripts: { test: "node --test" },
      },
      null,
      2,
    ),
    "utf8",
  );

  return { homeDir, cwd };
}

function cleanupFixture({ homeDir, cwd }) {
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}

function execSyncStub(command) {
  if (command.startsWith("git rev-parse")) return `${process.cwd()}\n`;
  if (command.startsWith("psmux --version"))
    throw new Error("psmux not installed");
  if (command.startsWith("where wt.exe"))
    return "C:\\Windows\\System32\\wt.exe\n";
  throw new Error(`unexpected command: ${command}`);
}

describe("cache-doctor", () => {
  it("손상된 캐시를 탐지하고 재빌드한다", async () => {
    const fixture = setupFixture();
    try {
      const preflight = {
        codex: { ok: true, path: "codex" },
        gemini: { ok: true, path: "gemini" },
        hub: { ok: true, state: "healthy" },
        codex_plan: { plan: "plus", source: "jwt" },
      };

      buildAll({
        cwd: fixture.cwd,
        homeDir: fixture.homeDir,
        force: true,
        preflight,
        execSyncFn: execSyncStub,
      });

      const clean = verifyCaches({
        cwd: fixture.cwd,
        homeDir: fixture.homeDir,
        preflight,
        execSyncFn: execSyncStub,
      });
      assert.equal(clean.ok, true);

      writeFileSync(
        resolveTargetPath("projectMeta", { cwd: fixture.cwd }),
        "{broken-json",
        "utf8",
      );

      const broken = verifyCaches({
        cwd: fixture.cwd,
        homeDir: fixture.homeDir,
        preflight,
        execSyncFn: execSyncStub,
      });

      assert.equal(broken.ok, false);
      assert.equal(
        broken.results.find((result) => result.target === "projectMeta")
          ?.status,
        "invalid",
      );

      const fixed = await fixCaches({
        cwd: fixture.cwd,
        homeDir: fixture.homeDir,
        preflight,
        execSyncFn: execSyncStub,
      });

      assert.equal(fixed.ok, true);
      assert.deepEqual(fixed.fixed, ["projectMeta"]);

      const repaired = verifyCaches({
        cwd: fixture.cwd,
        homeDir: fixture.homeDir,
        preflight,
        execSyncFn: execSyncStub,
      });
      assert.equal(repaired.ok, true);
    } finally {
      cleanupFixture(fixture);
    }
  });
});
