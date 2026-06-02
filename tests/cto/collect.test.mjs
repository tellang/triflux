import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

import { runCollect } from "../../cto/collect.mjs";

const SCHEMA_PATH = new URL("../../cto/current.schema.json", import.meta.url);

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "tfx-cto-collect-"));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function initGitRepo(rootDir) {
  execFileSync("git", ["init", "-b", "main"], {
    cwd: rootDir,
    windowsHide: true,
  });
  execFileSync("git", ["config", "user.email", "cto@test.local"], {
    cwd: rootDir,
    windowsHide: true,
  });
  execFileSync("git", ["config", "user.name", "CTO Test"], {
    cwd: rootDir,
    windowsHide: true,
  });
  writeFileSync(join(rootDir, "README.md"), "# cto collect fixture\n", "utf8");
  execFileSync("git", ["add", "README.md"], {
    cwd: rootDir,
    windowsHide: true,
  });
  execFileSync("git", ["commit", "-m", "seed"], {
    cwd: rootDir,
    windowsHide: true,
  });
}

function writeJson(filePath, payload) {
  mkdirSync(new URL(".", `file://${filePath}`).pathname, { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function readJsonl(filePath) {
  return readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function assertSourceState(value) {
  assert.equal(typeof value.available, "boolean");
  assert.equal(typeof value.status, "string");
  assert.ok(Object.hasOwn(value, "detail"));
  assert.ok(Object.hasOwn(value, "collected_at"));
  if (value.collected_at !== null) {
    assert.doesNotThrow(() => new Date(value.collected_at).toISOString());
  }
}

function assertCurrentMatchesSchema(current) {
  const schema = readJson(SCHEMA_PATH.pathname);
  for (const field of schema.required) {
    assert.ok(
      Object.hasOwn(current, field),
      `missing required field: ${field}`,
    );
  }
  assert.equal(current.schema_version, "cto-lake.v1");
  assert.doesNotThrow(() => new Date(current.generated_at).toISOString());
  assert.equal(typeof current.repo.root, "string");
  assert.ok(
    typeof current.repo.branch === "string" || current.repo.branch === null,
  );
  assert.ok(
    typeof current.repo.head === "string" || current.repo.head === null,
  );
  assert.equal(typeof current.repo.dirty, "boolean");

  for (const sourceId of schema.properties.sources.required) {
    assert.ok(
      Object.hasOwn(current.sources, sourceId),
      `missing source: ${sourceId}`,
    );
    assertSourceState(current.sources[sourceId]);
  }

  assert.equal(typeof current.summary, "object");
  assert.ok(Array.isArray(current.ledger_tail));
  for (const entry of current.ledger_tail) {
    for (const field of schema.$defs.ledgerEntry.required) {
      assert.ok(Object.hasOwn(entry, field), `ledger entry missing: ${field}`);
    }
  }
}

describe("runCollect", () => {
  it("writes schema-valid current.json, capped current.md, and one ledger event", async () => {
    const rootDir = makeTempDir();
    const lakeRoot = join(rootDir, ".test-lake");
    try {
      initGitRepo(rootDir);
      writeFileSync(join(rootDir, "dirty.txt"), "dirty\n", "utf8");
      writeJson(join(rootDir, ".omx", "ultragoal", "goals.json"), {
        goals: [
          { id: "G1", title: "Ship CTO lake", status: "in_progress" },
          { id: "G2", title: "Wire status", status: "pending" },
        ],
      });
      mkdirSync(join(rootDir, ".triflux"), { recursive: true });
      writeJson(join(rootDir, ".triflux", "swarm-locks.json"), {
        shards: [{ id: "S1", status: "running" }],
      });

      const current = await runCollect(["--json"], {
        lakeRoot,
        includeHostArtifacts: false,
        rootDir,
        stdout: { write() {} },
        stderr: { write() {} },
      });

      assertCurrentMatchesSchema(current);
      assert.equal(current.repo.branch, "main");
      assert.equal(current.repo.dirty, true);
      assert.equal(current.sources.ultragoal_omx.available, true);
      assert.equal(current.sources.tfx_swarm.available, true);

      const currentJson = readJson(join(lakeRoot, "current.json"));
      assert.deepEqual(currentJson, current);

      const brief = readFileSync(join(lakeRoot, "current.md"), "utf8");
      assert.ok(brief.startsWith("brief_version: cto-lake.v1\n"));
      assert.ok(Buffer.byteLength(brief, "utf8") <= 2048);

      const ledger = readJsonl(join(lakeRoot, "ledger.jsonl"));
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0].event, "collect");
      assert.equal(ledger[0].source, "tfx_cto_collect");
      assert.equal(ledger[0].ref.current_json, "current.json");
    } finally {
      cleanup(rootDir);
    }
  });

  it("appends one ledger line per successful collect", async () => {
    const rootDir = makeTempDir();
    const lakeRoot = join(rootDir, ".test-lake");
    try {
      initGitRepo(rootDir);

      await runCollect([], {
        lakeRoot,
        includeHostArtifacts: false,
        rootDir,
        stdout: { write() {} },
        stderr: { write() {} },
      });
      await runCollect([], {
        lakeRoot,
        includeHostArtifacts: false,
        rootDir,
        stdout: { write() {} },
        stderr: { write() {} },
      });

      assert.equal(readJsonl(join(lakeRoot, "ledger.jsonl")).length, 2);
    } finally {
      cleanup(rootDir);
    }
  });

  it("skips ledger append without throwing when the single-writer lock is held", async () => {
    const rootDir = makeTempDir();
    const lakeRoot = join(rootDir, ".test-lake");
    const warnings = [];
    try {
      initGitRepo(rootDir);
      mkdirSync(lakeRoot, { recursive: true });
      writeFileSync(join(lakeRoot, "ledger.jsonl.lock"), "held\n", "utf8");

      await assert.doesNotReject(() =>
        runCollect([], {
          lakeRoot,
          includeHostArtifacts: false,
          rootDir,
          stdout: { write() {} },
          stderr: {
            write(chunk) {
              warnings.push(String(chunk));
            },
          },
        }),
      );

      assert.equal(existsSync(join(lakeRoot, "ledger.jsonl")), false);
      assert.match(warnings.join(""), /ledger.*lock.*timeout/i);
      assert.ok(existsSync(join(lakeRoot, "current.json")));
      assert.ok(existsSync(join(lakeRoot, "current.md")));
    } finally {
      cleanup(rootDir);
    }
  });

  it("handles missing git and empty durable sources gracefully", async () => {
    const rootDir = makeTempDir();
    const lakeRoot = join(rootDir, ".test-lake");
    try {
      const current = await runCollect([], {
        lakeRoot,
        includeHostArtifacts: false,
        rootDir,
        stdout: { write() {} },
        stderr: { write() {} },
      });

      assertCurrentMatchesSchema(current);
      assert.equal(current.repo.branch, null);
      assert.equal(current.repo.head, null);
      assert.equal(current.repo.dirty, false);
      assert.equal(current.sources.git.available, false);
      assert.equal(current.sources.ultragoal_omx.available, false);
      assert.equal(current.sources.tfx_hub.available, false);
      assert.equal(current.sources.agy.status, "not_shell_collectable");
      assert.equal(
        current.sources.session_vault.status,
        "not_shell_collectable",
      );
    } finally {
      cleanup(rootDir);
    }
  });
});
