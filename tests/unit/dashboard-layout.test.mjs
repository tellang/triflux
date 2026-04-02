import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseDashboardLayout,
  resolveDashboardLayout,
} from "../../hub/team/dashboard-layout.mjs";
import { parseDashboardAnchor } from "../../hub/team/dashboard-anchor.mjs";
import { parseTeamArgs } from "../../hub/team/cli/commands/start/parse-args.mjs";
import { createLogDashboard } from "../../hub/team/tui.mjs";

describe("dashboard-layout", () => {
  it("CLI 입력 기본값은 single", () => {
    assert.equal(parseDashboardLayout(""), "single");
    assert.equal(parseDashboardLayout("unknown"), "single");
  });

  it("auto는 워커 수에 따라 dashboard 레이아웃을 해석한다", () => {
    assert.equal(resolveDashboardLayout("auto", 1), "single");
    assert.equal(resolveDashboardLayout("auto", 2), "split-2col");
    assert.equal(resolveDashboardLayout("auto", 3), "split-3col");
    assert.equal(resolveDashboardLayout("auto", 4), "summary+detail");
    assert.equal(resolveDashboardLayout("auto", 8), "summary+detail");
  });

  it("parseTeamArgs가 --dashboard-layout 플래그를 보존한다", () => {
    const parsed = parseTeamArgs(["--dashboard-layout", "auto", "fix", "bug"]);
    assert.equal(parsed.dashboardLayout, "auto");
    assert.equal(parsed.dashboard, true);
  });

  it("parseTeamArgs 기본 dashboard layout은 lite", () => {
    const parsed = parseTeamArgs(["fix", "bug"]);
    assert.equal(parsed.dashboardLayout, "lite");
    assert.equal(parsed.dashboard, true);
  });

  it("dashboard anchor 기본값은 window", () => {
    assert.equal(parseDashboardAnchor(""), "window");
    assert.equal(parseDashboardAnchor("unknown"), "window");
  });

  it("parseTeamArgs가 --dashboard-anchor 플래그를 보존한다", () => {
    const parsed = parseTeamArgs(["--dashboard-anchor", "tab", "fix", "bug"]);
    assert.equal(parsed.dashboardAnchor, "tab");
  });

  it("createLogDashboard가 resolved layout을 유지한다", () => {
    const tui = createLogDashboard({ refreshMs: 0, layout: "summary+detail" });
    assert.equal(tui.getLayout(), "summary+detail");
    tui.close();
  });
});
