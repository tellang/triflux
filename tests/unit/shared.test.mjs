import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as shared from "../../hub/team/shared.mjs";

describe("shared.mjs", () => {
  it("공유 ANSI 상수들은 문자열이어야 한다", () => {
    const keys = [
      "AMBER",
      "GREEN",
      "RED",
      "GRAY",
      "DIM",
      "BOLD",
      "RESET",
      "WHITE",
      "YELLOW",
    ];

    for (const key of keys) {
      assert.equal(typeof shared[key], "string");
      assert.ok(shared[key].startsWith("\x1b["));
    }
  });
});
