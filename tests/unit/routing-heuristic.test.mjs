import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveRoutingStrategy } from "../../hub/team/routing.mjs";

describe("resolveRoutingStrategy", () => {
  it("R-01: N==1 + S 복잡도 → quick_single", () => {
    const result = resolveRoutingStrategy({
      subtasks: [{ id: "1", agent: "codex", complexity: "S" }],
      graph_type: "INDEPENDENT",
      thorough: false,
    });
    assert.equal(result.strategy, "quick_single");
  });

  it("R-02: N==1 + XL 복잡도 → thorough_single", () => {
    const result = resolveRoutingStrategy({
      subtasks: [{ id: "1", agent: "codex", complexity: "XL" }],
      graph_type: "INDEPENDENT",
      thorough: false,
    });
    assert.equal(result.strategy, "thorough_single");
  });

  it("R-03: N==1 + thorough 플래그 → thorough_single", () => {
    const result = resolveRoutingStrategy({
      subtasks: [{ id: "1", agent: "codex", complexity: "S" }],
      graph_type: "INDEPENDENT",
      thorough: true,
    });
    assert.equal(result.strategy, "thorough_single");
  });

  it("R-04: 2개 SEQUENTIAL → dag_width==1 → quick_single (순차)", () => {
    const result = resolveRoutingStrategy({
      subtasks: [
        { id: "1", agent: "codex", complexity: "M" },
        { id: "2", agent: "codex", complexity: "M", depends_on: ["1"] },
      ],
      graph_type: "SEQUENTIAL",
      thorough: false,
    });
    assert.equal(result.strategy, "quick_single");
    assert.equal(result.dag_width, 1);
  });

  it("R-05: 4개 동일 에이전트 S → batch_single", () => {
    const result = resolveRoutingStrategy({
      subtasks: [
        { id: "1", agent: "codex", complexity: "S" },
        { id: "2", agent: "codex", complexity: "S" },
        { id: "3", agent: "codex", complexity: "S" },
        { id: "4", agent: "codex", complexity: "S" },
      ],
      graph_type: "INDEPENDENT",
      thorough: false,
    });
    assert.equal(result.strategy, "batch_single");
  });

  it("R-06: 3개 INDEPENDENT + L → thorough_team", () => {
    const result = resolveRoutingStrategy({
      subtasks: [
        { id: "1", agent: "codex", complexity: "L" },
        { id: "2", agent: "gemini", complexity: "M" },
        { id: "3", agent: "codex", complexity: "S" },
      ],
      graph_type: "INDEPENDENT",
      thorough: false,
    });
    assert.equal(result.strategy, "thorough_team");
    assert.equal(result.dag_width, 3);
  });

  it("R-07: 3개 INDEPENDENT + 모두 M → quick_team", () => {
    const result = resolveRoutingStrategy({
      subtasks: [
        { id: "1", agent: "codex", complexity: "M" },
        { id: "2", agent: "gemini", complexity: "M" },
        { id: "3", agent: "codex", complexity: "M" },
      ],
      graph_type: "INDEPENDENT",
      thorough: false,
    });
    assert.equal(result.strategy, "quick_team");
  });

  it("R-08: DAG 폭 계산 — 2레벨 병렬", () => {
    const result = resolveRoutingStrategy({
      subtasks: [
        { id: "1", agent: "codex", complexity: "M" },
        { id: "2", agent: "codex", complexity: "M" },
        { id: "3", agent: "codex", complexity: "M", depends_on: ["1", "2"] },
      ],
      graph_type: "DAG",
      thorough: false,
    });
    assert.equal(result.dag_width, 2);
    assert.equal(result.strategy, "quick_team");
  });

  it("R-09: thorough 플래그 + 팀 → thorough_team", () => {
    const result = resolveRoutingStrategy({
      subtasks: [
        { id: "1", agent: "codex", complexity: "S" },
        { id: "2", agent: "gemini", complexity: "S" },
      ],
      graph_type: "INDEPENDENT",
      thorough: true,
    });
    assert.equal(result.strategy, "thorough_team");
  });

  it("R-10: max_complexity 정확히 반환", () => {
    const result = resolveRoutingStrategy({
      subtasks: [
        { id: "1", agent: "codex", complexity: "S" },
        { id: "2", agent: "codex", complexity: "L" },
      ],
      graph_type: "INDEPENDENT",
      thorough: false,
    });
    assert.equal(result.max_complexity, "L");
  });

  it("R-11: 빈 배열 → quick_single (엣지케이스)", () => {
    const result = resolveRoutingStrategy({
      subtasks: [],
      graph_type: "INDEPENDENT",
      thorough: false,
    });
    assert.equal(result.strategy, "quick_single");
    assert.equal(result.reason, "empty_subtasks");
  });

  it("R-12: 순환 의존 → 무한 재귀 없이 반환", () => {
    const result = resolveRoutingStrategy({
      subtasks: [
        { id: "1", agent: "codex", complexity: "M", depends_on: ["2"] },
        { id: "2", agent: "codex", complexity: "M", depends_on: ["1"] },
      ],
      graph_type: "DAG",
      thorough: false,
    });
    assert.ok(result.strategy, "전략이 반환되어야 한다");
    assert.ok(
      typeof result.dag_width === "number",
      "dag_width가 숫자여야 한다",
    );
  });
});
