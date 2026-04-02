import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  decideDashboardOpenMode,
  parseWorkerNumber,
} from "../../hub/team/dashboard-open.mjs";

describe("dashboard-open", () => {
  it("selected worker는 WT 세션에서 split 우선", () => {
    assert.equal(decideDashboardOpenMode({ openAll: false, hasWtSession: true }), "split");
  });

  it("openAll은 WT 세션에서 tab 우선", () => {
    assert.equal(decideDashboardOpenMode({ openAll: true, hasWtSession: true }), "tab");
  });

  it("WT 세션이 없으면 window fallback", () => {
    assert.equal(decideDashboardOpenMode({ openAll: false, hasWtSession: false }), "window");
    assert.equal(decideDashboardOpenMode({ openAll: true, hasWtSession: false }), "window");
  });

  it("worker/pane 표기에서 워커 번호를 추출한다", () => {
    assert.equal(parseWorkerNumber("worker-3"), 3);
    assert.equal(parseWorkerNumber("wt:2"), 2);
    assert.equal(parseWorkerNumber("native:1"), 1);
    assert.equal(parseWorkerNumber("lead"), null);
  });
});
