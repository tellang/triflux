// tests/integration/router.test.mjs — router.mjs 통합 테스트
// store + router를 함께 초기화하여 실제 라우팅 경로를 검증

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createRouter } from "../../hub/router.mjs";
import { createStore } from "../../hub/store.mjs";
import { createRouter as createCoreRouter } from "../../packages/core/hub/router.mjs";
import { createStore as createRemoteStore } from "../../packages/remote/hub/store.mjs";
import { SQLITE_SKIP } from "../helpers/sqlite.mjs";

function tempDbPath() {
  const dir = join(tmpdir(), `tfx-router-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "test.db");
}

function createIsolatedRouter() {
  const dbPath = tempDbPath();
  const store = createStore(dbPath);
  const router = createRouter(store);
  return {
    store,
    router,
    cleanup() {
      router.stopSweeper();
      store.close();
      try {
        rmSync(join(dbPath, ".."), { recursive: true, force: true });
      } catch {}
    },
  };
}

function createIsolatedRemoteRouter() {
  const dbPath = tempDbPath();
  const store = createRemoteStore(dbPath);
  const router = createCoreRouter(store);
  return {
    store,
    router,
    cleanup() {
      router.stopSweeper();
      store.close();
      try {
        rmSync(join(dbPath, ".."), { recursive: true, force: true });
      } catch {}
    },
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createRouter()", { skip: SQLITE_SKIP }, () => {
  let store;
  let router;
  let dbPath;

  before(() => {
    dbPath = tempDbPath();
    store = createStore(dbPath);
    router = createRouter(store);
  });

  after(() => {
    router.stopSweeper();
    store.close();
    try {
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    } catch {}
  });

  // ── handlePublish ──

  describe("remote SQLite store compatibility", () => {
    it("core router registration succeeds and returns effective online presence", () => {
      const isolated = createIsolatedRemoteRouter();
      try {
        const registered = isolated.router.registerAgent({
          agent_id: "remote-sqlite-agent",
          cli: "codex",
          capabilities: ["code"],
          topics: ["remote.test"],
          heartbeat_ttl_ms: 60000,
        });

        assert.equal(registered.ok, true);
        assert.equal(registered.data.effective.updated, true);
        assert.equal(registered.data.hub_pid, process.pid);
        assert.equal(registered.data.effective.store_type, "sqlite");
        assert.equal(registered.data.effective.online, true);
        assert.equal(registered.data.effective.status, "online");
        assert.equal(
          registered.data.effective.lease_expires_ms,
          registered.data.lease_expires_ms,
        );
        assert.ok(
          registered.data.effective.last_seen_ms <=
            registered.data.server_time_ms,
        );

        const persisted = isolated.store.getAgent("remote-sqlite-agent");
        assert.equal(persisted.status, "online");
        assert.equal(
          persisted.lease_expires_ms,
          registered.data.lease_expires_ms,
        );
      } finally {
        isolated.cleanup();
      }
    });
  });

  describe("handlePublish()", () => {
    it("직접 에이전트 대상 발행 시 ok: true와 message_id를 반환해야 한다", () => {
      // 수신 에이전트 등록
      store.registerAgent({
        agent_id: "pub-receiver",
        cli: "other",
        capabilities: ["x"],
        topics: [],
        heartbeat_ttl_ms: 60000,
      });

      const result = router.handlePublish({
        from: "pub-sender",
        to: "pub-receiver",
        topic: "test.event",
        payload: { value: 1 },
      });

      assert.equal(result.ok, true);
      assert.ok(result.data.message_id);
      assert.equal(typeof result.data.fanout_count, "number");
      assert.ok(result.data.expires_at_ms > Date.now());
    });

    it("correlation_id 있을 때 response 타입으로 저장되어야 한다", () => {
      store.registerAgent({
        agent_id: "corr-receiver",
        cli: "other",
        capabilities: ["x"],
        topics: [],
        heartbeat_ttl_ms: 60000,
      });

      const cid = randomUUID();
      const result = router.handlePublish({
        from: "corr-sender",
        to: "corr-receiver",
        topic: "test.response",
        payload: { answer: 42 },
        correlation_id: cid,
      });

      assert.equal(result.ok, true);
      const msg = store.getMessage(result.data.message_id);
      assert.equal(msg.type, "response");
      assert.equal(msg.correlation_id, cid);
    });

    it("correlation_id 없을 때 event 타입으로 저장되어야 한다", () => {
      store.registerAgent({
        agent_id: "event-receiver",
        cli: "other",
        capabilities: ["x"],
        topics: [],
        heartbeat_ttl_ms: 60000,
      });

      const result = router.handlePublish({
        from: "event-sender",
        to: "event-receiver",
        topic: "test.plain",
        payload: {},
      });

      const msg = store.getMessage(result.data.message_id);
      assert.equal(msg.type, "event");
    });

    it("topic: 접두사로 팬아웃 발행 시 구독 에이전트 수를 fanout_count로 반환해야 한다", () => {
      // 동일 토픽을 구독하는 에이전트 2개 등록
      store.registerAgent({
        agent_id: "fanout-a",
        cli: "codex",
        capabilities: ["x"],
        topics: ["broadcast.test"],
        heartbeat_ttl_ms: 60000,
      });
      store.registerAgent({
        agent_id: "fanout-b",
        cli: "gemini",
        capabilities: ["y"],
        topics: ["broadcast.test"],
        heartbeat_ttl_ms: 60000,
      });

      const result = router.handlePublish({
        from: "broadcaster",
        to: "topic:broadcast.test",
        topic: "broadcast.test",
        payload: { msg: "hello all" },
      });

      assert.equal(result.ok, true);
      assert.ok(
        result.data.fanout_count >= 2,
        `fanout_count(${result.data.fanout_count})는 최소 2여야 한다`,
      );
    });
  });

  describe("CTO 역할 승계", () => {
    it("ineffective register는 ok:false로 반환하고 role election을 진행하지 않아야 한다", () => {
      const isolated = createIsolatedRouter();
      try {
        isolated.store.registerAgent = () => ({
          agent_id: "stuck-cto",
          lease_id: "lease-stuck",
          lease_expires_ms: Date.now() + 60000,
          server_time_ms: Date.now(),
          effective: {
            updated: false,
            online: false,
            status: "offline",
            last_seen_ms: Date.now() - 60000,
            lease_expires_ms: Date.now() - 1,
          },
        });

        const registered = isolated.router.registerAgent({
          agent_id: "stuck-cto",
          cli: "claude",
          capabilities: ["cto"],
          topics: [],
          metadata: { role: "cto", cto_priority: 100 },
          heartbeat_ttl_ms: 60000,
        });

        assert.equal(registered.ok, false);
        assert.equal(registered.error.code, "REGISTER_PRESENCE_NOT_UPDATED");
        assert.equal(registered.data.hub_pid, process.pid);
        assert.equal(
          isolated.router.getStatus("hub").data.roles.cto.leader_agent_id,
          null,
        );
      } finally {
        isolated.cleanup();
      }
    });

    it("offline explicit CTO 재등록은 DB presence를 복구하고 takeover 가능해야 한다", () => {
      const isolated = createIsolatedRouter();
      try {
        let registered = isolated.router.registerAgent({
          agent_id: "claude-callbot-main",
          cli: "claude",
          capabilities: ["code"],
          topics: [],
          metadata: { role: "cto", cto_priority: 100, cwd: process.cwd() },
          heartbeat_ttl_ms: 60000,
        });
        assert.equal(registered.ok, true);

        isolated.router.updateAgentStatus(
          "claude-callbot-main",
          "offline",
          registered.data.presence_generation,
        );
        registered = isolated.router.registerAgent({
          agent_id: "fallback-cto",
          cli: "claude",
          capabilities: ["code"],
          topics: ["cto"],
          metadata: { cwd: process.cwd() },
          heartbeat_ttl_ms: 60000,
        });
        assert.equal(registered.ok, true);
        assert.equal(
          isolated.router.getStatus("hub").data.roles.cto.leader_agent_id,
          "fallback-cto",
        );

        const before = isolated.store.getAgent("claude-callbot-main");
        assert.equal(before.status, "offline");

        registered = isolated.router.registerAgent({
          agent_id: "claude-callbot-main",
          cli: "claude",
          capabilities: ["code"],
          topics: [],
          metadata: { role: "cto", cto_priority: 100, cwd: process.cwd() },
          heartbeat_ttl_ms: 7200000,
        });
        assert.equal(registered.ok, true);
        assert.equal(registered.data.effective.status, "online");

        const row = isolated.store.getAgent("claude-callbot-main");
        assert.equal(row.status, "online");
        assert.equal(row.lease_expires_ms, registered.data.lease_expires_ms);
        assert.ok(row.last_seen_ms >= registered.data.server_time_ms - 50);

        const takeover = isolated.router.takeoverRole({
          role: "cto",
          agent_id: "claude-callbot-main",
          reason: "regression-454",
          requested_by: "test",
        });
        assert.equal(takeover.ok, true);
        assert.equal(takeover.data.leader_agent_id, "claude-callbot-main");
      } finally {
        isolated.cleanup();
      }
    });

    it("topic:cto는 전체 팬아웃이 아니라 현재 CTO leader 한 명에게만 라우팅해야 한다", () => {
      const isolated = createIsolatedRouter();
      try {
        isolated.router.registerAgent({
          agent_id: "cto-route-leader",
          cli: "claude",
          capabilities: ["code"],
          topics: [],
          metadata: { role: "cto", cto_priority: 10 },
          heartbeat_ttl_ms: 60000,
        });
        isolated.router.registerAgent({
          agent_id: "cto-topic-worker",
          cli: "codex",
          capabilities: ["code"],
          topics: ["cto"],
          heartbeat_ttl_ms: 60000,
        });

        const result = isolated.router.handlePublish({
          from: "lead",
          to: "topic:cto",
          topic: "cto",
          payload: { decision: "please coordinate" },
        });

        assert.equal(result.ok, true);
        assert.equal(result.data.fanout_count, 1);
        assert.equal(
          isolated.router.getPendingMessages("cto-route-leader").length,
          1,
        );
        assert.equal(
          isolated.router.getPendingMessages("cto-topic-worker").length,
          0,
        );
        const status = isolated.router.getStatus("hub");
        assert.equal(status.data.roles.cto.leader_agent_id, "cto-route-leader");
        assert.equal(status.data.roles.cto.candidate_source, "explicit");
      } finally {
        isolated.cleanup();
      }
    });

    it("leader가 없을 때 들어온 topic:cto 메시지는 후보 등록 시 새 leader에게 이전되어야 한다", () => {
      const isolated = createIsolatedRouter();
      try {
        const published = isolated.router.handlePublish({
          from: "lead",
          to: "topic:cto",
          topic: "cto",
          payload: { decision: "wait for a CTO" },
        });

        assert.equal(published.ok, true);
        assert.equal(published.data.fanout_count, 0);
        assert.equal(published.data.role.pending_count, 1);

        isolated.router.registerAgent({
          agent_id: "cto-late-leader",
          cli: "codex",
          capabilities: ["cto"],
          topics: [],
          metadata: { role: "cto" },
          heartbeat_ttl_ms: 60000,
        });

        const status = isolated.router.getStatus("hub");
        assert.equal(status.data.roles.cto.leader_agent_id, "cto-late-leader");
        assert.equal(status.data.roles.cto.pending_count, 1);

        const pending = isolated.router.getPendingMessages("cto-late-leader");
        assert.equal(pending.length, 1);
        assert.equal(pending[0].topic, "cto");
        assert.deepEqual(pending[0].payload, { decision: "wait for a CTO" });
      } finally {
        isolated.cleanup();
      }
    });

    it("legacy route(msg) 경로도 leader 없는 topic:cto backlog를 보존해야 한다", () => {
      const isolated = createIsolatedRouter();
      try {
        const msg = isolated.store.enqueueMessage({
          type: "event",
          from: "lead",
          to: "topic:cto",
          topic: "cto",
          payload: { decision: "legacy route backlog" },
        });

        assert.equal(isolated.router.route(msg), 0);
        assert.equal(
          isolated.router.getStatus("hub").data.roles.cto.pending_count,
          1,
        );

        isolated.router.registerAgent({
          agent_id: "cto-legacy-route",
          cli: "codex",
          capabilities: ["cto"],
          topics: [],
          metadata: { role: "cto" },
          heartbeat_ttl_ms: 60000,
        });

        const pending = isolated.router.getPendingMessages("cto-legacy-route");
        assert.equal(pending.length, 1);
        assert.deepEqual(pending[0].payload, {
          decision: "legacy route backlog",
        });
      } finally {
        isolated.cleanup();
      }
    });

    it("이전 leader가 먼저 offline 된 뒤 나중에 새 후보가 등록되어도 backlog를 이전해야 한다", () => {
      const isolated = createIsolatedRouter();
      try {
        const oldLeader = isolated.router.registerAgent({
          agent_id: "cto-gap-old",
          cli: "claude",
          capabilities: ["cto"],
          topics: [],
          metadata: { role: "cto" },
          heartbeat_ttl_ms: 60000,
        });
        isolated.router.handlePublish({
          from: "lead",
          to: "topic:cto",
          topic: "cto",
          payload: { decision: "survive leader gap" },
        });
        assert.equal(
          isolated.router.getPendingMessages("cto-gap-old").length,
          1,
        );

        isolated.router.updateAgentStatus(
          "cto-gap-old",
          "offline",
          oldLeader.data.presence_generation,
        );
        const gapStatus = isolated.router.getStatus("hub");
        assert.equal(gapStatus.data.roles.cto.leader_agent_id, null);
        assert.equal(
          gapStatus.data.roles.cto.previous_leader_agent_id,
          "cto-gap-old",
        );
        assert.equal(gapStatus.data.roles.cto.pending_count, 1);

        isolated.router.registerAgent({
          agent_id: "cto-gap-new",
          cli: "codex",
          capabilities: ["cto"],
          topics: [],
          metadata: { role: "cto" },
          heartbeat_ttl_ms: 60000,
        });

        const status = isolated.router.getStatus("hub");
        assert.equal(status.data.roles.cto.leader_agent_id, "cto-gap-new");
        assert.equal(
          status.data.roles.cto.previous_leader_agent_id,
          "cto-gap-old",
        );
        assert.equal(status.data.roles.cto.pending_count, 1);
        assert.equal(
          isolated.router.getPendingMessages("cto-gap-old").length,
          0,
        );
        assert.equal(
          isolated.router.getPendingMessages("cto-gap-new").length,
          1,
        );
      } finally {
        isolated.cleanup();
      }
    });

    it("leader가 offline 되면 새 CTO 후보로 승계하고 미처리 CTO 메시지를 이전해야 한다", () => {
      const isolated = createIsolatedRouter();
      try {
        const oldLeader = isolated.router.registerAgent({
          agent_id: "cto-old-leader",
          cli: "claude",
          capabilities: ["code"],
          topics: [],
          metadata: { roles: ["cto"], cto_priority: 10 },
          heartbeat_ttl_ms: 60000,
        });
        isolated.router.registerAgent({
          agent_id: "cto-new-leader",
          cli: "codex",
          capabilities: ["cto"],
          topics: [],
          metadata: { role: "cto", cto_priority: 5 },
          heartbeat_ttl_ms: 60000,
        });

        const ctoMessage = isolated.router.handlePublish({
          from: "lead",
          to: "topic:cto",
          topic: "cto",
          payload: { decision: "unacked backlog" },
        });
        const directMessage = isolated.router.handlePublish({
          from: "lead",
          to: "cto-old-leader",
          topic: "lead.control",
          payload: { command: "do not reroute" },
        });
        const misleadingDirectMessage = isolated.router.handlePublish({
          from: "lead",
          to: "cto-old-leader",
          topic: "ops.direct",
          payload: { role: "cto", command: "metadata only; do not reroute" },
        });
        const directCtoTopicMessage = isolated.router.handlePublish({
          from: "lead",
          to: "cto-old-leader",
          topic: "cto",
          payload: { command: "direct topic metadata; do not reroute" },
        });
        assert.equal(ctoMessage.data.fanout_count, 1);
        assert.equal(directMessage.data.fanout_count, 1);
        assert.equal(misleadingDirectMessage.data.fanout_count, 1);
        assert.equal(directCtoTopicMessage.data.fanout_count, 1);
        assert.equal(
          isolated.router.getPendingMessages("cto-old-leader").length,
          4,
        );

        isolated.router.updateAgentStatus(
          "cto-old-leader",
          "offline",
          oldLeader.data.presence_generation,
        );
        const status = isolated.router.getStatus("hub");
        assert.equal(status.data.roles.cto.leader_agent_id, "cto-new-leader");
        assert.equal(
          status.data.roles.cto.previous_leader_agent_id,
          "cto-old-leader",
        );
        assert.equal(status.data.roles.cto.pending_count, 1);

        const newPending = isolated.router.getPendingMessages("cto-new-leader");
        assert.equal(newPending.length, 1);
        assert.equal(newPending[0].topic, "cto");

        const oldPending = isolated.router.getPendingMessages("cto-old-leader");
        assert.equal(oldPending.length, 3);
        assert.deepEqual(oldPending.map((message) => message.topic).sort(), [
          "cto",
          "lead.control",
          "ops.direct",
        ]);

        isolated.router.refreshAgentLease("cto-old-leader", 60000);
        const afterOldHeartbeat = isolated.router.getStatus("hub");
        assert.equal(
          afterOldHeartbeat.data.roles.cto.leader_agent_id,
          "cto-new-leader",
        );
      } finally {
        isolated.cleanup();
      }
    });

    it("getStatus()는 read-only이며 만료 leader의 CTO backlog를 승계 이전하지 않아야 한다", async () => {
      const isolated = createIsolatedRouter();
      try {
        isolated.router.registerAgent({
          agent_id: "cto-status-old",
          cli: "claude",
          capabilities: ["cto"],
          topics: [],
          metadata: { role: "cto", cto_priority: 10 },
          heartbeat_ttl_ms: 60000,
        });
        isolated.router.registerAgent({
          agent_id: "cto-status-new",
          cli: "codex",
          capabilities: ["cto"],
          topics: [],
          metadata: { role: "cto", cto_priority: 1 },
          heartbeat_ttl_ms: 60000,
        });
        isolated.router.handlePublish({
          from: "lead",
          to: "topic:cto",
          topic: "cto",
          payload: { decision: "status must not move this" },
        });
        isolated.store.db
          .prepare("UPDATE agents SET lease_expires_ms=? WHERE agent_id=?")
          .run(Date.now() - 1, "cto-status-old");

        await delay(5);
        const status = isolated.router.getStatus("hub");

        assert.equal(status.ok, true);
        assert.equal(status.data.roles.cto.leader_agent_id, null);
        assert.equal(status.data.roles.cto.pending_count, 1);
        assert.equal(
          isolated.router.getPendingMessages("cto-status-old").length,
          1,
        );
        assert.equal(
          isolated.router.getPendingMessages("cto-status-new").length,
          0,
        );
      } finally {
        isolated.cleanup();
      }
    });

    it("직접 cto topic publish는 leader를 바꾸거나 CTO backlog를 고립시키면 안 된다", () => {
      const isolated = createIsolatedRouter();
      try {
        isolated.router.registerAgent({
          agent_id: "cto-direct-topic-old",
          cli: "claude",
          capabilities: ["cto"],
          topics: [],
          metadata: { role: "cto", cto_priority: 10 },
          heartbeat_ttl_ms: 60000,
        });
        const newRegistration = isolated.router.registerAgent({
          agent_id: "cto-direct-topic-new",
          cli: "codex",
          capabilities: ["cto"],
          topics: [],
          metadata: { role: "cto", cto_priority: 1 },
          heartbeat_ttl_ms: 60000,
        });
        isolated.router.handlePublish({
          from: "lead",
          to: "topic:cto",
          topic: "cto",
          payload: { decision: "move only on real role election" },
        });
        assert.equal(
          isolated.router.getPendingMessages("cto-direct-topic-old").length,
          1,
        );

        isolated.store.db
          .prepare("UPDATE agents SET lease_expires_ms=? WHERE agent_id=?")
          .run(Date.now() - 1, "cto-direct-topic-old");

        const direct = isolated.router.handlePublish({
          from: "lead",
          to: "some-direct-recipient",
          topic: "cto",
          payload: { command: "not role addressed" },
        });
        assert.equal(direct.ok, true);
        assert.equal(direct.data.role, undefined);

        const afterDirect = isolated.router.getStatus("hub");
        assert.equal(afterDirect.data.roles.cto.leader_agent_id, null);
        assert.equal(afterDirect.data.roles.cto.pending_count, 1);
        assert.equal(
          isolated.router.getPendingMessages("cto-direct-topic-old").length,
          1,
        );
        assert.equal(
          isolated.router.getPendingMessages("cto-direct-topic-new").length,
          0,
        );

        isolated.router.refreshAgentLease(
          "cto-direct-topic-new",
          60000,
          newRegistration.data.presence_generation,
        );
        const afterHeartbeat = isolated.router.getStatus("hub");
        assert.equal(
          afterHeartbeat.data.roles.cto.leader_agent_id,
          "cto-direct-topic-new",
        );
        assert.equal(
          isolated.router.getPendingMessages("cto-direct-topic-old").length,
          0,
        );
        assert.equal(
          isolated.router.getPendingMessages("cto-direct-topic-new").length,
          1,
        );
      } finally {
        isolated.cleanup();
      }
    });

    it("takeoverRole()은 명시 승계와 백로그 이전을 멱등하게 수행해야 한다", () => {
      const isolated = createIsolatedRouter();
      try {
        isolated.router.registerAgent({
          agent_id: "cto-manual-old",
          cli: "claude",
          capabilities: ["cto"],
          topics: [],
          metadata: { role: "cto", cto_priority: 10 },
          heartbeat_ttl_ms: 60000,
        });
        isolated.router.registerAgent({
          agent_id: "cto-manual-new",
          cli: "codex",
          capabilities: ["cto"],
          topics: [],
          metadata: { role: "cto", cto_priority: 1 },
          heartbeat_ttl_ms: 60000,
        });
        isolated.router.handlePublish({
          from: "lead",
          to: "topic:cto",
          topic: "cto",
          payload: { decision: "manual takeover" },
        });

        const takeover = isolated.router.takeoverRole({
          role: "cto",
          agent_id: "cto-manual-new",
          reason: "operator_request",
          requested_by: "test",
        });

        assert.equal(takeover.ok, true);
        assert.equal(takeover.data.changed, true);
        assert.equal(takeover.data.previous_leader_agent_id, "cto-manual-old");
        assert.equal(takeover.data.leader_agent_id, "cto-manual-new");
        assert.equal(takeover.data.transferred_count, 1);
        assert.equal(
          isolated.router.getPendingMessages("cto-manual-new").length,
          1,
        );
        assert.equal(
          isolated.router.getPendingMessages("cto-manual-old").length,
          0,
        );

        const again = isolated.router.takeoverRole({
          role: "cto",
          agent_id: "cto-manual-new",
          reason: "operator_request",
          requested_by: "test",
        });
        assert.equal(again.ok, true);
        assert.equal(again.data.changed, false);
        assert.equal(again.data.transferred_count, 0);
        assert.equal(
          isolated.router.getPendingMessages("cto-manual-new").length,
          1,
        );
      } finally {
        isolated.cleanup();
      }
    });

    it("동일 우선순위 CTO 후보는 agent_id 오름차순으로 결정적으로 leader를 선출해야 한다", () => {
      const isolated = createIsolatedRouter();
      try {
        for (const agent_id of ["cto-aaa", "cto-bbb", "cto-ccc"]) {
          isolated.store.registerAgent({
            agent_id,
            cli: "codex",
            capabilities: ["cto"],
            topics: [],
            metadata: { role: "cto", cto_priority: 5 },
            heartbeat_ttl_ms: 60000,
          });
        }
        isolated.store.db
          .prepare(
            "UPDATE agents SET last_seen_ms=? WHERE agent_id IN (?, ?, ?)",
          )
          .run(1234567890, "cto-aaa", "cto-bbb", "cto-ccc");

        isolated.router.reelectStaleRoles();
        const status = isolated.router.getStatus("hub");
        assert.equal(status.data.roles.cto.leader_agent_id, "cto-aaa");

        isolated.router.reelectStaleRoles();
        const again = isolated.router.getStatus("hub");
        assert.equal(again.data.roles.cto.leader_agent_id, "cto-aaa");
      } finally {
        isolated.cleanup();
      }
    });

    it("살아있는 leader가 있으면 reelectStaleRoles는 leader_epoch/transferred_count를 churn하지 않아야 한다", () => {
      const isolated = createIsolatedRouter();
      try {
        isolated.router.registerAgent({
          agent_id: "cto-live-leader",
          cli: "claude",
          capabilities: ["cto"],
          topics: [],
          metadata: { role: "cto", cto_priority: 10 },
          heartbeat_ttl_ms: 60000,
        });

        isolated.router.reelectStaleRoles();
        const before = isolated.router.getStatus("hub").data.roles.cto;
        assert.equal(before.leader_agent_id, "cto-live-leader");

        isolated.router.reelectStaleRoles();
        isolated.router.reelectStaleRoles();
        const after = isolated.router.getStatus("hub").data.roles.cto;

        assert.equal(after.leader_agent_id, "cto-live-leader");
        assert.equal(after.leader_epoch, before.leader_epoch);
        assert.equal(after.transferred_count, before.transferred_count);
      } finally {
        isolated.cleanup();
      }
    });

    it("leader 장애 시 2개 이상 CTO backlog를 새 heir에게 모두 이전해야 한다", () => {
      const isolated = createIsolatedRouter();
      try {
        const firstLeader = isolated.router.registerAgent({
          agent_id: "A",
          cli: "claude",
          capabilities: ["cto"],
          topics: [],
          metadata: { role: "cto", cto_priority: 10 },
          heartbeat_ttl_ms: 60000,
        });
        isolated.router.registerAgent({
          agent_id: "B",
          cli: "codex",
          capabilities: ["cto"],
          topics: [],
          metadata: { role: "cto", cto_priority: 1 },
          heartbeat_ttl_ms: 60000,
        });

        for (const decision of ["one", "two", "three"]) {
          isolated.router.handlePublish({
            from: "lead",
            to: "topic:cto",
            topic: "cto",
            payload: { decision },
          });
        }

        assert.equal(isolated.router.getPendingMessages("A").length, 3);

        isolated.router.updateAgentStatus(
          "A",
          "offline",
          firstLeader.data.presence_generation,
        );
        const status = isolated.router.getStatus("hub");
        assert.equal(status.data.roles.cto.leader_agent_id, "B");
        assert.equal(status.data.roles.cto.pending_count, 3);
        assert.equal(status.data.roles.cto.transferred_count, 3);
        assert.equal(isolated.router.getPendingMessages("B").length, 3);
        assert.equal(isolated.router.getPendingMessages("A").length, 0);
      } finally {
        isolated.cleanup();
      }
    });

    it("sweep 재선출 경로는 A→B→C 연쇄 승계 후 후보 snapshot을 누수 없이 유지해야 한다", () => {
      const isolated = createIsolatedRouter();
      try {
        isolated.router.registerAgent({
          agent_id: "A",
          cli: "claude",
          capabilities: ["cto"],
          topics: [],
          metadata: { role: "cto", cto_priority: 10 },
          heartbeat_ttl_ms: 60000,
        });
        isolated.router.registerAgent({
          agent_id: "B",
          cli: "codex",
          capabilities: ["cto"],
          topics: [],
          metadata: { role: "cto", cto_priority: 5 },
          heartbeat_ttl_ms: 60000,
        });
        isolated.router.registerAgent({
          agent_id: "C",
          cli: "codex",
          capabilities: ["cto"],
          topics: [],
          metadata: { role: "cto", cto_priority: 1 },
          heartbeat_ttl_ms: 60000,
        });
        isolated.router.handlePublish({
          from: "lead",
          to: "topic:cto",
          topic: "cto",
          payload: { decision: "chain failover" },
        });

        isolated.store.db
          .prepare("UPDATE agents SET lease_expires_ms=? WHERE agent_id=?")
          .run(Date.now() - 1, "A");
        isolated.router.reelectStaleRoles();
        const afterA = isolated.router.getStatus("hub");
        assert.equal(afterA.data.roles.cto.leader_agent_id, "B");
        assert.equal(afterA.data.roles.cto.previous_leader_agent_id, "A");

        isolated.store.db
          .prepare("UPDATE agents SET lease_expires_ms=? WHERE agent_id=?")
          .run(Date.now() - 1, "B");
        isolated.router.reelectStaleRoles();
        const afterB = isolated.router.getStatus("hub");
        const cto = afterB.data.roles.cto;
        assert.equal(cto.leader_agent_id, "C");
        assert.equal(cto.previous_leader_agent_id, "B");
        assert.equal(cto.candidate_count, 3);
        assert.equal(cto.live_candidate_count, 1);
        assert.equal(cto.candidates.length, 3);
        assert.equal(
          new Set(cto.candidates.map((candidate) => candidate.agent_id)).size,
          3,
        );
      } finally {
        isolated.cleanup();
      }
    });
  });

  // ── handleAsk ──

  describe("handleAsk()", () => {
    it("await_response_ms=0 일 때 즉시 티켓(correlation_id)을 반환해야 한다", async () => {
      store.registerAgent({
        agent_id: "ask-target",
        cli: "other",
        capabilities: ["x"],
        topics: [],
        heartbeat_ttl_ms: 60000,
      });

      const result = await router.handleAsk({
        from: "asker",
        to: "ask-target",
        topic: "test.ask",
        question: "지금 몇 시야?",
        await_response_ms: 0,
      });

      assert.equal(result.ok, true);
      assert.equal(result.data.state, "queued");
      assert.ok(result.data.correlation_id);
      assert.ok(result.data.request_message_id);
    });

    it("await_response_ms > 0이고 응답 없을 때 delivered 또는 queued 상태를 반환해야 한다", async () => {
      store.registerAgent({
        agent_id: "ask-timeout-target",
        cli: "other",
        capabilities: ["x"],
        topics: [],
        heartbeat_ttl_ms: 60000,
      });

      const result = await router.handleAsk({
        from: "asker2",
        to: "ask-timeout-target",
        topic: "test.ask.timeout",
        question: "응답 없는 질문",
        await_response_ms: 50, // 50ms 대기 후 타임아웃
      });

      assert.equal(result.ok, true);
      assert.ok(
        ["delivered", "queued"].includes(result.data.state),
        `state는 delivered 또는 queued여야 한다 (실제: ${result.data.state})`,
      );
    });
  });

  // ── handleHandoff ──

  describe("handleHandoff()", () => {
    it("handoff_message_id와 assigned_to를 포함한 응답을 반환해야 한다", () => {
      store.registerAgent({
        agent_id: "handoff-target",
        cli: "codex",
        capabilities: ["code"],
        topics: [],
        heartbeat_ttl_ms: 60000,
      });

      const result = router.handleHandoff({
        from: "lead",
        to: "handoff-target",
        topic: "task.handoff",
        task: "테스트 작업을 완료하세요",
        acceptance_criteria: ["테스트 통과"],
      });

      assert.equal(result.ok, true);
      assert.ok(result.data.handoff_message_id);
      assert.equal(result.data.assigned_to, "handoff-target");
      assert.equal(result.data.state, "queued");
    });

    it("만료된 handoff를 발신자에게 dead-letter로 통지한다", async () => {
      router.handleHandoff({
        from: "handoff-sender-dead-letter",
        to: "handoff-ghost-dead-letter",
        topic: "task.handoff",
        task: "만료 통지",
        ttl_ms: 1000,
      });
      await delay(1100);
      router.sweepExpired();
      const notices = router.getPendingMessages("handoff-sender-dead-letter", {
        max_messages: 20,
      });
      const notice = notices.find(
        (message) => message.topic === "handoff.dead_letter",
      );
      assert.ok(notice);
      assert.equal(notice.payload.original_to, "handoff-ghost-dead-letter");
    });
  });

  // ── assignAsync / reportAssignResult ──

  describe("assign job 상태머신", () => {
    it("assignAsync()는 queued assign job을 생성하고 워커에게 메시지를 큐잉해야 한다", () => {
      store.registerAgent({
        agent_id: "assign-worker-a",
        cli: "codex",
        capabilities: ["code"],
        topics: [],
        heartbeat_ttl_ms: 60000,
      });

      const result = router.assignAsync({
        supervisor_agent: "assign-lead-a",
        worker_agent: "assign-worker-a",
        task: "README를 점검하라",
        max_retries: 1,
      });

      assert.equal(result.ok, true);
      assert.equal(result.data.status, "queued");
      assert.ok(result.data.job_id);

      const pending = router.getPendingMessages("assign-worker-a", {
        max_messages: 10,
      });
      assert.ok(
        pending.some(
          (message) => message.payload?.assign_job_id === result.data.job_id,
        ),
      );
    });

    it("reportAssignResult()는 completed + metadata.result를 succeeded로 정규화해야 한다", () => {
      const created = router.assignAsync({
        supervisor_agent: "assign-lead-success",
        worker_agent: "assign-worker-success",
        task: "성공 케이스",
      });

      const running = router.reportAssignResult({
        job_id: created.data.job_id,
        worker_agent: "assign-worker-success",
        status: "running",
        attempt: 1,
      });
      assert.equal(running.ok, true);
      assert.equal(running.data.status, "running");

      const done = router.reportAssignResult({
        job_id: created.data.job_id,
        worker_agent: "assign-worker-success",
        status: "completed",
        attempt: 1,
        metadata: { result: "success" },
        result: { summary: "ok" },
      });

      assert.equal(done.ok, true);
      assert.equal(done.data.status, "succeeded");
      assert.deepEqual(done.data.result, { summary: "ok" });

      const supervisorMessages = router.getPendingMessages(
        "assign-lead-success",
        { max_messages: 20 },
      );
      assert.ok(
        supervisorMessages.some(
          (message) =>
            message.topic === "assign.result" &&
            message.payload?.job_id === created.data.job_id &&
            message.payload?.status === "succeeded",
        ),
      );
    });

    it("failed 결과는 max_retries 한도 내에서 자동 재시도되어야 한다", () => {
      const created = router.assignAsync({
        supervisor_agent: "assign-lead-retry",
        worker_agent: "assign-worker-retry",
        task: "재시도 케이스",
        max_retries: 1,
      });

      const failed = router.reportAssignResult({
        job_id: created.data.job_id,
        worker_agent: "assign-worker-retry",
        status: "failed",
        attempt: 1,
        error: { message: "실패" },
      });

      assert.equal(failed.ok, true);
      assert.equal(failed.data.retried, true);
      assert.equal(failed.data.status, "queued");
      assert.equal(failed.data.retry_count, 1);
      assert.equal(failed.data.attempt, 2);
    });

    it("sweepTimedOutAssigns()는 만료된 assign을 timed_out 또는 retry로 처리해야 한다", () => {
      const job = store.createAssign({
        supervisor_agent: "assign-lead-timeout",
        worker_agent: "assign-worker-timeout",
        task: "타임아웃 케이스",
        max_retries: 0,
        deadline_ms: Date.now() - 10,
      });

      const result = router.sweepTimedOutAssigns();
      assert.equal(result.timed_out >= 1, true);

      const updated = store.getAssign(job.job_id);
      assert.equal(updated.status, "timed_out");
    });

    it("최초 배달 시 deadline을 재장전하고 dispatched_at_ms를 기록한다", () => {
      store.registerAgent({
        agent_id: "assign-worker-dispatch",
        cli: "codex",
        capabilities: [],
        topics: [],
        heartbeat_ttl_ms: 60000,
      });
      const created = router.assignAsync({
        supervisor_agent: "assign-lead-dispatch",
        worker_agent: "assign-worker-dispatch",
        task: "delivery",
        timeout_ms: 5000,
      });
      const before = store.getAssign(created.data.job_id);
      assert.equal(before.dispatched_at_ms, null);
      router.drainAgent("assign-worker-dispatch", { max_messages: 10 });
      const after = store.getAssign(created.data.job_id);
      assert.ok(after.dispatched_at_ms >= before.created_at_ms);
      assert.equal(after.deadline_ms, after.dispatched_at_ms + 5000);
    });

    it("attempt mismatch 결과를 supervisor에게 late_result로 보존한다", () => {
      const created = router.assignAsync({
        supervisor_agent: "assign-lead-late",
        worker_agent: "assign-worker-late",
        task: "late",
        max_retries: 1,
      });
      router.retryAssign(created.data.job_id);
      const late = router.reportAssignResult({
        job_id: created.data.job_id,
        worker_agent: "assign-worker-late",
        status: "completed",
        attempt: 1,
        result: { summary: "late" },
      });
      assert.equal(late.ok, false);
      assert.equal(late.error.code, "ASSIGN_ATTEMPT_MISMATCH");
      assert.equal(late.error.details.preserved, true);
      const notices = router.getPendingMessages("assign-lead-late", {
        max_messages: 20,
      });
      assert.ok(
        notices.some(
          (message) =>
            message.topic === "assign.result" &&
            message.payload?.event === "late_result",
        ),
      );
      assert.equal(store.getAssign(created.data.job_id).status, "queued");
    });

    it("timeout 시 원 워커에 assign.cancel 이벤트를 발행한다", () => {
      const job = store.createAssign({
        supervisor_agent: "assign-lead-cancel",
        worker_agent: "assign-worker-cancel",
        task: "cancel",
        max_retries: 1,
        deadline_ms: Date.now() - 10,
      });
      router.sweepTimedOutAssigns();
      const messages = router.getPendingMessages("assign-worker-cancel", {
        max_messages: 20,
      });
      assert.ok(
        messages.some(
          (message) =>
            message.topic === "assign.cancel" &&
            message.payload.assign_job_id === job.job_id,
        ),
      );
    });
  });

  // ── getStatus ──

  describe("getStatus()", () => {
    it('scope=hub 일 때 hub.state === "healthy"를 반환해야 한다', () => {
      const result = router.getStatus("hub");
      assert.equal(result.ok, true);
      assert.equal(result.data.hub.state, "healthy");
      assert.ok(result.data.hub.uptime_ms >= 0);
    });

    it("scope=hub 일 때 queues 메트릭을 포함해야 한다", () => {
      const result = router.getStatus("hub", { include_metrics: true });
      assert.ok("queues" in result.data);
      assert.equal(typeof result.data.queues.urgent_depth, "number");
      assert.equal(typeof result.data.queues.normal_depth, "number");
      assert.equal(typeof result.data.queues.dlq_depth, "number");
    });

    it("scope=agent 일 때 등록된 에이전트 정보를 반환해야 한다", () => {
      store.registerAgent({
        agent_id: "status-check-agent",
        cli: "claude",
        capabilities: ["x"],
        topics: [],
        heartbeat_ttl_ms: 60000,
      });

      const result = router.getStatus("agent", {
        agent_id: "status-check-agent",
      });
      assert.equal(result.ok, true);
      assert.equal(result.data.agent.agent_id, "status-check-agent");
    });

    it("scope=trace 일 때 해당 trace_id 메시지 목록을 반환해야 한다", () => {
      const tid = randomUUID();
      store.enqueueMessage({
        type: "event",
        from: "tracer",
        to: "tracee",
        topic: "trace.test",
        payload: {},
        trace_id: tid,
      });

      const result = router.getStatus("trace", { trace_id: tid });
      assert.equal(result.ok, true);
      assert.ok(Array.isArray(result.data.trace));
      assert.ok(result.data.trace.some((m) => m.trace_id === tid));
    });
  });

  // ── 스위퍼 ──

  describe("startSweeper() / stopSweeper()", () => {
    it("startSweeper() 는 중복 호출해도 타이머를 하나만 유지해야 한다", () => {
      // 별도 router 인스턴스로 테스트 (메인 router 오염 방지)
      const r2 = createRouter(store);
      r2.startSweeper();
      r2.startSweeper(); // 중복 — 무시되어야 함
      r2.stopSweeper();
      // 에러 없이 완료되면 성공
      assert.ok(true);
    });

    it("stopSweeper() 는 미시작 상태에서도 안전해야 한다", () => {
      const r3 = createRouter(store);
      r3.stopSweeper(); // 시작 안 했어도 에러 없어야 함
      assert.ok(true);
    });
  });
});
