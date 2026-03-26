// tests/unit/tui.test.mjs — TUI 대시보드 + ANSI 유틸리티 테스트
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  moveTo, color, bold, dim, padRight, truncate, stripAnsi,
  box, progressBar, STATUS_ICON, CLI_ICON,
  FG, RESET, altScreenOn, altScreenOff,
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

  it("padRight: ANSI 포함 문자열 올바르게 패딩", () => {
    const painted = `${FG.red}hi${RESET}`;
    const padded = padRight(painted, 10);
    assert.equal(stripAnsi(padded).length, 10);
  });

  it("box: 테두리 생성", () => {
    const { top, body, bot } = box(["hello"], 20);
    assert.ok(top.startsWith("┌"));
    assert.ok(top.endsWith("┐"));
    assert.ok(bot.startsWith("└"));
    assert.equal(body.length, 1);
    assert.ok(body[0].startsWith("│"));
  });

  it("progressBar: 비율에 따른 바 생성", () => {
    const bar = progressBar(0.5, 10);
    const clean = stripAnsi(bar);
    assert.equal(clean.length, 10);
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

  it("render: 요구 포맷 로그 한 줄 출력", () => {
    let output = "";
    const fakeStream = { write: (s) => { output += s; }, columns: 60 };
    const tui = createLogDashboard({ stream: fakeStream, refreshMs: 0 });
    output = "";
    tui.updateWorker("worker-1", {
      cli: "codex",
      status: "completed",
      handoff: { verdict: "done", confidence: "high" },
      elapsed: 7,
    });
    tui.render();
    const clean = stripAnsi(output);
    assert.ok(clean.includes("[7s]"));
    assert.ok(clean.includes("worker-1 (codex)"));
    assert.ok(clean.includes("completed"));
    assert.ok(output.includes("done"));
    assert.ok(clean.includes("—"));
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
    const fakeStream = { write: (s) => { output += s; }, columns: 60 };
    const tui = createLogDashboard({ stream: fakeStream, refreshMs: 0 });
    tui.close();
    const before = output;
    tui.render();
    assert.equal(output, before); // close 후 추가 출력 없음
  });

  it("다중 워커 렌더링", () => {
    let output = "";
    const fakeStream = { write: (s) => { output += s; }, columns: 80 };
    const tui = createLogDashboard({ stream: fakeStream, refreshMs: 0 });
    output = "";
    tui.updateWorker("w1", { cli: "codex", status: "completed", handoff: { verdict: "auth done", confidence: "high" } });
    tui.updateWorker("w2", { cli: "gemini", status: "running" });
    tui.updateWorker("w3", { cli: "codex", status: "failed", handoff: { verdict: "dep missing", risk: "low", lead_action: "retry" } });
    tui.render();
    assert.ok(output.includes("auth done"));
    assert.ok(output.includes("dep missing"));
    // lead_action은 messageLabel이 verdict 우선이므로 verdict만 확인
    assert.ok(output.includes("failed"));
    tui.close();
  });

  it("상태가 같으면 append하지 않음 (변경 시에만 출력)", () => {
    let output = "";
    const fakeStream = { write: (s) => { output += s; }, columns: 80 };
    const tui = createLogDashboard({ stream: fakeStream, refreshMs: 0 });
    output = "";
    tui.updateWorker("w1", { cli: "codex", status: "running", snapshot: "step 1", elapsed: 1 });
    tui.render();
    const first = output;
    tui.render();
    assert.equal(output, first);
    tui.updateWorker("w1", { cli: "codex", status: "completed", handoff: { verdict: "ok" }, elapsed: 2 });
    tui.render();
    assert.ok(output.length > first.length);
    assert.ok(output.includes("ok"));
    tui.close();
  });

  it("frameCount 증가", () => {
    const fakeStream = { write: () => {}, columns: 60 };
    const tui = createLogDashboard({ stream: fakeStream, refreshMs: 0 });
    assert.equal(tui.getFrameCount(), 0);
    tui.render();
    assert.equal(tui.getFrameCount(), 1);
    tui.render();
    assert.equal(tui.getFrameCount(), 2);
    tui.close();
  });

  it("커서 이동/화면 클리어 ANSI를 출력하지 않음", () => {
    let output = "";
    const fakeStream = { write: (s) => { output += s; }, columns: 80 };
    const tui = createLogDashboard({ stream: fakeStream, refreshMs: 0 });
    output = "";
    tui.updateWorker("w1", { cli: "codex", status: "running", snapshot: "snapshot", elapsed: 3 });
    tui.render();
    assert.equal(output.includes("\x1b[H"), false); // cursorHome
    assert.equal(output.includes("\x1b[2J"), false); // clearScreen
    assert.equal(output.includes("\x1b[2K"), false); // clearLine
    tui.close();
  });
});
