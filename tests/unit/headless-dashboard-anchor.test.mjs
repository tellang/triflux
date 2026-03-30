import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildDashboardAttachArgs } from "../../hub/team/headless.mjs";

describe("headless dashboard anchor", () => {
  it("기본 anchor는 dedicated window를 사용한다", () => {
    const args = buildDashboardAttachArgs("tfx-session", "single", 2);
    assert.deepEqual(args.slice(0, 2), ["-w", "new"]);
    assert.ok(args.includes("--session"));
    assert.ok(args.includes("tfx-session"));
  });

  it("tab anchor는 현재 WT 창에 새 탭을 연다", () => {
    const args = buildDashboardAttachArgs("tfx-session", "split-2col", 2, "tab");
    assert.deepEqual(args.slice(0, 3), ["-w", "0", "nt"]);
  });

  it("알 수 없는 anchor 값은 window로 폴백한다", () => {
    const args = buildDashboardAttachArgs("tfx-session", "single", 2, "unknown");
    assert.deepEqual(args.slice(0, 2), ["-w", "new"]);
  });

  it("session 이름은 안전하게 정규화된다", () => {
    const args = buildDashboardAttachArgs("bad;name$with*chars", "single", 2, "window");
    const sessionIdx = args.indexOf("--session");
    assert.ok(sessionIdx > -1);
    assert.equal(args[sessionIdx + 1], "badnamewithchars");
  });
});
