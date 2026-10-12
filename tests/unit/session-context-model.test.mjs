import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { modelContext } from "../../hub/team/session-context.mjs";

test("Claude 5.5 세대는 1M 컨텍스트로 판정한다", () => {
  for (const model of [
    "claude-haiku-5-5",
    "claude-sonnet-5-5",
    "claude-opus-5-5",
  ])
    assert.equal(modelContext("claude", model).contextLimitTokens, 1_000_000);
});

test("Claude 5 이상 세대만 가족별 1M 규칙을 적용한다", () => {
  for (const family of ["fable", "opus", "sonnet", "haiku"]) {
    for (const version of ["5", "6-1", "10.2"])
      assert.equal(
        modelContext("claude", `claude-${family}-${version}`)
          .contextLimitTokens,
        1_000_000,
      );
    assert.equal(
      modelContext("claude", `claude-${family}-4-5`).contextLimitTokens,
      null,
    );
  }
});

test("Codex 캐시의 해당 slug 한도와 출처가 표보다 우선하고 손상 시 표로 폴백한다", (t) => {
  const codexHome = mkdtempSync(join(tmpdir(), "tfx-context-model-"));
  t.after(() => rmSync(codexHome, { recursive: true, force: true }));
  const cachePath = join(codexHome, "models_cache.json");
  writeFileSync(
    cachePath,
    JSON.stringify({
      models: [{ slug: "gpt-6.1-sol", context_window: 500_000 }],
    }),
  );
  const context = modelContext("codex", "gpt-6.1-sol", 100_000, { codexHome });
  assert.equal(context.contextLimitTokens, 500_000);
  assert.equal(context.contextLimitSource, cachePath);
  assert.equal(context.contextPct, 20);
  assert.equal(
    modelContext("codex", "gpt-6-astra", null, { codexHome })
      .contextLimitTokens,
    1_050_000,
  );
  writeFileSync(cachePath, "broken");
  const fallback = modelContext("codex", "gpt-6.1-sol", null, { codexHome });
  assert.equal(fallback.contextLimitTokens, 1_050_000);
  assert.equal(
    fallback.contextLimitSource,
    "https://developers.openai.com/api/docs/models",
  );
});

test("200K 인 Haiku 4.5 는 1M 으로 잡지 않는다", () => {
  assert.equal(
    modelContext("claude", "claude-haiku-4-5").contextLimitTokens,
    null,
  );
});
