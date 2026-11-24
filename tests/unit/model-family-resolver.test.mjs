import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ensureAgyProfiles,
  normalizeAgyProfileName,
  resolveAgyModel,
} from "../../scripts/lib/agy-profiles.mjs";
import {
  ensureManagedCodexProfiles,
  normalizeCodexProfileName,
} from "../../scripts/lib/codex-profile-config.mjs";
import {
  modelEffortFromProfile,
  resolveAgyModelEffort,
} from "../../scripts/lib/model-effort.mjs";
import {
  parseAgyModels,
  resolveModelFamilies,
  selectAgyModel,
  selectCodexModel,
} from "../../scripts/lib/model-family-resolver.mjs";

const model = (slug, efforts = ["high"], visibility = "list") => ({
  slug,
  visibility,
  supported_reasoning_levels: efforts.map((effort) => ({ effort })),
});

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "tfx-model-families-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const codexHome = join(home, ".codex");
  const stateDir = join(home, ".config", "triflux");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  return {
    home,
    codexHome,
    stateDir,
    env: { HOME: home },
    runCommand: () => {
      throw new Error("offline");
    },
  };
}

test("숫자 버전 순으로 같은 가족의 공개 모델 중 effort를 지원하는 것을 고른다", () => {
  const models = [
    model("gpt-6-sol"),
    model("gpt-6.9-sol"),
    model("gpt-6.10-sol"),
    model("gpt-7-sol", ["low"]),
    model("gpt-8-sol", ["high"], "hide"),
    model("gpt-99-astra"),
    model("gpt-5.6-sol"),
  ];
  assert.equal(selectCodexModel(models, "sol", "high")?.slug, "gpt-6.10-sol");
  assert.equal(selectCodexModel(models, "sol", "low")?.slug, "gpt-7-sol");
  assert.equal(selectCodexModel(models, "luna", "high"), null);
  assert.equal(
    selectCodexModel(
      [model("gpt-5.6-sol"), model("gpt-6-sol"), model("gpt-6.1-sol")],
      "sol",
      "high",
    )?.slug,
    "gpt-6.1-sol",
  );
});

test("agy 목록은 같은 가족의 숫자 버전과 effort를 골라 display name을 쓴다", () => {
  const models = parseAgyModels(
    "gemini-3.9-flash-high\tGemini 3.9 Flash (High)\ngemini-3.10-flash-high\tGemini 3.10 Flash (High)\ngemini-4.9-argon-high\tGemini 4.9 Argon (High)\ngemini-4.10-argon-high\tGemini 4.10 Argon (High)\ngemini-4-pro-high\tGemini 4 Pro (High)\nnoise\n",
  );
  assert.equal(models.length, 2);
  assert.equal(
    selectAgyModel(models, "argon", "high")?.model,
    "Gemini 4.10 Argon (High)",
  );
  assert.equal(selectAgyModel(models, "argon", "medium"), null);
});

test("agy 목록에서 Argon만 고르고 Flash와 Pro는 자동 선택하지 않는다", (t) => {
  const opts = fixture(t);
  opts.runCommand = () =>
    "gemini-4-argon-high\tGemini 4 Argon (High)\n" +
    "gemini-4-argon-medium\tGemini 4 Argon (Medium)\n" +
    "gemini-4-argon-low\tGemini 4 Argon (Low)\n" +
    "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n" +
    "gemini-3.1-pro-high\tGemini 3.1 Pro (High)\n";
  const { profiles } = resolveModelFamilies("agy", opts);
  assert.deepEqual(
    Object.keys(profiles).filter((name) => /^argon/.test(name)),
    ["argon_low", "argon", "argon_high"],
  );
  assert.equal(profiles.argon_high.model, "Gemini 4 Argon (High)");
});

test("agy 목록에 Carbon이 있으면 Carbon 프로필을 쓴다", (t) => {
  const opts = fixture(t);
  opts.runCommand = () =>
    "gemini-4-argon-high\tGemini 4 Argon (High)\n" +
    "gemini-4-carbon-high\tGemini 4 Carbon (High)\n" +
    "gemini-4-carbon-medium\tGemini 4 Carbon (Medium)\n" +
    "gemini-4-carbon-low\tGemini 4 Carbon (Low)\n";
  const { profiles, families } = resolveModelFamilies("agy", opts);
  assert.equal(profiles.carbon_high.model, "Gemini 4 Carbon (High)");
  assert.equal(profiles.carbon_high.fallbackFrom, undefined);
  assert.equal(families.carbon.model, "gemini-4-carbon");
  assert.equal(families.carbon.fallbackFrom, undefined);
});

