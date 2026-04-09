import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createRegistry } from "../../mesh/mesh-registry.mjs";

describe("mesh/mesh-registry.mjs", () => {
  describe("register()", () => {
    it("에이전트를 등록하고 조회할 수 있다", () => {
      const registry = createRegistry();
      registry.register("agent-1", ["read", "write"]);
      const info = registry.getAgent("agent-1");
      assert.ok(info !== null);
      assert.equal(info.agentId, "agent-1");
      assert.deepEqual([...info.capabilities], ["read", "write"]);
    });

    it("registeredAt 타임스탬프를 기록한다", () => {
      const registry = createRegistry();
      registry.register("agent-ts", []);
      const info = registry.getAgent("agent-ts");
      assert.ok(typeof info.registeredAt === "string");
    });

    it("capabilities 없이 등록할 수 있다 (빈 배열 기본값)", () => {
      const registry = createRegistry();
      registry.register("agent-empty");
      const info = registry.getAgent("agent-empty");
      assert.deepEqual([...info.capabilities], []);
    });

    it("agentId가 비어 있으면 TypeError를 던진다", () => {
      const registry = createRegistry();
      assert.throws(() => registry.register("", ["cap"]), TypeError);
    });

    it("capabilities가 배열이 아니면 TypeError를 던진다", () => {
      const registry = createRegistry();
      assert.throws(() => registry.register("a", "not-array"), TypeError);
    });

    it("동일 ID로 재등록하면 덮어쓴다", () => {
      const registry = createRegistry();
      registry.register("agent-x", ["a"]);
      registry.register("agent-x", ["b", "c"]);
      const info = registry.getAgent("agent-x");
      assert.deepEqual([...info.capabilities], ["b", "c"]);
    });

    it("반환된 AgentInfo는 동결 객체다", () => {
      const registry = createRegistry();
      registry.register("agent-frozen", ["x"]);
      const info = registry.getAgent("agent-frozen");
      assert.equal(Object.isFrozen(info), true);
    });
  });

  describe("unregister()", () => {
    it("등록된 에이전트를 제거한다", () => {
      const registry = createRegistry();
      registry.register("agent-del", ["x"]);
      registry.unregister("agent-del");
      assert.equal(registry.getAgent("agent-del"), null);
    });

    it("존재하지 않는 에이전트를 제거해도 오류가 없다", () => {
      const registry = createRegistry();
      assert.doesNotThrow(() => registry.unregister("nonexistent"));
    });
  });

  describe("discover()", () => {
    it("특정 capability를 가진 에이전트를 찾는다", () => {
      const registry = createRegistry();
      registry.register("a1", ["read", "write"]);
      registry.register("a2", ["write", "exec"]);
      registry.register("a3", ["read"]);

      const writers = registry.discover("write");
      assert.ok(writers.includes("a1"));
      assert.ok(writers.includes("a2"));
      assert.ok(!writers.includes("a3"));
    });

    it("해당 capability가 없으면 빈 배열을 반환한다", () => {
      const registry = createRegistry();
      registry.register("a1", ["read"]);
      const result = registry.discover("nonexistent");
      assert.deepEqual(result, []);
    });
  });

  describe("getAgent()", () => {
    it("존재하지 않는 ID면 null을 반환한다", () => {
      const registry = createRegistry();
      assert.equal(registry.getAgent("no-such"), null);
    });
  });

  describe("listAll()", () => {
    it("모든 등록된 에이전트를 배열로 반환한다", () => {
      const registry = createRegistry();
      registry.register("a1", ["x"]);
      registry.register("a2", ["y"]);
      const all = registry.listAll();
      assert.equal(all.length, 2);
      const ids = all.map((a) => a.agentId);
      assert.ok(ids.includes("a1"));
      assert.ok(ids.includes("a2"));
    });

    it("등록된 에이전트가 없으면 빈 배열을 반환한다", () => {
      const registry = createRegistry();
      assert.deepEqual(registry.listAll(), []);
    });
  });

  describe("clear()", () => {
    it("모든 에이전트를 제거한다", () => {
      const registry = createRegistry();
      registry.register("a1", []);
      registry.register("a2", []);
      registry.clear();
      assert.deepEqual(registry.listAll(), []);
    });
  });
});
