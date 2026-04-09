import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  buildHybridWrapperPrompt,
  buildScoutDispatchPrompt,
  buildSlimWrapperAgent,
  buildSlimWrapperPrompt,
  formatPollReport,
  pollTeamResults,
  SCOUT_ROLE_CONFIG,
  SLIM_WRAPPER_SUBAGENT_TYPE,
  verifySlimWrapperRouteExecution,
} from "../../hub/team/native.mjs";

describe("hub/team/native.mjs — route env prefix", () => {
  it("슬림 래퍼는 agentName 끝 숫자에서 TFX_WORKER_INDEX를 추론해야 한다", () => {
    const prompt = buildSlimWrapperPrompt("codex", {
      subtask: "quota strategy",
      agentName: "codex-2",
      mcp_profile: "analyze",
    });

    assert.match(prompt, /TFX_WORKER_INDEX="2"/);
    assert.match(prompt, /subagent_type="slim-wrapper"/);
    // v2.3: Bash 완료 후 TaskUpdate + SendMessage로 Claude Code 태스크 동기화
    assert.match(prompt, /TaskUpdate\(taskId:/);
    assert.match(prompt, /SendMessage\(type: "message"/);
    assert.match(
      prompt,
      /허용 도구: Bash, TaskUpdate, TaskGet, TaskList, SendMessage만 사용한다/,
    );
  });

  it("하이브리드 래퍼는 명시적 workerIndex와 searchTool을 함께 주입해야 한다", () => {
    const prompt = buildHybridWrapperPrompt("codex", {
      subtask: "quota strategy",
      agentName: "codex-worker",
      workerIndex: 3,
      searchTool: "exa",
      mcp_profile: "analyze",
    });

    assert.match(prompt, /TFX_WORKER_INDEX="3"/);
    assert.match(prompt, /TFX_SEARCH_TOOL="exa"/);
  });

  it("슬림 래퍼 agent spec은 slim-wrapper subagent_type을 명시해야 한다", () => {
    const worker = buildSlimWrapperAgent("codex", {
      subtask: "quota strategy",
      agentName: "codex-2",
    });

    assert.equal(worker.cli, "codex");
    assert.equal(worker.name, "codex-2");
    assert.equal(worker.subagent_type, SLIM_WRAPPER_SUBAGENT_TYPE);
    assert.match(worker.prompt, /subagent_type="slim-wrapper"/);
  });
});

describe("hub/team/native.mjs — slim wrapper route verification", () => {
  it("tfx-route stderr prefix가 있으면 정상 경유로 판정해야 한다", () => {
    const result = verifySlimWrapperRouteExecution({
      promptText: buildSlimWrapperPrompt("codex", {
        subtask: "quota strategy",
      }),
      stderrText: "[tfx-route] v2.3 type=codex agent=executor",
    });

    assert.equal(result.expectedRouteInvocation, true);
    assert.equal(result.usedRoute, true);
    assert.equal(result.abnormal, false);
  });

  it("route prompt인데 로그에 tfx-route 증거가 없으면 비정상 완료로 판정해야 한다", () => {
    const result = verifySlimWrapperRouteExecution({
      promptText: buildSlimWrapperPrompt("codex", {
        subtask: "quota strategy",
      }),
      stdoutText: "Used Read and Edit directly",
      stderrText: "",
    });

    assert.equal(result.expectedRouteInvocation, true);
    assert.equal(result.usedRoute, false);
    assert.equal(result.abnormal, true);
    assert.equal(result.reason, "missing_tfx_route_evidence");
  });

  it("route prompt가 아니면 검증을 강제하지 않아야 한다", () => {
    const result = verifySlimWrapperRouteExecution({
      promptText: "plain worker prompt",
      stdoutText: "normal output",
    });

    assert.equal(result.expectedRouteInvocation, false);
    assert.equal(result.abnormal, false);
  });
});

describe("hub/team/native.mjs — result polling", () => {
  it("결과 디렉터리가 없어도 expectedTaskIds를 pending으로 반환해야 한다", async () => {
    const teamName = `poll-missing-${randomUUID()}`;
    const result = await pollTeamResults(teamName, ["worker-1", "worker-2"]);

    assert.deepEqual(result, {
      completed: [],
      pending: ["worker-1", "worker-2"],
    });
  });

  it("존재하는 결과 파일만 완료로 집계하고 summary/result를 파싱해야 한다", async () => {
    const teamName = `poll-${randomUUID()}`;
    const resultDir = path.join(
      os.homedir(),
      ".claude",
      "tfx-results",
      teamName,
    );

    await fs.mkdir(resultDir, { recursive: true });
    await fs.writeFile(
      path.join(resultDir, "worker-1.json"),
      JSON.stringify({
        taskId: "worker-1",
        result: "success",
        summary: "초안 완료",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(resultDir, "worker-3.json"),
      JSON.stringify({
        taskId: "worker-3",
        result: "timeout",
        summary: "시간 초과",
      }),
      "utf8",
    );

    try {
      const result = await pollTeamResults(teamName, [
        "worker-1",
        "worker-2",
        "worker-3",
      ]);

      assert.deepEqual(result, {
        completed: [
          { taskId: "worker-1", result: "success", summary: "초안 완료" },
          { taskId: "worker-3", result: "timeout", summary: "시간 초과" },
        ],
        pending: ["worker-2"],
      });
      assert.equal(
        formatPollReport(result),
        "2/3 완료 (worker-1 success, worker-3 timeout)",
      );
    } finally {
      await fs.rm(resultDir, { recursive: true, force: true });
    }
  });
});

describe("hub/team/native.mjs — scout role (이슈 4)", () => {
  it('T4-01: scout 역할 프롬프트가 "탐색" 키워드를 포함해야 한다', () => {
    const prompt = buildSlimWrapperPrompt("codex", {
      subtask: "scout test",
      role: "scientist",
    });
    assert.match(prompt, /탐색/u);
  });

  it("T4-02: scout 역할 프롬프트가 코드 수정 금지를 포함해야 한다", () => {
    const prompt = buildSlimWrapperPrompt("codex", {
      subtask: "scout test",
      role: "scientist",
    });
    assert.match(prompt, /수정.*(금지|마라)/u);
  });

  it("T4-03: SCOUT_ROLE_CONFIG.maxIterations 기본값이 2여야 한다", () => {
    assert.equal(SCOUT_ROLE_CONFIG.maxIterations, 2);
  });

  it("T4-04: SCOUT_ROLE_CONFIG.readOnly가 true여야 한다", () => {
    assert.equal(SCOUT_ROLE_CONFIG.readOnly, true);
  });

  it("T4-05: buildScoutDispatchPrompt()가 scientist 역할로 프롬프트를 생성해야 한다", () => {
    const prompt = buildScoutDispatchPrompt({
      question: "DB 스키마 조사",
      scope: "db/",
    });
    assert.match(prompt, /scientist|탐색/u);
    assert.match(prompt, /DB 스키마 조사/u);
    assert.match(prompt, /db\//u);
  });

  it("T4-06: buildScoutDispatchPrompt()의 maxIterations가 SCOUT_ROLE_CONFIG에서 오는지 확인", () => {
    const prompt = buildScoutDispatchPrompt({ question: "test" });
    assert.match(prompt, /MAX_ITERATIONS = 2/u);
  });
});

describe("hub/team/native.mjs — feedback loop (이슈 8)", () => {
  const prompt = buildSlimWrapperPrompt("codex", {
    subtask: "feedback loop test",
    agentName: "codex-1",
    taskId: "task-fb-01",
    leadName: "team-lead",
  });

  it('T8-01: 프롬프트에 "즉시 종료" 문구가 없어야 한다', () => {
    assert.doesNotMatch(prompt, /즉시 종료/);
  });

  it("T8-02: Step 0 시작 보고 (턴 경계)가 포함되어야 한다", () => {
    assert.match(prompt, /Step 0.*시작 보고/);
    assert.match(prompt, /TaskUpdate.*in_progress/);
    assert.match(prompt, /SendMessage.*작업 시작/);
  });

  it("T8-03: Step 5 피드백 대기가 포함되어야 한다", () => {
    assert.match(prompt, /Step 5.*피드백 대기/);
    assert.match(prompt, /재실행:/);
    assert.match(prompt, /승인/);
  });

  it("T8-04: Step 4에서 TaskUpdate(completed)를 호출하지 않아야 한다", () => {
    // Step 4 텍스트를 추출 (Step 4 시작 ~ Step 5 시작 사이)
    const step4Match = prompt.match(/Step 4[^\n]*\n([\s\S]*?)(?=Step 5)/);
    assert.ok(step4Match, "Step 4 섹션이 존재해야 한다");
    const step4Text = step4Match[1];
    assert.doesNotMatch(step4Text, /TaskUpdate.*completed/);
    assert.doesNotMatch(step4Text, /status:\s*"completed"/);
  });

  it("T8-05: Step 6에서만 TaskUpdate(completed)를 호출해야 한다", () => {
    const step6Match = prompt.match(/Step 6[^\n]*\n([\s\S]*)/);
    assert.ok(step6Match, "Step 6 섹션이 존재해야 한다");
    const step6Text = step6Match[1];
    assert.match(step6Text, /TaskUpdate.*completed/);
  });

  it("T8-06: MAX_ITERATIONS 기본값 3이 포함되어야 한다", () => {
    assert.match(prompt, /MAX_ITERATIONS\s*=\s*3/);
  });

  it("T8-07: maxIterations 파라미터가 프롬프트에 반영되어야 한다", () => {
    const customPrompt = buildSlimWrapperPrompt("codex", {
      subtask: "custom iterations",
      maxIterations: 5,
    });
    assert.match(customPrompt, /MAX_ITERATIONS\s*=\s*5/);
  });

  it("T8-08: TFX_NEEDS_FALLBACK 시 Step 6 직행 지시가 있어야 한다", () => {
    assert.match(prompt, /TFX_NEEDS_FALLBACK[\s\S]*?Step 6/);
  });

  it("T8-09: ITERATION 카운터가 프롬프트에 포함되어야 한다", () => {
    assert.match(prompt, /ITERATION\s*=\s*0/);
  });

  it("T8-10: async + feedback 프로토콜 식별자가 포함되어야 한다", () => {
    assert.match(prompt, /async \+ feedback/);
  });
});

describe("hub/team/native.mjs — scout E2E integration (이슈 4)", () => {
  it("T4-E2E-01: scout dispatch 프롬프트가 tfx-route.sh scientist 호출을 포함해야 한다", () => {
    const prompt = buildScoutDispatchPrompt({
      question: "DB 마이그레이션 현황 파악",
      scope: "db/migrations/",
      teamName: "tfx-test",
      taskId: "scout-1",
      agentName: "codex-scout-1",
      leadName: "team-lead",
    });
    assert.match(prompt, /tfx-route\.sh/u);
    assert.match(prompt, /scientist/u);
    assert.match(prompt, /DB 마이그레이션 현황 파악/u);
  });

  it("T4-E2E-02: scout 프롬프트가 route verification을 통과해야 한다", () => {
    const prompt = buildScoutDispatchPrompt({ question: "API 구조 탐색" });
    const result = verifySlimWrapperRouteExecution({
      promptText: prompt,
      stdoutText: "analysis result",
      stderrText: "[tfx-route] role=scientist cli=codex",
    });
    assert.equal(result.expectedRouteInvocation, true);
    assert.equal(result.usedRoute, true);
    assert.equal(result.abnormal, false);
  });

  it("T4-E2E-03: scout 프롬프트가 direct tool bypass를 탐지해야 한다", () => {
    const prompt = buildScoutDispatchPrompt({ question: "test" });
    const result = verifySlimWrapperRouteExecution({
      promptText: prompt,
      stdoutText: 'Read(file_path="src/main.js")',
      stderrText: "",
    });
    assert.equal(result.sawDirectToolBypass, true);
    assert.equal(result.abnormal, true);
  });

  it("T4-E2E-04: scout Agent spec이 올바른 subagent_type을 포함해야 한다", () => {
    const prompt = buildScoutDispatchPrompt({
      question: "test",
      teamName: "tfx-scout-test",
      agentName: "codex-scout-1",
    });
    assert.match(
      prompt,
      new RegExp(`subagent_type="${SLIM_WRAPPER_SUBAGENT_TYPE}"`, "u"),
    );
  });
});
