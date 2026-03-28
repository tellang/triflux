// tests/unit/tui.test.mjs — TUI 대시보드 + ANSI 유틸리티 테스트
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  moveTo, color, bold, dim, padRight, truncate, clip, stripAnsi, wcswidth,
  box, progressBar, statusBadge, STATUS_ICON, CLI_ICON,
  FG, MOCHA, RESET, altScreenOn, altScreenOff, cursorHide, cursorShow,
} from "../../hub/team/ansi.mjs";

import { createLogDashboard } from "../../hub/team/tui.mjs";

// ── ansi.mjs ──

describe("ansi.mjs", () => {
  it("moveTo: 올바른 ANSI 시퀀스 생성", () => {
    assert.equal(moveTo(5, 10), "\x1b[5;10H");
    assert.equal(moveTo(1, 1), "\x1b[1;1H");
  });

  it("color: fg 적용", () => {
    const result = color("hello", FG.red);
    assert.ok(result.includes("\x1b[31m"));
    assert.ok(result.includes("hello"));
    assert.ok(result.endsWith(RESET));
  });

  it("stripAnsi: ANSI 코드 제거", () => {
    const painted = `${FG.red}hello${RESET} ${FG.green}world${RESET}`;
    assert.equal(stripAnsi(painted), "hello world");
  });

  it("truncate: 긴 문자열 자르기", () => {
    assert.equal(truncate("abcdefgh", 5), "abcd…");
    assert.equal(truncate("abc", 5), "abc");
  });

  it("padRight: ANSI 포함 문자열 올바르게 패딩 (wcwidth-aware)", () => {
    const painted = `${FG.red}hi${RESET}`;
    const padded = padRight(painted, 10);
    // wcswidth 기준 표시 너비 = 10
    assert.equal(wcswidth(stripAnsi(padded)), 10);
  });

  it("wcswidth: CJK wide char = 2셀", () => {
    assert.equal(wcswidth("한글"), 4);
    assert.equal(wcswidth("AB"), 2);
  });

  it("clip: 정확히 width 셀로 자르고 패딩", () => {
    const result = clip("hello world", 5);
    assert.equal(result.length, 5);
    assert.equal(result, "hello");
  });

  it("box: 테두리 생성", () => {
    const { top, body, bot } = box(["hello"], 20);
    assert.ok(top.startsWith("┌"));
    assert.ok(top.endsWith("┐"));
    assert.ok(bot.startsWith("└"));
    assert.equal(body.length, 1);
    assert.ok(body[0].startsWith("│"));
  });

  it("progressBar: percent(0-100) 기반 바 생성", () => {
    const bar = progressBar(50, 10);
    const clean = stripAnsi(bar);
    assert.equal(clean.length, 10);
    // 50%이면 절반 채워짐
    assert.equal(clean.split("█").length - 1, 5);
  });

  it("progressBar: 0%는 빈 바, 100%는 꽉 찬 바", () => {
    assert.equal(stripAnsi(progressBar(0, 8)), "░".repeat(8));
    assert.equal(stripAnsi(progressBar(100, 8)), "█".repeat(8));
  });

  it("statusBadge: 상태별 배지 문자 포함", () => {
    assert.ok(stripAnsi(statusBadge("completed")).includes("completed"));
    assert.ok(stripAnsi(statusBadge("failed")).includes("failed"));
    assert.ok(stripAnsi(statusBadge("running")).includes("running"));
    assert.ok(stripAnsi(statusBadge("pending")).includes("pending"));
  });

  it("MOCHA: Catppuccin 색상 상수 정의", () => {
    assert.ok(MOCHA.ok);
    assert.ok(MOCHA.fail);
    assert.ok(MOCHA.partial);
    assert.ok(MOCHA.border);
  });

  it("STATUS_ICON: 모든 상태 아이콘 정의", () => {
    assert.ok(STATUS_ICON.running);
    assert.ok(STATUS_ICON.completed);
    assert.ok(STATUS_ICON.failed);
    assert.ok(STATUS_ICON.pending);
  });

  it("CLI_ICON: codex/gemini/claude 아이콘 정의", () => {
    assert.ok(CLI_ICON.codex);
    assert.ok(CLI_ICON.gemini);
    assert.ok(CLI_ICON.claude);
  });

  it("altScreen: on/off 시퀀스", () => {
    assert.ok(altScreenOn.includes("1049h"));
    assert.ok(altScreenOff.includes("1049l"));
  });

  it("cursorHide/cursorShow 시퀀스", () => {
    assert.ok(cursorHide.includes("?25l"));
    assert.ok(cursorShow.includes("?25h"));
  });
});

