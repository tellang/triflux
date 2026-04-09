import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMeshBudget } from "../../mesh/mesh-budget.mjs";

describe("mesh/mesh-budget.mjs", () => {
  describe("allocate()", () => {
    it("에이전트에 토큰 버짓을 할당한다", () => {
      const budget = createMeshBudget();
      budget.allocate("agent-1", 10000);
      const status = budget.getStatus("agent-1");
      assert.equal(status.allocated, 10000);
      assert.equal(status.consumed, 0);
      assert.equal(status.remaining, 10000);
    });

    it("agentId가 비어 있으면 TypeError를 던진다", () => {
      const budget = createMeshBudget();
      assert.throws(() => budget.allocate("", 1000), TypeError);
    });

    it("재할당하면 allocated를 갱신하고 consumed는 유지한다", () => {
      const budget = createMeshBudget();
      budget.allocate("agent-a", 5000);
      budget.consume("agent-a", 1000);
      budget.allocate("agent-a", 8000);
      const status = budget.getStatus("agent-a");
      assert.equal(status.allocated, 8000);
      assert.equal(status.consumed, 1000);
      assert.equal(status.remaining, 7000);
    });
  });

  describe("consume()", () => {
    it("소비 후 remaining이 줄어든다", () => {
      const budget = createMeshBudget();
      budget.allocate("agent-2", 1000);
      const result = budget.consume("agent-2", 200);
      assert.equal(result.remaining, 800);
    });

    it("사용률에 따라 percent를 반환한다", () => {
      const budget = createMeshBudget();
      budget.allocate("agent-3", 1000);
      const result = budget.consume("agent-3", 500);
      assert.equal(result.percent, 50);
    });

    it("사용률 50% 미만이면 level=ok다", () => {
      const budget = createMeshBudget();
      budget.allocate("agent-ok", 1000);
      const result = budget.consume("agent-ok", 300);
      assert.equal(result.level, "ok");
    });

    it("사용률 60%이상이면 level=info다", () => {
      const budget = createMeshBudget();
      budget.allocate("agent-info", 1000);
      const result = budget.consume("agent-info", 600);
      assert.equal(result.level, "info");
    });

    it("사용률 80%이상이면 level=warn다", () => {
      const budget = createMeshBudget();
      budget.allocate("agent-warn", 1000);
      const result = budget.consume("agent-warn", 800);
      assert.equal(result.level, "warn");
    });

    it("사용률 90%이상이면 level=critical이다", () => {
      const budget = createMeshBudget();
      budget.allocate("agent-crit", 1000);
      const result = budget.consume("agent-crit", 900);
      assert.equal(result.level, "critical");
    });

    it("remaining은 0 미만으로 내려가지 않는다", () => {
      const budget = createMeshBudget();
      budget.allocate("agent-floor", 100);
      const result = budget.consume("agent-floor", 200);
      assert.equal(result.remaining, 0);
    });

    it("버짓이 없는 에이전트에 consume하면 Error를 던진다", () => {
      const budget = createMeshBudget();
      assert.throws(() => budget.consume("no-agent", 100), Error);
    });
  });

  describe("getStatus()", () => {
    it("할당·소비·잔여·레벨을 반환한다", () => {
      const budget = createMeshBudget();
      budget.allocate("agent-s", 2000);
      budget.consume("agent-s", 400);
      const status = budget.getStatus("agent-s");
      assert.equal(status.allocated, 2000);
      assert.equal(status.consumed, 400);
      assert.equal(status.remaining, 1600);
      assert.equal(typeof status.level, "string");
    });

    it("버짓이 없는 에이전트는 기본 상태를 반환한다", () => {
      const budget = createMeshBudget();
      const status = budget.getStatus("unknown");
      assert.equal(status.allocated, 0);
      assert.equal(status.consumed, 0);
      assert.equal(status.remaining, 0);
      assert.equal(status.level, "ok");
    });
  });

  describe("resetAll()", () => {
    it("모든 에이전트의 consumed를 0으로 초기화한다", () => {
      const budget = createMeshBudget();
      budget.allocate("a1", 1000);
      budget.allocate("a2", 2000);
      budget.consume("a1", 500);
      budget.consume("a2", 1000);
      budget.resetAll();
      assert.equal(budget.getStatus("a1").consumed, 0);
      assert.equal(budget.getStatus("a2").consumed, 0);
    });

    it("resetAll 후에도 allocated는 유지된다", () => {
      const budget = createMeshBudget();
      budget.allocate("a3", 5000);
      budget.consume("a3", 2000);
      budget.resetAll();
      assert.equal(budget.getStatus("a3").allocated, 5000);
    });
  });

  describe("listAllocations()", () => {
    it("현재 모든 버짓의 스냅샷 Map을 반환한다", () => {
      const budget = createMeshBudget();
      budget.allocate("x1", 1000);
      budget.allocate("x2", 2000);
      const alloc = budget.listAllocations();
      assert.ok(alloc instanceof Map);
      assert.equal(alloc.size, 2);
      assert.equal(alloc.get("x1").allocated, 1000);
      assert.equal(alloc.get("x2").allocated, 2000);
    });

    it("반환된 Map은 내부 상태와 독립적이다 (스냅샷)", () => {
      const budget = createMeshBudget();
      budget.allocate("snap", 500);
      const snap = budget.listAllocations();
      budget.consume("snap", 100);
      // snap should not reflect the consumption
      assert.equal(snap.get("snap").consumed, 0);
    });
  });
});
