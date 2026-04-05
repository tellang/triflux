import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { createRegistry } from "../../mesh/mesh-registry.mjs";
import { createConductorMeshBridge } from "../../hub/team/conductor-mesh-bridge.mjs";

function createMockConductor() {
  const emitter = new EventEmitter();
  return {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter),
  };
}

describe("hub/team/conductor-mesh-bridge.mjs", () => {
  describe("attach / detach", () => {
    it("attach 후 isAttached가 true이다", () => {
      const conductor = createMockConductor();
      const reg = createRegistry();
      const bridge = createConductorMeshBridge(conductor, reg);
      bridge.attach();
      assert.equal(bridge.isAttached, true);
    });

    it("detach 후 isAttached가 false이다", () => {
      const conductor = createMockConductor();
      const reg = createRegistry();
      const bridge = createConductorMeshBridge(conductor, reg);
      bridge.attach();
      bridge.detach();
      assert.equal(bridge.isAttached, false);
    });

    it("중복 attach는 무시된다", () => {
      const conductor = createMockConductor();
      const reg = createRegistry();
      const messages = [];
      const bridge = createConductorMeshBridge(conductor, reg, {
        onMessage: (m) => messages.push(m),
      });
      bridge.attach();
      bridge.attach(); // 두 번째 attach
      conductor.emit("stateChange", {
        sessionId: "s1", from: "init", to: "starting", reason: "test",
      });
      // 한 번만 처리됨
      assert.equal(messages.length, 1);
    });
  });

  describe("stateChange → registry sync", () => {
    it("starting 이벤트 시 에이전트를 registry에 등록한다", () => {
      const conductor = createMockConductor();
      const reg = createRegistry();
      const bridge = createConductorMeshBridge(conductor, reg);
      bridge.attach();

      conductor.emit("stateChange", {
        sessionId: "s1", from: "init", to: "starting", reason: "initial",
      });

      const agent = reg.getAgent("session:s1");
      assert.ok(agent !== null);
      assert.equal(agent.agentId, "session:s1");
    });

    it("dead 이벤트 시 에이전트를 registry에서 해제한다", () => {
      const conductor = createMockConductor();
      const reg = createRegistry();
      const bridge = createConductorMeshBridge(conductor, reg);
      bridge.attach();

      conductor.emit("stateChange", {
        sessionId: "s1", from: "init", to: "starting", reason: "initial",
      });
      conductor.emit("stateChange", {
        sessionId: "s1", from: "failed", to: "dead", reason: "maxRestarts",
      });

      assert.equal(reg.getAgent("session:s1"), null);
    });

    it("completed 이벤트 시 에이전트를 registry에서 해제한다", () => {
      const conductor = createMockConductor();
      const reg = createRegistry();
      const bridge = createConductorMeshBridge(conductor, reg);
      bridge.attach();

      conductor.emit("stateChange", {
        sessionId: "s1", from: "init", to: "starting", reason: "initial",
      });
      conductor.emit("stateChange", {
        sessionId: "s1", from: "healthy", to: "completed", reason: "exit_0",
      });

      assert.equal(reg.getAgent("session:s1"), null);
    });
  });

  describe("mesh message generation", () => {
    it("stateChange 시 EVENT 메시지를 생성한다", () => {
      const conductor = createMockConductor();
      const reg = createRegistry();
      const messages = [];
      const bridge = createConductorMeshBridge(conductor, reg, {
        onMessage: (m) => messages.push(m),
      });
      bridge.attach();

      conductor.emit("stateChange", {
        sessionId: "s1", from: "init", to: "starting", reason: "test",
      });

      assert.equal(messages.length, 1);
      assert.equal(messages[0].type, "event");
      assert.equal(messages[0].from, "conductor");
      assert.equal(messages[0].to, "*");
      assert.equal(messages[0].payload.event, "stateChange");
      assert.equal(messages[0].payload.sessionId, "s1");
    });

    it("completed 이벤트 시 EVENT 메시지를 생성한다", () => {
      const conductor = createMockConductor();
      const reg = createRegistry();
      const messages = [];
      const bridge = createConductorMeshBridge(conductor, reg, {
        onMessage: (m) => messages.push(m),
      });
      bridge.attach();

      conductor.emit("completed", { sessionId: "s1" });

      assert.equal(messages.length, 1);
      assert.equal(messages[0].payload.event, "completed");
    });

    it("dead 이벤트 시 EVENT 메시지를 생성한다", () => {
      const conductor = createMockConductor();
      const reg = createRegistry();
      const messages = [];
      const bridge = createConductorMeshBridge(conductor, reg, {
        onMessage: (m) => messages.push(m),
      });
      bridge.attach();

      conductor.emit("dead", { sessionId: "s1", reason: "test" });

      assert.equal(messages.length, 1);
      assert.equal(messages[0].payload.event, "dead");
      assert.equal(messages[0].payload.reason, "test");
    });
  });

  describe("detach cleanup", () => {
    it("detach 시 모든 등록된 세션 에이전트를 해제한다", () => {
      const conductor = createMockConductor();
      const reg = createRegistry();
      const bridge = createConductorMeshBridge(conductor, reg);
      bridge.attach();

      conductor.emit("stateChange", {
        sessionId: "s1", from: "init", to: "starting", reason: "test",
      });
      conductor.emit("stateChange", {
        sessionId: "s2", from: "init", to: "starting", reason: "test",
      });

      assert.ok(reg.getAgent("session:s1") !== null);
      assert.ok(reg.getAgent("session:s2") !== null);

      bridge.detach();

      assert.equal(reg.getAgent("session:s1"), null);
      assert.equal(reg.getAgent("session:s2"), null);
    });

    it("detach 후 이벤트가 더 이상 처리되지 않는다", () => {
      const conductor = createMockConductor();
      const reg = createRegistry();
      const messages = [];
      const bridge = createConductorMeshBridge(conductor, reg, {
        onMessage: (m) => messages.push(m),
      });
      bridge.attach();
      bridge.detach();

      conductor.emit("stateChange", {
        sessionId: "s1", from: "init", to: "starting", reason: "test",
      });

      assert.equal(messages.length, 0);
      assert.equal(reg.getAgent("session:s1"), null);
    });
  });
});
