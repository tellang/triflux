import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

  it("stats 필드 포함", () => {
    assert.equal(typeof result.stats.total, "number");
    assert.equal(typeof result.stats.peakRatePerSec, "number");
    assert.equal(typeof result.stats.maxConcurrent, "number");
    assert.equal(typeof result.stats.blocked, "number");
  });

  it("sysInfo 필드 포함", () => {
    assert.equal(typeof result.sysInfo.platform, "string");
    assert.equal(typeof result.sysInfo.nodeVersion, "string");
    assert.equal(typeof result.sysInfo.cpuCores, "number");
    assert.equal(typeof result.sysInfo.totalMemMB, "number");
  });

  it("traceCount/hookTimingCount 숫자", () => {
    assert.equal(typeof result.traceCount, "number");
    assert.equal(typeof result.hookTimingCount, "number");
  });

  it("codexMcpApproval 진단 결과 포함", () => {
    assert.ok(result.codexMcpApproval, "codexMcpApproval 필드 누락");
    assert.equal(typeof result.codexMcpApproval.found, "boolean");
    if (result.codexMcpApproval.found) {
      assert.ok(Array.isArray(result.codexMcpApproval.tools));
      assert.ok(result.codexMcpApproval.tools.length > 0);
    }
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
