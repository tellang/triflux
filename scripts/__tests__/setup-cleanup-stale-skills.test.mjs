// scripts/__tests__/setup-cleanup-stale-skills.test.mjs
// #144: cleanupStaleSkills 가 nested directory 를 가진 stale 스킬도 재귀 삭제하는지 확인.
//
// 이전 구현은 top-level 파일만 unlinkSync → 하위 폴더 있는 과거 스킬
// (tfx-deep-*, tfx-codex-swarm 등) 은 제거 실패 → "triflux update 돌려도 13개 그대로" UX bug.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const SETUP_MJS_URL = new URL("../setup.mjs", import.meta.url).href;
const {
  cleanupStaleSkills,
  isSkillSupportedOnPlatform,
  LOCAL_DEV_SKILL_MARKER,
} = await import(SETUP_MJS_URL);

describe("#144 cleanupStaleSkills — 재귀 삭제", () => {
  const cleanupDirs = [];
  after(() => {
    for (const d of cleanupDirs) rmSync(d, { recursive: true, force: true });
  });

  function setupFixture() {
    const root = mkdtempSync(path.join(tmpdir(), "tfx-cleanup-"));
    cleanupDirs.push(root);
    const installedDir = path.join(root, "installed");
    const pkgDir = path.join(root, "pkg");
    mkdirSync(installedDir, { recursive: true });
    mkdirSync(pkgDir, { recursive: true });
    // pkg 에는 tfx-auto 만 있음 (나머지는 installed 에서 stale 로 감지)
    mkdirSync(path.join(pkgDir, "tfx-auto"), { recursive: true });
    return { installedDir, pkgDir };
  }

  it("nested directory 가 있는 stale 스킬도 전부 제거된다 (과거 회귀 bug)", () => {
    const { installedDir, pkgDir } = setupFixture();
    // stale 스킬: top-level 파일 + nested 디렉토리
    const staleSkill = path.join(installedDir, "tfx-deep-review");
    mkdirSync(staleSkill, { recursive: true });
    writeFileSync(path.join(staleSkill, "SKILL.md"), "# deprecated");
    const nested = path.join(staleSkill, "snapshot");
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(nested, "data.json"), "{}");
    mkdirSync(path.join(nested, "sub"), { recursive: true });
    writeFileSync(path.join(nested, "sub", "more.txt"), "xxx");

    // 유지해야 할 스킬 (pkg 에 있음)
    mkdirSync(path.join(installedDir, "tfx-auto"), { recursive: true });
    writeFileSync(path.join(installedDir, "tfx-auto", "SKILL.md"), "# ok");

    const result = cleanupStaleSkills(installedDir, pkgDir);
    assert.equal(result.count, 1);
    assert.deepEqual(result.removed, ["tfx-deep-review"]);
    assert.equal(existsSync(staleSkill), false, "nested dir 포함 전부 삭제");
    assert.equal(
      existsSync(path.join(installedDir, "tfx-auto")),
      true,
      "pkg 에 있는 스킬은 보존",
    );
  });

  it("top-level 파일만 있는 stale 스킬도 제거된다 (legacy behavior 회귀 방지)", () => {
    const { installedDir, pkgDir } = setupFixture();
    const staleSkill = path.join(installedDir, "tfx-autoresearch");
    mkdirSync(staleSkill, { recursive: true });
    writeFileSync(path.join(staleSkill, "SKILL.md"), "# deprecated");
    writeFileSync(path.join(staleSkill, "config.json"), "{}");

    const result = cleanupStaleSkills(installedDir, pkgDir);
    assert.equal(result.count, 1);
    assert.equal(existsSync(staleSkill), false);
  });

  it("SKILL_ALIASES 에 있는 alias 는 유지된다", () => {
    const { installedDir, pkgDir } = setupFixture();
    // alias (tfx-autopilot) 는 SKILL_ALIASES 에 있으므로 pkgNames 에 자동 포함
    mkdirSync(path.join(installedDir, "tfx-autopilot"), { recursive: true });
    writeFileSync(
      path.join(installedDir, "tfx-autopilot", "SKILL.md"),
      "# alias",
    );

    const result = cleanupStaleSkills(installedDir, pkgDir);
    assert.equal(result.count, 0);
    assert.equal(existsSync(path.join(installedDir, "tfx-autopilot")), true);
  });

  it("tfx- 접두사 없는 디렉토리는 건드리지 않음", () => {
    const { installedDir, pkgDir } = setupFixture();
    mkdirSync(path.join(installedDir, "other-skill"), { recursive: true });
    writeFileSync(
      path.join(installedDir, "other-skill", "SKILL.md"),
      "# other",
    );

    const result = cleanupStaleSkills(installedDir, pkgDir);
    assert.equal(result.count, 0);
    assert.equal(existsSync(path.join(installedDir, "other-skill")), true);
  });

  it("local dev marker 가 있는 tfx-* 스킬은 패키지에 없어도 보존한다", () => {
    const { installedDir, pkgDir } = setupFixture();
    const localSkill = path.join(installedDir, "tfx-harness");
    mkdirSync(localSkill, { recursive: true });
    writeFileSync(path.join(localSkill, "SKILL.md"), "# local dev harness");
    writeFileSync(path.join(localSkill, LOCAL_DEV_SKILL_MARKER), "");

    const result = cleanupStaleSkills(installedDir, pkgDir);
    assert.equal(result.count, 0);
    assert.equal(
      existsSync(localSkill),
      true,
      "로컬 개발 스킬은 setup cleanup 에서 보존",
    );
  });
});

