import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import { cleanupStaleSkills, LOCAL_DEV_SKILL_MARKER } from "../setup.mjs";

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "tfx-stale-skills-"));
  roots.push(root);
  const installed = path.join(root, "installed");
  const pkg = path.join(root, "pkg");
  mkdirSync(installed);
  mkdirSync(pkg);
  return { installed, pkg };
}

function skill(dir, name, content, marker = null) {
  const dst = path.join(dir, name);
  mkdirSync(dst, { recursive: true });
  writeFileSync(path.join(dst, "SKILL.md"), content);
  if (marker) writeFileSync(path.join(dst, marker), "");
  return dst;
}

it("관리 표식이 있는 이전 스킬은 접두사와 관계없이 재귀 삭제한다", () => {
  const { installed, pkg } = fixture();
  for (const name of ["tfx-plan", "merge-worktree", "star-prompt", "tfx-qa"]) {
    const dst = skill(installed, name, "legacy", ".triflux-managed-skill");
    mkdirSync(path.join(dst, "nested"));
    writeFileSync(path.join(dst, "nested", "data"), "old");
  }
  const result = cleanupStaleSkills(installed, pkg);
  assert.deepEqual(result.removed.sort(), [
    "merge-worktree",
    "star-prompt",
    "tfx-plan",
    "tfx-qa",
  ]);
  assert.deepEqual(result.preserved, []);
  assert.equal(existsSync(path.join(installed, "star-prompt")), false);
});

it("원본과 전체 트리가 같은 설치본만 지운다", () => {
  const { installed, pkg } = fixture();
  const source = skill(pkg, "tfx-wt", "---\nplatform: [win32]\n---\nbody\n");
  const matching = path.join(installed, "tfx-wt");
  cpSync(source, matching, { recursive: true });
  const edited = skill(installed, "tfx-qa", "user edit");
  const other = skill(installed, "tfx-random-user", "user skill");
  const result = cleanupStaleSkills(installed, pkg, { platform: "darwin" });
  assert.deepEqual(result.removed, ["tfx-wt"]);
  assert.deepEqual(result.preserved, ["tfx-qa"]);
  assert.equal(existsSync(matching), false);
  assert.equal(
    readFileSync(path.join(edited, "SKILL.md"), "utf8"),
    "user edit",
  );
  assert.equal(existsSync(other), true);
});

it("원본 외 파일이 추가되거나 로컬 표식이 있으면 보존한다", () => {
  const { installed, pkg } = fixture();
  const source = skill(pkg, "tfx-wt", "---\nplatform: [win32]\n---\nbody\n");
  const edited = path.join(installed, "tfx-wt");
  cpSync(source, edited, { recursive: true });
  writeFileSync(path.join(edited, "notes.txt"), "user data");
  const local = skill(installed, "tfx-plan", "local", LOCAL_DEV_SKILL_MARKER);
  const result = cleanupStaleSkills(installed, pkg, { platform: "darwin" });
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.preserved, ["tfx-plan", "tfx-wt"]);
  assert.equal(existsSync(local), true);
});
