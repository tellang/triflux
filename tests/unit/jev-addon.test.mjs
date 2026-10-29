import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readTailSafe } from "../../hub/bridge.mjs";
import {
  isJevEnabled,
  judgeBusyAction,
  judgeHandoffQuality,
  judgePeerConvergence,
  judgeSameFailureCause,
  judgeWorkerHealth,
  queryJev,
} from "../../hub/lib/jev-addon.mjs";
import { processHandoffWithJev } from "../../hub/team/handoff.mjs";
import { createRetryStateMachine } from "../../hub/team/retry-state-machine.mjs";

describe("jev-addon: opt-in 및 fail-open 검증", () => {
  it("API 키와 CLI가 모두 없으면 isJevEnabled가 false이고 모든 판단 함수가 즉시 null을 반환한다", async () => {
    const emptyEnv = { PATH: "" };
    assert.equal(isJevEnabled(emptyEnv), false);

    assert.equal(
      await judgeSameFailureCause("err A", "err B", { env: emptyEnv }),
      null,
    );
    assert.equal(
      await judgeHandoffQuality(
        { rawText: "done", handoff: { status: "ok", summary: "ok" } },
        { env: emptyEnv },
      ),
      null,
    );
    assert.equal(
      await judgePeerConvergence(
        {
          seed: "topic",
          previousResponse: "plan A",
          currentResponse: "plan A agreed",
          hopIndex: 2,
          participantsCount: 2,
        },
        { env: emptyEnv },
      ),
      null,
    );
    assert.equal(
      await judgeBusyAction(
        { prompt: "잠깐 멈추고 방향 바꿔" },
        { env: emptyEnv },
      ),
      null,
    );
    assert.equal(
      await judgeWorkerHealth(
        { stdoutTail: "Proceed? [y/N]", elapsedSec: 90 },
        { env: emptyEnv },
      ),
      null,
    );
  });

  it("TFX_JEV=0 이면 키가 있어도 비활성화된다", () => {
    assert.equal(
      isJevEnabled({ TFX_JEV: "0", JEV_API_KEY: "test-key" }),
      false,
    );
    assert.equal(isJevEnabled({ TFX_JEV: "1", JEV_API_KEY: "test-key" }), true);
  });

  it("인자 없는 기본 호출에서 process.env의 JEV_API_KEY를 정상 감지한다", () => {
    const prevKey = process.env.JEV_API_KEY;
    const prevFlag = process.env.TFX_JEV;
    try {
      process.env.JEV_API_KEY = "sk-env-default-test";
      delete process.env.TFX_JEV;
      assert.equal(isJevEnabled(), true);
      assert.equal(isJevEnabled({ minConfidence: 0.8 }), true);
    } finally {
      if (prevKey === undefined) delete process.env.JEV_API_KEY;
      else process.env.JEV_API_KEY = prevKey;
      if (prevFlag === undefined) delete process.env.TFX_JEV;
      else process.env.TFX_JEV = prevFlag;
    }
  });

  it("신뢰도가 누락, 비수치, 범위 밖이거나 임계값보다 낮거나 오류가 나면 null로 폴백한다 (fail-open)", async () => {
    const resLow = await judgeSameFailureCause("err A", "err B", {
      minConfidence: 0.7,
      client: async () => ({ answer: true, confidence: 0.4 }),
    });
    assert.equal(resLow, null);

    for (const badConf of [
      undefined,
      null,
      "",
      "1",
      "invalid",
      true,
      false,
      [1],
      [],
      {},
      -0.1,
      1.2,
      NaN,
      Infinity,
    ]) {
      const resBad = await judgeSameFailureCause("err A", "err B", {
        client: async () => ({ answer: true, confidence: badConf }),
      });
      assert.equal(resBad, null);
    }

    const resBadHttp = await judgeWorkerHealth(
      { stdoutTail: "worker output" },
      {
        env: { JEV_API_KEY: "dummy" },
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({ choice: "looping_error", confidence: [1] }),
        }),
      },
    );
    assert.equal(resBadHttp, null);

    const resErr = await judgeSameFailureCause("err A", "err B", {
      client: async () => {
        throw new Error("network timeout");
      },
    });
    assert.equal(resErr, null);
  });

  it("HTTP fetchImpl과 CLI execFileImpl 경로를 모두 지원한다", async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ choice: "steer", confidence: 0.91 }),
    });
    const httpRes = await queryJev(
      { kind: "choice", query: "끼어들지 판단", options: ["steer", "wait"] },
      {
        env: { JEV_API_KEY: "sk-test" },
        fetchImpl: mockFetch,
      },
    );
    assert.deepEqual(httpRes, {
      choice: "steer",
      confidence: 0.91,
    });

    const mockExecFile = async () => ({
      stdout: JSON.stringify({ answer: true, confidence: 0.88 }),
      stderr: "",
    });
    const cliRes = await queryJev(
      { kind: "noul", query: "같은 원인인지 판단" },
      {
        env: { TFX_JEV: "1", TFX_JEV_CLI: "/usr/local/bin/jev" },
        execFileImpl: mockExecFile,
      },
    );
    assert.deepEqual(cliRes, {
      value: true,
      confidence: 0.88,
    });

    const systemOneNoul = await queryJev(
      { kind: "noul", query: "동일 원인 여부", context: "err1 vs err2" },
      {
        env: { TYPESAFE_API_KEY: "sk-typesafe" },
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({
            model: "typesafe/jev-1.13",
            answers: { q: { type: "noul", noul: 0.96 } },
          }),
        }),
      },
    );
    assert.deepEqual(systemOneNoul, { value: true, confidence: 0.96 });

    const systemOneChoice = await queryJev(
      {
        kind: "choice",
        query: "끼어들기 판단",
        options: ["steer", "wait"],
        context: "busy thread",
      },
      {
        env: { TYPESAFE_API_KEY: "sk-typesafe" },
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({
            model: "jev-latest",
            answers: {
              q: {
                type: "choice",
                choice: "steer",
                probabilities: { steer: 0.92, wait: 0.08 },
                confidence: 0.89,
              },
            },
          }),
        }),
      },
    );
    assert.deepEqual(systemOneChoice, { choice: "steer", confidence: 0.89 });
  });
});

