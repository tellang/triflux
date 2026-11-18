import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverAgyTmuxSessions } from "../../bin/tfx-live.mjs";
import {
  agyContextDir,
  readAgyContext,
  writeAgyContext,
} from "../../hub/lib/agy-context.mjs";

const CONVERSATION_ID = "0b7d1c5e-3f2a-4c8e-9a41-6d5f2e8b7a10";

function runHud(stdin, state) {
  const result = spawnSync(process.execPath, ["hud/hud-qos-status.mjs"], {
    input: JSON.stringify(stdin),
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: state,
      XDG_STATE_HOME: state,
      CODEX_HOME: join(state, "codex"),
      XDG_CONFIG_HOME: join(state, "config"),
      COLUMNS: "120",
      TFX_DISABLE_CODEX: "0",
      TFX_DISABLE_ANTIGRAVITY: "0",
      TFX_DISABLE_CLAUDE: "0",
    },
  });
  assert.equal(result.status, 0, result.stderr);
}

test("agy HUD 입력은 대화 ID 별 기록이 되고 tfx-live 필드로 읽힌다", () => {
  const state = mkdtempSync(join(tmpdir(), "tfx-agy-context-"));
  try {
    const env = { XDG_STATE_HOME: state };
    runHud(
      {
        product: "antigravity",
        conversation_id: CONVERSATION_ID,
        model: "gemini-4-argon",
        context_window: {
          context_window_size: 200000,
          current_usage: { total_tokens: 54000 },
        },
      },
      state,
    );
    const context = readAgyContext(CONVERSATION_ID, { env });
    assert.equal(context.contextPct, 27);
    assert.equal(context.estimatedContextTokens, 54000);
    assert.equal(context.contextLimitTokens, 200000);
    assert.equal(context.contextLimitSource, "agy-statusline");
    assert.equal(context.model, "gemini-4-argon");
    assert.ok(Number.isFinite(Date.parse(context.contextRecordedAt)));
    assert.equal(readAgyContext("other-conversation", { env }), null);

    // 창 크기를 모르면 기록하지 않고, 이전 기록도 건드리지 않는다.
    runHud(
      {
        product: "antigravity",
        conversation_id: "unknown-window",
        context_window: { context_window_size: 0, used_percentage: 0 },
      },
      state,
    );
    assert.deepEqual(readdirSync(agyContextDir(env)), [
      `${CONVERSATION_ID}.json`,
    ]);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("list-sessions agy 는 기록이 있는 세션에 컨텍스트 필드를 싣는다", async () => {
  const state = mkdtempSync(join(tmpdir(), "tfx-agy-list-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = state;
  try {
    writeAgyContext({
      conversationId: CONVERSATION_ID,
      usedPercentage: 42,
      windowSize: 1_000_000,
      usedTokens: 420_000,
      model: "agy-model",
    });
    const panes = (id) =>
      `work\t1\t0\t0\t0\t/tmp\tnode\t\t/dev/ttys001\t${id}\t%${id}\t\t\t`;
    const result = await discoverAgyTmuxSessions(
      {},
      {
        runTmux: async () => ({ stdout: `${panes(1)}\n${panes(2)}` }),
        paneCliProcess: async (_target, _cli, pid) => ({ pid, running: true }),
        // 두 번째 세션은 기록이 없는 대화다.
        agyConversation: async (pid) => ({
          appDataDir: "/tmp/antigravity-cli",
          conversationId:
            pid === 1
              ? CONVERSATION_ID
              : "11111111-2222-3333-4444-555555555555",
        }),
      },
    );
    assert.equal(result.sessions.length, 2);
    assert.equal(result.sessions[0].contextPct, 42);
    assert.equal(result.sessions[0].estimatedContextTokens, 420_000);
    assert.equal(result.sessions[0].contextLimitTokens, 1_000_000);
    assert.equal(result.sessions[0].contextLimitSource, "agy-statusline");
    assert.ok(result.sessions[0].contextRecordedAt);
    assert.equal(result.sessions[1].contextPct, null);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(state, { recursive: true, force: true });
  }
});