test("agy 목록에 Carbon이 없으면 Neon, 그다음 Hydrogen으로 폴백하고 Argon으로는 가지 않는다", (t) => {
  const withNeon = fixture(t);
  withNeon.runCommand = () =>
    "gemini-4-argon-high\tGemini 4 Argon (High)\n" +
    "gemini-4-neon-high\tGemini 4 Neon (High)\n" +
    "gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)\n" +
    "gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)\n";
  const { profiles, families } = resolveModelFamilies("agy", withNeon);
  assert.equal(families.carbon.model, "gemini-4-neon");
  assert.equal(families.carbon.fallbackFamily, "neon");
  assert.equal(families.carbon.fallbackFrom, "carbon");
  // 옛 결합 이름은 결합 이름이 있는 Hydrogen의 같은 effort로 옮긴다.
  assert.equal(profiles.carbon_high.model, "Gemini 4 Hydrogen (High)");
  assert.equal(profiles.carbon.model, "Gemini 4 Hydrogen (Medium)");
  assert.equal(profiles.carbon_high.fallbackFrom, "carbon");

  const argonOnly = fixture(t);
  argonOnly.runCommand = () => "gemini-4-argon-high\tGemini 4 Argon (High)\n";
  const onlyArgon = resolveModelFamilies("agy", argonOnly);
  assert.equal(onlyArgon.families.carbon.model, "gemini-4-carbon");
  assert.equal(onlyArgon.families.carbon.fallbackFrom, undefined);
});

test("agy Neon은 결합 이름 없이 가족과 effort로 해석하고, 목록에 없으면 Hydrogen에서 effort를 낮춘다", (t) => {
  assert.deepEqual(modelEffortFromProfile("agy", "neon"), {
    family: "neon",
    effort: "medium",
  });
  assert.deepEqual(modelEffortFromProfile("agy", "neon", "xhigh"), {
    family: "neon",
    effort: "xhigh",
  });

  const withNeon = fixture(t);
  withNeon.runCommand = () =>
    "gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)\n" +
    "gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)\n" +
    "gemini-4-neon-high\tGemini 4 Neon (High)\n";
  assert.deepEqual(
    resolveAgyModelEffort({ family: "neon", effort: "xhigh" }, withNeon),
    { family: "neon", model: "gemini-4-neon", effort: "xhigh" },
  );

  const withoutNeon = fixture(t);
  withoutNeon.runCommand = () =>
    "gemini-4-argon-high\tGemini 4 Argon (High)\n" +
    "gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)\n" +
    "gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)\n";
  assert.deepEqual(
    resolveAgyModelEffort({ family: "neon", effort: "xhigh" }, withoutNeon),
    {
      family: "hydrogen",
      model: "gemini-4-hydrogen",
      fallbackFrom: "neon",
      effort: "high",
    },
  );
});

test("목록을 읽지 못하면 Carbon 내장 기본값을 유지하고, 고정한 Carbon은 폴백하지 않는다", (t) => {
  const opts = fixture(t);
  const offline = resolveModelFamilies("agy", opts);
  assert.equal(offline.profiles.carbon_high.model, "Gemini 4 Carbon (High)");
  assert.equal(offline.families.carbon.fallbackFrom, undefined);

  opts.runCommand = () => "gemini-4-argon-high\tGemini 4 Argon (High)\n";
  writeFileSync(
    join(opts.stateDir, "models.json"),
    JSON.stringify({ carbon: "gemini-4-carbon" }),
  );
  const pinned = resolveModelFamilies("agy", { ...opts, now: () => 1 });
  assert.equal(pinned.families.carbon.model, "gemini-4-carbon");
  assert.equal(pinned.profiles.carbon_high.model, "Gemini 4 Carbon (High)");
  assert.equal(pinned.families.carbon.fallbackFrom, undefined);
});

test("models.json의 Argon 고정은 최신 목록보다 우선한다", (t) => {
  const opts = fixture(t);
  opts.runCommand = () =>
    "gemini-4.1-argon-high\tGemini 4.1 Argon (High)\n" +
    "gemini-4-argon-medium\tGemini 4 Argon (Medium)\n" +
    "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n";
  const pins = join(opts.stateDir, "models.json");
  writeFileSync(pins, JSON.stringify({ argon: "gemini-4-argon" }));
  const { profiles } = resolveModelFamilies("agy", opts);
  assert.equal(profiles.argon_low?.model, "Gemini 4 Argon (Low)");
  assert.equal(profiles.argon?.model, "Gemini 4 Argon (Medium)");
  assert.equal(profiles.argon_high?.model, "Gemini 4 Argon (High)");
  rmSync(pins);
  assert.equal(
    resolveModelFamilies("agy", opts).profiles.argon_high.model,
    "Gemini 4.1 Argon (High)",
  );
});

