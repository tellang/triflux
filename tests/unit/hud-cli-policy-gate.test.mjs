import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  resolveHudCliVisibility,
  shouldRenderGeminiFallbackRow,
} from "../../hud/cli-policy.mjs";
import { getMicroLine } from "../../hud/renderers.mjs";
import { stripAnsi } from "../../hud/utils.mjs";

// getMicroLine 은 터미널 폭으로 잘라낸다. 좁은 터미널에서 세그먼트가 잘려
// 판정이 흔들리지 않도록 폭을 고정한다. getTerminalColumns 는 첫 호출에서
// 캐시하므로 아래 어떤 렌더 호출보다 먼저 정해지면 된다.
process.env.COLUMNS = "200";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

// 실제 홈이나 머신 프로파일을 읽지 않도록 존재하지 않는 경로를 고정한다.
const MISSING_PROFILE = join(
  tmpdir(),
  "tfx-hud-cli-policy-absent",
  "machine-profile.env",
);

function envWith(overrides = {}) {
  return { TFX_MACHINE_PROFILE_PATH: MISSING_PROFILE, ...overrides };
}

describe("hud/cli-policy: resolveHudCliVisibility", () => {
  it("codex 차단은 codex 행만 숨기고 antigravity 는 건드리지 않는다", () => {
    const visibility = resolveHudCliVisibility(
      envWith({ TFX_DISABLE_CODEX: "1" }),
    );
    assert.equal(visibility.showCodex, false);
    assert.equal(visibility.antigravityAllowed, true);
    assert.equal(visibility.policy.codexDisabled, true);
    assert.equal(visibility.policy.source.codex, "env");
  });

  it("antigravity 차단은 antigravityAllowed 를 내린다", () => {
    const visibility = resolveHudCliVisibility(
      envWith({ TFX_DISABLE_ANTIGRAVITY: "1" }),
    );
    assert.equal(visibility.showCodex, true);
    assert.equal(visibility.antigravityAllowed, false);
    assert.equal(visibility.policy.antigravityDisabled, true);
  });

  it("둘 다 허용이면 두 표시 플래그가 모두 참이다", () => {
    const visibility = resolveHudCliVisibility(
      envWith({ TFX_DISABLE_CODEX: "0", TFX_DISABLE_ANTIGRAVITY: "0" }),
    );
    assert.equal(visibility.showCodex, true);
    assert.equal(visibility.antigravityAllowed, true);
  });

  it("프로파일도 env 도 없으면 기본값으로 전부 표시한다", () => {
    const visibility = resolveHudCliVisibility(envWith());
    assert.equal(visibility.showCodex, true);
    assert.equal(visibility.antigravityAllowed, true);
    assert.equal(visibility.policy.source.codex, "default");
  });

  it("이미 계산한 정책을 주입하면 그대로 접는다", () => {
    const visibility = resolveHudCliVisibility(envWith(), {
      policy: { codexDisabled: true, antigravityDisabled: true },
    });
    assert.equal(visibility.showCodex, false);
    assert.equal(visibility.antigravityAllowed, false);
  });

  it("정책 판독이 예외를 던지면 fail-open 으로 전부 표시한다", () => {
    const visibility = resolveHudCliVisibility(envWith(), {
      resolve: () => {
        throw new Error("machine profile 판독 실패");
      },
    });
    assert.deepEqual(visibility, {
      showCodex: true,
      antigravityAllowed: true,
      policy: null,
    });
  });
});

describe("hud/cli-policy: shouldRenderGeminiFallbackRow", () => {
  it("antigravity 가 허용이면 gemini 정보가 없어도 그린다", () => {
    assert.equal(
      shouldRenderGeminiFallbackRow({
        antigravityAllowed: true,
        antigravityReady: false,
        geminiEmail: null,
        geminiBucket: null,
        geminiSession: null,
      }),
      true,
    );
  });

  it("antigravity 가 차단이고 gemini 정보가 전무하면 행을 생략한다", () => {
    assert.equal(
      shouldRenderGeminiFallbackRow({
        antigravityAllowed: false,
        antigravityReady: false,
        geminiEmail: null,
        geminiBucket: null,
        geminiSession: null,
      }),
      false,
    );
  });

  it("antigravity 가 차단이어도 이메일 하나만 있으면 그린다", () => {
    assert.equal(
      shouldRenderGeminiFallbackRow({
        antigravityAllowed: false,
        geminiEmail: "someone@example.com",
      }),
      true,
    );
  });

  it("쿼터 버킷이나 세션 중 하나만 있어도 그린다", () => {
    assert.equal(
      shouldRenderGeminiFallbackRow({
        antigravityAllowed: false,
        geminiBucket: { modelId: "gemini-3-flash-preview" },
      }),
      true,
    );
    assert.equal(
      shouldRenderGeminiFallbackRow({
        antigravityAllowed: false,
        geminiSession: { total: 1200 },
      }),
      true,
    );
  });

  it("인자를 주지 않으면 기존 동작대로 그린다", () => {
    assert.equal(shouldRenderGeminiFallbackRow(), true);
  });
});

