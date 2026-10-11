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

  it("살아 있는 캐시는 full 5h 게이지 뒤 공백을 + 로 바꾸고 폭은 그대로다", (t) => {
    t.mock.method(Date, "now", () => 0);
    const warm = claude("full");
    const cold = claude("full", { promptCache: undefined });
    assert.ok(warm.left.includes(claudeOrange("+")));
    assert.match(stripAnsi(warm.left), /^5h:\S{5}\+/);
    assert.equal(stripAnsi(warm.left).length, stripAnsi(cold.left).length);
    assert.equal(warm.prefix, cold.prefix);
    const x = getProviderRow("full", "codex", "x", codexWhite, null, "dev", {
      promptCache: { expiresAt: 1_800_000, ttlMs: 1_800_000 },
    });
    assert.ok(x.left.includes(codexWhite("+")));
    for (const tier of ["compact", "minimal", "micro", "nano"])
      assert.doesNotMatch(stripAnsi(claude(tier).left), /\+/);
  });

  it("곧 식음 경계는 TTL의 20%와 5분 중 작은 값이고 흐린 + 로 보인다", (t) => {
    t.mock.method(Date, "now", () => 0);
    for (const [ttl, boundary] of [
      ["5m", 60],
      ["1h", 300],
    ]) {
      const left = (seconds) =>
        claude("full", {
          promptCache: { ...options.promptCache, ttl, expires_at: seconds },
        }).left;
      assert.ok(left(boundary + 1).includes(claudeOrange("+")));
      assert.ok(left(boundary).includes(dim("+")));
    }
  });

  it("식거나 정보 없는 캐시는 원래 공백을 쓴다", (t) => {
    t.mock.method(Date, "now", () => 0);
    for (const promptCache of [
      undefined,
      { ...options.promptCache, caching_observed: false },
      { ...options.promptCache, warm: false },
      { ...options.promptCache, expires_at: null },
      { ...options.promptCache, expires_at: 0 },
    ]) {
      assert.match(
        stripAnsi(claude("full", { promptCache }).left),
        /^5h:\S{5} /,
      );
    }
  });

  it("ctx 라벨은 모든 표시 단계와 한 줄 요약에서 흐린 소문자다", () => {
    for (const tier of ["full", "compact", "minimal"]) {
      assert.ok(claude(tier).right.includes(dim("ctx:")));
    }
    assert.ok(getMicroLine(context, usage, null).includes(dim("ctx:")));
  });

  it("GCP 표시는 배경색 없이 파란 글자이고 기존 칸 폭을 유지한다", () => {
    const project = { auth: "project" };
    const row = getProviderRow(
      "full",
      "antigravity",
      "a",
      geminiBlue,
      project,
      "project",
    );
    assert.ok(row.left.includes(geminiBlue(" GCP ")));
    assert.equal(stripAnsi(row.left).slice(3, 3 + GAUGE_WIDTH), " GCP ");
    const micro = getMicroLine(context, usage, null, {
      antigravityQuota: project,
    });
    assert.ok(micro.includes(geminiBlue(" GCP")));
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
