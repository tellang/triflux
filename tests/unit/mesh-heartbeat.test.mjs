import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHeartbeatMonitor } from "../../mesh/mesh-heartbeat.mjs";
import { createRegistry } from "../../mesh/mesh-registry.mjs";

describe("mesh/mesh-heartbeat.mjs", () => {
  describe("recordHeartbeat / getStaleAgents", () => {
    it("heartbeat를 기록한 에이전트는 stale이 아니다", () => {
      const reg = createRegistry();
      reg.register("a1", []);
      const hb = createHeartbeatMonitor(reg, { thresholdMs: 60_000 });
      hb.recordHeartbeat("a1");
      const stale = hb.getStaleAgents();
      assert.equal(stale.length, 0);
    });

    it("heartbeat가 없는 등록 에이전트는 stale로 간주한다", () => {
      const reg = createRegistry();
      reg.register("a1", []);
      reg.register("a2", []);
      const hb = createHeartbeatMonitor(reg, { thresholdMs: 60_000 });
      hb.recordHeartbeat("a1");
      const stale = hb.getStaleAgents();
      assert.deepEqual(stale, ["a2"]);
    });

    it("custom threshold를 getStaleAgents에 전달할 수 있다", () => {
      const reg = createRegistry();
      reg.register("a1", []);
      const hb = createHeartbeatMonitor(reg, { thresholdMs: 60_000 });
      hb.recordHeartbeat("a1");
      // threshold 0 이면 방금 기록해도 stale
      const stale = hb.getStaleAgents(0);
      assert.equal(stale.length, 1);
    });

    it("agentId가 비어있으면 TypeError를 던진다", () => {
      const reg = createRegistry();
      const hb = createHeartbeatMonitor(reg);
      assert.throws(() => hb.recordHeartbeat(""), TypeError);
    });

    it("미등록 에이전트의 heartbeat는 stale 결과에 포함되지 않는다", () => {
      const reg = createRegistry();
      const hb = createHeartbeatMonitor(reg);
      hb.recordHeartbeat("unregistered");
      const stale = hb.getStaleAgents();
      assert.deepEqual(stale, []);
    });
  });

  describe("onStale callback", () => {
    it("scan() 시 stale 에이전트마다 onStale이 호출된다", () => {
      const reg = createRegistry();
      reg.register("a1", []);
      reg.register("a2", []);

      const staleCalled = [];
      const hb = createHeartbeatMonitor(reg, {
        thresholdMs: 60_000,
        onStale: (id) => staleCalled.push(id),
      });

      hb.recordHeartbeat("a1");
      hb.scan();

      assert.deepEqual(staleCalled, ["a2"]);
    });
  });

  describe("start / stop", () => {
    it("주기적 스캔을 시작하고 중지할 수 있다", () => {
      const reg = createRegistry();
      reg.register("a1", []);

      const staleCalled = [];
      const hb = createHeartbeatMonitor(reg, {
        thresholdMs: 0,
        onStale: (id) => staleCalled.push(id),
      });

      hb.start(30);
      return new Promise((resolve) => {
        setTimeout(() => {
          hb.stop();
          assert.ok(staleCalled.length >= 1);
          assert.ok(staleCalled.includes("a1"));
          resolve();
        }, 80);
      });
    });

    it("stop() 후 더 이상 콜백이 호출되지 않는다", () => {
      const reg = createRegistry();
      reg.register("a1", []);

      let count = 0;
      const hb = createHeartbeatMonitor(reg, {
        thresholdMs: 0,
        onStale: () => {
          count++;
        },
      });

      hb.start(20);
      hb.stop();

      return new Promise((resolve) => {
        setTimeout(() => {
          assert.equal(count, 0);
          resolve();
        }, 60);
      });
    });
  });

  describe("remove", () => {
    it("heartbeat 기록을 삭제한다", () => {
      const reg = createRegistry();
      reg.register("a1", []);
      const hb = createHeartbeatMonitor(reg, { thresholdMs: 60_000 });
      hb.recordHeartbeat("a1");
      hb.remove("a1");
      const stale = hb.getStaleAgents();
      assert.deepEqual(stale, ["a1"]);
    });
  });
});
