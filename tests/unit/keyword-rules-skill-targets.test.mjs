import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const REPO_ROOT = process.cwd();

const MIRRORS = [
  "hooks/keyword-rules.json",
  "packages/core/hooks/keyword-rules.json",
  "packages/triflux/hooks/keyword-rules.json",
];

const TRIFLUX_SKILL_ROOTS = ["skills", "packages/triflux/skills"];

// 외부 gstack 시스템 skill — ~/.claude/skills/gstack-<name> 또는 ~/.claude/skills/<name>
// triflux 통제 밖이지만 keyword-rules 가 라우팅 타깃으로 참조함. CI 머신 의존을
// 피하기 위해 allowlist 로 관리한다. ~/.claude 실제 존재 여부는 검증하지 않는다.
const EXTERNAL_GSTACK_TARGETS = new Set([
  "autoplan",
  "checkpoint",
  "cso",
  "investigate",
  "office-hours",
  "qa",
  "retro",
  "ship",
]);

function readRules(mirrorPath) {
  const text = readFileSync(join(REPO_ROOT, mirrorPath), "utf8");
  return JSON.parse(text);
}

function isTrifluxSkill(name) {
  return TRIFLUX_SKILL_ROOTS.some((root) =>
    existsSync(join(REPO_ROOT, root, name, "SKILL.md")),
  );
}

function isKnownTarget(name) {
  if (name == null) return true;
  if (typeof name !== "string") return false;
  if (isTrifluxSkill(name)) return true;
  if (EXTERNAL_GSTACK_TARGETS.has(name)) return true;
  return false;
}

describe("keyword-rules.json: skill target 검증", () => {
  for (const mirror of MIRRORS) {
    it(`${mirror}: 모든 skill 타깃이 알려진 skill 이어야 함`, () => {
      const rules = readRules(mirror);
      const missing = [];
      for (const rule of rules.rules ?? []) {
        if (!isKnownTarget(rule.skill)) {
          missing.push(`${rule.id} → ${rule.skill}`);
        }
      }
      assert.deepEqual(
        missing,
        [],
        `Unknown skill targets in ${mirror}:\n  ${missing.join("\n  ")}\n\n` +
          `Fix options:\n` +
          `  (1) skills/<name>/SKILL.md (+ packages/triflux/skills/<name>/SKILL.md mirror) 신규 작성\n` +
          `  (2) keyword-rules.json 에서 해당 rule 의 skill 값을 기존 skill 로 재라우팅\n` +
          `  (3) EXTERNAL_GSTACK_TARGETS allowlist 에 추가 (외부 시스템 skill 인 경우)`,
      );
    });
  }

  it("3 mirror 가 byte-identical 이어야 함 (tfx-mirror-policy.md)", () => {
    const [root, coreMirror, trifluxMirror] = MIRRORS.map((m) =>
      readFileSync(join(REPO_ROOT, m), "utf8"),
    );
    assert.equal(
      root,
      coreMirror,
      `${MIRRORS[0]} ↔ ${MIRRORS[1]} drift. tfx-mirror-policy.md 에 따라 byte-identical 유지.`,
    );
    assert.equal(
      coreMirror,
      trifluxMirror,
      `${MIRRORS[1]} ↔ ${MIRRORS[2]} drift. tfx-mirror-policy.md 에 따라 byte-identical 유지.`,
    );
  });
});
