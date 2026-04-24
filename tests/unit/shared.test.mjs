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
      // biome-ignore lint/performance/noDynamicNamespaceImportAccess: 테스트는 상수 키를 반복 순회하며 타입/값을 검증해야 하므로 dynamic access 가 의도된 동작
      const value = shared[key];
      assert.equal(typeof value, "string");
      assert.ok(value.startsWith("\x1b["));
    }
  });
});
