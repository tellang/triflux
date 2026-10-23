import assert from "node:assert/strict";
import { describe, it } from "node:test";

const {
  extractProfileLines,
  hasProfileSection,
  listInlineProfileNames,
  removeProfileSection,
} = await import("../../scripts/setup.mjs");

// ── removeProfileSection: inline [profiles.*] 제거 (0.134 마이그레이션) ──

describe("removeProfileSection: inline 프로필 섹션 제거", () => {
  it("inline 프로필 섹션을 제거한다", () => {
    const content =
      'model = "gpt-5.5"\n\n[profiles.gpt55_high]\nmodel = "gpt-5.5"\nmodel_reasoning_effort = "high"\n';
    const result = removeProfileSection(content, "gpt55_high");
    assert.equal(hasProfileSection(result, "gpt55_high"), false);
    assert.ok(
      result.includes('model = "gpt-5.5"'),
      "top-level 키는 보존되어야 한다",
    );
  });

  it("대상 외 프로필은 보존한다", () => {
    const content =
      '[profiles.gpt55_high]\nmodel = "gpt-5.5"\n[profiles.gpt55_low]\nmodel = "gpt-5.5"\nmodel_reasoning_effort = "low"\n';
    const result = removeProfileSection(content, "gpt55_high");
    assert.equal(hasProfileSection(result, "gpt55_high"), false);
    assert.equal(hasProfileSection(result, "gpt55_low"), true);
  });

  it("존재하지 않는 프로필 제거는 내용을 바꾸지 않는다", () => {
    const content = 'model = "gpt-5.5"\n';
    assert.equal(removeProfileSection(content, "nope"), content);
  });
});

// ── listInlineProfileNames / extractProfileLines: 커스텀 프로필 이관 (0.134) ──

describe("listInlineProfileNames: config.toml 의 모든 inline 프로필 이름", () => {
  it("관리/구형/커스텀 inline 프로필을 모두 순서대로 나열한다", () => {
    const content =
      '[profiles.gpt55_high]\nmodel = "gpt-5.5"\n[profiles.personal]\nmodel = "custom"\n[profiles.gpt54_low]\nmodel = "gpt-5.4"\n';
    assert.deepEqual(listInlineProfileNames(content), [
      "gpt55_high",
      "personal",
      "gpt54_low",
    ]);
  });
});

describe("extractProfileLines: inline 본문 추출 (커스텀 이관용)", () => {
  it("프로필 본문의 key = value 라인을 추출한다", () => {
    const content =
      '[profiles.personal]\nmodel = "custom-model"\nmodel_reasoning_effort = "high"\n\n[profiles.other]\nmodel = "x"\n';
    assert.deepEqual(extractProfileLines(content, "personal"), [
      'model = "custom-model"',
      'model_reasoning_effort = "high"',
    ]);
  });
});
