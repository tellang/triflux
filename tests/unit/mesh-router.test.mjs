import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMessage, MSG_TYPES } from "../../mesh/mesh-protocol.mjs";
import { createRegistry } from "../../mesh/mesh-registry.mjs";
import { routeMessage, routeOrDeadLetter } from "../../mesh/mesh-router.mjs";

function makeMsg(from, to) {
  return createMessage(MSG_TYPES.REQUEST, from, to, { action: "test" });
}

describe("mesh/mesh-router.mjs", () => {
  describe("routeMessage() — direct addressing", () => {
    it("등록된 에이전트로 직접 라우팅한다", () => {
      const reg = createRegistry();
      reg.register("agent-1", ["read"]);
      const msg = makeMsg("sender", "agent-1");
      const result = routeMessage(msg, reg);
      assert.equal(result.routed, true);
      assert.deepEqual(result.targets, ["agent-1"]);
    });

    it("미등록 에이전트는 dead letter 처리한다", () => {
      const reg = createRegistry();
      const msg = makeMsg("sender", "no-such-agent");
      const result = routeMessage(msg, reg);
      assert.equal(result.routed, false);
      assert.ok(result.reason.includes("no-such-agent"));
    });
  });

  describe("routeMessage() — broadcast", () => {
    it("'*'로 전송 시 모든 에이전트에 브로드캐스트한다 (발신자 제외)", () => {
      const reg = createRegistry();
      reg.register("a1", []);
      reg.register("a2", []);
      reg.register("sender", []);
      const msg = makeMsg("sender", "*");
      const result = routeMessage(msg, reg);
      assert.equal(result.routed, true);
      assert.ok(result.targets.includes("a1"));
      assert.ok(result.targets.includes("a2"));
      assert.ok(!result.targets.includes("sender"));
    });

    it("에이전트가 없으면 브로드캐스트 실패한다", () => {
      const reg = createRegistry();
      const msg = makeMsg("sender", "*");
      const result = routeMessage(msg, reg);
      assert.equal(result.routed, false);
      assert.ok(result.reason.includes("no agents"));
    });
  });

  describe("routeMessage() — capability routing", () => {
    it("'capability:X'로 해당 능력을 가진 에이전트를 찾는다", () => {
      const reg = createRegistry();
      reg.register("codex-1", ["codex", "edit"]);
      reg.register("gemini-1", ["gemini", "search"]);
      reg.register("codex-2", ["codex"]);
      const msg = makeMsg("sender", "capability:codex");
      const result = routeMessage(msg, reg);
      assert.equal(result.routed, true);
      assert.ok(result.targets.includes("codex-1"));
      assert.ok(result.targets.includes("codex-2"));
      assert.ok(!result.targets.includes("gemini-1"));
    });

    it("해당 capability가 없으면 실패한다", () => {
      const reg = createRegistry();
      reg.register("a1", ["read"]);
      const msg = makeMsg("sender", "capability:nonexistent");
      const result = routeMessage(msg, reg);
      assert.equal(result.routed, false);
      assert.ok(result.reason.includes("nonexistent"));
    });

    it("빈 capability 이름은 실패한다", () => {
      const reg = createRegistry();
      const msg = makeMsg("sender", "capability:");
      const result = routeMessage(msg, reg);
      assert.equal(result.routed, false);
      assert.ok(result.reason.includes("empty"));
    });
  });

  describe("routeMessage() — validation", () => {
    it("유효하지 않은 메시지는 routed: false를 반환한다", () => {
      const reg = createRegistry();
      const result = routeMessage({ bad: true }, reg);
      assert.equal(result.routed, false);
      assert.ok(result.reason.includes("invalid message"));
    });
  });

  describe("routeOrDeadLetter()", () => {
    it("라우팅 실패 시 deadLetter 객체를 포함한다", () => {
      const reg = createRegistry();
      const msg = makeMsg("sender", "missing-agent");
      const result = routeOrDeadLetter(msg, reg);
      assert.equal(result.routed, false);
      assert.ok(result.deadLetter);
      assert.equal(result.deadLetter.originalMessage, msg);
      assert.ok(result.deadLetter.timestamp);
    });

    it("라우팅 성공 시 deadLetter가 없다", () => {
      const reg = createRegistry();
      reg.register("target", []);
      const msg = makeMsg("sender", "target");
      const result = routeOrDeadLetter(msg, reg);
      assert.equal(result.routed, true);
      assert.equal(result.deadLetter, undefined);
    });
  });
});
