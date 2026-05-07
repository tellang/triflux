import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decideDashboardOpenMode,
  openHeadlessDashboardTarget,
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

  it("openAll은 terminal opener openSession으로 라우팅한다", () => {
    const calls = [];

    const opened = openHeadlessDashboardTarget("demo session!", {
      openAll: true,
      cwd: "/tmp/triflux",
      title: "Team Dashboard",
      _deps: {
        createTerminalOpener: (deps) => {
          assert.equal(typeof deps.createTerminalOpener, "function");
          return {
            openSession: (sessionName, spec) => {
              calls.push({ sessionName, spec });
              return false;
            },
          };
        },
      },
    });

    assert.equal(opened, false);
    assert.deepEqual(calls, [
      {
        sessionName: "demosession",
        spec: {
          title: "Team Dashboard",
          cwd: "/tmp/triflux",
          profile: "triflux",
        },
      },
    ]);
  });

  it("workerNumber는 terminal opener focusPane으로 라우팅한다", () => {
    const calls = [];

    const opened = openHeadlessDashboardTarget("demo", {
      worker: "worker-2",
      workerNumber: 4,
      _deps: {
        createTerminalOpener: () => ({
          focusPane: (sessionName, workerNumber) => {
            calls.push({ sessionName, workerNumber });
            return true;
          },
        }),
      },
    });

    assert.equal(opened, true);
    assert.deepEqual(calls, [{ sessionName: "demo", workerNumber: 4 }]);
  });

  it("선택 워커 focus 실패는 기존처럼 true로 처리한다", () => {
    const opened = openHeadlessDashboardTarget("demo", {
      worker: "worker-2",
      _deps: {
        createTerminalOpener: () => ({
          focusPane: () => false,
        }),
      },
    });

    assert.equal(opened, true);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";

const dashSrc = readFileSync(
  join(import.meta.dirname, "../../hub/team/dashboard-open.mjs"),
  "utf8",
);

describe("dashboard-open wt-manager migration", () => {
  it("terminal-opener를 import한다", () => {
    assert.ok(dashSrc.includes('from "./terminal-opener.mjs"'));
  });

  it("wt-manager를 직접 import하지 않는다", () => {
    assert.ok(!dashSrc.includes('from "./wt-manager.mjs"'));
  });

  it("wt.exe 직접 spawn이 없다", () => {
    assert.ok(!dashSrc.match(/(?:spawn|execFile(?:Sync)?)\s*\(\s*["']wt\.exe/));
  });
});
