import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as modelEffort from "../../scripts/lib/model-effort.mjs";

test("옛 결합 이름을 같은 가족과 effort로 해석한다", () => {
  for (const [cli, profile, family, effort] of [
    ["codex", "sol_high", "sol", "high"],
    ["codex", "sol_med", "sol", "medium"],
    ["codex", "gpt61_sol_high", "sol", "high"],
    ["codex", "gpt56_terra_high", "sol", "high"],
    ["codex", "gpt56_terra_med", "sol", "medium"],
    ["codex", "gpt56_sol_xhigh", "astra", "xhigh"],
    ["codex", "gpt56_sol_max", "astra", "max"],
    ["codex", "gpt56_sol_ultra", "astra", "ultra"],
    ["codex", "max", "astra", "max"],
    ["codex", "ultra", "astra", "ultra"],
    ["codex", "terra_high", "terra", "high"],
    ["codex", "luna_low", "luna", "low"],
    ["antigravity", "argon_high", "argon", "high"],
    ["antigravity", "argon", "argon", "medium"],
    ["antigravity", "flash38_high", "argon", "low"],
    ["agy", "argon_low", "argon", "low"],
  ]) {
    assert.deepEqual(modelEffort.modelEffortFromProfile(cli, profile), {
      family,
      effort,
    });
  }
});

test("분리한 값을 옛 설치본이 읽는 결합 이름으로 돌린다", () => {
  for (const [cli, family, effort, profile] of [
    ["codex", "sol", "medium", "sol_med"],
    ["codex", "sol", "high", "sol_high"],
    ["codex", "astra", "max", "astra_max"],
    ["codex", "terra", "high", "terra_high"],
    ["codex", "luna", "low", "luna_low"],
    ["antigravity", "argon", "medium", "argon"],
    ["agy", "argon", "high", "argon_high"],
  ]) {
    assert.equal(
      modelEffort.profileFromModelEffort(cli, { family, effort }),
      profile,
    );
  }
});

test("알 수 없는 이름과 CLI 또는 effort를 임의 기본값으로 바꾸지 않는다", () => {
  for (const profile of ["", "personal", "sol_bogus", "argon_high"]) {
    assert.equal(modelEffort.modelEffortFromProfile("codex", profile), null);
  }
  assert.equal(modelEffort.modelEffortFromProfile("claude", "sol_high"), null);
  assert.equal(
    modelEffort.profileFromModelEffort("codex", {
      family: "sol",
      effort: "bogus",
    }),
    null,
  );
  assert.equal(
    modelEffort.profileFromModelEffort("codex", {
      family: "argon",
      effort: "high",
    }),
    null,
  );
});

test("객체 상속 키를 프로필로 해석하지 않는다", () => {
  for (const cli of ["codex", "antigravity"]) {
    for (const profile of ["__proto__", "constructor", "toString"]) {
      assert.equal(modelEffort.modelEffortFromProfile(cli, profile), null);
    }
  }
});

test("정규화는 객체 상속 키도 문자열로 보존한다", () => {
  for (const name of ["__proto__", "constructor", "toString"]) {
    assert.equal(modelEffort.normalizeCodexProfileName(name), name);
  }
});

test("최신 가족 모델에서 지원하는 가장 가까운 아래 effort를 고른다", (t) => {
  const home = mkdtempSync(join(tmpdir(), "tfx-effort-capability-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const codexHome = join(home, ".codex");
  mkdirSync(codexHome);
  const cachePath = join(codexHome, "models_cache.json");
  writeFileSync(
    cachePath,
    JSON.stringify({
      models: [
        {
          slug: "gpt-6-astra",
          visibility: "list",
          supported_reasoning_levels: ["max"],
        },
        {
          slug: "gpt-7-astra",
          visibility: "list",
          supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
        },
      ],
    }),
  );
  const opts = { home, codexHome, allowCommand: false, persist: false };
  assert.deepEqual(
    modelEffort.resolveCodexModelEffort(
      { family: "astra", effort: "max" },
      opts,
    ),
    { family: "astra", model: "gpt-7-astra", effort: "high" },
  );
  assert.throws(
    () =>
      modelEffort.resolveCodexModelEffort(
        { family: "astra", effort: "none" },
        opts,
      ),
    /지원.*effort/,
  );
  writeFileSync(cachePath, JSON.stringify({ models: [] }));
  assert.equal(
    modelEffort.resolveCodexModelEffort(
      { family: "astra", effort: "max" },
      opts,
    ).effort,
    "max",
  );
  rmSync(cachePath);
  assert.equal(
    modelEffort.resolveCodexModelEffort(
      { family: "astra", effort: "max" },
      opts,
    ).effort,
    "max",
  );
});

test("agy는 최신 가족의 지원 effort를 쓰고 목록이 없으면 낮추지 않는다", (t) => {
  const home = mkdtempSync(join(tmpdir(), "tfx-agy-effort-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const stateDir = join(home, "state");
  const opts = {
    home,
    stateDir,
    env: { HOME: home },
    runCommand: () =>
      "gemini-4.9-argon-high\tGemini 4.9 Argon (High)\n" +
      "gemini-4.10-argon-medium\tGemini 4.10 Argon (Medium)\n",
  };
  for (const effort of ["high", "xhigh", "max"]) {
    assert.deepEqual(
      modelEffort.resolveAgyModelEffort({ family: "argon", effort }, opts),
      { family: "argon", model: "gemini-4.10-argon", effort: "medium" },
    );
  }
  assert.throws(
    () =>
      modelEffort.resolveAgyModelEffort(
        { family: "argon", effort: "low" },
        opts,
      ),
    { code: "unsupported-effort" },
  );
  rmSync(join(stateDir, "agy-models.json"));
  const offline = { ...opts, allowCommand: false };
  assert.deepEqual(
    modelEffort.resolveAgyModelEffort(
      { family: "argon", effort: "max" },
      offline,
    ),
    { family: "argon", model: "gemini-4.10-argon", effort: "max" },
  );
  writeFileSync(join(stateDir, "models.json"), '{"argon":"gemini-4-argon"}');
  assert.deepEqual(
    modelEffort.resolveAgyModelEffort(
      { family: "argon", effort: "high" },
      opts,
    ),
    { family: "argon", model: "gemini-4-argon", effort: "high" },
  );
});
