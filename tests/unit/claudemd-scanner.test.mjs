import assert from "node:assert/strict";
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
import { afterEach, describe, it } from "node:test";

import {
  findAllClaudeMdPaths,
  migrateClaudeMd,
  TFX_END,
  TFX_START,
  writeSection,
} from "../../scripts/lib/claudemd-scanner.mjs";

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

describe("writeSection()", () => {
  it("파일이 없으면 TFX 블록으로 새 파일을 생성한다", () => {
    const root = createTempDir("triflux-claudemd-write-new-");
    const target = join(root, "CLAUDE.md");

    const result = writeSection(target, {
      version: "1.2.3",
      template: "managed-body",
    });

    const saved = readFileSync(target, "utf8");
    assert.equal(result.action, "created");
    assert.equal(saved.includes(TFX_START), true);
    assert.equal(saved.includes("<!-- TFX:VERSION:1.2.3 -->"), true);
    assert.equal(saved.includes("managed-body"), true);
    assert.equal(saved.includes(TFX_END), true);
  });

  it("기존 TFX 블록이 있으면 내용만 교체한다", () => {
    const root = createTempDir("triflux-claudemd-write-update-");
    const target = join(root, "CLAUDE.md");
    writeFileSync(
      target,
      [
        "# header",
        TFX_START,
        "<!-- TFX:VERSION:0.1.0 -->",
        "old-body",
        TFX_END,
        "# footer",
      ].join("\n"),
      "utf8",
    );

    const result = writeSection(target, {
      version: "2.0.0",
      template: "new-body",
    });

    const saved = readFileSync(target, "utf8");
    assert.equal(result.action, "updated");
    assert.equal(result.oldVersion, "0.1.0");
    assert.equal(saved.includes("old-body"), false);
    assert.equal(saved.includes("new-body"), true);
    assert.equal(saved.startsWith("# header"), true);
    assert.equal(saved.includes("# footer"), true);
  });
});

describe("migrateClaudeMd()", () => {
  it("레거시 user_cli_routing 블록을 제거하고 TFX 블록으로 마이그레이션한다", () => {
    const root = createTempDir("triflux-claudemd-migrate-");
    const target = join(root, "CLAUDE.md");
    writeFileSync(
      target,
      [
        "# intro",
        "<!-- USER OVERRIDES -->",
        "<user_cli_routing>",
        "- legacy route",
        "</user_cli_routing>",
        "# end",
      ].join("\n"),
      "utf8",
    );

    const result = migrateClaudeMd(target, {
      version: "9.9.9",
      template: "new-managed",
    });

    const saved = readFileSync(target, "utf8");
    assert.equal(result.action, "migrated");
    assert.equal(result.removed.includes("<user_cli_routing> block"), true);
    assert.equal(saved.includes("<user_cli_routing>"), false);
    assert.equal(saved.includes("new-managed"), true);
    assert.equal(saved.includes("<!-- TFX:VERSION:9.9.9 -->"), true);
  });

  it("파일이 없으면 no_file을 반환한다", () => {
    const root = createTempDir("triflux-claudemd-no-file-");
    const target = join(root, "missing.md");

    const result = migrateClaudeMd(target);
    assert.equal(result.action, "no_file");
    assert.equal(existsSync(target), false);
  });
});
