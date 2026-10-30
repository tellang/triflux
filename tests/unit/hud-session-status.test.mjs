import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sessionStatus } from "../../hud/session-status.mjs";
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

test("현재 CLI 행에 사용률과 지정된 다른 행에 Jev를 표시한다", () => {
  for (const columns of [80, 120, 160]) {
    for (const [product, marker] of [
      [undefined, "c"],
      ["antigravity", "a"],
      ["codex", "x"],
    ]) {
      for (const enabled of [true, false]) {
        const output = render(
          {
            product,
            terminal_width: columns,
            context_window: {
              context_window_size: 158000,
              current_usage: { total_tokens: 42000 },
            },
          },
          {
            COLUMNS: String(columns),
            TFX_JEV: enabled ? "1" : "off",
            TFX_JEV_CLI: "/missing-test-jev",
          },
        );
        const lines = output.trim().split("\n");
        assert.equal(lines.length, 3, output);
        assert.match(
          lines.find((line) => line.startsWith(`${marker}:`)),
          /ctx:27%$/,
        );
        assert.equal(
          lines.filter((line) => line.includes("ctx:27%")).length,
          1,
        );
        assert.equal(
          lines.filter((line) => /\bj\b/.test(line)).length,
          enabled ? 1 : 0,
        );
        const jevMarker = marker === "x" ? "c" : "x";
        const jevRow = lines.find((line) => line.startsWith(`${jevMarker}:`));
        if (enabled) assert.match(jevRow, /\bj$/);
        else assert.doesNotMatch(output, /\bj\b/);
        assert.doesNotMatch(jevRow, /ctx:/);
        assert.deepEqual(
          lines.map((line) => line.slice(0, 2)),
          ["c:", "x:", "a:"],
        );
        assert.doesNotMatch(output, /\d+k\/|Jev|문맥|ON|OFF/);
        assert.ok(
          lines.every((line) => line.length <= columns),
          output,
        );
        const aligned = lines.filter((line) => line.includes("|"));
        assert.ok(
          aligned.every(
            (line) => line.indexOf("|") === aligned[0].indexOf("|"),
          ),
          output,
        );
      }
    }
  }
});

test("실제 토큰으로 사용률을 계산하고 비율 폴백과 0과 unknown을 구분한다", async () => {
  for (const [context_window, expected] of [
    [{ used_percentage: 42 }, "ctx:42%"],
    [{ context_window_size: 200000, used_percentage: 42 }, "ctx:42%"],
    [{ remaining_percentage: 58 }, "ctx:42%"],
    [{ remaining_percentage: 73, used_percentage: 99 }, "ctx:99%"],
    [
      {
        context_window_size: 200000,
        current_usage: { total_tokens: 54000 },
        remaining_percentage: 1,
      },
      "ctx:27%",
    ],
    [
      { context_window_size: 200000, current_usage: { total_tokens: 0 } },
      "ctx:0%",
    ],
    [
      { context_window_size: 200000, current_usage: { total_tokens: 200000 } },
      "ctx:100%",
    ],
    [
      {
        context_window_size: 200000,
        current_usage: {
          input_tokens: 20000,
          cache_creation_input_tokens: 1000,
          cache_read_input_tokens: 21000,
        },
      },
      "ctx:21%",
    ],
    [{ current_usage: { total_tokens: 42000 } }, "ctx:--"],
    [{ context_window_size: 200000 }, "ctx:--"],
    [
      { context_window_size: 200000, current_usage: { total_tokens: null } },
      "ctx:--",
    ],
    [{ used_percentage: null }, "ctx:--"],
    [{}, "ctx:--"],
  ])
    assert.deepEqual(
      await sessionStatus({ context_window }, { TFX_JEV: "off" }),
      { context: expected, jev: "" },
    );
  assert.deepEqual(
    await sessionStatus(
      {},
      new Proxy(
        {},
        {
          get() {
            throw new Error("unknown");
          },
        },
      ),
    ),
    { context: "ctx:--", jev: "" },
  );
  assert.deepEqual(
    await sessionStatus(
      {
        product: "antigravity",
        context_window: {
          context_window_size: 0,
          current_usage: { total_tokens: 0 },
          used_percentage: 0,
          remaining_percentage: 0,
        },
      },
      { TFX_JEV: "off" },
    ),
    { context: "ctx:--", jev: "" },
  );
});

test("nano와 band는 기존 provider 축소 정책을 유지한다", () => {
  const input = { context_window: { used_percentage: 100 } };
  const nano = render(input, { COLUMNS: "35", TFX_JEV: "off" });
  assert.equal(nano.trim().split("\n").length, 1);
  assert.match(nano, /c:.*ctx:100%.*x:.*a:/);
  const band = render(input, { TFX_JEV_CLI: "/missing-test-jev" }, ["--band"]);
  assert.match(band, /^tfx-band 1\nc:.*ctx:100%/);
  assert.match(band, /^x:.*\bj$/m);
});
