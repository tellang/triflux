import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  DEFAULT_GEMINI_PROFILES,
  ensureGeminiProfiles,
  resolveGeminiModel,
  resolveGeminiProfileForPurpose,
} from "../../scripts/lib/gemini-profiles.mjs";

const tempDirs = [];

function makeTempPaths() {
  const root = mkdtempSync(join(tmpdir(), "triflux-gemini-profiles-"));
  tempDirs.push(root);
  const geminiDir = join(root, ".gemini");
  const profilesPath = join(geminiDir, "triflux-profiles.json");
  mkdirSync(geminiDir, { recursive: true });
  return { geminiDir, profilesPath };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("ensureGeminiProfiles()", () => {
  it("설정 파일이 없으면 기본 프로필을 생성하고 추가 수를 반환한다", () => {
    const { geminiDir, profilesPath } = makeTempPaths();
    const expectedCount = Object.keys(DEFAULT_GEMINI_PROFILES.profiles).length;

    const result = ensureGeminiProfiles({ geminiDir, profilesPath });

    assert.deepEqual(result, {
      ok: true,
      created: true,
      added: expectedCount,
      count: expectedCount,
      message: null,
    });
    assert.equal(existsSync(profilesPath), true);
    assert.deepEqual(
      JSON.parse(readFileSync(profilesPath, "utf8")),
      DEFAULT_GEMINI_PROFILES,
    );
  });

  it("누락된 프로필만 보완하고 총 개수를 유지한다", () => {
    const { geminiDir, profilesPath } = makeTempPaths();
    writeFileSync(
      profilesPath,
      JSON.stringify(
        {
          profiles: {
            flash38_high: DEFAULT_GEMINI_PROFILES.profiles.flash38_high,
          },
        },
        null,
        2,
      ),
    );

    const result = ensureGeminiProfiles({ geminiDir, profilesPath });
    const saved = JSON.parse(readFileSync(profilesPath, "utf8"));

    assert.equal(result.ok, true);
    assert.equal(result.created, false);
    assert.equal(
      result.added,
      Object.keys(DEFAULT_GEMINI_PROFILES.profiles).length - 1,
    );
    assert.equal(
      result.count,
      Object.keys(DEFAULT_GEMINI_PROFILES.profiles).length,
    );
    assert.equal(saved.model, DEFAULT_GEMINI_PROFILES.model);
    assert.deepEqual(saved.profiles, DEFAULT_GEMINI_PROFILES.profiles);
  });

  it("기존 파일 파싱에 실패하면 백업 후 기본 프로필로 재생성한다", () => {
    const { geminiDir, profilesPath } = makeTempPaths();
    writeFileSync(profilesPath, "{broken json", "utf8");

    const result = ensureGeminiProfiles({ geminiDir, profilesPath });
    const backupFiles = readdirSync(geminiDir).filter((name) =>
      name.startsWith("triflux-profiles.json.bak."),
    );

    assert.equal(result.ok, true);
    assert.equal(result.created, true);
    assert.equal(
      result.added,
      Object.keys(DEFAULT_GEMINI_PROFILES.profiles).length,
    );
    assert.equal(backupFiles.length, 1);
    assert.deepEqual(
      JSON.parse(readFileSync(profilesPath, "utf8")),
      DEFAULT_GEMINI_PROFILES,
    );
  });
});

describe("ensureGeminiProfiles() 기존 설정", () => {
  it("기존 프로필과 기본 모델을 유지하며 새 기본 프로필만 추가한다", () => {
    const { geminiDir, profilesPath } = makeTempPaths();
    const oldModel = "Gemini 3.5 Flash (Medium)";
    const oldProfile = { model: oldModel, hint: "custom" };
    writeFileSync(
      profilesPath,
      JSON.stringify({ model: oldModel, profiles: { flash35: oldProfile } }),
    );

    const result = ensureGeminiProfiles({ geminiDir, profilesPath });
    const saved = JSON.parse(readFileSync(profilesPath, "utf8"));

    assert.equal(
      result.added,
      Object.keys(DEFAULT_GEMINI_PROFILES.profiles).length,
    );
    assert.equal(saved.model, oldModel);
    assert.deepEqual(saved.profiles.flash35, oldProfile);
    assert.deepEqual(
      saved.profiles.flash38,
      DEFAULT_GEMINI_PROFILES.profiles.flash38,
    );
    assert.equal(
      readdirSync(geminiDir).filter((name) => name.includes(".bak.")).length,
      0,
    );
  });
});

describe("용도별 effort 분리 (SSOT)", () => {
  it("역할을 3.8 Flash effort 프로필로 매핑한다", () => {
    assert.equal(resolveGeminiProfileForPurpose("designer"), "flash38_high");
    assert.equal(resolveGeminiProfileForPurpose("reviewer"), "flash38_high");
    assert.equal(
      resolveGeminiProfileForPurpose("Code-Reviewer"),
      "flash38_high",
    );
    assert.equal(resolveGeminiProfileForPurpose("writer"), "flash38");
    assert.equal(resolveGeminiProfileForPurpose("antigravity"), "flash38");
    assert.equal(resolveGeminiProfileForPurpose("summarizer"), "flash38_low");
    assert.equal(resolveGeminiProfileForPurpose("no-such-role"), "flash38");
    assert.equal(resolveGeminiProfileForPurpose(""), "flash38");
  });

  it("프로필 이름을 display name 으로 푼다 (사용자 파일 우선, 없으면 기본값)", () => {
    const { profilesPath } = makeTempPaths();
    assert.equal(
      resolveGeminiModel("flash38_high", { profilesPath }),
      "Gemini 3.8 Flash (High)",
    );
    writeFileSync(
      profilesPath,
      JSON.stringify({
        model: "Gemini 3.8 Flash (Low)",
        profiles: { flash38: { model: "Gemini 3.7 Flash (Medium)" } },
      }),
    );
    assert.equal(
      resolveGeminiModel("flash38", { profilesPath }),
      "Gemini 3.7 Flash (Medium)",
    );
    assert.equal(
      resolveGeminiModel("unknown_profile", { profilesPath }),
      "Gemini 3.8 Flash (Low)",
    );
    assert.equal(
      resolveGeminiModel("Gemini 3.1 Pro (High)", { profilesPath }),
      "Gemini 3.1 Pro (High)",
    );
    assert.equal(
      resolveGeminiModel("gemini-3.8-flash-high", { profilesPath }),
      "gemini-3.8-flash-high",
    );
  });
});
