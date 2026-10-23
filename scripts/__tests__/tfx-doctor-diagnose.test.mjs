import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { after, describe, it } from "node:test";

describe("doctor-diagnose: 진단 번들 생성", () => {
  let result;

  it("diagnose() 실행 성공", async () => {
    const { diagnose } = await import("../../scripts/doctor-diagnose.mjs");
    result = await diagnose({ json: false });
    assert.ok(result);
    assert.equal(result.ok, true);
  });

  it("zip 파일 생성됨", () => {
    assert.ok(result.zipPath);
    assert.ok(existsSync(result.zipPath), `zip not found: ${result.zipPath}`);
    assert.ok(result.zipPath.endsWith(".zip"));
  });

  after(() => {
    // 테스트 생성 zip 정리
    if (result?.zipPath && existsSync(result.zipPath)) {
      try {
        rmSync(result.zipPath);
      } catch {
        /* ignore */
      }
    }
  });
});
