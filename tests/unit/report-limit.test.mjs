import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  filePaths,
  headLength,
  reportLimit,
  shorten,
} from "../../hub/lib/report-limit.mjs";

describe("report-limit", () => {
  it("버전 문자열은 경로로 보지 않고 경로 끝의 조사와 문장부호는 뗀다", () => {
    assert.deepEqual(filePaths("v10.82.1/10.82.3 과 0.5/1.0 을 비교했다"), []);
    assert.deepEqual(
      filePaths(
        "/work/.omc/briefs/a.result.md에 썼다. (~/x/y.ts) ./hub/lib/lead-marker.mjs와 /work/adapters/agy/guard",
      ),
      [
        "/work/.omc/briefs/a.result.md",
        "~/x/y.ts",
        "./hub/lib/lead-marker.mjs",
        "/work/adapters/agy/guard",
      ],
    );
  });

  it("reportLimit 이하이면 keep을 반환한다", () => {
    assert.deepEqual(shorten("가".repeat(reportLimit)), { kind: "keep" });
  });

  it("상한을 넘고 파일 경로가 있으면 앞 800자와 파일 경로 목록으로 줄인다", () => {
    const body = `요약 첫 줄\n${"가".repeat(4500)}\n결과: /work/.omc/briefs/a.result.md 와 ./hub/lib/report-limit.mjs 참조`;
    const result = shorten(body);
    assert.equal(result.kind, "cut");
    assert.ok(result.text.startsWith(body.slice(0, headLength)));
    assert.ok(
      result.text.includes(
        "- /work/.omc/briefs/a.result.md\n- ./hub/lib/report-limit.mjs",
      ),
    );
    assert.ok(result.text.includes(`원문 ${body.length}자, 결과 파일 참조`));
  });

  it("상한을 넘어도 파일 경로가 없으면 warn을 반환하고 자르지 않는다", () => {
    const body = "나".repeat(5000);
    assert.deepEqual(shorten(body), { kind: "warn", total: 5000 });
  });
});
