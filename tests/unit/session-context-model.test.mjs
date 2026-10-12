import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  contextGuard,
  modelContext,
  readCodexContext,
} from "../../hub/team/session-context.mjs";

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

test("200K 인 Haiku 4.5 는 1M 으로 잡지 않는다", () => {
  assert.equal(
    modelContext("claude", "claude-haiku-4-5").contextLimitTokens,
    null,
  );
});

async function codexRolloutContext(tokens, modelContextWindow) {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "cx-window-"));
  const rolloutPath = path.join(dir, "rollout.jsonl");
  try {
    await fs.writeFile(
      rolloutPath,
      [
        { type: "turn_context", payload: { model: "gpt-6-astra" } },
        {
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: { total_tokens: tokens },
              ...(modelContextWindow
                ? { model_context_window: modelContextWindow }
                : {}),
            },
          },
        },
      ]
        .map(JSON.stringify)
        .join("\n"),
    );
    return await readCodexContext(rolloutPath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("Codex 는 rollout 실행 창을 분모로 60/85 를 쓴다", async () => {
  const warned = await codexRolloutContext(160_000, 258_400);
  assert.equal(warned.contextLimitTokens, 1_050_000);
  assert.equal(warned.executionContextLimitTokens, 258_400);
  assert.equal(warned.contextPct, (160_000 / 258_400) * 100);
  assert.equal(contextGuard("codex", warned).contextWarning.thresholdPct, 60);

  const blocked = contextGuard(
    "codex",
    await codexRolloutContext(220_000, 258_400),
  );
  assert.equal(blocked.errorCode, "context-limit");
  assert.equal(blocked.thresholdPct, 85);
});

test("Codex 실행 창이 없으면 1.05M 분모에 15/22 를 쓴다", async () => {
  const warned = await codexRolloutContext(160_000, null);
  assert.equal(warned.executionContextLimitTokens, null);
  assert.equal(warned.contextPct, (160_000 / 1_050_000) * 100);
  assert.equal(contextGuard("codex", warned).contextWarning.thresholdPct, 15);

  const blocked = contextGuard(
    "codex",
    await codexRolloutContext(231_000, null),
  );
  assert.equal(blocked.errorCode, "context-limit");
  assert.equal(blocked.thresholdPct, 22);
});

test("사용자 비율 플래그가 Codex 기본값보다 우선한다", async () => {
  const context = await codexRolloutContext(220_000, 258_400);
  assert.deepEqual(
    contextGuard("codex", context, { warnContextPct: 0, maxContextPct: 90 }),
    {},
  );
  assert.equal(
    contextGuard("codex", await codexRolloutContext(160_000, null), {
      maxContextPct: 15,
    }).thresholdPct,
    15,
  );
});
