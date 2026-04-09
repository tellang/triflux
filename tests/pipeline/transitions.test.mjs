// tests/pipeline/transitions.test.mjs — 전이 규칙 단위 테스트
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  canTransition,
  PHASES,
  ralphRestart,
  TERMINAL,
  transitionPhase,
} from "../../hub/pipeline/transitions.mjs";

describe("PHASES / TERMINAL", () => {
  it("10개 단계 정의 (confidence + deslop + selfcheck 포함)", () => {
    assert.equal(PHASES.length, 10);
    assert.ok(PHASES.includes("confidence"));
    assert.ok(PHASES.includes("deslop"));
    assert.ok(PHASES.includes("selfcheck"));
  });

  it("터미널 상태는 complete, failed", () => {
    assert.ok(TERMINAL.has("complete"));
    assert.ok(TERMINAL.has("failed"));
    assert.equal(TERMINAL.size, 2);
  });
});

describe("canTransition", () => {
  // 허용 전이 (confidence + selfcheck 포함)
  const allowed = [
    ["plan", "prd"],
    ["prd", "confidence"],
    ["confidence", "exec"],
    ["confidence", "failed"],
    ["exec", "deslop"],
    ["deslop", "verify"],
    ["verify", "selfcheck"],
    ["verify", "fix"],
    ["verify", "failed"],
    ["selfcheck", "complete"],
    ["selfcheck", "fix"],
    ["fix", "exec"],
    ["fix", "verify"],
    ["fix", "complete"],
    ["fix", "failed"],
  ];

  for (const [from, to] of allowed) {
    it(`${from} → ${to} 허용`, () => {
      assert.ok(canTransition(from, to));
    });
  }

  // 금지 전이 (confidence + selfcheck 포함)
  const forbidden = [
    ["plan", "exec"],
    ["plan", "verify"],
    ["plan", "fix"],
    ["plan", "complete"],
    ["prd", "plan"],
    ["prd", "exec"],
    ["prd", "verify"],
    ["confidence", "plan"],
    ["confidence", "verify"],
    ["exec", "plan"],
    ["exec", "fix"],
    ["exec", "complete"],
    ["verify", "plan"],
    ["verify", "exec"],
    ["verify", "complete"],
    ["selfcheck", "plan"],
    ["selfcheck", "exec"],
    ["complete", "plan"],
    ["complete", "exec"],
    ["failed", "plan"],
    ["failed", "fix"],
  ];

  for (const [from, to] of forbidden) {
    it(`${from} → ${to} 금지`, () => {
      assert.ok(!canTransition(from, to));
    });
  }

  it("존재하지 않는 단계에서 전이 불가", () => {
    assert.ok(!canTransition("unknown", "plan"));
  });
});

describe("transitionPhase", () => {
  function makeState(phase, overrides = {}) {
    return {
      phase,
      fix_attempt: 0,
      fix_max: 3,
      ralph_iteration: 0,
      ralph_max: 10,
      phase_history: [],
      ...overrides,
    };
  }

  it("정상 전이 체인: plan → prd → confidence → exec → deslop → verify → selfcheck → complete", () => {
    let r = transitionPhase(makeState("plan"), "prd");
    assert.ok(r.ok);
    assert.equal(r.state.phase, "prd");

    r = transitionPhase(r.state, "confidence");
    assert.ok(r.ok);
    assert.equal(r.state.phase, "confidence");

    r = transitionPhase(r.state, "exec");
    assert.ok(r.ok);
    assert.equal(r.state.phase, "exec");

    r = transitionPhase(r.state, "deslop");
    assert.ok(r.ok);
    assert.equal(r.state.phase, "deslop");

    r = transitionPhase(r.state, "verify");
    assert.ok(r.ok);
    assert.equal(r.state.phase, "verify");

    r = transitionPhase(r.state, "selfcheck");
    assert.ok(r.ok);
    assert.equal(r.state.phase, "selfcheck");

    r = transitionPhase(r.state, "complete");
    assert.ok(r.ok);
    assert.equal(r.state.phase, "complete");
  });

  it("금지 전이 시 에러 반환", () => {
    const r = transitionPhase(makeState("plan"), "exec");
    assert.ok(!r.ok);
    assert.ok(r.error.includes("전이 불가"));
  });

  it("금지 전이: prd → exec (confidence 거쳐야 함)", () => {
    const r = transitionPhase(makeState("prd"), "exec");
    assert.ok(!r.ok);
  });

  it("금지 전이: verify → complete (selfcheck 거쳐야 함)", () => {
    const r = transitionPhase(makeState("verify"), "complete");
    assert.ok(!r.ok);
  });

  it("fix 진입 시 fix_attempt 증가", () => {
    const r = transitionPhase(makeState("verify"), "fix");
    assert.ok(r.ok);
    assert.equal(r.state.fix_attempt, 1);
  });

  it("fix loop 바운딩: fix_max 초과 시 거부", () => {
    const state = makeState("verify", { fix_attempt: 3, fix_max: 3 });
    const r = transitionPhase(state, "fix");
    assert.ok(!r.ok);
    assert.ok(r.error.includes("fix loop 초과"));
  });

  it("fix → exec → deslop → verify → fix 반복 시 attempt 누적", () => {
    const s = makeState("verify");

    // fix 1회
    let r = transitionPhase(s, "fix");
    assert.equal(r.state.fix_attempt, 1);

    r = transitionPhase(r.state, "exec");
    r = transitionPhase(r.state, "deslop");
    r = transitionPhase(r.state, "verify");

    // fix 2회
    r = transitionPhase(r.state, "fix");
    assert.equal(r.state.fix_attempt, 2);

    r = transitionPhase(r.state, "exec");
    r = transitionPhase(r.state, "deslop");
    r = transitionPhase(r.state, "verify");

    // fix 3회
    r = transitionPhase(r.state, "fix");
    assert.equal(r.state.fix_attempt, 3);

    r = transitionPhase(r.state, "exec");
    r = transitionPhase(r.state, "deslop");
    r = transitionPhase(r.state, "verify");

    // fix 4회 — 초과
    r = transitionPhase(r.state, "fix");
    assert.ok(!r.ok);
  });

  it("phase_history 기록", () => {
    const r = transitionPhase(makeState("plan"), "prd");
    assert.equal(r.state.phase_history.length, 1);
    assert.equal(r.state.phase_history[0].from, "plan");
    assert.equal(r.state.phase_history[0].to, "prd");
  });
});

describe("ralphRestart", () => {
  function makeState(overrides = {}) {
    return {
      phase: "fix",
      fix_attempt: 3,
      fix_max: 3,
      ralph_iteration: 0,
      ralph_max: 10,
      phase_history: [],
      ...overrides,
    };
  }

  it("plan으로 재시작, ralph_iteration 증가, fix_attempt 리셋", () => {
    const r = ralphRestart(makeState());
    assert.ok(r.ok);
    assert.equal(r.state.phase, "plan");
    assert.equal(r.state.ralph_iteration, 1);
    assert.equal(r.state.fix_attempt, 0);
  });

  it("ralph_max 초과 시 거부", () => {
    const r = ralphRestart(makeState({ ralph_iteration: 10, ralph_max: 10 }));
    assert.ok(!r.ok);
    assert.ok(r.error.includes("ralph loop 초과"));
  });

  it("phase_history에 ralph_restart 기록", () => {
    const r = ralphRestart(makeState());
    const last = r.state.phase_history[r.state.phase_history.length - 1];
    assert.ok(last.ralph_restart);
  });
});
