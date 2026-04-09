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