test("고정 파일이 목록보다 우선하고 제거하면 자동 선택으로 돌아간다", (t) => {
  const opts = fixture(t);
  const cache = join(opts.codexHome, "models_cache.json");
  writeFileSync(
    cache,
    JSON.stringify({
      fetched_at: "2026-10-12T00:00:00Z",
      models: [model("gpt-6.2-sol", ["high", "medium"])],
    }),
  );
  const pins = join(opts.stateDir, "models.json");
  writeFileSync(
    pins,
    JSON.stringify({
      sol: "gpt-6-sol",
      argon: "gemini-4-argon",
      luna: "gpt-99-sol",
    }),
  );
  assert.equal(
    resolveModelFamilies("codex", opts).profiles.sol_high.model,
    "gpt-6-sol",
  );
  assert.equal(
    resolveModelFamilies("codex", opts).profiles.luna_low.model,
    "gpt-6-luna",
  );
  assert.equal(
    resolveModelFamilies("agy", opts).profiles.argon_high.model,
    "Gemini 4 Argon (High)",
  );
  rmSync(pins);
  assert.equal(
    resolveModelFamilies("codex", opts).profiles.sol_high.model,
    "gpt-6.2-sol",
  );
});

test("갱신된 목록을 반영하고 손상되거나 가족이 없으면 마지막 결과와 기본값으로 폴백한다", (t) => {
  const opts = fixture(t);
  const cache = join(opts.codexHome, "models_cache.json");
  assert.equal(
    resolveModelFamilies("codex", opts).profiles.sol_high.model,
    "gpt-6.2-sol",
  );
  writeFileSync(
    cache,
    JSON.stringify({
      fetched_at: "2026-10-12T00:00:00Z",
      models: [model("gpt-6.2-sol")],
    }),
  );
  assert.equal(
    resolveModelFamilies("codex", opts).profiles.sol_high.model,
    "gpt-6.2-sol",
  );
  writeFileSync(
    cache,
    JSON.stringify({
      fetched_at: "2026-10-13T00:00:00Z",
      models: [model("gpt-6.10-sol")],
    }),
  );
  assert.equal(
    resolveModelFamilies("codex", opts).profiles.sol_high.model,
    "gpt-6.10-sol",
  );
  writeFileSync(cache, "broken");
  assert.equal(
    resolveModelFamilies("codex", opts).profiles.sol_high.model,
    "gpt-6.10-sol",
  );
  writeFileSync(
    cache,
    JSON.stringify({ fetched_at: "2026-10-14T00:00:00Z", models: [] }),
  );
  assert.equal(
    resolveModelFamilies("codex", opts).profiles.sol_high.model,
    "gpt-6.10-sol",
  );
  const record = JSON.parse(
    readFileSync(join(opts.stateDir, "codex-model-resolution.json"), "utf8"),
  );
  assert.equal(record.profiles.sol_high.fetched_at, "2026-10-13T00:00:00Z");
});

test("Codex 캐시가 없으면 debug models를 쓰고 agy는 하루에 한 번만 재조회한다", (t) => {
  const opts = fixture(t);
  let calls = 0;
  opts.runCommand = (command, args) => {
    calls++;
    if (command === "codex") {
      assert.deepEqual(args, ["debug", "models"]);
      return JSON.stringify({ models: [model("gpt-7-sol")] });
    }
    assert.deepEqual(args, ["models"]);
    return "gemini-4.1-argon-high\tGemini 4.1 Argon (High)\n";
  };
  opts.now = () => Date.parse("2026-10-12T00:00:00Z");
  assert.equal(
    resolveModelFamilies("codex", opts).profiles.sol_high.model,
    "gpt-7-sol",
  );
  assert.equal(
    resolveModelFamilies("agy", opts).profiles.argon_high.model,
    "Gemini 4.1 Argon (High)",
  );
  resolveModelFamilies("agy", opts);
  resolveModelFamilies("codex", opts);
  assert.equal(calls, 2);
  opts.now = () => Date.parse("2026-10-13T00:00:01Z");
  opts.runCommand = () => {
    calls++;
    throw new Error("offline");
  };
  assert.equal(
    resolveModelFamilies("agy", opts).profiles.argon_high.model,
    "Gemini 4.1 Argon (High)",
  );
  resolveModelFamilies("agy", opts);
  assert.equal(calls, 3);
});

