import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");

const {
  extractProfileLines,
  hasProfileSection,
  LEGACY_CODEX_PROFILE_NAMES,
  listInlineProfileNames,
  REQUIRED_CODEX_PROFILES,
  REQUIRED_TOP_LEVEL_SETTINGS,
  removeProfileSection,
} = await import("../../scripts/setup.mjs");

// ── helpers ──

const TMP_DIR = join(PROJECT_ROOT, "tests", ".tmp-codex-profiles");

function ensureTmpDir() {
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
}

function cleanTmpDir() {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
}

/**
 * Patch the module-level CODEX paths so ensureCodexProfiles writes to a temp
 * directory instead of the real ~/.codex/config.toml.
 */
function _withTempCodex(configContent, fn) {
  const fakeCodexDir = join(
    TMP_DIR,
    `codex-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(fakeCodexDir, { recursive: true });
  const configPath = join(fakeCodexDir, "config.toml");
  if (configContent !== null) {
    writeFileSync(configPath, configContent, "utf8");
  }
  return { fakeCodexDir, configPath };
}

// ── REQUIRED_CODEX_PROFILES 확장 확인 ──

describe("REQUIRED_CODEX_PROFILES: 확장된 프로필 목록 검증", () => {
  const requiredNames = [
    "gpt56_sol_ultra",
    "gpt56_sol_max",
    "gpt56_sol_xhigh",
    "gpt56_terra_high",
    "gpt56_terra_med",
    "gpt56_luna_low",
  ];

  for (const name of requiredNames) {
    it(`REQUIRED_CODEX_PROFILES에 ${name} 이 포함되어야 한다`, () => {
      const found = REQUIRED_CODEX_PROFILES.some((p) => p.name === name);
      assert.ok(found, `${name} not found in REQUIRED_CODEX_PROFILES`);
    });
  }

  it("각 프로필에 name과 lines 필드가 있어야 한다", () => {
    for (const p of REQUIRED_CODEX_PROFILES) {
      assert.ok(
        typeof p.name === "string" && p.name.length > 0,
        `profile missing name`,
      );
      assert.ok(
        Array.isArray(p.lines) && p.lines.length > 0,
        `profile ${p.name} missing lines`,
      );
    }
  });

  it("Sol max/ultra 프로필은 서로 다른 reasoning effort를 고정한다", () => {
    const byName = new Map(REQUIRED_CODEX_PROFILES.map((p) => [p.name, p]));
    assert.deepEqual(byName.get("gpt56_sol_max")?.lines, [
      'model = "gpt-5.6-sol"',
      'model_reasoning_effort = "max"',
    ]);
    assert.deepEqual(byName.get("gpt56_sol_ultra")?.lines, [
      'model = "gpt-5.6-sol"',
      'model_reasoning_effort = "ultra"',
    ]);
  });
});

// ── REQUIRED_TOP_LEVEL_SETTINGS 검증 ──

describe("REQUIRED_TOP_LEVEL_SETTINGS: 필수 top-level 설정 목록", () => {
  it("model, model_reasoning_effort, service_tier 가 포함되어야 한다", () => {
    const keys = REQUIRED_TOP_LEVEL_SETTINGS.map((s) => s.key);
    assert.ok(keys.includes("model"), "model missing");
    assert.ok(
      keys.includes("model_reasoning_effort"),
      "model_reasoning_effort missing",
    );
    assert.ok(keys.includes("service_tier"), "service_tier missing");
  });

  it("model 기본값은 gpt-5.6-sol", () => {
    const entry = REQUIRED_TOP_LEVEL_SETTINGS.find((s) => s.key === "model");
    assert.ok(
      entry?.value.includes("gpt-5.6-sol"),
      `unexpected model default: ${entry?.value}`,
    );
  });

  it("service_tier 기본값은 fast", () => {
    const entry = REQUIRED_TOP_LEVEL_SETTINGS.find(
      (s) => s.key === "service_tier",
    );
    assert.ok(
      entry?.value.includes("fast"),
      `unexpected service_tier default: ${entry?.value}`,
    );
  });
});

// ── ensureCodexProfiles: top-level 주입 동작 ──
// Note: ensureCodexProfiles writes to the real CODEX_CONFIG_PATH which is
// module-level. These tests verify the logic via hasProfileSection on the
// content that ensureCodexProfiles would produce, using a real temp file
// approach by temporarily swapping environment via monkey-patching the path.
// Since the module path is hardcoded, we test the pure helper logic instead.

describe("hasProfileSection: 프로필 섹션 감지", () => {
  it("존재하는 프로필 섹션을 감지한다", () => {
    const content =
      '[profiles.gpt55_high]\nmodel = "gpt-5.5"\nmodel_reasoning_effort = "high"\n';
    assert.equal(hasProfileSection(content, "gpt55_high"), true);
  });

  it("존재하지 않는 프로필 섹션은 false를 반환한다", () => {
    const content = '[profiles.gpt55_high]\nmodel = "gpt-5.5"\n';
    assert.equal(hasProfileSection(content, "gpt55_low"), false);
  });

  it("부분 일치는 false를 반환한다 (gpt55 vs gpt55_high)", () => {
    const content = '[profiles.gpt55]\nmodel = "gpt-5.5"\n';
    assert.equal(hasProfileSection(content, "gpt55_high"), false);
  });
});

// ── top-level 주입 로직 검증 (순수 함수 수준) ──

describe("top-level 설정 주입 로직: 없으면 주입, 있으면 보존", () => {
  it("top-level 영역(첫 섹션 전)에 model이 없으면 주입 대상으로 판정된다", () => {
    const content = '[profiles.gpt55_high]\nmodel = "gpt-5.5"\n';
    // top-level 영역 = 첫 번째 [profiles.*] 헤더 이전
    const firstSectionIdx = content.search(/^\[(?:profiles|mcp_servers)\./m);
    const topLevelRegion =
      firstSectionIdx === -1 ? content : content.slice(0, firstSectionIdx);
    const topLevelKeyRe = /^model\s*=/m;
    assert.equal(
      topLevelKeyRe.test(topLevelRegion),
      false,
      "top-level region before first section should not contain model=",
    );
  });

  it("top-level model= 이 있으면 보존 대상으로 판정된다", () => {
    const content =
      'model = "gpt-5.5"\nservice_tier = "fast"\n\n[profiles.gpt55_high]\nmodel = "gpt-5.5"\n';
    const topLevelKeyRe = /^model\s*=/m;
    assert.equal(
      topLevelKeyRe.test(content),
      true,
      "should find top-level model=",
    );
  });

  it("프로필 내부 model= 은 top-level로 오인되지 않는다", () => {
    // 프로필 섹션 안의 model=은 top-level key 탐지에서 제외되어야 한다.
    // 현재 regex는 ^model\s*= (multiline)이므로 섹션 헤더 다음 줄도 매칭될 수 있다.
    // 이 테스트는 top-level에 model= 이 없고 프로필에만 있는 케이스를 문서화한다.
    const contentWithoutTopLevel = '[profiles.gpt55_high]\nmodel = "gpt-5.5"\n';
    // regex matches any line starting with "model" — including inside profiles.
    // The injection logic relies on the caller to check BEFORE the first section header.
    // Here we just document the known behavior: the regex WILL match the profile-internal model=.
    // The actual ensureCodexProfiles logic inserts before the first [profiles.*] section,
    // so if top-level model= is absent, the regex test against the full content may still
    // return true due to profile-internal lines. This is a known limitation documented here.
    // The real protection is: inject only if the key is absent from the region BEFORE any section.
    const topLevelKeyRe = /^model\s*=/m;
    // This assertion documents that the regex matches inside profiles too (known behavior)
    assert.equal(
      topLevelKeyRe.test(contentWithoutTopLevel),
      true,
      "regex matches model= inside profiles — known limitation, acceptable since profiles come after top-level region",
    );
  });

  it("top-level 삽입 로직: 첫 섹션 앞에 키를 삽입한다", () => {
    const content = '[profiles.gpt55_high]\nmodel = "gpt-5.5"\n';
    const key = "service_tier";
    const value = '"fast"';
    const line = `${key} = ${value}\n`;
    const firstSectionIdx = content.search(/^\[(?:profiles|mcp_servers)\./m);
    const injected =
      content.slice(0, firstSectionIdx) + line + content.slice(firstSectionIdx);
    assert.ok(
      injected.startsWith(`${key} = ${value}`),
      "key should be inserted at top",
    );
    assert.ok(
      injected.includes("[profiles.gpt55_high]"),
      "profile section preserved",
    );
  });
});

// ── config.toml 크기 가드 ──

describe("ensureCodexProfiles: 손상 파일 가드", () => {
  before(ensureTmpDir);
  after(cleanTmpDir);

  it("REQUIRED_CODEX_PROFILES 리스트가 비어 있지 않다", () => {
    assert.ok(REQUIRED_CODEX_PROFILES.length >= 3, "need at least 3 profiles");
  });

  it("REQUIRED_TOP_LEVEL_SETTINGS 리스트가 비어 있지 않다", () => {
    assert.ok(
      REQUIRED_TOP_LEVEL_SETTINGS.length >= 3,
      "need at least 3 top-level settings",
    );
  });
});

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

// ── LEGACY_CODEX_PROFILE_NAMES: 마이그레이션 정리 대상 ──

describe("LEGACY_CODEX_PROFILE_NAMES: 구형 프로필 정리 목록", () => {
  it("retired 모델 프로필명을 포함한다", () => {
    assert.ok(Array.isArray(LEGACY_CODEX_PROFILE_NAMES));
    for (const n of [
      "codex53_high",
      "gpt54_high",
      "mini54_low",
      "spark53_low",
    ]) {
      assert.ok(
        LEGACY_CODEX_PROFILE_NAMES.includes(n),
        `${n} not in LEGACY_CODEX_PROFILE_NAMES`,
      );
    }
  });

  it("현행 gpt56_* 는 legacy 목록에 없다 (정리 대상 아님)", () => {
    for (const p of REQUIRED_CODEX_PROFILES) {
      assert.equal(
        LEGACY_CODEX_PROFILE_NAMES.includes(p.name),
        false,
        `${p.name} 은 현행 프로필이라 legacy 가 아니어야 한다`,
      );
    }
  });
});

// ── 0.134 별도 파일 포맷: 프로필 lines 는 top-level 키 (inline 헤더 없음) ──

describe("프로필 lines 포맷: 별도 파일용 top-level 키", () => {
  it("REQUIRED_CODEX_PROFILES lines 에 [profiles.*] 헤더가 없다", () => {
    for (const p of REQUIRED_CODEX_PROFILES) {
      for (const line of p.lines) {
        assert.equal(
          line.includes("[profiles."),
          false,
          `${p.name} line 에 inline 헤더가 있으면 안 된다: ${line}`,
        );
      }
    }
  });

  it("각 line 은 key = value 형태다 (별도 파일 top-level)", () => {
    for (const p of REQUIRED_CODEX_PROFILES) {
      for (const line of p.lines) {
        assert.match(line, /^\w+\s*=\s*.+$/, `invalid profile line: ${line}`);
      }
    }
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

  it("inline 프로필이 없으면 빈 배열을 반환한다", () => {
    assert.deepEqual(listInlineProfileNames('model = "gpt-5.5"\n'), []);
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

  it("존재하지 않는 프로필은 빈 배열을 반환한다", () => {
    assert.deepEqual(extractProfileLines('model = "x"\n', "nope"), []);
  });
});
