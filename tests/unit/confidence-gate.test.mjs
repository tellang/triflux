// tests/unit/confidence-gate.test.mjs — Confidence Gate 단위 테스트
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  CRITERIA,
  runConfidenceCheck,
} from "../../hub/pipeline/gates/confidence.mjs";
import { canTransition, PHASES } from "../../hub/pipeline/transitions.mjs";

describe("confidence gate — 판정 로직", () => {
  it('점수 >= 90% → decision: "proceed"', () => {
    const result = runConfidenceCheck("implement auth module", {
      checks: {
        no_duplicate: 1,
        architecture: 1,
        docs_verified: 1,
        oss_reference: 0.8,
        root_cause: 1,
      },
    });
    assert.ok(result.score >= 90);
    assert.equal(result.decision, "proceed");
  });

  it('점수 70-89% → decision: "alternative"', () => {
    const _result = runConfidenceCheck("implement auth module", {
      checks: {
        no_duplicate: 1,
        architecture: 1,
        docs_verified: 0,
        oss_reference: 0,
        root_cause: 1,
      },
    });
    // 0.25 + 0.25 + 0 + 0 + 0.15 = 0.65 → 65%... need to adjust
    // Let's use partial scores for a 70-89% result
    const r2 = runConfidenceCheck("implement auth module", {
      checks: {
        no_duplicate: 1,
        architecture: 1,
        docs_verified: 1,
        oss_reference: 0,
        root_cause: 0,
      },
    });
    // 0.25 + 0.25 + 0.20 + 0 + 0 = 0.70 → 70%
    assert.ok(r2.score >= 70 && r2.score < 90, `score=${r2.score}`);
    assert.equal(r2.decision, "alternative");
  });

  it('점수 < 70% → decision: "abort"', () => {
    const result = runConfidenceCheck("implement auth module", {
      checks: {
        no_duplicate: 1,
        architecture: 0,
        docs_verified: 0,
        oss_reference: 0,
        root_cause: 0,
      },
    });
    // 0.25 + 0 + 0 + 0 + 0 = 0.25 → 25%
    assert.ok(result.score < 70, `score=${result.score}`);
    assert.equal(result.decision, "abort");
  });

  it("5개 항목 가중치 합산이 100%", () => {
    const totalWeight = CRITERIA.reduce((sum, c) => sum + c.weight, 0);
    assert.equal(totalWeight, 1.0);
  });

  it("모든 항목 만점 시 score === 100", () => {
    const result = runConfidenceCheck("plan", {
      checks: {
        no_duplicate: 1,
        architecture: 1,
        docs_verified: 1,
        oss_reference: 1,
        root_cause: 1,
      },
    });
    assert.equal(result.score, 100);
    assert.equal(result.decision, "proceed");
    assert.equal(result.breakdown.length, 5);
    assert.ok(result.breakdown.every((b) => b.passed));
  });

  it("planArtifact 누락 시 abort", () => {
    const result = runConfidenceCheck(null, { checks: { no_duplicate: 1 } });
    assert.equal(result.score, 0);
    assert.equal(result.decision, "abort");
    assert.ok(result.reasoning.includes("planArtifact"));
  });

  it("빈 context 시 낮은 점수", () => {
    const result = runConfidenceCheck("some plan", {});
    assert.equal(result.score, 0);
    assert.equal(result.decision, "abort");
  });
});

describe("confidence gate — 파이프라인 전이", () => {
  it("prd → confidence 허용", () => {
    assert.ok(canTransition("prd", "confidence"));
  });

  it("confidence → exec 허용", () => {
    assert.ok(canTransition("confidence", "exec"));
  });

  it("confidence → failed 허용", () => {
    assert.ok(canTransition("confidence", "failed"));
  });

  it("confidence가 PHASES에 포함", () => {
    assert.ok(PHASES.includes("confidence"));
  });
});
