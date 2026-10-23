import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTeamArgs } from "../../hub/team/cli/commands/start/parse-args.mjs";
import { resolveDashboardLayout } from "../../hub/team/dashboard-layout.mjs";

describe("dashboard-layout", () => {
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

  it("parseTeamArgs가 --dashboard-anchor 플래그를 보존한다", () => {
    const parsed = parseTeamArgs(["--dashboard-anchor", "tab", "fix", "bug"]);
    assert.equal(parsed.dashboardAnchor, "tab");
  });
});
