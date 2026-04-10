import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decideDashboardOpenMode,
  parseWorkerNumber,
} from "../../hub/team/dashboard-open.mjs";

describe("dashboard-open", () => {
  it("selected worker는 WT 세션에서 split 우선", () => {
    assert.equal(
      decideDashboardOpenMode({ openAll: false, hasWtSession: true }),
      "split",
    );
  });

  it("openAll은 WT 세션에서 tab 우선", () => {
    assert.equal(
      decideDashboardOpenMode({ openAll: true, hasWtSession: true }),
      "tab",
    );
  });

  it("WT 세션이 없으면 window fallback", () => {
    assert.equal(
      decideDashboardOpenMode({ openAll: false, hasWtSession: false }),
      "window",
    );
    assert.equal(
      decideDashboardOpenMode({ openAll: true, hasWtSession: false }),
      "window",
    );
  });

  it("worker/pane 표기에서 워커 번호를 추출한다", () => {
    assert.equal(parseWorkerNumber("worker-3"), 3);
    assert.equal(parseWorkerNumber("wt:2"), 2);
    assert.equal(parseWorkerNumber("native:1"), 1);
    assert.equal(parseWorkerNumber("lead"), null);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";

const dashSrc = readFileSync(
  join(import.meta.dirname, "../../hub/team/dashboard-open.mjs"),
  "utf8",
);

describe("dashboard-open wt-manager migration", () => {
  it("createWtManager를 import한다", () => {
    assert.ok(dashSrc.includes('from "./wt-manager.mjs"'));
  });

  it("wt.exe 직접 spawn이 없다", () => {
    assert.ok(!dashSrc.match(/(?:spawn|execFile(?:Sync)?)\s*\(\s*["']wt\.exe/));
  });
});