describe("jev-addon: 5대 훅 도메인 동작 검증", () => {
  it("Hook 1: retry-state-machine reportVerifyFailAsync가 다른 문구의 같은 원인을 stuckCounter에 누적한다", async () => {
    const sm = createRetryStateMachine({ maxIterations: 5 });
    sm.startIteration();
    await sm.reportVerifyFailAsync(
      "TypeError: Cannot read properties of undefined (reading 'id')",
      {
        client: async () => ({ answer: true, confidence: 0.95 }),
      },
    );
    assert.equal(sm.serialize().stuckCounter, 1);

    sm.startIteration();
    await sm.reportVerifyFailAsync(
      "UnhandledRejection: user.id is undefined at auth.mjs:42",
      {
        client: async () => ({ answer: true, confidence: 0.92 }),
      },
    );
    assert.equal(sm.serialize().stuckCounter, 2);
  });

  it("Hook 2: processHandoffWithJev가 부실한 완료 보고를 needs_read 또는 retry로 보정한다", async () => {
    const rawText = [
      "수정을 마쳤습니다.",
      "--- HANDOFF ---",
      "status: ok",
      "lead_action: accept",
      "verdict: 모든 테스트 통과 및 구현 완료",
      "files_changed:",
      "  - hub/index.mjs",
    ].join("\n");

    const needsRead = await processHandoffWithJev(
      rawText,
      { exitCode: 0, gitDiffFiles: ["hub/index.mjs"] },
      {
        client: async () => ({ choice: "needs_read", confidence: 0.89 }),
      },
    );
    assert.equal(needsRead.handoff.lead_action, "needs_read");
    assert.equal(needsRead.handoff._jev.lead_action, "needs_read");

    const retryVerdict = await processHandoffWithJev(
      rawText,
      { exitCode: 0, gitDiffFiles: ["hub/index.mjs"] },
      {
        client: async () => ({ choice: "retry", confidence: 0.93 }),
      },
    );
    assert.equal(retryVerdict.handoff.status, "partial");
    assert.equal(retryVerdict.handoff.lead_action, "retry");

    const emptyFilesText = [
      "조사만 마쳤습니다.",
      "--- HANDOFF ---",
      "status: ok",
      "lead_action: accept",
      "verdict: 조사 완료",
      "files_changed: none",
    ].join("\n");
    const blockedAccept = await processHandoffWithJev(
      emptyFilesText,
      { exitCode: 0, gitDiffFiles: [] },
      {
        client: async () => ({ choice: "accept", confidence: 0.98 }),
      },
    );
    assert.equal(blockedAccept.handoff.lead_action, "needs_read");

    const blockedEmptyDiff = await processHandoffWithJev(
      rawText,
      { exitCode: 0, gitDiffFiles: [] },
      {
        client: async () => ({ choice: "accept", confidence: 0.98 }),
      },
    );
    assert.equal(blockedEmptyDiff.handoff.lead_action, "needs_read");
  });

  it("Hook 3: judgePeerConvergence가 합의 수렴 여부를 판정한다", async () => {
    const res = await judgePeerConvergence(
      {
        seed: "API 캐시 전략",
        mode: "consensus",
        previousResponse:
          "Redis TTL 60초와 stale-while-revalidate 조합을 제안합니다.",
        currentResponse:
          "동의합니다. 추가 이견 없이 Redis TTL 60초 + SWR로 확정합시다.",
        hopIndex: 2,
        participantsCount: 2,
      },
      {
        client: async () => ({ output: true, confidence: 0.94 }),
      },
    );
    assert.equal(res?.converged, true);
    assert.equal(res?.confidence, 0.94);
  });

  it("Hook 4: judgeBusyAction이 긴급 방향 수정 프롬프트를 steer로 분류한다", async () => {
    const res = await judgeBusyAction(
      {
        prompt:
          "잠깐 멈추고 DB 스키마를 PostgreSQL 대신 SQLite로 바꿔서 작업해",
        threadSummary: "현재 PostgreSQL 마이그레이션 파일 작성 중",
      },
      {
        client: async () => ({ output: "steer", confidence: 0.91 }),
      },
    );
    assert.equal(res?.action, "steer");
  });

  it("Hook 5: judgeWorkerHealth가 대화형 프롬프트 대기를 waiting_input으로 판정하고 readTailSafe가 파일 끝 바이트만 읽는다", async () => {
    const res = await judgeWorkerHealth(
      {
        stdoutTail: "? Overwrite existing configuration file? (y/N)",
        stderrTail: "",
        elapsedSec: 120,
      },
      {
        client: async () => ({ choice: "waiting_input", confidence: 0.96 }),
      },
    );
    assert.equal(res?.status, "waiting_input");

    const dir = mkdtempSync(join(tmpdir(), "jev-tail-"));
    try {
      const logFile = join(dir, 'strange"name.log');
      writeFileSync(logFile, `${"A".repeat(5000)}TAIL_MARKER_END`, "utf8");
      const tail = readTailSafe(logFile, 64);
      assert.equal(tail.length, 64);
      assert.equal(tail.endsWith("TAIL_MARKER_END"), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
