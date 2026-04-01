import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { stripAnsi } from "../../hub/team/ansi.mjs";
import { createLogDashboard } from "../../hub/team/tui-lite.mjs";

describe("createLogDashboard(tui-lite)", () => {
  it("워커 상태를 저장하고 선택 워커를 유지한다", () => {
    const tui = createLogDashboard({ refreshMs: 0 });
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
    const tui = createLogDashboard({ stream, refreshMs: 0, columns: 120 });
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
    const tui = createLogDashboard({ stream, refreshMs: 0, columns: 132, rows: 20 });
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
});
