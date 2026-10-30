import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stripAnsi } from "../../hud/utils.mjs";

function render(input, extraEnv = {}, args = []) {
  const home = mkdtempSync(join(tmpdir(), "tfx-hud-session-"));
  try {
    const result = spawnSync(
      process.execPath,
      ["hud/hud-qos-status.mjs", ...args],
      {
        input: JSON.stringify(input),
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: home,
          USERPROFILE: home,
          CODEX_HOME: join(home, "codex"),
          XDG_CONFIG_HOME: join(home, "config"),
          COLUMNS: "200",
          TFX_DISABLE_CODEX: "0",
          TFX_DISABLE_ANTIGRAVITY: "0",
          ...extraEnv,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return stripAnsi(result.stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("공유 HUD는 Jev 설정과 남은 문맥 토큰을 표시한다", () => {
  for (const product of [undefined, "antigravity", "codex"]) {
    const output = render(
      {
        product,
        context_window: {
          context_window_size: 200000,
          current_usage: { input_tokens: 84000 },
        },
      },
      { TFX_JEV: "off", JEV_API_KEY: "test-only" },
    );
    assert.match(output, /Jev OFF.*문맥 116k 남음/);
    assert.match(output, /^c:/m);
    assert.match(output, /^x:/m);
    assert.match(output, /^a:/m);
    assert.doesNotMatch(output, /test-only|Jev 오류/);
  }
  assert.match(render({}, { TFX_JEV_CLI: "/missing-test-jev" }), /Jev ON/);
});

test("비율만 알면 토큰을 추정하지 않고 정보가 없으면 미확인이다", () => {
  for (const context_window of [
    { used_percentage: 42 },
    { context_window_size: 200000, used_percentage: 42 },
    { remaining_percentage: 58 },
  ]) {
    const output = render({ context_window });
    assert.match(output, /문맥 58% 남음/);
    assert.doesNotMatch(output, /문맥 \d+k 남음/);
  }
  assert.match(
    render({
      context_window: {
        context_window_size: 200000,
        current_usage: { total_tokens: 0 },
      },
    }),
    /문맥 200k 남음/,
  );
  assert.match(render({}), /Jev OFF.*문맥 미확인/);
  assert.match(
    render({ context_window: { used_percentage: null } }),
    /문맥 미확인/,
  );
});

test("좁은 HUD와 band에도 Jev와 남은 문맥이 있다", () => {
  const input = { context_window: { used_percentage: 100 } };
  assert.match(render(input, { COLUMNS: "35" }), /Jev OFF.*문맥 0% 남음/);
  assert.match(render(input, {}, ["--band"]), /^tfx-band 1\n[\s\S]*Jev OFF/);
});