describe("스킬 표면 축소 — 제거 스킬과 플랫폼 필터", () => {
  const cleanupDirs = [];
  after(() => {
    for (const d of cleanupDirs) rmSync(d, { recursive: true, force: true });
  });

  function writeSkill(dir, name, extraFrontmatter = "") {
    mkdirSync(path.join(dir, name), { recursive: true });
    writeFileSync(
      path.join(dir, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: x\n${extraFrontmatter}---\nbody\n`,
    );
  }

  function setupFixture() {
    const root = mkdtempSync(path.join(tmpdir(), "tfx-cleanup-platform-"));
    cleanupDirs.push(root);
    const installedDir = path.join(root, "installed");
    const pkgDir = path.join(root, "pkg");
    writeSkill(pkgDir, "tfx-auto");
    writeSkill(pkgDir, "tfx-wt", "platform:\n  - win32\n");
    for (const name of ["tfx-auto", "tfx-wt"]) {
      mkdirSync(path.join(installedDir, name), { recursive: true });
      writeFileSync(path.join(installedDir, name, "SKILL.md"), "# installed");
    }
    return { installedDir, pkgDir };
  }

  const REMOVED_SKILLS = [
    "tfx-ralph",
    "tfx-forge",
    "tfx-find",
    "tfx-index",
    "tfx-goal-clarify",
    "tfx-hooks",
    "tfx-hub",
    "tfx-analysis",
    "tfx-prune",
    "tfx-qa",
  ];

  it("패키지에서 지운 스킬의 설치본은 보호되지 않고 제거된다", () => {
    const { installedDir, pkgDir } = setupFixture();
    for (const name of REMOVED_SKILLS) {
      mkdirSync(path.join(installedDir, name), { recursive: true });
      writeFileSync(path.join(installedDir, name, "SKILL.md"), "# removed");
    }

    const result = cleanupStaleSkills(installedDir, pkgDir, {
      platform: "win32",
    });

    assert.deepEqual([...result.removed].sort(), [...REMOVED_SKILLS].sort());
    for (const name of REMOVED_SKILLS) {
      assert.equal(existsSync(path.join(installedDir, name)), false, name);
    }
  });

  it("platform 비대상 스킬(macOS 의 tfx-wt) 설치본은 제거된다", () => {
    const { installedDir, pkgDir } = setupFixture();
    const result = cleanupStaleSkills(installedDir, pkgDir, {
      platform: "darwin",
    });
    assert.deepEqual(result.removed, ["tfx-wt"]);
    assert.equal(existsSync(path.join(installedDir, "tfx-wt")), false);
    assert.equal(existsSync(path.join(installedDir, "tfx-auto")), true);
  });

  it("platform 대상(win32)에서는 tfx-wt 설치본을 유지한다", () => {
    const { installedDir, pkgDir } = setupFixture();
    const result = cleanupStaleSkills(installedDir, pkgDir, {
      platform: "win32",
    });
    assert.equal(result.count, 0);
    assert.equal(existsSync(path.join(installedDir, "tfx-wt")), true);
  });

  it("platform 은 블록 목록·인라인 목록·무지정을 모두 읽는다", () => {
    const root = mkdtempSync(path.join(tmpdir(), "tfx-skill-platform-"));
    cleanupDirs.push(root);
    writeSkill(root, "block", "platform:\n  - win32\n  - linux\n");
    writeSkill(root, "inline", "platform: [win32]\n");
    writeSkill(root, "none");
    const supported = (name, platform) =>
      isSkillSupportedOnPlatform(path.join(root, name), platform);

    assert.equal(supported("block", "linux"), true);
    assert.equal(supported("block", "darwin"), false);
    assert.equal(supported("inline", "win32"), true);
    assert.equal(supported("inline", "darwin"), false);
    assert.equal(supported("none", "darwin"), true);
    assert.equal(supported("missing", "darwin"), true);
  });

  it("패키지 tfx-wt 는 win32 에만 설치된다", () => {
    const repoSkills = path.join(import.meta.dirname, "..", "..", "skills");
    const supported = (name, platform) =>
      isSkillSupportedOnPlatform(path.join(repoSkills, name), platform);
    assert.equal(supported("tfx-wt", "win32"), true);
    assert.equal(supported("tfx-wt", "darwin"), false);
    assert.equal(supported("tfx-wt", "linux"), false);
    assert.equal(supported("tfx-auto", "darwin"), true);
  });
});
