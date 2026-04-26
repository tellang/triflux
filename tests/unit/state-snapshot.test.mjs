import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";

import { snapshotState } from "../../hub/lib/state-snapshot.mjs";

const execFileAsync = promisify(execFile);
const TEST_ROOT = mkdtempSync(join(tmpdir(), "tfx-state-snapshot-test-"));

after(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

function makeFixture(name) {
  const sourceDir = join(TEST_ROOT, name, "source");
  const destDir = join(TEST_ROOT, name, "snapshots");
  mkdirSync(join(sourceDir, "skills", "user-skill"), { recursive: true });
  mkdirSync(join(sourceDir, "agents"), { recursive: true });
  mkdirSync(join(sourceDir, "cache"), { recursive: true });
  writeFileSync(join(sourceDir, "config.toml"), 'model = "gpt"\n', "utf8");
  writeFileSync(
    join(sourceDir, "skills", "user-skill", "SKILL.md"),
    "# skill\n",
    "utf8",
  );
  writeFileSync(join(sourceDir, "agents", "agent.md"), "# agent\n", "utf8");
  writeFileSync(join(sourceDir, "state.sqlite"), "sqlite", "utf8");
  writeFileSync(join(sourceDir, "cache", "transient.txt"), "cache", "utf8");
  return { sourceDir, destDir };
}

async function listArchiveEntries(archivePath) {
  const { stdout } = await execFileAsync(
    "tar",
    ["-tf", basename(archivePath)],
    {
      cwd: dirname(archivePath),
      windowsHide: true,
    },
  );
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function readArchiveFile(archivePath, entry) {
  const { stdout } = await execFileAsync(
    "tar",
    ["-xOf", basename(archivePath), entry],
    {
      cwd: dirname(archivePath),
      windowsHide: true,
    },
  );
  return stdout;
}

function listSnapshots(destDir) {
  return readdirSync(destDir)
    .filter((name) => name.endsWith(".tar.gz"))
    .sort();
}

describe("snapshotState", () => {
  it("creates a tar.gz snapshot from included state files", async () => {
    const { sourceDir, destDir } = makeFixture("creates");

    const result = await snapshotState({
      sourceDir,
      destDir,
      includes: ["config.toml", "skills", "agents"],
      excludes: ["*.sqlite*", "cache"],
      thresholdMs: 0,
      maxSnapshots: 10,
    });

    assert.equal(result.skipped, false);
    assert.ok(result.path?.endsWith(".tar.gz"));
    assert.ok(existsSync(result.path));
    assert.ok(result.sizeBytes > 0);
    assert.equal(result.fileCount, 3);

    const entries = await listArchiveEntries(result.path);
    assert.ok(entries.includes("config.toml"));
    assert.ok(entries.includes("skills/user-skill/SKILL.md"));
    assert.ok(entries.includes("agents/agent.md"));
  });

  it("skips when the newest snapshot is newer than thresholdMs", async () => {
    const { sourceDir, destDir } = makeFixture("threshold");

    const first = await snapshotState({
      sourceDir,
      destDir,
      includes: ["config.toml", "skills"],
      excludes: ["*.sqlite*"],
      thresholdMs: 0,
      maxSnapshots: 10,
    });
    const second = await snapshotState({
      sourceDir,
      destDir,
      includes: ["config.toml", "skills"],
      excludes: ["*.sqlite*"],
      thresholdMs: 24 * 60 * 60 * 1000,
      maxSnapshots: 10,
    });

    assert.equal(first.skipped, false);
    assert.equal(second.skipped, true);
    assert.equal(second.reason, "threshold");
    assert.equal(listSnapshots(destDir).length, 1);
  });

  it("keeps only maxSnapshots newest archives", async () => {
    const { sourceDir, destDir } = makeFixture("rolling");

    for (let index = 0; index < 11; index += 1) {
      writeFileSync(
        join(sourceDir, "config.toml"),
        `index = ${index}\n`,
        "utf8",
      );
      await snapshotState({
        sourceDir,
        destDir,
        includes: ["config.toml"],
        excludes: [],
        thresholdMs: 0,
        maxSnapshots: 10,
      });
    }

    const snapshots = listSnapshots(destDir);
    assert.equal(snapshots.length, 10);
    const configs = await Promise.all(
      snapshots.map((snapshot) =>
        readArchiveFile(join(destDir, snapshot), "config.toml"),
      ),
    );
    assert.ok(!configs.includes("index = 0\n"));
    assert.ok(configs.includes("index = 10\n"));
  });

  it("excludes sqlite files while retaining skills", async () => {
    const { sourceDir, destDir } = makeFixture("excludes");

    const result = await snapshotState({
      sourceDir,
      destDir,
      includes: ["config.toml", "skills", "state.sqlite", "cache"],
      excludes: ["*.sqlite*", "cache"],
      thresholdMs: 0,
      maxSnapshots: 10,
    });

    const entries = await listArchiveEntries(result.path);
    assert.ok(entries.includes("skills/user-skill/SKILL.md"));
    assert.ok(!entries.some((entry) => entry.includes("state.sqlite")));
    assert.ok(!entries.some((entry) => entry.startsWith("cache/")));
    assert.equal(result.fileCount, 2);
  });

  it("uses archive mtimes for rolling order, not file names", async () => {
    const destDir = join(TEST_ROOT, "mtime-order", "snapshots");
    mkdirSync(destDir, { recursive: true });
    const oldPath = join(destDir, "state-z.tar.gz");
    const newPath = join(destDir, "state-a.tar.gz");
    writeFileSync(oldPath, "old", "utf8");
    writeFileSync(newPath, "new", "utf8");
    const oldTime = new Date("2024-01-01T00:00:00Z");
    const newTime = new Date("2024-01-02T00:00:00Z");
    await import("node:fs/promises").then(({ utimes }) =>
      Promise.all([
        utimes(oldPath, oldTime, oldTime),
        utimes(newPath, newTime, newTime),
      ]),
    );

    const { sourceDir } = makeFixture("mtime-order");
    await snapshotState({
      sourceDir,
      destDir,
      includes: ["config.toml"],
      excludes: [],
      thresholdMs: 0,
      maxSnapshots: 2,
    });

    assert.equal(existsSync(oldPath), false);
    assert.equal(existsSync(newPath), true);
    assert.equal(
      listSnapshots(destDir).filter((name) =>
        statSync(join(destDir, name)).isFile(),
      ).length,
      2,
    );
  });
});
