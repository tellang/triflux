// tests/unit/doctor-dynamic-routing.test.mjs
//
// Phase 1 Wire-up 4 — `tfx doctor --dynamic-routing` diagnostic helper 검증.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resetSnapshotCache } from "../../hub/routing-snapshot.mjs";
import { diagnoseDynamicRouting } from "../../scripts/doctor-dynamic-routing.mjs";

const ENV_FLAG = "TRIFLUX_DYNAMIC_ROUTING";

let originalEnvFlag;

beforeEach(() => {
  originalEnvFlag = process.env[ENV_FLAG];
  delete process.env[ENV_FLAG];
  resetSnapshotCache();
});

afterEach(() => {
  if (originalEnvFlag === undefined) {
    delete process.env[ENV_FLAG];
  } else {
    process.env[ENV_FLAG] = originalEnvFlag;
  }
  resetSnapshotCache();
});

describe("doctor-dynamic-routing diagnostic", () => {
  it("DR-01: env 미설정 시 enabled=false + previewDecision null", async () => {
    const report = await diagnoseDynamicRouting();
    assert.equal(report.enabled, false);
    assert.equal(report.envFlag, null);
    assert.equal(report.previewDecision, null);
    // policy 와 snapshot 은 enabled 와 무관하게 진단
    assert.equal(report.policyLoaded, true, "policy 가 로드되지 않음");
    assert.ok(report.policyScenarios.length > 0, "scenarios 가 비었다");
  });

  it("DR-02: env=1 시 enabled=true + previewDecision 생성", async () => {
    process.env[ENV_FLAG] = "1";
    const report = await diagnoseDynamicRouting();
    assert.equal(report.enabled, true);
    assert.equal(report.envFlag, "1");
    assert.ok(report.previewDecision, "previewDecision 누락");
    assert.equal(typeof report.previewDecision.decisionId, "string");
    assert.equal(typeof report.previewDecision.scenario, "string");
    assert.ok(
      Array.isArray(report.previewDecision.shards),
      "shards 가 배열 아님",
    );
  });

  it("DR-03: env=true 도 활성화", async () => {
    process.env[ENV_FLAG] = "true";
    const report = await diagnoseDynamicRouting();
    assert.equal(report.enabled, true);
    assert.ok(report.previewDecision);
  });

  it("DR-04: env=0 (명시 비활성) — previewDecision null", async () => {
    process.env[ENV_FLAG] = "0";
    const report = await diagnoseDynamicRouting();
    assert.equal(report.enabled, false);
    assert.equal(report.previewDecision, null);
  });

  it("DR-05: report 가 policyPath 와 scenarios 메타 포함", async () => {
    const report = await diagnoseDynamicRouting();
    assert.match(report.policyPath, /routing-policy\.json$/);
    assert.ok(report.policyScenarios.includes("S1"), "S1 scenario 누락");
    assert.ok(report.policyScenarios.includes("S6"), "S6 scenario 누락");
  });

  it("DR-06: snapshot cache 가 채워진 후 두 번째 호출은 hit", async () => {
    await diagnoseDynamicRouting();
    const second = await diagnoseDynamicRouting();
    assert.equal(second.snapshotCached, true);
    // age 는 비교적 작아야 한다 (TTL 안)
    assert.ok(
      second.snapshotAgeMs !== null && second.snapshotAgeMs < 10_000,
      `snapshotAgeMs 가 비정상: ${second.snapshotAgeMs}`,
    );
  });

  it("DR-07: report 구조가 contract 와 일치 — error 는 null 또는 string", async () => {
    process.env[ENV_FLAG] = "1";
    const report = await diagnoseDynamicRouting();
    const expectedKeys = [
      "enabled",
      "envFlag",
      "policyLoaded",
      "policyScenarios",
      "policyPath",
      "snapshotCached",
      "snapshotAgeMs",
      "previewDecision",
      "error",
    ];
    for (const k of expectedKeys) {
      assert.ok(k in report, `report 에 ${k} 키 누락`);
    }
    assert.ok(report.error === null || typeof report.error === "string");
  });
});
