// tests/unit/ansi.test.mjs — ansi.mjs 단위 테스트 (wcwidth + badge + progressBar 포함)

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  altScreenOff,
  altScreenOn,
  BG,
  BOLD,
  bold,
  box,
  CLI_ICON,
  clearLine,
  clearScreen,
  clearToEnd,
  clip,
  color,
  cursorHide,
  cursorHome,
  cursorShow,
  DIM,
  dim,
  FG,
  MOCHA,
  moveDown,
  moveTo,
  moveUp,
  padRight,
  progressBar,
  RESET,
  STATUS_ICON,
  statusBadge,
  stripAnsi,
  truncate,
  wcswidth,
} from "../../hub/team/ansi.mjs";

// ── 화면 시퀀스 ──
describe("화면 시퀀스", () => {
  it("altScreenOn/Off 시퀀스 포함", () => {
    assert.ok(altScreenOn.includes("1049h"));
    assert.ok(altScreenOff.includes("1049l"));
  });

  it("clearScreen / cursorHome / cursorHide / cursorShow 정의", () => {
    assert.ok(clearScreen.includes("2J"));
    assert.ok(cursorHome.includes("H"));
    assert.ok(cursorHide.includes("25l"));
    assert.ok(cursorShow.includes("25h"));
  });

  it("clearLine / clearToEnd 정의", () => {
    assert.ok(clearLine.includes("2K"));
    assert.ok(clearToEnd.includes("[K") || clearToEnd.includes("K"));
  });
});

// ── 커서 이동 ──
describe("커서 이동", () => {
  it("moveTo: 올바른 ANSI 시퀀스 생성", () => {
    assert.equal(moveTo(5, 10), "\x1b[5;10H");
    assert.equal(moveTo(1, 1), "\x1b[1;1H");
  });

  it("moveUp / moveDown 기본값 1", () => {
    assert.ok(moveUp().includes("1A"));
    assert.ok(moveDown().includes("1B"));
    assert.ok(moveUp(3).includes("3A"));
    assert.ok(moveDown(5).includes("5B"));
  });
});

// ── 색상 헬퍼 ──
describe("color / bold / dim", () => {
  it("color: fg 적용 후 RESET으로 끝남", () => {
    const result = color("hello", FG.red);
    assert.ok(result.includes("\x1b[31m"));
    assert.ok(result.includes("hello"));
    assert.ok(result.endsWith(RESET));
  });

  it("color: fg+bg 동시 적용", () => {
    const result = color("x", FG.green, BG.black);
    assert.ok(result.includes(FG.green));
    assert.ok(result.includes(BG.black));
    assert.ok(result.endsWith(RESET));
  });

  it("color: fg 없으면 원본 반환", () => {
    assert.equal(color("abc", null, null), "abc");
    assert.equal(color("abc"), "abc");
  });

  it("bold: BOLD + RESET 감쌈", () => {
    const result = bold("x");
    assert.ok(result.startsWith(BOLD));
    assert.ok(result.endsWith(RESET));
  });

  it("dim: DIM + RESET 감쌈", () => {
    const result = dim("x");
    assert.ok(result.startsWith(DIM));
    assert.ok(result.endsWith(RESET));
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

  it("ANSI 없는 문자열은 그대로", () => {
    assert.equal(stripAnsi("plain text"), "plain text");
  });

  it("빈 문자열 처리", () => {
    assert.equal(stripAnsi(""), "");
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

  it("빈 문자열은 0", () => {
    assert.equal(wcswidth(""), 0);
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

  it("여러 라인 지원", () => {
    const { body } = box(["line1", "line2", "line3"], 30);
    assert.equal(body.length, 3);
  });

  it("mid 구분선 포함", () => {
    const { mid } = box(["x"], 10);
    assert.ok(mid.startsWith("├"));
    assert.ok(mid.endsWith("┤"));
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

  it("기본 width 20", () => {
    const bar = progressBar(50);
    const clean = stripAnsi(bar);
    assert.equal(clean.length, 20);
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

  it("thinking → ⠿", () => {
    assert.ok(statusBadge("thinking").includes("⠿"));
  });

  it("executing → ▶", () => {
    assert.ok(statusBadge("executing").includes("▶"));
  });

  it("알 수 없는 상태 → · prefix", () => {
    const badge = statusBadge("unknown_state");
    assert.ok(badge.includes("·"));
  });

  it("RESET으로 끝남", () => {
    assert.ok(statusBadge("ok").endsWith(RESET));
    assert.ok(statusBadge("failed").endsWith(RESET));
  });
});

// ── STATUS_ICON / CLI_ICON ──
describe("STATUS_ICON / CLI_ICON", () => {
  it("STATUS_ICON: 모든 상태 정의", () => {
    assert.ok(STATUS_ICON.running);
    assert.ok(STATUS_ICON.completed);
    assert.ok(STATUS_ICON.failed);
    assert.ok(STATUS_ICON.pending);
  });

  it("CLI_ICON: codex/gemini/claude 정의", () => {
    assert.ok(CLI_ICON.codex);
    assert.ok(CLI_ICON.gemini);
    assert.ok(CLI_ICON.claude);
  });
});

// ── MOCHA 색상 상수 ──
describe("MOCHA 색상 상수", () => {
  it("ok / partial / fail / thinking / executing / border 모두 ANSI 시퀀스", () => {
    for (const key of [
      "ok",
      "partial",
      "fail",
      "thinking",
      "executing",
      "border",
    ]) {
      assert.ok(MOCHA[key].startsWith("\x1b["), `MOCHA.${key} ANSI 아님`);
    }
  });
});
