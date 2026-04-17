// tests/unit/tui-widgets.test.mjs — UX 위젯 테스트

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripAnsi } from "../../hub/team/ansi.mjs";
import {
  createPanelResizer,
  createSearchState,
  createTokenTracker,
  createVimMotion,
  sparkline,
} from "../../hub/team/tui-widgets.mjs";

describe("sparkline", () => {
  it("빈 값 배열 → 대시 문자열", () => {
    const result = stripAnsi(sparkline([], 8));
    assert.equal(result.length, 8);
    assert.ok(result.includes("─"));
  });

  it("값 배열 → 블록 문자 렌더링", () => {
    const result = stripAnsi(sparkline([1, 3, 5, 7, 9], 5));
    assert.equal(result.length, 5);
    assert.ok(/[▁▂▃▄▅▆▇█]/.test(result));
  });

  it("단일 값 → 동일 높이", () => {
    const result = stripAnsi(sparkline([5], 4));
    // padding + 1 char
    assert.equal(result.length, 4);
  });

  it("width보다 많은 데이터 → 최근 width개만", () => {
    const data = Array.from({ length: 20 }, (_, i) => i);
    const result = stripAnsi(sparkline(data, 8));
    assert.equal(result.length, 8);
  });
});

describe("createTokenTracker", () => {
  it("워커별 토큰 히스토리 기록", () => {
    const tracker = createTokenTracker(4);
    tracker.record("w1", 100);
    tracker.record("w1", 200);
    tracker.record("w1", 300);
    assert.deepEqual(tracker.getHistory("w1"), [100, 200, 300]);
  });

  it("maxSamples 초과 시 오래된 데이터 제거", () => {
    const tracker = createTokenTracker(3);
    tracker.record("w1", 1);
    tracker.record("w1", 2);
    tracker.record("w1", 3);
    tracker.record("w1", 4);
    assert.deepEqual(tracker.getHistory("w1"), [2, 3, 4]);
  });

  it("잘못된 값은 무시", () => {
    const tracker = createTokenTracker();
    tracker.record("w1", null);
    tracker.record("w1", "");
    tracker.record("w1", "invalid");
    assert.deepEqual(tracker.getHistory("w1"), []);
  });

  it("sparkline 메서드 호출", () => {
    const tracker = createTokenTracker();
    tracker.record("w1", 10);
    tracker.record("w1", 20);
    const result = tracker.sparkline("w1", 4);
    assert.ok(result.length > 0);
  });
});

describe("createSearchState", () => {
  it("활성화/비활성화 상태 전환", () => {
    const search = createSearchState();
    assert.equal(search.active, false);
    search.activate();
    assert.equal(search.active, true);
    search.deactivate();
    assert.equal(search.active, false);
  });

  it("문자 입력 → 버퍼 축적", () => {
    const search = createSearchState();
    search.activate();
    search.handleKey("t");
    search.handleKey("e");
    search.handleKey("s");
    assert.equal(search.buffer, "tes");
  });

  it("Enter → 쿼리 확정", () => {
    const search = createSearchState();
    search.activate();
    search.handleKey("a");
    search.handleKey("b");
    search.handleKey("\r");
    assert.equal(search.query, "ab");
    assert.equal(search.active, false);
  });

  it("Escape → 쿼리 취소", () => {
    const search = createSearchState();
    search.activate();
    search.handleKey("x");
    search.handleKey("\x1b");
    assert.equal(search.query, "");
    assert.equal(search.active, false);
  });

  it("Backspace → 버퍼에서 문자 제거", () => {
    const search = createSearchState();
    search.activate();
    search.handleKey("a");
    search.handleKey("b");
    search.handleKey("\x7f");
    assert.equal(search.buffer, "a");
  });

  it("findMatch: 순방향 검색", () => {
    const search = createSearchState();
    search.activate();
    search.handleKey("w");
    search.handleKey("2");
    search.handleKey("\r");
    const idx = search.findMatch(["w1", "w2", "w3"], 0, 1);
    assert.equal(idx, 1);
  });

  it("findMatch: 역방향 검색", () => {
    const search = createSearchState();
    search.activate();
    search.handleKey("w");
    search.handleKey("1");
    search.handleKey("\r");
    const idx = search.findMatch(["w1", "w2", "w3"], 2, -1);
    assert.equal(idx, 0);
  });

  it("findMatch: 매칭 없으면 -1", () => {
    const search = createSearchState();
    search.activate();
    search.handleKey("z");
    search.handleKey("\r");
    assert.equal(search.findMatch(["w1", "w2"], 0, 1), -1);
  });
});

describe("createPanelResizer", () => {
  it("기본 비율 0.3", () => {
    const resizer = createPanelResizer();
    assert.equal(resizer.ratio, 0.3);
  });

  it("shrinkRail: 비율 감소", () => {
    const resizer = createPanelResizer();
    resizer.shrinkRail();
    assert.ok(resizer.ratio < 0.3);
  });

  it("expandRail: 비율 증가", () => {
    const resizer = createPanelResizer();
    resizer.expandRail();
    assert.ok(resizer.ratio > 0.3);
  });

  it("minRatio/maxRatio 준수", () => {
    const resizer = createPanelResizer({
      minRatio: 0.2,
      maxRatio: 0.4,
      step: 0.5,
    });
    resizer.shrinkRail();
    assert.equal(resizer.ratio, 0.2);
    resizer.expandRail();
    resizer.expandRail();
    assert.equal(resizer.ratio, 0.4);
  });

  it("reset: 초기 비율 복원", () => {
    const resizer = createPanelResizer({ initialRatio: 0.25 });
    resizer.expandRail();
    resizer.reset();
    assert.equal(resizer.ratio, 0.25);
  });
});

describe("createVimMotion", () => {
  it("G → 'G' 반환", () => {
    const vim = createVimMotion();
    assert.equal(vim.handleKey("G"), "G");
  });

  it("gg → 'gg' 반환 (두 번 연속 g)", () => {
    const vim = createVimMotion();
    assert.equal(vim.handleKey("g"), null); // 첫 번째 g: 대기
    assert.equal(vim.handleKey("g"), "gg"); // 두 번째 g: gg!
  });

  it("g 후 다른 키 → 모션 없음", () => {
    const vim = createVimMotion();
    vim.handleKey("g");
    assert.equal(vim.handleKey("j"), null);
  });

  it("다른 키 → null", () => {
    const vim = createVimMotion();
    assert.equal(vim.handleKey("j"), null);
    assert.equal(vim.handleKey("k"), null);
  });
});