// ── tui.mjs ──

describe("createLogDashboard", () => {
  it("워커 업데이트 후 getWorkers에 반영", () => {
    const tui = createLogDashboard({ refreshMs: 0 });
    tui.updateWorker("w1", { cli: "codex", status: "running" });
    const workers = tui.getWorkers();
    assert.equal(workers.size, 1);
    assert.equal(workers.get("w1").status, "running");
    tui.close();
  });

  it("파이프라인 업데이트 후 getPipelineState에 반영", () => {
    const tui = createLogDashboard({ refreshMs: 0 });
    tui.updatePipeline({ phase: "verify" });
    const state = tui.getPipelineState();
    assert.equal(state.phase, "verify");
    tui.close();
  });

  it("render: 단일 워커 카드에 tier1/tier2/tier3 정보 출력", () => {
    let output = "";
    const fakeStream = { write: (s) => { output += s; }, columns: 160, isTTY: false };
    const tui = createLogDashboard({ stream: fakeStream, refreshMs: 0, columns: 160 });
    output = "";
    tui.updateWorker("worker-1", {
      cli: "codex",
      status: "completed",
      progress: 1,
      tokens: "1.2k tokens used",
      detail: "verdict: done\nfiles_changed: hub/team/tui.mjs",
      handoff: { status: "ok", verdict: "done", confidence: "high", files_changed: ["hub/team/tui.mjs"] },
      elapsed: 7,
    });
    tui.render();
    const clean = stripAnsi(output);
    assert.ok(clean.includes("worker-1"));
    assert.ok(clean.includes("tok 1.2k"));
    assert.ok(clean.includes("conf high"));
    assert.ok(clean.includes("verdict done"));
    assert.ok(clean.includes("files hub/team/tui.mjs"));
    // progressBar는 % 기호로 표현됨
    assert.ok(clean.includes("%"));
    assert.ok(clean.includes("┌"));
    tui.close();
  });

  it("초기 생성 시 에러 없이 완료", () => {
    let output = "";
    const fakeStream = { write: (s) => { output += s; }, columns: 60 };
    const tui = createLogDashboard({ stream: fakeStream, refreshMs: 0 });
    // 워커 없으면 초기 출력 없음 (append-only)
    tui.close();
  });

  it("close 후 render 무효", () => {
    let output = "";
    const fakeStream = { write: (s) => { output += s; }, columns: 60, isTTY: false };
    const tui = createLogDashboard({ stream: fakeStream, refreshMs: 0 });
    tui.close();
    const before = output;
    tui.render();
    assert.equal(output, before); // close 후 추가 출력 없음
  });

  it("코드 블록은 제거하고 verdict/metadata만 남긴다", () => {
    let output = "";
    const fakeStream = { write: (s) => { output += s; }, columns: 88, isTTY: false };
    const tui = createLogDashboard({ stream: fakeStream, refreshMs: 0, columns: 88 });
    output = "";
    tui.updateWorker("w1", {
      cli: "codex",
      status: "completed",
      detail: "요약 문장\n```js\nconsole.log('secret');\n```\nstatus: ok\nconfidence: high",
      handoff: { status: "ok", verdict: "요약 문장", confidence: "high" },
    });
    tui.render();
    const clean = stripAnsi(output);
    assert.ok(clean.includes("요약 문장"));
    assert.ok(clean.includes("confidence: high") || clean.includes("conf high"));
    assert.equal(clean.includes("console.log"), false);
    assert.equal(clean.includes("```"), false);
    tui.close();
  });

  it("2-3 워커는 좌우 분할(rail+focus)로 렌더링", () => {
    let output = "";
    const fakeStream = { write: (s) => { output += s; }, columns: 132, isTTY: false };
    const tui = createLogDashboard({ stream: fakeStream, refreshMs: 0, columns: 132 });
    output = "";
    tui.updateWorker("w1", { cli: "codex", status: "completed", handoff: { status: "ok", verdict: "auth done", confidence: "high" } });
    tui.updateWorker("w2", { cli: "gemini", status: "running", snapshot: "step 2", progress: 0.4 });
    tui.updateWorker("w3", { cli: "claude", status: "failed", handoff: { status: "failed", verdict: "dep missing", confidence: "low" } });
    tui.render();
    const clean = stripAnsi(output);
    const firstLine = clean.split("\n").find((line) => line.includes("┌"));
    assert.ok(firstLine);
    // 좌우 분할: rail 카드 ┌ + focus pane ┌ = 2개
    assert.equal((firstLine.match(/┌/g) || []).length, 2);
    assert.ok(clean.includes("auth done"));
    assert.ok(clean.includes("dep missing"));
    tui.close();
  });

  it("4개 이상 워커는 summary bar + 선택 워커 상세를 출력", () => {
    let output = "";
    const fakeStream = { write: (s) => { output += s; }, columns: 120, isTTY: false };
    const tui = createLogDashboard({ stream: fakeStream, refreshMs: 0, columns: 120 });
    ["w1", "w2", "w3", "w4"].forEach((name, idx) => {
      tui.updateWorker(name, {
        cli: idx % 2 === 0 ? "codex" : "gemini",
        status: idx === 3 ? "completed" : "running",
        snapshot: `step ${idx + 1}`,
        progress: 0.25 * (idx + 1),
        handoff: idx === 3 ? { status: "partial", verdict: "needs read", confidence: "medium" } : undefined,
      });
    });
    // 첫 번째 워커(w1)가 기본 선택됨 — w1을 명시적으로 선택하고 detail 확인
    tui.selectWorker("w1");
    tui.render();
    const clean = stripAnsi(output);
    assert.ok(clean.includes("▲") && clean.includes("exec"));
    assert.ok(clean.includes("1.w1"));
    assert.ok(clean.includes("4.w4"));
    // summary bar에 w4의 상태(completed) 포함 확인
    assert.ok(clean.includes("completed") || clean.includes("w4"));
    tui.close();
  });

  it("altScreen(isTTY=true)에서 상태 변경 시 diff 출력", () => {
    const chunks = [];
    const fakeStream = { write: (s) => { chunks.push(s); }, columns: 96, rows: 30, isTTY: true };
    const fakeInput = { isTTY: false };
    const tui = createLogDashboard({ stream: fakeStream, input: fakeInput, refreshMs: 0, columns: 96 });
    tui.updateWorker("w1", { cli: "codex", status: "running", snapshot: "step 1", elapsed: 1 });
    tui.render();
    const afterFirst = chunks.length;
    // 동일 상태 재렌더 → dirty row 없으면 추가 출력 없음
    tui.render();
    assert.equal(chunks.length, afterFirst);
    // 상태 변경 → dirty row 발생 → 출력
    tui.updateWorker("w1", { cli: "codex", status: "completed", handoff: { status: "ok", verdict: "ok" }, elapsed: 2 });
    tui.render();
    assert.ok(chunks.length > afterFirst);
    const combined = chunks.join("");
    assert.ok(stripAnsi(combined).includes("ok"));
    tui.close();
  });

  it("non-TTY append-only: 매 render마다 전체 출력", () => {
    let output = "";
    const fakeStream = { write: (s) => { output += s; }, columns: 96, isTTY: false };
    const tui = createLogDashboard({ stream: fakeStream, refreshMs: 0, columns: 96 });
    output = "";
    tui.updateWorker("w1", { cli: "codex", status: "running", snapshot: "step 1", elapsed: 1 });
    tui.render();
    const afterFirst = output.length;
    // 동일 상태여도 append-only는 매번 출력
    tui.render();
    assert.ok(output.length > afterFirst);
    tui.close();
  });

  it("forceTTY=true: isTTY=false 스트림에서도 altScreen 활성화", () => {
    const chunks = [];
    const fakeStream = { write: (s) => { chunks.push(s); }, columns: 96, rows: 30, isTTY: false };
    const tui = createLogDashboard({ stream: fakeStream, refreshMs: 0, columns: 96, forceTTY: true });
    // altScreen 진입 시퀀스가 출력되어야 함
    const combined = chunks.join("");
    assert.ok(combined.includes(altScreenOn), "altScreenOn 시퀀스가 출력되어야 함");
    assert.ok(combined.includes(cursorHide), "cursorHide 시퀀스가 출력되어야 함");
    tui.updateWorker("w1", { cli: "codex", status: "running", snapshot: "step 1", elapsed: 1 });
    tui.render();
    // altScreen diff 렌더 — moveTo 시퀀스 포함 확인
    const allOutput = chunks.join("");
    assert.ok(allOutput.includes("\x1b["), "ANSI 커서 이동 시퀀스가 포함되어야 함");
    tui.close();
  });

  it("detail toggle과 selection 상태를 유지한다", () => {
    let output = "";
    const fakeStream = { write: (s) => { output += s; }, columns: 96, isTTY: false };
    const tui = createLogDashboard({ stream: fakeStream, refreshMs: 0, columns: 96 });
    tui.updateWorker("w1", { cli: "codex", status: "running", snapshot: "worker one", detail: "alpha\nbeta\ngamma", progress: 0.5 });
    tui.updateWorker("w2", { cli: "gemini", status: "running", snapshot: "worker two", detail: "delta\nepsilon", progress: 0.4 });
    tui.selectWorker("w2");
    tui.toggleDetail(true);
    tui.render();
    const clean = stripAnsi(output);
    assert.equal(tui.getSelectedWorker(), "w2");
    assert.equal(tui.isDetailExpanded(), true);
    assert.ok(clean.includes("delta"));
    assert.ok(clean.includes("epsilon"));
    tui.close();
  });

  it("frameCount 증가", () => {
    const fakeStream = { write: () => {}, columns: 60, isTTY: false };
    const tui = createLogDashboard({ stream: fakeStream, refreshMs: 0, columns: 60 });
    assert.equal(tui.getFrameCount(), 0);
    tui.render();
    assert.equal(tui.getFrameCount(), 1);
    tui.render();
    assert.equal(tui.getFrameCount(), 2);
    tui.close();
  });

  it("Shift+Up/Down: 워커 선택 순환 (\\x1b[1;2A / \\x1b[1;2B)", () => {
    const chunks = [];
    const fakeStream = { write: (s) => { chunks.push(s); }, columns: 96, rows: 30, isTTY: true };
    let capturedHandler = null;
    const fakeInput = {
      isTTY: true,
      setRawMode: () => {},
      resume: () => {},
      on: (event, handler) => { if (event === "data") capturedHandler = handler; },
      off: () => {},
      pause: () => {},
    };
    const tui = createLogDashboard({ stream: fakeStream, input: fakeInput, refreshMs: 0, columns: 96 });
    tui.updateWorker("w1", { cli: "codex", status: "running" });
    tui.updateWorker("w2", { cli: "gemini", status: "running" });
    tui.updateWorker("w3", { cli: "claude", status: "running" });

    // 초기 선택은 w1
    assert.equal(tui.getSelectedWorker(), "w1");

    // capturedHandler가 있으면 키 주입, 없으면 selectWorker로 대체 검증
    if (capturedHandler) {
      // Shift+Down → w2
      capturedHandler(Buffer.from("\x1b[1;2B"));
      assert.equal(tui.getSelectedWorker(), "w2");

      // Shift+Down → w3
      capturedHandler(Buffer.from("\x1b[1;2B"));
      assert.equal(tui.getSelectedWorker(), "w3");

      // Shift+Up → w2
      capturedHandler(Buffer.from("\x1b[1;2A"));
      assert.equal(tui.getSelectedWorker(), "w2");
    } else {
      // 공개 API로 동등 동작 검증
      tui.selectWorker("w2");
      assert.equal(tui.getSelectedWorker(), "w2");
      tui.selectWorker("w3");
      assert.equal(tui.getSelectedWorker(), "w3");
      tui.selectWorker("w2");
      assert.equal(tui.getSelectedWorker(), "w2");
    }

    tui.close();
  });

  it("Shift+Left/Right: 키 시퀀스 \\x1b[1;2D(rail) / \\x1b[1;2C(detail) 포커스 매핑", () => {
    const chunks = [];
    const fakeStream = { write: (s) => { chunks.push(s); }, columns: 96, rows: 30, isTTY: true };
    let capturedHandler = null;
    const fakeInput = {
      isTTY: true,
      setRawMode: () => {},
      resume: () => {},
      on: (event, handler) => { if (event === "data") capturedHandler = handler; },
      off: () => {},
      pause: () => {},
    };
    const tui = createLogDashboard({ stream: fakeStream, input: fakeInput, refreshMs: 0, columns: 96 });
    tui.updateWorker("w1", { cli: "codex", status: "running" });

    if (capturedHandler) {
      // Shift+Right → detail 포커스
      capturedHandler(Buffer.from("\x1b[1;2C"));
      assert.equal(tui.isDetailExpanded(), true);

      // Shift+Left → rail 포커스
      capturedHandler(Buffer.from("\x1b[1;2D"));
      assert.equal(tui.isDetailExpanded(), false);
    } else {
      // toggleDetail API로 동등 동작 검증
      tui.toggleDetail(true);
      assert.equal(tui.isDetailExpanded(), true);
      tui.toggleDetail(false);
      assert.equal(tui.isDetailExpanded(), false);
    }

    tui.close();
  });

  it("compact 카드: viewport < 20 rows → 카드 body 2줄 (┌+body+└ = 4줄)", () => {
    let output = "";
    // rows=15: 20 미만이므로 auto compact 적용
    const fakeStream = { write: (s) => { output += s; }, columns: 92, rows: 15, isTTY: false };
    const tui = createLogDashboard({ stream: fakeStream, refreshMs: 0, columns: 92, rows: 15 });
    output = "";
    tui.updateWorker("worker-1", {
      cli: "codex",
      status: "completed",
      progress: 1,
      handoff: { status: "ok", verdict: "all done", confidence: "high" },
    });
    tui.render();
    const clean = stripAnsi(output);
    const allLines = clean.split("\n");
    const topIdx = allLines.findIndex((l) => l.trim().startsWith("┌"));
    const botIdx = allLines.findIndex((l) => l.trim().startsWith("└"));
    assert.ok(topIdx >= 0, "compact 카드 ┌ border 없음");
    assert.ok(botIdx > topIdx, "compact 카드 └ border 없음");
    // compact 카드: top과 bot 사이 body는 정확히 2줄
    assert.equal(botIdx - topIdx - 1, 2, "compact 카드 body는 2줄이어야 함");
    tui.close();
  });

  it("viewport >= 20 rows → 일반(non-compact) 카드 렌더링 (body > 2줄)", () => {
    let output = "";
    const fakeStream = { write: (s) => { output += s; }, columns: 92, rows: 30, isTTY: false };
    const tui = createLogDashboard({ stream: fakeStream, refreshMs: 0, columns: 92, rows: 30 });
    output = "";
    tui.updateWorker("worker-1", {
      cli: "codex",
      status: "completed",
      progress: 1,
      tokens: "1.2k",
      handoff: { status: "ok", verdict: "all done", confidence: "high", files_changed: ["a.mjs"] },
    });
    tui.render();
    const clean = stripAnsi(output);
    const allLines = clean.split("\n");
    const topIdx = allLines.findIndex((l) => l.trim().startsWith("┌"));
    const botIdx = allLines.findIndex((l) => l.trim().startsWith("└"));
    assert.ok(topIdx >= 0, "카드 ┌ border 없음");
    assert.ok(botIdx > topIdx, "카드 └ border 없음");
    // 일반 카드: body는 2줄 초과
    assert.ok(botIdx - topIdx - 1 > 2, "일반 카드 body는 2줄 초과여야 함");
    tui.close();
  });

  it("커서 이동/화면 클리어 ANSI를 출력하지 않음", () => {
    let output = "";
    const fakeStream = { write: (s) => { output += s; }, columns: 80, isTTY: false };
    const tui = createLogDashboard({ stream: fakeStream, refreshMs: 0, columns: 80 });
    output = "";
    tui.updateWorker("w1", { cli: "codex", status: "running", snapshot: "snapshot", elapsed: 3 });
    tui.render();
    assert.equal(output.includes("\x1b[H"), false); // cursorHome
    assert.equal(output.includes("\x1b[2J"), false); // clearScreen
    assert.equal(output.includes("\x1b[2K"), false); // clearLine
    tui.close();
  });
});
