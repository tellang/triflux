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

describe("ensureGeminiProfiles() 마이그레이션", () => {
  it("deprecated 2.5 프로필을 제거하고 옛 ID 형식을 display name 으로 갱신한다", () => {
    const { geminiDir, profilesPath } = makeTempPaths();
    writeFileSync(
      profilesPath,
      JSON.stringify({
        model: "gemini-3.1-pro-preview",
        profiles: {
          pro31: { model: "gemini-3.1-pro-preview", hint: "old" },
          flash3: { model: "gemini-3-flash-preview", hint: "old" },
          pro25: { model: "gemini-2.5-pro" },
          flash25: { model: "gemini-2.5-flash" },
          lite25: { model: "gemini-2.5-flash-lite" },
        },
      }),
    );

    const result = ensureGeminiProfiles({ geminiDir, profilesPath });
    const saved = JSON.parse(readFileSync(profilesPath, "utf8"));

    assert.equal(result.ok, true);
    assert.equal(saved.profiles.pro25, undefined);
    assert.equal(saved.profiles.flash25, undefined);
    assert.equal(saved.profiles.lite25, undefined);
    // pro31 은 자동 생성 이름이라 정책상 제거된다 (Pro 미사용)
    assert.equal(saved.profiles.pro31, undefined);
    // "Gemini 3 Flash" 는 agy 카탈로그에서 빠졌으므로 프로필 자체가 제거된다
    assert.equal(saved.profiles.flash3, undefined);
    // 신규 default 프로필이 함께 채워짐
    assert.ok(saved.profiles.flash38);
    assert.equal(saved.profiles.flash38.model, "Gemini 3.8 Flash (Medium)");
    const baks = readdirSync(geminiDir).filter((name) =>
      name.startsWith("triflux-profiles.json.bak."),
    );
    assert.equal(baks.length, 1);
  });

  it("옛 ID 형식 기본 model 을 새 기본으로 정규화한다", () => {
    const { geminiDir, profilesPath } = makeTempPaths();
    writeFileSync(
      profilesPath,
      JSON.stringify({
        model: "gemini-3.1-pro-preview",
        profiles: { mypro: { model: "gemini-3.1-pro-preview" } },
      }),
    );

    ensureGeminiProfiles({ geminiDir, profilesPath });
    const saved = JSON.parse(readFileSync(profilesPath, "utf8"));

    assert.equal(saved.model, DEFAULT_GEMINI_PROFILES.model);
    assert.equal(saved.model, "Gemini 3.8 Flash (Medium)");
  });

  it("이전 세대 자동 생성 기본 model(3.5 Flash Medium)과 display name 형식의 3 Flash 프로필을 정리한다", () => {
    const { geminiDir, profilesPath } = makeTempPaths();
    writeFileSync(
      profilesPath,
      JSON.stringify({
        model: "Gemini 3.5 Flash (Medium)",
        profiles: {
          flash3: { model: "Gemini 3 Flash", hint: "3.0 Flash" },
          flash35: { model: "Gemini 3.5 Flash (Medium)", hint: "keep" },
          pro31: { model: "Gemini 3.1 Pro (High)" },
        },
      }),
    );

    ensureGeminiProfiles({ geminiDir, profilesPath });
    const saved = JSON.parse(readFileSync(profilesPath, "utf8"));

    assert.equal(saved.model, "Gemini 3.8 Flash (Medium)");
    assert.equal(saved.profiles.flash3, undefined);
    // 이전 세대 자동 생성 프로필도 제거된다
    assert.equal(saved.profiles.flash35, undefined);
    assert.ok(saved.profiles.flash38_high);
  });

  it("이미 새 형식이면 마이그레이션/백업하지 않는다 (멱등)", () => {
    const { geminiDir, profilesPath } = makeTempPaths();
    writeFileSync(profilesPath, JSON.stringify(DEFAULT_GEMINI_PROFILES));

    const result = ensureGeminiProfiles({ geminiDir, profilesPath });
    const baks = readdirSync(geminiDir).filter((name) =>
      name.startsWith("triflux-profiles.json.bak."),
    );

    assert.equal(result.added, 0);
    assert.equal(baks.length, 0);
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
