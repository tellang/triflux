// tests/unit/consensus-gate.test.mjs — Consensus Gate 단위 테스트
import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
// 기존 게이트와의 공존 확인용
import { runConfidenceCheck } from "../../hub/pipeline/gates/confidence.mjs";
import {
  evaluateConsensus,
  evaluateQualityBranch,
  STAGE_THRESHOLDS,
} from "../../hub/pipeline/gates/consensus.mjs";
import { runSelfCheck } from "../../hub/pipeline/gates/selfcheck.mjs";

// ── 5단계 분기 (evaluateQualityBranch) ──────────────────────────────────────

describe("consensus gate — evaluateQualityBranch 5단계 분기", () => {
  it("successRate >= 90 → proceed", () => {
    assert.equal(evaluateQualityBranch(90, 0, 2, undefined), "proceed");
    assert.equal(evaluateQualityBranch(100, 0, 2, undefined), "proceed");
  });

  it("successRate 75-89 → proceed_warn", () => {
    assert.equal(evaluateQualityBranch(75, 0, 2, undefined), "proceed_warn");
    assert.equal(evaluateQualityBranch(89, 0, 2, undefined), "proceed_warn");
  });

  it("successRate < 75 + retryCount < maxRetries → retry", () => {
    assert.equal(evaluateQualityBranch(50, 0, 2, undefined), "retry");
    assert.equal(evaluateQualityBranch(74, 1, 3, undefined), "retry");
  });

  it("successRate < 75 + retryCount >= maxRetries + supervised → escalate", () => {
    assert.equal(evaluateQualityBranch(50, 2, 2, "supervised"), "escalate");
    assert.equal(evaluateQualityBranch(0, 3, 2, "supervised"), "escalate");
  });

  it("successRate < 75 + retryCount >= maxRetries + 비감독 → abort", () => {
    assert.equal(evaluateQualityBranch(50, 2, 2, undefined), "abort");
    assert.equal(evaluateQualityBranch(50, 2, 2, "autonomous"), "abort");
  });
});

// ── evaluateConsensus ───────────────────────────────────────────────────────

describe("consensus gate — evaluateConsensus 합의도 평가", () => {
  it("전원 성공 → proceed", () => {
    const results = [{ success: true }, { success: true }, { success: true }];
    const out = evaluateConsensus(results);
    assert.equal(out.successRate, 100);
    assert.equal(out.decision, "proceed");
  });

  it("부분 성공 (75-89%) → proceed_warn", () => {
    // 3/4 = 75%
    const results = [
      { success: true },
      { success: true },
      { success: true },
      { success: false },
    ];
    const out = evaluateConsensus(results);
    assert.equal(out.successRate, 75);
    assert.equal(out.decision, "proceed_warn");
  });

  it("낮은 합의 + 재시도 가능 → retry", () => {
    // 1/3 = 33%
    const results = [{ success: true }, { success: false }, { success: false }];
    const out = evaluateConsensus(results, { retryCount: 0, maxRetries: 2 });
    assert.equal(out.successRate, 33);
    assert.equal(out.decision, "retry");
  });

  it("낮은 합의 + 재시도 소진 + supervised → escalate", () => {
    const results = [{ success: false }, { success: false }, { success: true }];
    const out = evaluateConsensus(results, {
      retryCount: 2,
      maxRetries: 2,
      mode: "supervised",
    });
    assert.equal(out.successRate, 33);
    assert.equal(out.decision, "escalate");
  });

  it("낮은 합의 + 재시도 소진 + 비감독 → abort", () => {
    const results = [{ success: false }, { success: false }, { success: true }];
    const out = evaluateConsensus(results, { retryCount: 2, maxRetries: 2 });
    assert.equal(out.successRate, 33);
    assert.equal(out.decision, "abort");
  });

  it("빈 results → abort", () => {
    const out = evaluateConsensus([]);
    assert.equal(out.successRate, 0);
    assert.equal(out.decision, "abort");
    assert.ok(out.reasoning.includes("결과가 없습니다"));
  });

  it("null/undefined results → abort", () => {
    const out = evaluateConsensus(null);
    assert.equal(out.decision, "abort");
  });

  it("전원 실패 → abort (기본 retryCount=0, maxRetries=2이므로 retry)", () => {
    const results = [{ success: false }, { success: false }];
    // retryCount=0 < maxRetries=2 → retry
    const out = evaluateConsensus(results);
    assert.equal(out.successRate, 0);
    assert.equal(out.decision, "retry");
  });
});

