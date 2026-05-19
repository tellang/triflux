import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  detectChangedFiles,
  hasCodeChange,
} from "../../hub/lib/staged-file-detect.mjs";

const TEMP_DIRS = [];

function makeRepo(prefix = "tfx-staged-file-detect-") {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  TEMP_DIRS.push(cwd);
  git(cwd, ["init"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test User"]);
  return cwd;
}

function makePlainDir(prefix = "tfx-staged-file-detect-plain-") {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  TEMP_DIRS.push(cwd);
  return cwd;
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function write(cwd, file, content) {
  writeFileSync(join(cwd, file), content);
}

function commitSeed(cwd) {
  write(cwd, "README.md", "# seed\n");
  git(cwd, ["add", "README.md"]);
  git(cwd, ["commit", "-m", "seed"]);
}

afterEach(() => {
  while (TEMP_DIRS.length > 0) {
    rmSync(TEMP_DIRS.pop(), { recursive: true, force: true });
  }
});

describe("hub/lib/staged-file-detect.mjs", () => {
  it("returns empty counts for a clean repo", () => {
    const cwd = makeRepo();
    commitSeed(cwd);

    const result = detectChangedFiles({ cwd });

    assert.deepEqual(result, {
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      totalChanged: 0,
      files: [],
    });
    assert.equal(hasCodeChange({ cwd }), false);
  });

  it("counts one staged file", () => {
    const cwd = makeRepo();
    write(cwd, "staged.txt", "staged\n");
    git(cwd, ["add", "staged.txt"]);

    const result = detectChangedFiles({ cwd });

    assert.equal(result.stagedCount, 1);
    assert.equal(result.unstagedCount, 0);
    assert.equal(result.untrackedCount, 0);
    assert.equal(result.totalChanged, 1);
    assert.deepEqual(result.files, ["staged.txt"]);
    assert.equal(hasCodeChange({ cwd }), true);
  });

  it("counts mixed unstaged and untracked files", () => {
    const cwd = makeRepo();
    commitSeed(cwd);
    write(cwd, "README.md", "# changed\n");
    write(cwd, "new.txt", "new\n");

    const result = detectChangedFiles({ cwd });

    assert.equal(result.stagedCount, 0);
    assert.equal(result.unstagedCount, 1);
    assert.equal(result.untrackedCount, 1);
    assert.equal(result.totalChanged, 2);
    assert.deepEqual(result.files, ["README.md", "new.txt"]);
  });

  it("returns empty counts for a non-git cwd", () => {
    const cwd = makePlainDir();

    const result = detectChangedFiles({ cwd });

    assert.deepEqual(result, {
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      totalChanged: 0,
      files: [],
    });
    assert.equal(hasCodeChange({ cwd }), false);
  });

  it("excludes staged files when includeStaged is false", () => {
    const cwd = makeRepo();
    write(cwd, "staged.txt", "staged\n");
    git(cwd, ["add", "staged.txt"]);

    const result = detectChangedFiles({ cwd, includeStaged: false });

    assert.equal(result.stagedCount, 0);
    assert.equal(result.unstagedCount, 0);
    assert.equal(result.untrackedCount, 0);
    assert.equal(result.totalChanged, 0);
    assert.deepEqual(result.files, []);
  });

  it("deduplicates a file that is staged and then modified again", () => {
    const cwd = makeRepo();
    commitSeed(cwd);
    write(cwd, "README.md", "# staged\n");
    git(cwd, ["add", "README.md"]);
    write(cwd, "README.md", "# unstaged\n");

    const result = detectChangedFiles({ cwd });

    assert.equal(result.stagedCount, 1);
    assert.equal(result.unstagedCount, 1);
    assert.equal(result.untrackedCount, 0);
    assert.equal(result.totalChanged, 1);
    assert.deepEqual(result.files, ["README.md"]);
  });
});
