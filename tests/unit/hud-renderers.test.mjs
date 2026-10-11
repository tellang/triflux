import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  claudeOrange,
  codexWhite,
  dim,
  GAUGE_WIDTH,
  geminiBlue,
} from "../../hud/colors.mjs";
import { PERCENT_CELL_WIDTH } from "../../hud/constants.mjs";
import {
  getClaudeRows,
  getMicroLine,
  getProviderRow,
  renderAlignedRows,
} from "../../hud/renderers.mjs";
import { stripAnsi } from "../../hud/utils.mjs";

process.env.COLUMNS = "200";
const context = { percent: 25, display: "25%" };
const usage = { fiveHourPercent: 17, weeklyPercent: 42 };
const options = {
  accountName: "developer@example.test",
  promptCache: {
    warm: true,
    caching_observed: true,
    expires_at: 180,
    ttl: "5m",
  },
};

function claude(tier, overrides = {}) {
  return getClaudeRows(tier, context, usage, { ...options, ...overrides })[0];
}

describe("HUD 표시", () => {
  it("Claude 계정은 이메일 앞부분을 같은 폭과 색으로 표시한다", () => {
    for (const tier of ["full", "compact", "minimal"]) {
      assert.ok(claude(tier).right.startsWith(`${claudeOrange("developer")} `));
      assert.ok(
        claude(tier, {
          accountName: "long-developer@example.test",
        }).right.startsWith(claudeOrange("long-deve…")),
      );
      assert.doesNotMatch(
        stripAnsi(claude(tier, { accountName: null }).right),
        /developer|claude/,
      );
    }
    for (const tier of ["nano", "micro"]) assert.equal(claude(tier).right, "");
  });

  it("살아 있는 캐시는 모든 단계와 요약에서 마커만 반전한다", (t) => {
    t.mock.method(Date, "now", () => 0);
    for (const tier of ["full", "compact", "minimal", "micro", "nano"]) {
      const row = claude(tier);
      assert.match(row.prefix, /\x1b\[48;2;232;112;64m/);
      assert.match(row.prefix, /\x1b\[30m\x1b\[1mc/);
      assert.doesNotMatch(row.prefix, /\x1b\[[57]m/);
      assert.equal(stripAnsi(row.prefix), "c:");
      assert.doesNotMatch(stripAnsi(row.right), /cache/);
      const x = getProviderRow(tier, "codex", "x", codexWhite, null, "dev", {
        promptCache: { expiresAt: 1_800_000, ttlMs: 1_800_000 },
      });
      assert.match(x.prefix, /\x1b\[48;5;15m/);
      assert.equal(stripAnsi(x.prefix), "x:");
    }
    const line = getMicroLine(context, usage, null, {
      ...options,
      codexPromptCache: { expiresAt: 1_800_000, ttlMs: 1_800_000 },
    });
    assert.match(line, /\x1b\[48;2;232;112;64m/);
    assert.match(line, /\x1b\[48;5;15m/);
    assert.doesNotMatch(stripAnsi(line), /cache|developer/);
  });

  it("곧 식음 경계는 TTL의 20%와 5분 중 작은 값이다", (t) => {
    t.mock.method(Date, "now", () => 0);
    for (const [ttl, boundary] of [
      ["5m", 60],
      ["1h", 300],
    ]) {
      for (const [seconds, blinking] of [
        [boundary + 1, false],
        [boundary, true],
      ]) {
        const row = claude("full", {
          promptCache: { ...options.promptCache, ttl, expires_at: seconds },
        });
        assert.equal(row.prefix.includes("\x1b[5m"), blinking);
      }
    }
    const x = getProviderRow("nano", "codex", "x", codexWhite, null, "dev", {
      promptCache: { expiresAt: 300_000, ttlMs: 1_800_000 },
    });
    assert.match(x.prefix, /\x1b\[5m/);
  });

  it("식거나 정보 없는 캐시와 로그아웃 x는 기존 마커를 쓴다", (t) => {
    t.mock.method(Date, "now", () => 0);
    for (const promptCache of [
      undefined,
      { ...options.promptCache, caching_observed: false },
      { ...options.promptCache, warm: false },
      { ...options.promptCache, expires_at: null },
      { ...options.promptCache, expires_at: 0 },
      { ...options.promptCache, expires_at: -1 },
    ]) {
      const row = claude("full", { promptCache });
      assert.doesNotMatch(row.prefix, /\x1b\[(?:48;|5m)/);
      assert.doesNotMatch(stripAnsi(row.right), /cache/);
    }
    const line = getMicroLine(context, usage, null, {
      codexLoggedOut: true,
      codexPromptCache: { expiresAt: 1_800_000, ttlMs: 1_800_000 },
    });
    assert.ok(line.includes(dim("x")));
    assert.doesNotMatch(line, /\x1b\[48;/);
  });

  it("ctx 라벨은 모든 표시 단계와 한 줄 요약에서 흐린 소문자다", () => {
    for (const tier of ["full", "compact", "minimal"]) {
      assert.ok(claude(tier).right.includes(dim("ctx:")));
    }
    assert.ok(getMicroLine(context, usage, null).includes(dim("ctx:")));
  });

  it("GCP 배지는 파란 배경과 흰 굵은 글씨이며 기존 칸 폭을 유지한다", () => {
    const project = { auth: "project" };
    const row = getProviderRow(
      "full",
      "antigravity",
      "a",
      geminiBlue,
      project,
      "project",
    );
    const badge = /\x1b\[48;5;39m\x1b\[1m\x1b\[97m( GCP )/;
    assert.match(row.left, badge);
    assert.equal(stripAnsi(row.left).slice(3, 3 + GAUGE_WIDTH), " GCP ");
    const micro = getMicroLine(context, usage, null, {
      antigravityQuota: project,
    });
    assert.match(micro, /\x1b\[48;5;39m\x1b\[1m\x1b\[97m( GCP)/);
    assert.equal(
      stripAnsi(micro).match(/a:(.*?) ctx:/)[1].length,
      PERCENT_CELL_WIDTH,
    );
    const x = getProviderRow(
      "full",
      "codex",
      "x",
      codexWhite,
      null,
      "developer",
    );
    const lines = renderAlignedRows([claude("full"), x, row]).map(stripAnsi);
    assert.ok(
      lines.every((line) => line.indexOf("|") === lines[0].indexOf("|")),
    );
    assert.equal(stripAnsi(row.left).length, stripAnsi(x.left).length);
  });
});
