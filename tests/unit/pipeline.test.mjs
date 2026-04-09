import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import {
  createPipeline,
  ensurePipelineTable,
} from "../../hub/pipeline/index.mjs";
import { initPipelineState } from "../../hub/pipeline/state.mjs";
import { createTools } from "../../hub/tools.mjs";

// 테스트 전용 임시 디렉토리 (CWD를 오염시키지 않기 위해)
const TEST_BASE = resolve(
  import.meta.dirname,
  "..",
  "..",
  ".test-tmp-pipeline",
);

describe("pipeline.writePlanFile()", () => {
  let db;
  let origCwd;

  beforeEach(() => {
    // CWD를 임시 디렉토리로 이동
    rmSync(TEST_BASE, { recursive: true, force: true });
    mkdirSync(TEST_BASE, { recursive: true });
    origCwd = process.cwd();
    process.chdir(TEST_BASE);

    // in-memory SQLite
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
    process.chdir(origCwd);
    rmSync(TEST_BASE, { recursive: true, force: true });
  });

  it("T1-01: writePlanFile()은 .tfx/plans/{teamName}-plan.md를 생성한다", () => {
    const pipeline = createPipeline(db, "alpha");
    const content = "# Plan\n\n- step 1\n- step 2\n";

    const planPath = pipeline.writePlanFile(content);

    const expectedPath = join(
      resolve(TEST_BASE, ".tfx", "plans"),
      "alpha-plan.md",
    );
    assert.equal(planPath, expectedPath);
    assert.ok(existsSync(planPath), "plan 파일이 디스크에 존재해야 한다");
    assert.equal(readFileSync(planPath, "utf8"), content);
  });

  it('T1-02: writePlanFile()은 setArtifact("plan_path")를 동시에 호출한다', () => {
    const pipeline = createPipeline(db, "bravo");
    const content = "# Bravo Plan\n";

    const planPath = pipeline.writePlanFile(content);
    const state = pipeline.getState();

    assert.equal(state.artifacts.plan_path, planPath);
  });

  it("T1-03: 기존 plan 파일을 덮어쓰기할 수 있다", () => {
    const pipeline = createPipeline(db, "charlie");

    pipeline.writePlanFile("# v1\n");
    const path2 = pipeline.writePlanFile("# v2 — updated\n");

    assert.equal(readFileSync(path2, "utf8"), "# v2 — updated\n");
    // artifact도 최신 경로
    assert.equal(pipeline.getState().artifacts.plan_path, path2);
  });

  it('T1-04: teamName의 특수문자(<>:"/\\|?*)가 안전하게 치환된다', () => {
    const pipeline = createPipeline(db, "team<>:bad|name");
    const content = "# Special\n";

    const planPath = pipeline.writePlanFile(content);

    // 파일명에 위험 문자가 포함되지 않아야 한다
    const basename = planPath.split(/[\\/]/).pop();
    assert.equal(basename, "team___bad_name-plan.md");
    assert.ok(existsSync(planPath));
    assert.equal(readFileSync(planPath, "utf8"), content);
  });
});

describe("pipeline_advance_gated (이슈 2)", () => {
  let db;
  let pipelineAdvanceGatedTool;
  let hitlCalls;

  function parseToolResult(result) {
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text");
    return JSON.parse(result.content[0].text);
  }

  beforeEach(() => {
    db = new Database(":memory:");
    ensurePipelineTable(db);

    hitlCalls = [];
    const hitl = {
      requestHumanInput(args) {
        hitlCalls.push(args);
        return { ok: true, data: { request_id: "test-req-1" } };
      },
    };

    pipelineAdvanceGatedTool = createTools({ db }, {}, hitl, null).find(
      ({ name }) => name === "pipeline_advance_gated",
    );
  });

  afterEach(() => {
    db.close();
  });

  it("T2-01: canAdvance()가 false면 TRANSITION_BLOCKED 반환", async () => {
    initPipelineState(db, "test-team");
    const pipeline = createPipeline(db, "test-team");

    assert.equal(pipeline.canAdvance("verify"), false);

    const result = await pipelineAdvanceGatedTool.handler({
      team_name: "test-team",
      phase: "verify",
    });
    const body = parseToolResult(result);

    assert.deepEqual(body, {
      ok: false,
      error: {
        code: "TRANSITION_BLOCKED",
        message: "전이 불가: plan → verify",
      },
    });
    assert.equal(hitlCalls.length, 0);
  });

  it("T2-02: canAdvance()가 true면 전이 가능", () => {
    initPipelineState(db, "test-team");
    const pipeline = createPipeline(db, "test-team");

    assert.equal(pipeline.canAdvance("prd"), true);
  });

  it("T2-03: pipeline_advance_gated handler가 pending: true를 반환", async () => {
    const result = await pipelineAdvanceGatedTool.handler({
      team_name: "test-team",
      phase: "prd",
    });
    const body = parseToolResult(result);

    assert.equal(body.ok, true);
    assert.equal(body.data.pending, true);
    assert.equal(body.data.request_id, "test-req-1");
    assert.equal(body.data.team_name, "test-team");
    assert.equal(body.data.target_phase, "prd");
    assert.equal(body.data.current_phase, "plan");
    assert.equal(hitlCalls.length, 1);
    assert.equal(hitlCalls[0].kind, "approval");
  });

  it("T2-04: HITL 요청에 deadline_ms와 default_action이 포함되어야 한다", async () => {
    const before = Date.now();
    const result = await pipelineAdvanceGatedTool.handler({
      team_name: "test-team",
      phase: "prd",
      prompt: "승인 요청 메시지",
      deadline_ms: 5000,
      default_action: "timeout_abort",
      requester_agent: "qa-agent",
    });
    const after = Date.now();
    const body = parseToolResult(result);

    assert.equal(hitlCalls.length, 1);
    assert.equal(hitlCalls[0].requester_agent, "qa-agent");
    assert.equal(hitlCalls[0].kind, "approval");
    assert.equal(hitlCalls[0].prompt, "승인 요청 메시지");
    assert.equal(hitlCalls[0].default_action, "timeout_abort");
    assert.ok(hitlCalls[0].deadline_ms >= before + 5000);
    assert.ok(hitlCalls[0].deadline_ms <= after + 5000);
    assert.equal(body.data.deadline_ms, hitlCalls[0].deadline_ms);
    assert.equal(body.data.default_action, "timeout_abort");
    assert.match(body.data.message, /5초 후 timeout_abort 자동 실행\./);
  });

  it("T2-MCP-01: pipeline_advance_gated 도구가 createTools()에 등록되어야 한다", () => {
    assert.ok(pipelineAdvanceGatedTool);
    assert.equal(pipelineAdvanceGatedTool.name, "pipeline_advance_gated");
  });

  it("T2-MCP-02: 도구 inputSchema에 필수 필드 team_name, phase가 있어야 한다", () => {
    assert.ok(
      pipelineAdvanceGatedTool.inputSchema.required.includes("team_name"),
    );
    assert.ok(pipelineAdvanceGatedTool.inputSchema.required.includes("phase"));
    assert.ok(pipelineAdvanceGatedTool.inputSchema.properties.team_name);
    assert.ok(pipelineAdvanceGatedTool.inputSchema.properties.phase);
  });
});
