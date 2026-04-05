import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MSG_TYPES,
  createMessage,
  serialize,
  deserialize,
  validate,
} from "../../mesh/mesh-protocol.mjs";

describe("mesh/mesh-protocol.mjs", () => {
  describe("MSG_TYPES", () => {
    it("네 가지 메시지 타입을 정의한다", () => {
      assert.equal(MSG_TYPES.REQUEST, "request");
      assert.equal(MSG_TYPES.RESPONSE, "response");
      assert.equal(MSG_TYPES.EVENT, "event");
      assert.equal(MSG_TYPES.HEARTBEAT, "heartbeat");
    });

    it("동결(frozen) 객체다", () => {
      assert.equal(Object.isFrozen(MSG_TYPES), true);
    });
  });

  describe("createMessage()", () => {
    it("필수 필드를 가진 메시지를 생성한다", () => {
      const msg = createMessage(MSG_TYPES.REQUEST, "agent-a", "agent-b", { data: 1 });
      assert.equal(msg.type, "request");
      assert.equal(msg.from, "agent-a");
      assert.equal(msg.to, "agent-b");
      assert.deepEqual(msg.payload, { data: 1 });
      assert.ok(typeof msg.timestamp === "string");
      assert.ok(typeof msg.correlationId === "string");
    });

    it("동결된 객체를 반환한다", () => {
      const msg = createMessage(MSG_TYPES.EVENT, "a", "b");
      assert.equal(Object.isFrozen(msg), true);
    });

    it("payload 기본값은 null이다", () => {
      const msg = createMessage(MSG_TYPES.HEARTBEAT, "a", "b");
      assert.equal(msg.payload, null);
    });

    it("잘못된 type으로 생성하면 TypeError를 던진다", () => {
      assert.throws(
        () => createMessage("invalid", "a", "b"),
        TypeError,
      );
    });

    it("from이 비어 있으면 TypeError를 던진다", () => {
      assert.throws(
        () => createMessage(MSG_TYPES.REQUEST, "", "b"),
        TypeError,
      );
    });

    it("to가 비어 있으면 TypeError를 던진다", () => {
      assert.throws(
        () => createMessage(MSG_TYPES.REQUEST, "a", ""),
        TypeError,
      );
    });

    it("각 메시지마다 고유한 correlationId를 갖는다", () => {
      const m1 = createMessage(MSG_TYPES.EVENT, "a", "b");
      const m2 = createMessage(MSG_TYPES.EVENT, "a", "b");
      assert.notEqual(m1.correlationId, m2.correlationId);
    });
  });

  describe("serialize() / deserialize()", () => {
    it("메시지를 JSON 문자열로 직렬화한다", () => {
      const msg = createMessage(MSG_TYPES.REQUEST, "a", "b", { x: 1 });
      const raw = serialize(msg);
      assert.equal(typeof raw, "string");
      const parsed = JSON.parse(raw);
      assert.equal(parsed.type, "request");
      assert.equal(parsed.from, "a");
    });

    it("JSON 문자열을 역직렬화한다", () => {
      const msg = createMessage(MSG_TYPES.RESPONSE, "b", "a", { ok: true });
      const raw = serialize(msg);
      const recovered = deserialize(raw);
      assert.equal(recovered.type, "response");
      assert.deepEqual(recovered.payload, { ok: true });
    });

    it("직렬화 후 역직렬화하면 원래 데이터를 복원한다", () => {
      const msg = createMessage(MSG_TYPES.EVENT, "src", "dst", [1, 2, 3]);
      const recovered = deserialize(serialize(msg));
      assert.equal(recovered.correlationId, msg.correlationId);
      assert.deepEqual(recovered.payload, [1, 2, 3]);
    });

    it("deserialize: 문자열이 아니면 TypeError를 던진다", () => {
      assert.throws(() => deserialize(123), TypeError);
    });

    it("deserialize: 유효하지 않은 JSON이면 SyntaxError를 던진다", () => {
      assert.throws(() => deserialize("{bad json"), SyntaxError);
    });
  });

  describe("validate()", () => {
    it("유효한 메시지에 대해 valid:true를 반환한다", () => {
      const msg = createMessage(MSG_TYPES.REQUEST, "a", "b", null);
      const result = validate(msg);
      assert.equal(result.valid, true);
      assert.deepEqual(result.errors, []);
    });

    it("type이 없으면 오류를 반환한다", () => {
      const result = validate({ type: "bad", from: "a", to: "b", timestamp: "t", correlationId: "c" });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("type") || e.includes("Invalid")));
    });

    it("from이 없으면 오류를 반환한다", () => {
      const result = validate({ type: "request", from: "", to: "b", timestamp: "t", correlationId: "c" });
      assert.equal(result.valid, false);
    });

    it("to가 없으면 오류를 반환한다", () => {
      const result = validate({ type: "request", from: "a", to: "", timestamp: "t", correlationId: "c" });
      assert.equal(result.valid, false);
    });

    it("null이나 비객체는 invalid를 반환한다", () => {
      const r1 = validate(null);
      const r2 = validate("string");
      assert.equal(r1.valid, false);
      assert.equal(r2.valid, false);
    });
  });
});
