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
            pro31: DEFAULT_GEMINI_PROFILES.profiles.pro31,
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
    assert.equal(saved.profiles.pro31.model, "Gemini 3.1 Pro (High)");
    assert.equal(saved.profiles.flash3.model, "Gemini 3 Flash");
    // 모델 값만 교체, 나머지 필드(hint)는 보존
    assert.equal(saved.profiles.pro31.hint, "old");
    // 신규 default 프로필이 함께 채워짐
    assert.ok(saved.profiles.flash35);
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
        profiles: { pro31: { model: "gemini-3.1-pro-preview" } },
      }),
    );

    ensureGeminiProfiles({ geminiDir, profilesPath });
    const saved = JSON.parse(readFileSync(profilesPath, "utf8"));

    assert.equal(saved.model, DEFAULT_GEMINI_PROFILES.model);
    assert.equal(saved.model, "Gemini 3.5 Flash (Medium)");
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
