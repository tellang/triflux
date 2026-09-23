// tests/unit/retry-state-machine.test.mjs
// Phase 3 Step A — retry-state-machine.mjs 계약 검증.

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  createRetryStateMachine,
  DEFAULT_ESCALATION_CHAIN,
  loadSnapshot,
  resumeFromStateFile,
  STATES,
  saveSnapshot,
} from "../../hub/team/retry-state-machine.mjs";

const tempDirs = [];

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "triflux-rsm-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("retry-state-machine — bounded / ralph / auto-escalate", () => {
  describe("ralph — bounded by max_iterations", () => {
    it("maxIterations=5 일 때 정확히 5회 EXECUTING 후 BUDGET_EXCEEDED", () => {
      const sm = createRetryStateMachine({ mode: "ralph", maxIterations: 5 });
      for (let i = 0; i < 5; i += 1) {
        sm.startIteration();
        sm.reportVerifyFail(`fail-${i}`);
      }
      const cur = sm.getCurrent();
      assert.equal(cur.current, STATES.BUDGET_EXCEEDED);
      assert.equal(cur.iterations, 5);
    });

    it("ralph 기본 maxIterations=0 (unlimited) 는 budget 으로 종료되지 않는다", () => {
      const sm = createRetryStateMachine({ mode: "ralph" });
      for (let i = 0; i < 50; i += 1) {
        sm.startIteration();
        sm.reportVerifyFail(`reason-${i}`);
      }
      const cur = sm.getCurrent();
      assert.notEqual(cur.current, STATES.BUDGET_EXCEEDED);
      assert.equal(cur.maxIterations, 0);
    });

    it("bounded 기본 maxIterations=3 을 3회 만에 소진", () => {
      const sm = createRetryStateMachine({ mode: "bounded" });
      for (let i = 0; i < 3; i += 1) {
        sm.startIteration();
        sm.reportVerifyFail(`different-${i}`);
      }
      assert.equal(sm.getCurrent().current, STATES.BUDGET_EXCEEDED);
    });

    it("VerifySuccess 는 즉시 DONE", () => {
      const sm = createRetryStateMachine({ mode: "ralph", maxIterations: 5 });
      sm.startIteration();
      sm.reportVerifySuccess();
      assert.equal(sm.getCurrent().current, STATES.DONE);
    });
  });

  describe("stuck detector — 동일 failureReason 연속 3회", () => {
    it("동일 failureReason 3회 연속 → STUCK", () => {
      const sm = createRetryStateMachine({ mode: "ralph", maxIterations: 100 });
      for (let i = 0; i < 3; i += 1) {
        sm.startIteration();
        sm.reportVerifyFail("same-reason");
      }
      const cur = sm.getCurrent();
      assert.equal(cur.current, STATES.STUCK);
      assert.equal(cur.stuckCounter, 3);
      assert.equal(cur.lastFailureReason, "same-reason");
    });

    it("다른 failureReason 이 끼어들면 stuck 카운터 초기화", () => {
      const sm = createRetryStateMachine({ mode: "ralph", maxIterations: 100 });
      sm.startIteration();
      sm.reportVerifyFail("A");
      sm.startIteration();
      sm.reportVerifyFail("A");
      sm.startIteration();
      sm.reportVerifyFail("B");
      const cur = sm.getCurrent();
      assert.equal(cur.current, STATES.DIAGNOSING);
      assert.equal(cur.stuckCounter, 1);
      assert.equal(cur.lastFailureReason, "B");
    });
  });

  describe("auto-escalate — CLI 승격 체인", () => {
    it("체인 [A,B,C] 에서 A 3회 fail 시 B 로 전이, iterations 리셋", () => {
      const chain = [
        { cli: "codex", model: "A" },
        { cli: "codex", model: "B" },
        { cli: "claude", model: "C" },
      ];
      const sm = createRetryStateMachine({
        mode: "auto-escalate",
        maxIterations: 3,
        cliChain: chain,
      });
      for (let i = 0; i < 3; i += 1) {
        sm.startIteration();
        sm.reportVerifyFail(`A-fail-${i}`);
      }
      const cur = sm.getCurrent();
      assert.equal(cur.current, STATES.EXECUTING);
      assert.equal(cur.cliIndex, 1);
      assert.equal(cur.iterations, 0);
      assert.equal(cur.stuckCounter, 0);
    });

    it("체인 끝까지 소진되면 BUDGET_EXCEEDED with reason=escalation-chain-exhausted", () => {
      const chain = [
        { cli: "a", model: "1" },
        { cli: "b", model: "2" },
      ];
      const sm = createRetryStateMachine({
        mode: "auto-escalate",
        maxIterations: 2,
        cliChain: chain,
      });
      // 1단계: 2회 fail → escalate
      for (let i = 0; i < 2; i += 1) {
        sm.startIteration();
        sm.reportVerifyFail(`s1-${i}`);
      }
      // 2단계: 2회 fail → exhausted
      for (let i = 0; i < 2; i += 1) {
        sm.startIteration();
        sm.reportVerifyFail(`s2-${i}`);
      }
      const cur = sm.getCurrent();
      assert.equal(cur.current, STATES.BUDGET_EXCEEDED);
      const last = cur.history.at(-1);
      assert.equal(last.reason, "escalation-chain-exhausted");
    });

    it("DEFAULT_ESCALATION_CHAIN 은 gpt-6-astra → 최신 Fable 별칭 2단계 순", () => {
      assert.equal(DEFAULT_ESCALATION_CHAIN.length, 2);
      const [s1, s2] = DEFAULT_ESCALATION_CHAIN;

      assert.equal(s1.cli, "codex");
      assert.equal(s1.model, "gpt-6-astra");
      assert.equal(s1.profile, "gpt6_astra_max");

      assert.equal(s2.cli, "claude");
      assert.equal(s2.model, "fable");
      assert.equal(s2.profile, undefined);
    });

    it("TFX_ESCALATION_CLAUDE_MODEL은 프로젝트 override가 없을 때 기본 Claude 모델을 대체한다", () => {
      const sm = createRetryStateMachine({
        mode: "auto-escalate",
        env: { TFX_ESCALATION_CLAUDE_MODEL: "claude-opus-5" },
      });

      assert.equal(sm.getCurrent().cliChain[1].model, "claude-opus-5");
    });

    it("custom cliChain 의 optional profile 필드를 보존한다", () => {
      const chain = [
        { cli: "codex", model: "gpt-5.5", profile: "gpt55_xhigh" },
        { cli: "claude", model: "opus" },
      ];
      const sm = createRetryStateMachine({
        mode: "auto-escalate",
        cliChain: chain,
      });

      const cur = sm.getCurrent();
      assert.deepEqual(cur.cliChain, chain);

      const restored = createRetryStateMachine({ mode: "auto-escalate" });
      restored.applySnapshot(sm.serialize());
      assert.deepEqual(restored.getCurrent().cliChain, chain);
    });

    it("custom Codex ultra retry profile은 Astra max로 정규화한다", () => {
      const sm = createRetryStateMachine({
        mode: "auto-escalate",
        cliChain: [
          {
            cli: "codex",
            model: "gpt-6-astra",
            profile: "gpt6_astra_ultra",
          },
          { cli: "claude", model: "opus" },
        ],
      });

      assert.equal(sm.getCurrent().cliChain[0].profile, "gpt6_astra_max");
    });

    it("옛 Sol profile 이름 세 개를 Astra profile로 정규화한다", () => {
      const aliases = [
        ["gpt56_sol_xhigh", "gpt6_astra_xhigh"],
        ["gpt56_sol_max", "gpt6_astra_max"],
        ["gpt56_sol_ultra", "gpt6_astra_max"],
      ];

      for (const [legacy, canonical] of aliases) {
        const sm = createRetryStateMachine({
          mode: "auto-escalate",
          cliChain: [
            { cli: "codex", model: "gpt-6-astra", profile: legacy },
            { cli: "claude", model: "fable" },
          ],
        });
        assert.equal(sm.getCurrent().cliChain[0].profile, canonical);
      }
    });

    it("옛 GPT-5.6 스냅샷은 profile과 model을 함께 GPT-6 값으로 맞춘다", () => {
      const cases = [
        ["gpt-5.6-terra", "gpt56_terra_high", "gpt6_sol_high", "gpt-6-sol"],
        ["gpt-5.6-terra", "gpt56_terra_med", "gpt6_sol_med", "gpt-6-sol"],
        ["gpt-5.6-luna", "gpt56_luna_low", "gpt6_luna_low", "gpt-6-luna"],
        ["gpt-5.6-sol", "gpt56_sol_max", "gpt6_astra_max", "gpt-6-astra"],
      ];

      for (const [legacyModel, legacyProfile, profile, model] of cases) {
        const sm = createRetryStateMachine({
          mode: "auto-escalate",
          cliChain: [
            { cli: "codex", model: legacyModel, profile: legacyProfile },
            { cli: "claude", model: "fable" },
          ],
        });
        const [step] = sm.getCurrent().cliChain;
        assert.equal(step.profile, profile);
        assert.equal(step.model, model);
      }
    });

    it("canonical profile은 사용자가 지정한 model을 바꾸지 않는다", () => {
      const sm = createRetryStateMachine({
        mode: "auto-escalate",
        cliChain: [
          { cli: "codex", model: "custom-model", profile: "gpt6_sol_high" },
          { cli: "claude", model: "fable" },
        ],
      });
      assert.equal(sm.getCurrent().cliChain[0].model, "custom-model");
    });

    it(".triflux/config/escalation-chain.json의 옛 Sol profile을 정규화한다", () => {
      const dir = makeTempDir();
      const configDir = join(dir, ".triflux", "config");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "escalation-chain.json"),
        JSON.stringify({
          version: 1,
          chain: [
            {
              cli: "codex",
              model: "gpt-6-astra",
              profile: "gpt56_sol_xhigh",
            },
            {
              cli: "codex",
              model: "gpt-6-astra",
              profile: "gpt56_sol_max",
            },
            {
              cli: "codex",
              model: "gpt-6-astra",
              profile: "gpt56_sol_ultra",
            },
            { cli: "claude", model: "opus" },
          ],
        }),
      );

      const sm = createRetryStateMachine({
        mode: "auto-escalate",
        projectRoot: dir,
        env: { TFX_ESCALATION_CLAUDE_MODEL: "claude-opus-5" },
      });
      assert.deepEqual(sm.getCurrent().cliChain, [
        {
          cli: "codex",
          model: "gpt-6-astra",
          profile: "gpt6_astra_xhigh",
        },
        {
          cli: "codex",
          model: "gpt-6-astra",
          profile: "gpt6_astra_max",
        },
        {
          cli: "codex",
          model: "gpt-6-astra",
          profile: "gpt6_astra_max",
        },
        { cli: "claude", model: "opus" },
      ]);
    });

    it("malformed escalation-chain override 는 problem/cause/fix 에러로 실패한다", () => {
      const dir = makeTempDir();
      const configDir = join(dir, ".triflux", "config");
      const configPath = join(configDir, "escalation-chain.json");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, '{"version":1,"chain":[', "utf8");

      assert.throws(
        () =>
          createRetryStateMachine({
            mode: "auto-escalate",
            projectRoot: dir,
          }),
        (err) => {
          assert.match(err.message, /escalation-chain override 파싱 실패/u);
          assert.match(err.message, new RegExp(configPath));
          assert.match(err.message, /원인:/u);
          assert.match(
            err.message,
            /수정: JSON 문법 확인 또는 파일 삭제로 DEFAULT_ESCALATION_CHAIN 사용/u,
          );
          return true;
        },
      );
    });
  });

  describe("compaction survival — stateFile persist / resume", () => {
    it("stateFile 에 transition 이 jsonl 로 append 된다", () => {
      const dir = makeTempDir();
      const stateFile = join(dir, "ralph.jsonl");
      const sm = createRetryStateMachine({
        mode: "ralph",
        maxIterations: 3,
        stateFile,
      });
      sm.startIteration();
      sm.reportVerifyFail("reason-x");

      const raw = readFileSync(stateFile, "utf8");
      const lines = raw.trim().split("\n");
      assert.equal(lines.length, 2); // EXECUTING + DIAGNOSING
      const last = JSON.parse(lines[1]);
      assert.equal(last.to, STATES.DIAGNOSING);
      assert.equal(last.reason, "reason-x");
    });

    it("resumeFromStateFile 은 마지막 transition 을 복원", () => {
      const dir = makeTempDir();
      const stateFile = join(dir, "ralph.jsonl");
      const sm = createRetryStateMachine({
        mode: "ralph",
        maxIterations: 3,
        stateFile,
      });
      sm.startIteration();
      sm.reportVerifyFail("only");

      const last = resumeFromStateFile(stateFile);
      assert.equal(last.to, STATES.DIAGNOSING);
      assert.equal(last.iteration, 1);
    });

    it("존재하지 않는 stateFile 은 null 반환", () => {
      const dir = makeTempDir();
      const last = resumeFromStateFile(join(dir, "never-exists.jsonl"));
      assert.equal(last, null);
    });
  });

  describe("full-snapshot serialize / applySnapshot — Phase 3 Step C2", () => {
    it("serialize 결과를 새 SM 에 applySnapshot 하면 state 가 복원됨", () => {
      const sm1 = createRetryStateMachine({
        mode: "auto-escalate",
        maxIterations: 3,
        cliChain: [
          { cli: "a", model: "1" },
          { cli: "b", model: "2" },
        ],
      });
      // A 단계 2회 fail
      sm1.startIteration();
      sm1.reportVerifyFail("boom");
      sm1.startIteration();
      sm1.reportVerifyFail("boom");

      const snap = sm1.serialize();
      assert.equal(snap.version, 1);
      assert.equal(snap.stuckCounter, 2);
      assert.equal(snap.lastFailureReason, "boom");

      const sm2 = createRetryStateMachine({ mode: "auto-escalate" });
      sm2.applySnapshot(snap);
      const cur = sm2.getCurrent();
      assert.equal(cur.current, snap.current);
      assert.equal(cur.iterations, snap.iterations);
      assert.equal(cur.stuckCounter, 2);
      assert.equal(cur.lastFailureReason, "boom");
      assert.equal(cur.cliIndex, snap.cliIndex);
    });

    it("saveSnapshot + loadSnapshot 으로 round-trip 성공", () => {
      const dir = makeTempDir();
      const file = join(dir, "snap.json");
      const sm = createRetryStateMachine({
        mode: "ralph",
        maxIterations: 5,
      });
      sm.startIteration();
      sm.reportVerifyFail("r1");
      saveSnapshot(file, sm.serialize());

      const loaded = loadSnapshot(file);
      assert.equal(loaded.version, 1);
      assert.equal(loaded.mode, "ralph");
      assert.equal(loaded.current, STATES.DIAGNOSING);
    });

    it("loadSnapshot은 옛 Codex profile을 applySnapshot과 같은 값으로 정규화한다", () => {
      const dir = makeTempDir();
      const file = join(dir, "legacy-profiles.json");
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          current: STATES.EXECUTING,
          iterations: 1,
          maxIterations: 3,
          stuckCounter: 0,
          lastFailureReason: null,
          cliIndex: 0,
          cliChain: [
            { cli: "codex", model: "gpt-6-astra", profile: "gpt56_sol_xhigh" },
            { cli: "codex", model: "gpt-6-astra", profile: "gpt56_sol_max" },
            { cli: "codex", model: "gpt-6-astra", profile: "gpt56_sol_ultra" },
          ],
          mode: "auto-escalate",
          sessionId: null,
          history: [],
        }),
        "utf8",
      );

      const loaded = loadSnapshot(file);
      assert.deepEqual(
        loaded.cliChain.map((entry) => entry.profile),
        ["gpt6_astra_xhigh", "gpt6_astra_max", "gpt6_astra_max"],
      );

      const restored = createRetryStateMachine({ mode: "auto-escalate" });
      restored.applySnapshot(loaded);
      assert.deepEqual(restored.getCurrent().cliChain, loaded.cliChain);
    });

    it("loadSnapshot 존재하지 않는 파일은 null", () => {
      const dir = makeTempDir();
      assert.equal(loadSnapshot(join(dir, "none.json")), null);
    });

    it("loadSnapshot 지원 안 하는 version 은 throw", () => {
      const dir = makeTempDir();
      const file = join(dir, "bad.json");
      saveSnapshot(file, { version: 99, current: "X" });
      assert.throws(() => loadSnapshot(file), /unsupported snapshot version/);
    });
  });
});
