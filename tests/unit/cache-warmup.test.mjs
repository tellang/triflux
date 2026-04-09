import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
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
import { describe, it } from "node:test";

import { buildAll, resolveTargetPath } from "../../scripts/cache-warmup.mjs";

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function setupFixture() {
  const homeDir = makeTempDir("tfx-cache-warmup-home-");
  const cwd = makeTempDir("tfx-cache-warmup-project-");

  mkdirSync(join(homeDir, ".codex", "skills", "custom-plan"), {
    recursive: true,
  });
  writeFileSync(
    join(homeDir, ".codex", "skills", "custom-plan", "SKILL.md"),
    `---
name: custom-plan
description: plan the work
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
              name: "brave-search",
              status: "enabled",
              tool_count: 2,
              domain_tags: ["search", "web"],
            },
          ],
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(
    join(cwd, ".claude", "mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          tavily: { url: "http://example.test" },
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
        name: "warmup-fixture",
        description: "fixture project",
        scripts: { test: "node --test" },
      },
      null,
      2,
    ),
    "utf8",
  );

  return { homeDir, cwd };
}

function makeJwt(plan = "pro", extra = {}) {
  const header = Buffer.from(
    JSON.stringify({ alg: "none", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: "user-1",
      exp: 1_900_000_000,
      "https://api.openai.com/auth": {
        chatgpt_plan_type: plan,
      },
      ...extra,
    }),
  ).toString("base64url");
  return `${header}.${payload}.sig`;
}

function writeAuth(homeDir, plan = "pro", extra = {}) {
  mkdirSync(join(homeDir, ".codex"), { recursive: true });
  writeFileSync(
    join(homeDir, ".codex", "auth.json"),
    JSON.stringify(
      {
        auth_mode: "chatgpt",
        tokens: {
          id_token: makeJwt(plan, extra),
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

function cleanupFixture({ homeDir, cwd }) {
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}

function execSyncStub(command) {
  if (command.startsWith("git rev-parse")) return `${process.cwd()}\n`;
  if (command.startsWith("psmux --version")) return "psmux 1.0.0\n";
  if (command.startsWith("where wt.exe"))
    return "C:\\Windows\\System32\\wt.exe\n";
  throw new Error(`unexpected command: ${command}`);
}

describe("cache-warmup", () => {
  it("4개 캐시를 생성하고 TTL 내에서는 스킵한다", () => {
    const fixture = setupFixture();
    try {
      writeAuth(fixture.homeDir, "pro");
      const preflight = {
        codex: { ok: true, path: "codex" },
        gemini: { ok: false },
        hub: { ok: true, state: "healthy" },
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

      for (const target of [
        "codexSkills",
        "tierEnvironment",
        "projectMeta",
        "searchEngines",
      ]) {
        assert.equal(
          existsSync(resolveTargetPath(target, { cwd: fixture.cwd })),
          true,
        );
      }

      const searchPayload = JSON.parse(
        readFileSync(
          resolveTargetPath("searchEngines", { cwd: fixture.cwd }),
          "utf8",
        ),
      );
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

  it("Codex auth가 바뀌면 TTL 내라도 auth-sensitive 캐시를 재빌드한다", () => {
    const fixture = setupFixture();
    try {
      writeAuth(fixture.homeDir, "pro", { sub: "user-1" });
      const preflight = {
        codex: { ok: true, path: "codex" },
        gemini: { ok: false },
        hub: { ok: true, state: "healthy" },
      };

      const first = buildAll({
        cwd: fixture.cwd,
        homeDir: fixture.homeDir,
        force: true,
        preflight,
        execSyncFn: execSyncStub,
      });
      assert.equal(first.built, 4);

      const warm = buildAll({
        cwd: fixture.cwd,
        homeDir: fixture.homeDir,
        ttlMs: 60_000,
        preflight,
        execSyncFn: execSyncStub,
      });
      assert.equal(warm.skipped, 4);

      writeAuth(fixture.homeDir, "plus", { sub: "user-2", exp: 1_900_000_100 });
      const changed = buildAll({
        cwd: fixture.cwd,
        homeDir: fixture.homeDir,
        ttlMs: 60_000,
        preflight,
        execSyncFn: execSyncStub,
      });

      assert.equal(changed.ok, true);
      assert.equal(changed.built, 3);
      assert.equal(changed.skipped, 1);
      assert.deepEqual(
        changed.results
          .filter((result) => result.status === "built")
          .map((result) => result.target)
          .sort(),
        ["codexSkills", "searchEngines", "tierEnvironment"],
      );
    } finally {
      cleanupFixture(fixture);
    }
  });
});