describe("hud/renderers: getMicroLine 정책 게이트", () => {
  const CONTEXT_VIEW = { percent: 12, display: "12%" };
  const CLAUDE_USAGE = { fiveHourPercent: 39, weeklyPercent: 20 };
  const CODEX_BUCKETS = {
    codex: {
      primary: { used_percent: 41 },
      secondary: { used_percent: 22 },
    },
  };

  function micro(options) {
    const args = [
      CONTEXT_VIEW,
      CLAUDE_USAGE,
      CODEX_BUCKETS,
      { total: 1200 },
      null,
      180,
      "g",
    ];
    if (options !== undefined) args.push(options);
    return stripAnsi(getMicroLine(...args));
  }

  it("8번째 인자를 주지 않은 기존 호출과 빈 객체 호출의 출력이 같다", () => {
    assert.equal(micro(), micro({}));
  });

  it("showCodex 가 false 면 x 세그먼트만 빠진다", () => {
    const line = micro({ showCodex: false });
    assert.ok(!line.includes("x:"), `x 세그먼트가 남아 있다: ${line}`);
    assert.ok(line.includes("c:"), "claude 세그먼트는 남아야 한다");
    assert.ok(line.includes("g:"), "gemini 세그먼트는 남아야 한다");
    assert.ok(line.includes("sv:"), "sv 세그먼트는 남아야 한다");
    assert.ok(line.includes("CTX:"), "CTX 세그먼트는 남아야 한다");
  });

  it("showGemini 가 false 면 g 세그먼트만 빠진다", () => {
    const line = micro({ showGemini: false });
    assert.ok(!line.includes("g:"), `g 세그먼트가 남아 있다: ${line}`);
    assert.ok(line.includes("x:"), "codex 세그먼트는 남아야 한다");
    assert.ok(line.includes("c:"), "claude 세그먼트는 남아야 한다");
  });

  it("둘 다 빼도 공백이 두 번 연속 나오지 않는다", () => {
    const line = micro({ showCodex: false, showGemini: false });
    assert.ok(
      !line.includes("  "),
      `이중 공백이 있다: ${JSON.stringify(line)}`,
    );
    assert.ok(!line.includes("x:"), "codex 세그먼트가 남아 있다");
    assert.ok(!line.includes("g:"), "gemini 세그먼트가 남아 있다");
    assert.ok(line.includes("c:") && line.includes("CTX:"));
  });

  it("세그먼트를 빼도 나머지 순서는 유지된다", () => {
    const line = micro({ showCodex: false });
    assert.ok(
      line.indexOf("c:") < line.indexOf("g:"),
      `순서가 바뀌었다: ${line}`,
    );
    assert.ok(line.indexOf("g:") < line.indexOf("sv:"));
    assert.ok(line.indexOf("sv:") < line.indexOf("CTX:"));
  });
});

describe("hud/hud-qos-status: 정책 게이트 배선", () => {
  it("정책 판독이 rows 조립보다 앞서고 codex 행이 showCodex 아래에 있다", () => {
    const source = readFileSync(
      join(PROJECT_ROOT, "hud", "hud-qos-status.mjs"),
      "utf8",
    );

    const visibilityIndex = source.indexOf("resolveHudCliVisibility(");
    const rowsIndex = source.indexOf("const rows = [");
    const showCodexGuardIndex = source.indexOf("if (showCodex) {");
    const codexRowIndex = source.indexOf("codexQuotaData,");
    const geminiGateIndex = source.indexOf("shouldRenderGeminiFallbackRow({");
    const geminiGuardIndex = source.indexOf("if (showGeminiRow) {");
    const microLineGateIndex = source.indexOf(
      "{ showCodex, showGemini: showGeminiRow }",
    );

    assert.ok(visibilityIndex >= 0, "resolveHudCliVisibility 호출이 없다");
    assert.ok(rowsIndex >= 0, "rows 배열 조립부가 없다");
    assert.ok(
      visibilityIndex < rowsIndex,
      "정책 판독은 rows 조립보다 먼저 실행되어야 한다",
    );
    assert.ok(showCodexGuardIndex >= 0, "showCodex 게이트가 없다");
    assert.ok(codexRowIndex >= 0, "codex provider 행 인자가 없다");
    assert.ok(
      showCodexGuardIndex < codexRowIndex,
      "codex 행은 showCodex 조건 아래에서만 만들어야 한다",
    );
    assert.ok(
      geminiGateIndex >= 0 && geminiGateIndex < rowsIndex,
      "gemini 슬롯 판정은 rows 조립 전에 한 번만 계산해야 한다",
    );
    assert.ok(
      geminiGuardIndex > rowsIndex,
      "gemini 행은 showGeminiRow 조건 아래에서만 만들어야 한다",
    );
    assert.ok(
      microLineGateIndex >= 0 && microLineGateIndex < rowsIndex,
      "nano tier 의 getMicroLine 도 같은 정책을 넘겨야 한다",
    );
  });

  it("antigravityReady 가 정책 허용과 함께 계산된다", () => {
    const source = readFileSync(
      join(PROJECT_ROOT, "hud", "hud-qos-status.mjs"),
      "utf8",
    );
    assert.match(
      source,
      /const antigravityReady =\s*\n\s*antigravityAllowed &&/u,
      "antigravityAllowed 가 antigravityReady 계산에 들어가야 한다",
    );
  });
});
