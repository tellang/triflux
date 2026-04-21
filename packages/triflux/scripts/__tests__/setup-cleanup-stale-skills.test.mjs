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
const { cleanupStaleSkills } = await import(SETUP_MJS_URL);

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
    writeFileSync(path.join(installedDir, "other-skill", "SKILL.md"), "# other");

    const result = cleanupStaleSkills(installedDir, pkgDir);
    assert.equal(result.count, 0);
    assert.equal(existsSync(path.join(installedDir, "other-skill")), true);
  });
});
