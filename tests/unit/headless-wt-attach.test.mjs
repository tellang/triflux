import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildDashboardAttachArgs,
  buildWtAttachArgs,
} from "../../hub/team/headless.mjs";

function countOccurrences(items, value) {
  return items.filter((item) => item === value).length;
}

describe("headless WT attach builders", () => {
  it("single worker는 split 없이 새 탭에서 attach-session 한다", () => {
    const args = buildWtAttachArgs("tfx-team", 1);
    assert.deepEqual(args.slice(0, 3), ["-w", "0", "nt"]);
    assert.equal(countOccurrences(args, "sp"), 0);
    assert.ok(args.includes("attach-session"));
  });

  it("two workers는 상하 분할 시퀀스를 사용한다", () => {
    const args = buildWtAttachArgs("tfx-team", 2);
    assert.deepEqual(args.slice(0, 3), ["-w", "0", "nt"]);
    assert.equal(countOccurrences(args, "sp"), 1);
    assert.ok(args.includes("-H"));
    assert.equal(countOccurrences(args, "move-focus"), 0);
  });

  it("four workers는 좌상단 attach 후 2x2 grid 시퀀스를 만든다", () => {
    const args = buildWtAttachArgs("bad;name$chars", 4);
    const sequence = [
      "nt",
      ";",
      "sp",
      "-V",
      ";",
      "move-focus",
      "left",
      ";",
      "sp",
      "-H",
      ";",
      "move-focus",
      "right",
      ";",
      "sp",
      "-H",
    ];
    let cursor = 0;
    for (const token of sequence) {
      const next = args.indexOf(token, cursor);
      assert.ok(next >= cursor, `missing token ${token} after ${cursor}`);
      cursor = next + 1;
    }
    const sessionTarget = args.indexOf("-t");
    assert.equal(args[sessionTarget + 1], "badnamechars");
    assert.equal(countOccurrences(args, "attach-session"), 4);
  });

  it("five or more workers는 dashboard attach로 전환한다", () => {
    const directArgs = buildWtAttachArgs("tfx-team", 5);
    const dashboardArgs = buildDashboardAttachArgs("tfx-team", "single", 5);
    assert.deepEqual(directArgs, dashboardArgs);
    assert.deepEqual(directArgs.slice(0, 2), ["-w", "new"]);
    assert.ok(directArgs.includes("--layout"));
  });
});
