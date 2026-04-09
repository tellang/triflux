import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMessage, MSG_TYPES } from "../../mesh/mesh-protocol.mjs";
import { createMessageQueue } from "../../mesh/mesh-queue.mjs";

function makeMsg(id) {
  return createMessage(MSG_TYPES.REQUEST, "sender", `agent-${id}`, { id });
}

describe("mesh/mesh-queue.mjs", () => {
  describe("enqueue / dequeue", () => {
    it("메시지를 넣고 FIFO 순서로 꺼낸다", () => {
      const q = createMessageQueue();
      const m1 = makeMsg(1);
      const m2 = makeMsg(2);
      q.enqueue("a1", m1);
      q.enqueue("a1", m2);
      assert.equal(q.dequeue("a1"), m1);
      assert.equal(q.dequeue("a1"), m2);
      assert.equal(q.dequeue("a1"), null);
    });

    it("다른 에이전트의 큐는 독립적이다", () => {
      const q = createMessageQueue();
      const m1 = makeMsg(1);
      const m2 = makeMsg(2);
      q.enqueue("a1", m1);
      q.enqueue("a2", m2);
      assert.equal(q.dequeue("a1"), m1);
      assert.equal(q.dequeue("a2"), m2);
    });

    it("agentId가 비어있으면 TypeError를 던진다", () => {
      const q = createMessageQueue();
      assert.throws(() => q.enqueue("", makeMsg(1)), TypeError);
    });
  });

  describe("maxQueueSize", () => {
    it("최대 크기 초과 시 가장 오래된 메시지를 drop한다", () => {
      const q = createMessageQueue({ maxQueueSize: 2 });
      const m1 = makeMsg(1);
      const m2 = makeMsg(2);
      const m3 = makeMsg(3);
      q.enqueue("a1", m1);
      q.enqueue("a1", m2);
      const result = q.enqueue("a1", m3);
      assert.equal(result.dropped, true);
      assert.equal(q.size("a1"), 2);
      assert.equal(q.dequeue("a1"), m2);
      assert.equal(q.dequeue("a1"), m3);
    });

    it("최대 크기 이하면 drop하지 않는다", () => {
      const q = createMessageQueue({ maxQueueSize: 5 });
      const result = q.enqueue("a1", makeMsg(1));
      assert.equal(result.dropped, false);
      assert.equal(result.queued, true);
    });
  });

  describe("peek", () => {
    it("메시지를 제거하지 않고 확인한다", () => {
      const q = createMessageQueue();
      const m = makeMsg(1);
      q.enqueue("a1", m);
      assert.equal(q.peek("a1"), m);
      assert.equal(q.size("a1"), 1);
    });

    it("빈 큐에서 peek하면 null을 반환한다", () => {
      const q = createMessageQueue();
      assert.equal(q.peek("a1"), null);
    });
  });

  describe("size", () => {
    it("큐 크기를 반환한다", () => {
      const q = createMessageQueue();
      q.enqueue("a1", makeMsg(1));
      q.enqueue("a1", makeMsg(2));
      assert.equal(q.size("a1"), 2);
    });

    it("존재하지 않는 에이전트 큐는 0을 반환한다", () => {
      const q = createMessageQueue();
      assert.equal(q.size("nonexistent"), 0);
    });
  });

  describe("TTL", () => {
    it("TTL 초과 메시지는 자동 만료된다", () => {
      const q = createMessageQueue({ ttlMs: 50 });
      q.enqueue("a1", makeMsg(1));

      // 만료 전에는 존재
      assert.equal(q.size("a1"), 1);

      // 시간 경과 시뮬레이션: 내부 큐에 직접 접근하지 않고 대기
      return new Promise((resolve) => {
        setTimeout(() => {
          assert.equal(q.size("a1"), 0);
          assert.equal(q.dequeue("a1"), null);
          resolve();
        }, 80);
      });
    });
  });

  describe("drain", () => {
    it("모든 메시지를 꺼내고 큐를 비운다", () => {
      const q = createMessageQueue();
      const m1 = makeMsg(1);
      const m2 = makeMsg(2);
      q.enqueue("a1", m1);
      q.enqueue("a1", m2);
      const drained = q.drain("a1");
      assert.deepEqual(drained, [m1, m2]);
      assert.equal(q.size("a1"), 0);
    });

    it("빈 큐에서 drain하면 빈 배열을 반환한다", () => {
      const q = createMessageQueue();
      assert.deepEqual(q.drain("a1"), []);
    });
  });

  describe("clear / totalSize", () => {
    it("에이전트 큐를 완전히 제거한다", () => {
      const q = createMessageQueue();
      q.enqueue("a1", makeMsg(1));
      q.clear("a1");
      assert.equal(q.size("a1"), 0);
    });

    it("전체 메시지 수를 반환한다", () => {
      const q = createMessageQueue();
      q.enqueue("a1", makeMsg(1));
      q.enqueue("a2", makeMsg(2));
      q.enqueue("a2", makeMsg(3));
      assert.equal(q.totalSize(), 3);
    });
  });
});