test("옛 프로필 이름은 effort를 유지한 가족 별칭으로 정규화한다", () => {
  for (const [old, current] of [
    ["gpt61_sol_high", "sol_high"],
    ["gpt61_sol_med", "sol_med"],
    ["gpt6_sol_high", "sol_high"],
    ["gpt6_sol_med", "sol_med"],
    ["gpt6_astra_xhigh", "astra_xhigh"],
    ["gpt6_astra_max", "astra_max"],
    ["gpt6_astra_ultra", "astra_ultra"],
    ["gpt6_luna_low", "luna_low"],
    ["gpt6_luna_high", "luna_high"],
    ["gpt56_luna_low", "luna_low"],
    ["gpt56_luna_high", "luna_high"],
    ["gpt56_terra_med", "sol_med"],
    ["gpt56_terra_high", "sol_high"],
    ["gpt56_sol_xhigh", "astra_xhigh"],
    ["gpt56_sol_max", "astra_max"],
    ["gpt56_sol_ultra", "astra_ultra"],
  ])
    assert.equal(normalizeCodexProfileName(old), current);
  assert.equal(normalizeCodexProfileName("personal"), "personal");
  for (const old of ["flash", "flash_high", "flash38", "flash38_low"])
    assert.equal(normalizeAgyProfileName(old), "argon_low");
});

test("관리 프로필 갱신은 최신 해석을 쓰고 옛 파일과 커스텀 프로필을 보존한다", (t) => {
  const opts = fixture(t);
  const oldPath = join(opts.codexHome, "gpt61_sol_high.config.toml");
  writeFileSync(oldPath, "old profile");
  writeFileSync(
    join(opts.codexHome, "models_cache.json"),
    JSON.stringify({
      fetched_at: "2026-10-12T00:00:00Z",
      models: [model("gpt-6.10-sol")],
    }),
  );
  ensureManagedCodexProfiles(opts);
  assert.match(
    readFileSync(join(opts.codexHome, "sol.config.toml"), "utf8"),
    /gpt-6\.10-sol/,
  );
  assert.equal(existsSync(join(opts.codexHome, "sol_high.config.toml")), false);
  assert.equal(readFileSync(oldPath, "utf8"), "old profile");
  assert.equal(ensureManagedCodexProfiles(opts).changed, 0);
  opts.geminiDir = join(opts.home, ".gemini");
  opts.profilesPath = join(opts.geminiDir, "triflux-profiles.json");
  mkdirSync(opts.geminiDir);
  writeFileSync(
    opts.profilesPath,
    JSON.stringify({
      profiles: {
        personal: { model: "custom" },
        flash38_high: { model: "old" },
      },
    }),
  );
  opts.runCommand = () => "gemini-4-argon-low\tGemini 4 Argon (Low)\n";
  assert.equal(ensureAgyProfiles(opts).ok, true);
  assert.equal(resolveAgyModel("flash38_high", opts), "Gemini 4 Argon (Low)");
  assert.equal(resolveAgyModel("personal", opts), "custom");
});

test("가족 파일은 effort와 무관한 최신 모델만 쓰고 결합 파일은 새로 만들지 않는다", (t) => {
  const opts = fixture(t);
  writeFileSync(
    join(opts.codexHome, "models_cache.json"),
    JSON.stringify({
      fetched_at: "2030-01-01T00:00:00Z",
      models: [model("gpt-6.1-sol"), model("gpt-7-sol", ["low"])],
    }),
  );
  ensureManagedCodexProfiles(opts);
  assert.equal(
    readFileSync(join(opts.codexHome, "sol.config.toml"), "utf8"),
    'model = "gpt-7-sol"\n',
  );
  assert.equal(
    readFileSync(join(opts.codexHome, "astra.config.toml"), "utf8"),
    'model = "gpt-6.2-astra"\n',
  );
  assert.equal(existsSync(join(opts.codexHome, "sol_high.config.toml")), false);
  assert.equal(ensureManagedCodexProfiles(opts).changed, 0);
  writeFileSync(join(opts.stateDir, "models.json"), '{"sol":"gpt-6-sol"}');
  ensureManagedCodexProfiles(opts);
  assert.equal(
    readFileSync(join(opts.codexHome, "sol.config.toml"), "utf8"),
    'model = "gpt-6-sol"\n',
  );
  rmSync(join(opts.stateDir, "models.json"));
  rmSync(join(opts.codexHome, "models_cache.json"));
  ensureManagedCodexProfiles(opts);
  assert.equal(
    readFileSync(join(opts.codexHome, "sol.config.toml"), "utf8"),
    'model = "gpt-7-sol"\n',
  );
});

