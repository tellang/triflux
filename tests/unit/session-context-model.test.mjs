import assert from "node:assert/strict";
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

test("200K 인 Haiku 4.5 는 1M 으로 잡지 않는다", () => {
  assert.equal(
    modelContext("claude", "claude-haiku-4-5").contextLimitTokens,
    null,
  );
});
