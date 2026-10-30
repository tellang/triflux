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

test("현재 CLI 행에만 Jev와 사용량/잔량을 통합한다", () => {
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
          enabled ? /j 42k\/116k$/ : /42k\/116k$/,
        );
        assert.equal(
          lines.filter((line) => line.includes("42k/116k")).length,
          1,
        );
        assert.equal(
          lines.filter((line) => /\bj\b/.test(line)).length,
          enabled ? 1 : 0,
        );
        assert.doesNotMatch(output, /ctx:|Jev|문맥|ON|OFF/);
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

test("실행창과 usage가 함께 있어야 토큰을 표시하고 0과 unknown을 구분한다", async () => {
  for (const [context_window, expected] of [
    [{ used_percentage: 42 }, "42%/58%"],
    [{ context_window_size: 200000, used_percentage: 42 }, "42%/58%"],
    [{ remaining_percentage: 58 }, "42%/58%"],
    [
      { context_window_size: 200000, current_usage: { total_tokens: 0 } },
      "0/200k",
    ],
    [
      { context_window_size: 200000, current_usage: { total_tokens: 200000 } },
      "200k/0",
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
      "42k/158k",
    ],
    [{ current_usage: { total_tokens: 42000 } }, "?/?"],
    [{ context_window_size: 200000 }, "?/?"],
    [
      { context_window_size: 200000, current_usage: { total_tokens: null } },
      "?/?",
    ],
    [{ used_percentage: null }, "?/?"],
    [{}, "?/?"],
  ])
    assert.equal(
      await sessionStatus({ context_window }, { TFX_JEV: "off" }),
      expected,
    );
  assert.equal(
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
    "?/?",
  );
  assert.equal(
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
    "?/?",
  );
});

test("nano와 band는 기존 provider 축소 정책을 유지한다", () => {
  const input = { context_window: { used_percentage: 100 } };
  const nano = render(input, { COLUMNS: "35", TFX_JEV: "off" });
  assert.equal(nano.trim().split("\n").length, 1);
  assert.match(nano, /c:.*100%\/0%.*x:.*a:/);
  assert.match(
    render(input, { TFX_JEV_CLI: "/missing-test-jev" }, ["--band"]),
    /^tfx-band 1\nc:.*j 100%\/0%/,
  );
});