test("families 없는 옛 기록으로 업그레이드해도 최신 가족 모델을 다시 고른다", (t) => {
  const opts = fixture(t);
  writeFileSync(
    join(opts.codexHome, "models_cache.json"),
    JSON.stringify({
      models: [model("gpt-6.1-sol"), model("gpt-6.2-sol", ["low"])],
    }),
  );
  resolveModelFamilies("codex", opts);
  const recordPath = join(opts.stateDir, "codex-model-resolution.json");
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  delete record.families;
  writeFileSync(recordPath, JSON.stringify(record));
  ensureManagedCodexProfiles(opts);
  assert.equal(
    readFileSync(join(opts.codexHome, "sol.config.toml"), "utf8"),
    'model = "gpt-6.2-sol"\n',
  );
});

test("가족 목록이 바뀌기 전에 저장한 agy 목록은 하루가 안 지나도 다시 조회한다", (t) => {
  const opts = fixture(t);
  const now = Date.parse("2026-11-11T09:00:00Z");
  writeFileSync(
    join(opts.stateDir, "agy-models.json"),
    JSON.stringify({
      models: [{ slug: "gemini-4-argon-high", model: "Gemini 4 Argon (High)" }],
      fetched_at: "2026-11-11T00:55:00Z",
      checked_at: "2026-11-11T00:55:00Z",
    }),
  );
  let calls = 0;
  opts.now = () => now;
  opts.runCommand = () => {
    calls++;
    return (
      "gemini-4-argon-high\tGemini 4 Argon (High)\n" +
      "gemini-4-carbon-high\tGemini 4 Carbon (High)\n"
    );
  };
  const first = resolveModelFamilies("agy", opts);
  assert.equal(first.families.carbon.fallbackFrom, undefined);
  resolveModelFamilies("agy", opts);
  assert.equal(calls, 1);
});

test("agy Hydrogen 프로필 해석 및 목록 부재 시 Neon 폴백과 models.json 핀을 검증한다", (t) => {
  const opts = fixture(t);
  opts.runCommand = () =>
    "gemini-4-argon-medium\tGemini 4 Argon (Medium)\n" +
    "gemini-4-neon-medium\tGemini 4 Neon (Medium)\n";
  const withoutHydrogen = resolveModelFamilies("agy", opts);
  assert.equal(withoutHydrogen.families.hydrogen.fallbackFrom, "hydrogen");
  assert.equal(withoutHydrogen.families.hydrogen.model, "gemini-4-neon");

  rmSync(join(opts.stateDir, "agy-models.json"), { force: true });
  opts.runCommand = () =>
    "gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)\n" +
    "gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)\n" +
    "gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)\n" +
    "gemini-4-argon-medium\tGemini 4 Argon (Medium)\n";
  const withHydrogen = resolveModelFamilies("agy", opts);
  assert.equal(withHydrogen.families.hydrogen.fallbackFrom, undefined);
  assert.equal(withHydrogen.families.hydrogen.model, "gemini-4-hydrogen");
  assert.equal(
    withHydrogen.profiles.hydrogen_low.model,
    "Gemini 4 Hydrogen (Low)",
  );
  assert.equal(
    withHydrogen.profiles.hydrogen.model,
    "Gemini 4 Hydrogen (Medium)",
  );
  assert.equal(
    withHydrogen.profiles.hydrogen_high.model,
    "Gemini 4 Hydrogen (High)",
  );

  const pinsPath = join(opts.stateDir, "models.json");
  rmSync(join(opts.stateDir, "agy-models.json"), { force: true });
  opts.runCommand = () => "gemini-4-argon-medium\tGemini 4 Argon (Medium)\n";
  writeFileSync(pinsPath, JSON.stringify({ hydrogen: "gemini-4.5-hydrogen" }));
  const pinned = resolveModelFamilies("agy", opts);
  assert.equal(pinned.families.hydrogen.model, "gemini-4.5-hydrogen");
  assert.equal(pinned.families.hydrogen.source, pinsPath);
  assert.equal(pinned.families.hydrogen.fallbackFrom, undefined);
});
