import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { stripAnsi } from "../../hud/utils.mjs";

const hudPath = fileURLToPath(
  new URL("../../hud/hud-qos-status.mjs", import.meta.url),
);

// 빈 HOME 에서 돌려 갱신 프로세스(claude, codex, agy 조회)가 뜨지 않게 한다.
function renderRows(input) {
  const home = mkdtempSync(join(tmpdir(), "tfx-hud-agy-"));
  try {
    const result = spawnSync(process.execPath, [hudPath], {
      input: JSON.stringify(input),
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: join(home, ".codex"),
        XDG_CONFIG_HOME: join(home, "config"),
        COLUMNS: "200",
        TFX_DISABLE_CODEX: "0",
        TFX_DISABLE_ANTIGRAVITY: "0",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const rows = {};
    for (const line of stripAnsi(result.stdout).split("\n")) {
      const marker = line.match(/^([cxa]):/)?.[1];
      if (marker) rows[marker] = line;
    }
    return rows;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const contextWindow = {
  context_window_size: 1_000_000,
  used_percentage: 37,
  current_usage: { input_tokens: 370_000 },
};

it("agy statusLine 입력이면 사용량/잔량이 c 행이 아니라 a 행에 붙는다", () => {
  const rows = renderRows({
    product: "antigravity",
    session_id: "agy-session",
    terminal_width: 200,
    context_window: contextWindow,
  });
  assert.match(rows.a, /370k\/630k/);
  assert.doesNotMatch(rows.c, /370k\/630k/);
});

it("Claude statusLine 입력이면 사용량/잔량이 c 행에 붙는다", () => {
  const rows = renderRows({
    session_id: "claude-session",
    context_window: contextWindow,
  });
  assert.match(rows.c, /370k\/630k/);
  assert.doesNotMatch(rows.a, /370k\/630k/);
});
