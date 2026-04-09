import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getUpstreamResults,
  resolveRoutingStrategy,
  updateTaskResult,
} from "../../hub/team/routing.mjs";

describe("dagContext in resolveRoutingStrategy", () => {
  it("DS-01: dagContext가 반환값에 포함된다", () => {
    const result = resolveRoutingStrategy({
      subtasks: [
        { id: "1", agent: "codex", complexity: "M" },
        { id: "2", agent: "codex", complexity: "M" },
        { id: "3", agent: "codex", complexity: "M", depends_on: ["1", "2"] },
      ],
      graph_type: "DAG",
      thorough: false,
    });
    assert.ok(result.dagContext, "dagContext가 존재해야 한다");
    assert.equal(result.dagContext.dag_width, 2);
    assert.equal(result.dagContext.max_complexity, "M");
  });

  it("DS-02: dagContext.levels가 레벨별 태스크 배열을 포함한다", () => {
    const result = resolveRoutingStrategy({
      subtasks: [
        { id: "a", agent: "codex", complexity: "S" },
        { id: "b", agent: "codex", complexity: "S" },
        { id: "c", agent: "codex", complexity: "S", depends_on: ["a", "b"] },
      ],
      graph_type: "DAG",
      thorough: false,
    });
    const { levels } = result.dagContext;
    assert.deepEqual(levels[0].sort(), ["a", "b"]);
    assert.deepEqual(levels[1], ["c"]);
  });

  it("DS-03: dagContext.edges가 의존성 간선을 포함한다", () => {
    const result = resolveRoutingStrategy({
      subtasks: [
        { id: "x", agent: "codex", complexity: "M" },
        { id: "y", agent: "codex", complexity: "M", depends_on: ["x"] },
      ],
      graph_type: "DAG",
      thorough: false,
    });
    assert.deepEqual(result.dagContext.edges, [{ from: "x", to: "y" }]);
  });

  it("DS-04: INDEPENDENT 그래프는 단일 레벨 + 빈 edges", () => {
    const result = resolveRoutingStrategy({
      subtasks: [
        { id: "1", agent: "codex", complexity: "S" },
        { id: "2", agent: "gemini", complexity: "S" },
      ],
      graph_type: "INDEPENDENT",
      thorough: false,
    });
    assert.deepEqual(result.dagContext.levels, { 0: ["1", "2"] });
    assert.deepEqual(result.dagContext.edges, []);
  });

  it("DS-05: SEQUENTIAL 그래프는 순차 레벨 + 체인 edges", () => {
    const result = resolveRoutingStrategy({
      subtasks: [
        { id: "a", agent: "codex", complexity: "M" },
        { id: "b", agent: "codex", complexity: "M" },
        { id: "c", agent: "codex", complexity: "M" },
      ],
      graph_type: "SEQUENTIAL",
      thorough: false,
    });
    assert.deepEqual(result.dagContext.levels, {
      0: ["a"],
      1: ["b"],
      2: ["c"],
    });
    assert.deepEqual(result.dagContext.edges, [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ]);
  });

  it("DS-06: 빈 subtasks → dagContext가 빈 구조체", () => {
    const result = resolveRoutingStrategy({
      subtasks: [],
      graph_type: "DAG",
      thorough: false,
    });
    assert.deepEqual(result.dagContext, {
      dag_width: 0,
      levels: {},
      edges: [],
      max_complexity: "S",
      taskResults: {},
    });
  });

  it("DS-07: taskResults 초기값은 빈 객체", () => {
    const result = resolveRoutingStrategy({
      subtasks: [{ id: "1", agent: "codex", complexity: "S" }],
      graph_type: "INDEPENDENT",
      thorough: false,
    });
    assert.deepEqual(result.dagContext.taskResults, {});
  });
});

describe("getUpstreamResults", () => {
  it("DS-08: 선행 태스크 결과를 올바르게 반환한다", () => {
    const state = {
      dagContext: {
        edges: [
          { from: "1", to: "3" },
          { from: "2", to: "3" },
        ],
        taskResults: { 1: { output: "result-1" }, 2: { output: "result-2" } },
      },
    };
    const upstream = getUpstreamResults("3", state);
    assert.deepEqual(upstream, {
      1: { output: "result-1" },
      2: { output: "result-2" },
    });
  });

  it("DS-09: 선행 결과가 아직 없으면 빈 객체 반환", () => {
    const state = {
      dagContext: {
        edges: [{ from: "1", to: "2" }],
        taskResults: {},
      },
    };
    const upstream = getUpstreamResults("2", state);
    assert.deepEqual(upstream, {});
  });

  it("DS-10: dagContext가 없으면 빈 객체 반환", () => {
    assert.deepEqual(getUpstreamResults("1", {}), {});
    assert.deepEqual(getUpstreamResults("1", null), {});
  });

  it("DS-11: 의존성이 없는 루트 태스크는 빈 객체 반환", () => {
    const state = {
      dagContext: {
        edges: [{ from: "1", to: "2" }],
        taskResults: { 1: "done" },
      },
    };
    assert.deepEqual(getUpstreamResults("1", state), {});
  });
});

describe("updateTaskResult", () => {
  it("DS-12: 태스크 결과를 dagContext에 기록한다", () => {
    const state = {
      dagContext: { edges: [], taskResults: {} },
    };
    const ok = updateTaskResult("1", { summary: "done" }, state);
    assert.equal(ok, true);
    assert.deepEqual(state.dagContext.taskResults["1"], { summary: "done" });
  });

  it("DS-13: dagContext가 없으면 false 반환", () => {
    assert.equal(updateTaskResult("1", "x", {}), false);
    assert.equal(updateTaskResult("1", "x", null), false);
  });

  it("DS-14: taskResults가 없으면 자동 초기화 후 기록", () => {
    const state = { dagContext: { edges: [] } };
    const ok = updateTaskResult("1", 42, state);
    assert.equal(ok, true);
    assert.equal(state.dagContext.taskResults["1"], 42);
  });
});

describe("순환 의존 방어 (dagContext)", () => {
  it("DS-15: 순환 의존 시 무한 재귀 없이 dagContext 반환", () => {
    const result = resolveRoutingStrategy({
      subtasks: [
        { id: "a", agent: "codex", complexity: "M", depends_on: ["b"] },
        { id: "b", agent: "codex", complexity: "M", depends_on: ["a"] },
      ],
      graph_type: "DAG",
      thorough: false,
    });
    assert.ok(result.dagContext, "dagContext가 존재해야 한다");
    assert.ok(typeof result.dagContext.dag_width === "number");
    assert.ok(Array.isArray(result.dagContext.edges));
    // 순환 간선도 기록됨
    assert.equal(result.dagContext.edges.length, 2);
  });
});
