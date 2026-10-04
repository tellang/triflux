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

// 외부 gstack 시스템 skill. 설치 이름이 머신마다 다르다 — ~/.claude/skills/<name>
// (접두사 없음) 또는 ~/.claude/skills/gstack-<name>. 규칙은 이름을 고정하지 않고
// skill_candidates 로 두 이름을 모두 적으며, detector 가 실행 시점에 설치된 이름을
// 고른다(ADR-0021). CI 머신 의존을 피하기 위해 allowlist 로 관리한다.
const GSTACK_BASE_NAMES = [
  "autoplan",
  "cso",
  "investigate",
  "office-hours",
  "qa",
  "retro",
  "ship",
  "context-restore",
];
const EXTERNAL_GSTACK_TARGETS = new Set(
  GSTACK_BASE_NAMES.flatMap((name) => [name, `gstack-${name}`]),
);
const EXTERNAL_HOST_TARGETS = new Set(["ai-slop-cleaner"]);

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
  if (EXTERNAL_HOST_TARGETS.has(name)) return true;
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
        for (const candidate of rule.skill_candidates ?? []) {
          if (!isKnownTarget(candidate)) {
            missing.push(`${rule.id} → ${candidate} (candidate)`);
          }
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

describe("keyword-rules.json: gstack 타깃은 설치 이름 후보로 둔다", () => {
  it("gstack-* 규칙은 skill 을 고정하지 않고 [<name>, gstack-<name>] 후보를 갖는다", () => {
    const rules = readRules(MIRRORS[0]).rules.filter((rule) =>
      rule.id.startsWith("gstack-"),
    );
    assert.ok(rules.length > 0);
    for (const rule of rules) {
      assert.equal(rule.skill, undefined, `${rule.id} 가 skill 을 고정함`);
      const [base, prefixed] = rule.skill_candidates ?? [];
      assert.ok(GSTACK_BASE_NAMES.includes(base), `${rule.id}: ${base}`);
      assert.equal(prefixed, `gstack-${base}`, rule.id);
    }
  });
});

describe("tfx-harness 라우팅 우선순위 (동순위 가로채기 회귀 가드)", () => {
  async function resolveFor(text) {
    const { compileRules, loadRules, matchRules, resolveConflicts } =
      await import("../../scripts/lib/keyword-rules.mjs");
    const rules = loadRules(join(REPO_ROOT, "hooks/keyword-rules.json"));
    const compiled = compileRules(rules);
    return resolveConflicts(matchRules(compiled, text));
  }

  it("명시 'tfx-harness' 토큰은 priority 1로 선택된다", async () => {
    const resolved = await resolveFor("이건 tfx-harness로 라우팅 해줘");
    assert.equal(resolved[0]?.id, "tfx-harness");
  });

  it("광역 메타 문구는 priority 2 — 명시 스킬 룰(tfx-swarm)을 가로채지 않는다", async () => {
    const resolved = await resolveFor(
      "tfx swarm으로 돌릴 건데 어떤 스킬이 맞아?",
    );
    assert.equal(resolved[0]?.id, "tfx-swarm");
    assert.equal(resolved[0]?.skill, "tfx-auto");
    const meta = resolved.find((match) => match.id === "tfx-harness-meta");
    assert.ok(meta, "meta 룰은 함께 매치되되 최우선이 아니어야 한다");
  });

  it("priority 1 명시 토큰(tfx hub → tfx-doctor 등)은 메타 문구와 섞여도 가로채이지 않는다", async () => {
    const resolved = await resolveFor(
      "tfx hub 상태 보려는데 어떤 스킬이 맞아?",
    );
    assert.equal(resolved[0]?.id, "tfx-doctor");
    assert.ok(resolved.some((match) => match.id === "tfx-harness-meta"));
  });

  it("메타 문구 단독은 tfx-harness-meta가 tfx-unified를 supersede한다", async () => {
    const resolved = await resolveFor("어떤 스킬 쓰는 게 맞아? 스킬 추천해줘");
    assert.equal(resolved[0]?.id, "tfx-harness-meta");
    assert.equal(resolved[0]?.skill, "tfx-harness");
    assert.equal(
      resolved.some((match) => match.id === "tfx-unified"),
      false,
    );
  });
});
