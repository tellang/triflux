import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { findAllClaudeMdPaths } from "../../scripts/lib/claudemd-scanner.mjs";

const tempDirs = [];

function createTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("findAllClaudeMdPaths()", () => {
  it("global + project CLAUDE.md를 모두 탐지한다", () => {
    const root = createTempDir("triflux-claudemd-scan-");
    const homeDir = join(root, "home");
    const cwd = join(root, "project");
    mkdirSync(join(homeDir, ".claude"), { recursive: true });
    mkdirSync(cwd, { recursive: true });

    const globalFile = join(homeDir, ".claude", "CLAUDE.md");
    const projectFile = join(cwd, "CLAUDE.md");
    writeFileSync(globalFile, "# global", "utf8");
    writeFileSync(projectFile, "# project", "utf8");

    const found = findAllClaudeMdPaths({ homeDir, cwd });
    assert.deepEqual(found.sort(), [globalFile, projectFile].sort());
  });

  it("존재하는 파일만 반환한다", () => {
    const root = createTempDir("triflux-claudemd-scan-empty-");
    const homeDir = join(root, "home");
    const cwd = join(root, "project");
    mkdirSync(join(homeDir, ".claude"), { recursive: true });
    mkdirSync(cwd, { recursive: true });

    const found = findAllClaudeMdPaths({ homeDir, cwd });
    assert.deepEqual(found, []);
  });
});
