import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { stripAnsi } from "../../hub/team/ansi.mjs";
import { createLiteDashboard } from "../../hub/team/tui-lite.mjs";

describe("createLogDashboard(tui-lite)", () => {
  it("워커 상태를 저장하고 선택 워커를 유지한다", () => {
    const tui = createLiteDashboard({ refreshMs: 0 });
    tui.updateWorker("w1", { cli: "codex", status: "running" });
    tui.updateWorker("w2", { cli: "gemini", status: "completed" });
    tui.selectWorker("w2");
    assert.equal(tui.getWorkers().get("w2").status, "completed");
    assert.equal(tui.getSelectedWorker(), "w2");
    tui.close();
  });

  it("렌더 시 핵심 메타데이터를 출력하고 코드 블록은 제거한다", () => {
    let output = "";
    const stream = { write: (chunk) => { output += chunk; }, columns: 120, isTTY: false };
    const tui = createLiteDashboard({ stream, refreshMs: 0, columns: 120 });
    tui.updateWorker("worker-1", {
      cli: "codex",
      status: "completed",
      progress: 1,
      tokens: "1.2k tokens used",
      summary: "요약 문장",
      detail: "verdict: done\n```js\nconsole.log('secret');\n```\nconfidence: high",
      handoff: { status: "ok", verdict: "done", confidence: "high", files_changed: ["hub/team/tui-lite.mjs"] },
    });
    tui.setFocusTab("files");
    tui.render();
    const clean = stripAnsi(output);
    assert.ok(clean.includes("worker-1"));
    assert.ok(clean.includes("tokens 1.2k"));
    assert.ok(clean.includes("verdict done"));
    assert.ok(clean.includes("files hub/team/tui-lite.mjs"));
    assert.equal(clean.includes("console.log"), false);
    tui.close();
  });

  it("넓은 화면에서는 rail + detail 분할 레이아웃을 쓴다", () => {
    let output = "";
    const stream = { write: (chunk) => { output += chunk; }, columns: 132, rows: 20, isTTY: false };
    const tui = createLiteDashboard({ stream, refreshMs: 0, columns: 132, rows: 20 });
    tui.updateWorker("w1", { cli: "codex", status: "running", summary: "step 1" });
    tui.updateWorker("w2", { cli: "claude", status: "completed", handoff: { status: "ok", verdict: "done" } });
    tui.selectWorker("w2");
    tui.render();
    const clean = stripAnsi(output);
    assert.ok(clean.includes("w1"));
    assert.ok(clean.includes("w2"));
    assert.ok(clean.includes("│"));
    assert.ok(clean.includes("verdict done"));
    tui.close();
  });

  it("TTY 입력에서 j/k와 Enter 콜백을 처리한다", () => {
    let opened = "";
    const input = new EventEmitter();
    input.isTTY = true;
    input.resume = () => {};
    input.pause = () => {};
    input.setRawMode = () => {};

    const stream = { write: () => {}, columns: 120, rows: 20, isTTY: true };
    const tui = createLiteDashboard({
      stream,
      input,
      refreshMs: 0,
      onOpenSelectedWorker: (name) => { opened = name; },
    });
    tui.updateWorker("worker-1", { cli: "codex", status: "running" });
    tui.updateWorker("worker-2", { cli: "gemini", status: "running" });
    tui.render();

    input.emit("data", "j");
    input.emit("data", "\r");

    assert.equal(tui.getSelectedWorker(), "worker-2");
    assert.equal(opened, "worker-2");
    tui.close();
  });

  it("Shift+Enter에서 전체 열기 콜백을 호출한다", () => {
    let called = false;
    const input = new EventEmitter();
    input.isTTY = true;
    input.resume = () => {};
    input.pause = () => {};
    input.setRawMode = () => {};

    const stream = { write: () => {}, columns: 120, rows: 20, isTTY: true };
    const tui = createLiteDashboard({
      stream,
      input,
      refreshMs: 0,
      onOpenAllWorkers: () => { called = true; },
    });
    tui.updateWorker("worker-1", { cli: "codex", status: "running" });
    tui.render();

    input.emit("data", "\x1b[13;2u");

    assert.equal(called, true);
    tui.close();
  });
});
