import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  openHeadlessDashboardTarget,
  parseWorkerNumber,
} from "../../hub/team/dashboard-open.mjs";

describe("dashboard-open", () => {
  it("worker/pane 표기에서 워커 번호를 추출한다", () => {
    assert.equal(parseWorkerNumber("worker-3"), 3);
    assert.equal(parseWorkerNumber("wt:2"), 2);
    assert.equal(parseWorkerNumber("native:1"), 1);
    assert.equal(parseWorkerNumber("lead"), null);
  });

  it("openAll은 terminal opener openSession으로 라우팅한다", async () => {
    const calls = [];

    const opened = await openHeadlessDashboardTarget("demo session!", {
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

  it("openAll은 async openSession 실패를 false로 반환한다", async () => {
    const opened = await openHeadlessDashboardTarget("demo", {
      openAll: true,
      _deps: {
        createTerminalOpener: () => ({
          openSession: async () => false,
        }),
      },
    });

    assert.equal(opened, false);
  });

  it("workerNumber는 terminal opener focusPane으로 라우팅한다", async () => {
    const calls = [];

    const opened = await openHeadlessDashboardTarget("demo", {
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

  it("선택 워커 focus 실패는 기존처럼 true로 처리한다", async () => {
    const opened = await openHeadlessDashboardTarget("demo", {
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
