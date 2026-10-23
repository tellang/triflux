// tests/unit/ansi.test.mjs — ansi.mjs 단위 테스트 (wcwidth + badge + progressBar 포함)

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  box,
  clip,
  color,
  FG,
  MOCHA,
  padRight,
  progressBar,
  RESET,
  statusBadge,
  stripAnsi,
  truncate,
  wcswidth,
} from "../../hub/team/ansi.mjs";

// ── 색상 헬퍼 ──
describe("color / bold / dim", () => {
  it("color: fg 없으면 원본 반환", () => {
    assert.equal(color("abc", null, null), "abc");
    assert.equal(color("abc"), "abc");
  });
});

// ── stripAnsi ──
describe("stripAnsi", () => {
  it("ANSI 색상 코드 제거", () => {
    assert.equal(stripAnsi(`${FG.red}hello${RESET}`), "hello");
    assert.equal(
      stripAnsi(`${FG.green}foo${RESET} ${FG.blue}bar${RESET}`),
      "foo bar",
    );
  });
});

// ── wcswidth ──
describe("wcswidth", () => {
  it("ASCII 문자: 길이 = 바이트 수", () => {
    assert.equal(wcswidth("hello"), 5);
    assert.equal(wcswidth("abc"), 3);
  });

  it("한글: 2 셀/자", () => {
    assert.equal(wcswidth("가나다"), 6);
    assert.equal(wcswidth("한글"), 4);
  });

  it("이모지: wide 2 셀", () => {
    // 기본 이모지 (U+1F300 범위)
    assert.equal(wcswidth("🌀"), 2);
  });

  it("ANSI 코드 제외하고 계산", () => {
    const painted = `${FG.red}ab${RESET}`;
    assert.equal(wcswidth(painted), 2);
  });
});

// ── padRight ──
describe("padRight (wcwidth-aware)", () => {
  it("ASCII: 지정 길이로 패딩", () => {
    const padded = padRight("hi", 10);
    assert.equal(stripAnsi(padded).length, 10);
  });

  it("ANSI 포함 문자열: 표시 폭 기준 패딩", () => {
    const painted = `${FG.red}hi${RESET}`;
    const padded = padRight(painted, 10);
    assert.equal(wcswidth(padded), 10);
  });

  it("이미 충분히 긴 문자열: 그대로 반환", () => {
    const result = padRight("hello world", 5);
    assert.equal(result, "hello world");
  });
});

// ── truncate ──
describe("truncate (wcwidth-aware)", () => {
  it("긴 ASCII 문자열 자르기 + 말줄임표", () => {
    const result = truncate("abcdefgh", 5);
    assert.ok(result.endsWith("…"));
    assert.ok(wcswidth(result) <= 5);
  });

  it("짧은 문자열은 그대로", () => {
    assert.equal(truncate("abc", 10), "abc");
  });

  it("한글 경계에서 올바르게 자름", () => {
    const result = truncate("가나다라마", 7);
    // "가나다" = 6셀, "가나다…" = 7셀
    assert.ok(wcswidth(result) <= 7);
    assert.ok(result.endsWith("…"));
  });
});

// ── clip ──
describe("clip", () => {
  it("정확히 width 셀에 맞게 자르고 패딩", () => {
    const result = clip("hello world", 5);
    assert.equal(result.length, 5);
  });

  it("짧은 문자열: 공백으로 채움", () => {
    const result = clip("hi", 6);
    assert.equal(result, "hi    ");
  });

  it("wide char 경계에서 공백 보정", () => {
    // "가나" = 4셀, width=3이면 "가"(2셀) + " "(1셀) = 표시 폭 3셀
    // JS .length는 "가 ".length = 2 이므로 wcswidth 기준으로 검증
    const result = clip("가나", 3);
    assert.equal(wcswidth(result), 3);
  });
});

// ── box ──
describe("box", () => {
  it("테두리 문자 올바름", () => {
    const { top, body, bot } = box(["hello"], 20);
    assert.ok(top.startsWith("┌"));
    assert.ok(top.endsWith("┐"));
    assert.ok(bot.startsWith("└"));
    assert.ok(bot.endsWith("┘"));
    assert.equal(body.length, 1);
    assert.ok(body[0].startsWith("│"));
    assert.ok(body[0].endsWith("│"));
  });
});

// ── progressBar ──
describe("progressBar (percent 0-100 API)", () => {
  it("0%: 모두 빈칸", () => {
    const bar = progressBar(0, 10);
    const clean = stripAnsi(bar);
    assert.ok(clean.includes("░".repeat(10)));
    assert.ok(!clean.includes("█"));
  });

  it("100%: 모두 채움", () => {
    const bar = progressBar(100, 10);
    const clean = stripAnsi(bar);
    assert.ok(clean.includes("█".repeat(10)));
    assert.ok(!clean.includes("░"));
  });

  it("50%: 절반 채움", () => {
    const bar = progressBar(50, 10);
    const clean = stripAnsi(bar);
    assert.equal(clean.length, 10);
    assert.ok(clean.includes("█"));
    assert.ok(clean.includes("░"));
  });

  it("범위 초과 입력 처리 (>100, <0)", () => {
    const bar150 = stripAnsi(progressBar(150, 10));
    const barNeg = stripAnsi(progressBar(-10, 10));
    assert.equal(bar150.length, 10);
    assert.equal(barNeg.length, 10);
  });
});

// ── statusBadge ──
describe("statusBadge", () => {
  it("ok/completed/done → MOCHA.ok 색상 + ✓", () => {
    for (const s of ["ok", "completed", "done"]) {
      const badge = statusBadge(s);
      assert.ok(badge.includes("✓"), `${s}: ✓ 없음`);
      assert.ok(badge.includes(MOCHA.ok), `${s}: ok 색상 없음`);
    }
  });

  it("partial/in_progress/running → MOCHA.partial 색상 + ◑", () => {
    for (const s of ["partial", "in_progress", "running"]) {
      const badge = statusBadge(s);
      assert.ok(badge.includes("◑"), `${s}: ◑ 없음`);
    }
  });

  it("fail/failed/error → MOCHA.fail 색상 + ✗", () => {
    for (const s of ["fail", "failed", "error"]) {
      const badge = statusBadge(s);
      assert.ok(badge.includes("✗"), `${s}: ✗ 없음`);
    }
  });

  it("알 수 없는 상태 → · prefix", () => {
    const badge = statusBadge("unknown_state");
    assert.ok(badge.includes("·"));
  });
});
