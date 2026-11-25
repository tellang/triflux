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

async function codexRolloutContext(
  tokens,
  modelContextWindow,
  model = "gpt-6-astra",
) {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "cx-window-"));
  const rolloutPath = path.join(dir, "rollout.jsonl");
  try {
    await fs.writeFile(
      rolloutPath,
      [
        { type: "turn_context", payload: { model } },
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

test("Codex 실행 창은 모델 표에 없는 모델에도 적용한다", async () => {
  const guard = contextGuard(
    "codex",
    await codexRolloutContext(220_000, 258_400, "gpt-5.4"),
  );
  assert.equal(guard.errorCode, "context-limit");
  assert.equal(guard.contextPct, (220_000 / 258_400) * 100);
});

test("Codex 실행 창이 표 값보다 커도 표 값으로 깎지 않는다", async () => {
  const guard = contextGuard(
    "codex",
    await codexRolloutContext(1_000_000, 1_500_000),
  );
  assert.equal(guard.ok, undefined);
  assert.equal(guard.contextWarning.contextPct, (1_000_000 / 1_500_000) * 100);
});

test("Codex 구체 모델(gpt-6.2-astra, gpt-6.2-sol, gpt-6.1)은 실행 창이 없어도 모델별 창과 60/85 임계값을 쓴다", async () => {
  const astraWarn = await codexRolloutContext(170_000, null, "gpt-6.2-astra");
  assert.equal(astraWarn.contextLimitTokens, 272_000);
  assert.equal(astraWarn.exactModelWindow, true);
  assert.equal(astraWarn.contextPct, (170_000 / 272_000) * 100);
  assert.equal(
    contextGuard("codex", astraWarn).contextWarning.thresholdPct,
    60,
  );

  const astraBlocked = contextGuard(
    "codex",
    await codexRolloutContext(235_000, null, "gpt-6.2-astra-2026"),
  );
  assert.equal(astraBlocked.errorCode, "context-limit");
  assert.equal(astraBlocked.thresholdPct, 85);

  const solWarn = await codexRolloutContext(310_000, null, "gpt-6.2-sol");
  assert.equal(solWarn.contextLimitTokens, 500_000);
  assert.equal(solWarn.exactModelWindow, true);
  assert.equal(contextGuard("codex", solWarn).contextWarning.thresholdPct, 60);

  const sol61Warn = await codexRolloutContext(310_000, null, "gpt-6.1-sol");
  assert.equal(sol61Warn.contextLimitTokens, 500_000);
  assert.equal(sol61Warn.exactModelWindow, true);
  assert.equal(
    contextGuard("codex", sol61Warn).contextWarning.thresholdPct,
    60,
  );

  const terra61Warn = await codexRolloutContext(350_000, null, "gpt-6.1-terra");
  assert.equal(terra61Warn.contextLimitTokens, 500_000);
  assert.equal(terra61Warn.exactModelWindow, true);
  assert.equal(contextGuard("codex", terra61Warn).errorCode, undefined);
  assert.equal(
    contextGuard("codex", terra61Warn).contextWarning.thresholdPct,
    60,
  );

  const lunaBlocked = contextGuard(
    "codex",
    await codexRolloutContext(235_000, null, "gpt-6-luna"),
  );
  assert.equal(lunaBlocked.contextLimitTokens, 272_000);
  assert.equal(lunaBlocked.errorCode, "context-limit");
  assert.equal(lunaBlocked.thresholdPct, 85);

  const gpt61Blocked = contextGuard(
    "codex",
    await codexRolloutContext(350_000, null, "gpt-6.1"),
  );
  assert.equal(gpt61Blocked.contextLimitTokens, 400_000);
  assert.equal(gpt61Blocked.errorCode, "context-limit");
  assert.equal(gpt61Blocked.thresholdPct, 85);

  const unknownSuffix = await codexRolloutContext(
    160_000,
    null,
    "gpt-6.1-nova",
  );
  assert.equal(unknownSuffix.contextLimitTokens, 1_050_000);
  assert.equal(unknownSuffix.exactModelWindow, false);
  assert.equal(
    contextGuard("codex", unknownSuffix).contextWarning.thresholdPct,
    15,
  );
});