// ── 임계값 오버라이드 ───────────────────────────────────────────────────────

describe("consensus gate — 임계값 오버라이드", () => {
  it("threshold 직접 지정 시 해당 값 사용", () => {
    const out = evaluateConsensus([{ success: true }], { threshold: 95 });
    assert.equal(out.threshold, 95);
  });

  it("stage 지정 시 STAGE_THRESHOLDS에서 조회", () => {
    const out = evaluateConsensus([{ success: true }], { stage: "security" });
    assert.equal(out.threshold, 100);
  });

  it("threshold와 stage 동시 지정 시 threshold 우선", () => {
    const out = evaluateConsensus([{ success: true }], {
      threshold: 60,
      stage: "security",
    });
    assert.equal(out.threshold, 60);
  });

  it("STAGE_THRESHOLDS에 5개 단계가 정의됨", () => {
    const expected = ["plan", "define", "execute", "verify", "security"];
    for (const key of expected) {
      assert.ok(key in STAGE_THRESHOLDS, `${key} 누락`);
      assert.equal(typeof STAGE_THRESHOLDS[key], "number");
    }
  });

  it("STAGE_THRESHOLDS 값이 올바름", () => {
    assert.equal(STAGE_THRESHOLDS.plan, 50);
    assert.equal(STAGE_THRESHOLDS.define, 75);
    assert.equal(STAGE_THRESHOLDS.execute, 75);
    assert.equal(STAGE_THRESHOLDS.verify, 80);
    assert.equal(STAGE_THRESHOLDS.security, 100);
  });
});

// ── 환경변수 테스트 ─────────────────────────────────────────────────────────

describe("consensus gate — TRIFLUX_CONSENSUS_THRESHOLD 환경변수", () => {
  const originalEnv = process.env.TRIFLUX_CONSENSUS_THRESHOLD;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.TRIFLUX_CONSENSUS_THRESHOLD;
    } else {
      process.env.TRIFLUX_CONSENSUS_THRESHOLD = originalEnv;
    }
  });

  it("환경변수 미설정 시 기본 75 사용", () => {
    delete process.env.TRIFLUX_CONSENSUS_THRESHOLD;
    const out = evaluateConsensus([{ success: true }]);
    assert.equal(out.threshold, 75);
  });

  it("환경변수 설정 시 해당 값 사용", () => {
    process.env.TRIFLUX_CONSENSUS_THRESHOLD = "60";
    const out = evaluateConsensus([{ success: true }]);
    assert.equal(out.threshold, 60);
  });

  it("환경변수 비정상 값 시 기본 75 사용", () => {
    process.env.TRIFLUX_CONSENSUS_THRESHOLD = "invalid";
    const out = evaluateConsensus([{ success: true }]);
    assert.equal(out.threshold, 75);
  });
});

// ── 기존 게이트와의 공존 확인 ────────────────────────────────────────────────

describe("consensus gate — 기존 게이트와의 공존", () => {
  it("confidence gate 정상 동작 확인", () => {
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
  });

  it("selfcheck gate 정상 동작 확인", () => {
    const result = runSelfCheck("완료", "완료", {
      evidence: {
        testOutput: "PASS",
        requirementChecklist: ["done"],
        references: "docs",
        artifacts: "diff",
      },
    });
    assert.ok(result.passed);
    assert.equal(result.score, 100);
  });

  it("index.mjs에서 consensus 재수출 확인", async () => {
    const gates = await import("../../hub/pipeline/gates/index.mjs");
    assert.equal(typeof gates.evaluateConsensus, "function");
    assert.equal(typeof gates.evaluateQualityBranch, "function");
    assert.ok(gates.STAGE_THRESHOLDS);
    // 기존 게이트도 여전히 존재
    assert.equal(typeof gates.runConfidenceCheck, "function");
    assert.equal(typeof gates.runSelfCheck, "function");
    assert.ok(gates.CRITERIA);
    assert.ok(gates.RED_FLAGS);
    assert.ok(gates.QUESTIONS);
  });
});
