import assert from "node:assert/strict";
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
