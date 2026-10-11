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
  promptCache: { warm: true, caching_observed: true, expires_at: 180 },
};

function claude(tier, overrides = {}) {
  return getClaudeRows(tier, context, usage, { ...options, ...overrides })[0];
}

describe("HUD 표시", () => {
  it("Claude 계정은 이메일 앞부분을 같은 폭과 색으로 표시한다", () => {
    for (const tier of ["full", "compact", "minimal"]) {
      assert.ok(claude(tier).right.endsWith(claudeOrange("developer")));
      assert.ok(
        claude(tier, {
          accountName: "long-developer@example.test",
        }).right.endsWith(claudeOrange("long-deve…")),
      );
      assert.doesNotMatch(
        stripAnsi(claude(tier, { accountName: null }).right),
        /developer|claude/,
      );
    }
    for (const tier of ["nano", "micro"]) assert.equal(claude(tier).right, "");
  });

  it("full 과 compact 에서만 캐시 남은 시간과 만료 상태를 표시한다", (t) => {
    t.mock.method(Date, "now", () => 0);
    for (const tier of ["full", "compact"]) {
      assert.match(stripAnsi(claude(tier).right), /ctx:25% cache 3m/);
      assert.match(
        stripAnsi(
          claude(tier, {
            promptCache: { ...options.promptCache, expires_at: 59 },
          }).right,
        ),
        /cache <1m/,
      );
      for (const change of [
        { warm: false },
        { expires_at: null },
        { expires_at: 0 },
      ]) {
        assert.ok(
          claude(tier, {
            promptCache: { ...options.promptCache, ...change },
          }).right.includes(dim("cache --")),
        );
      }
      for (const promptCache of [
        undefined,
        { ...options.promptCache, caching_observed: false },
      ]) {
        assert.doesNotMatch(
          stripAnsi(claude(tier, { promptCache }).right),
          /cache/,
        );
      }
    }
    for (const tier of ["minimal", "micro", "nano"]) {
      assert.doesNotMatch(stripAnsi(claude(tier).right), /cache/);
    }
    assert.doesNotMatch(
      stripAnsi(getMicroLine(context, usage, null, options)),
      /cache|developer/,
    );
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
