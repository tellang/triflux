import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createRoleActivator } from "../../hub/role-activator.mjs";
import { encodeRoleKey, roleTopicAddress } from "../../hub/role-contract.mjs";
import { createRouter } from "../../hub/router.mjs";
import { createStore } from "../../hub/store.mjs";
import { SQLITE_SKIP } from "../helpers/sqlite.mjs";

const PROJECT_ID = `prj_${"r".repeat(22)}`;
const CTO_KEY = { project_id: PROJECT_ID, role_kind: "cto" };
const CTO_WIRE = encodeRoleKey(CTO_KEY);
const TEMP_DIRS = [];

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "tfx-role-router-"));
  TEMP_DIRS.push(dir);
  return createStore(join(dir, "hub.db"));
}

function fakeActivator() {
  const calls = [];
  const expiryCalls = [];
  return {
    calls,
    expiryCalls,
    requestEnsureRole(request) {
      calls.push(request);
      return {
        accepted: true,
        disposition: "started",
        role_key_wire: encodeRoleKey(request.role_key),
        state: "elected-probing",
        epoch: 1,
        activation_id: "activation-router",
      };
    },
    getRoleSnapshot: () => ({
      role_key: CTO_KEY,
      role_key_wire: CTO_WIRE,
      state: "elected-probing",
      epoch: 1,
    }),
    ensureExpiredRoles(now) {
      expiryCalls.push(now);
      return [];
    },
  };
}

afterEach(() => {
  while (TEMP_DIRS.length > 0) {
    rmSync(TEMP_DIRS.pop(), { recursive: true, force: true });
  }
});

describe("router role activator integration", { skip: SQLITE_SKIP }, () => {
  it("keeps no-holder publish durable, returns immediately with a receipt, and ensures CTO after SessionStart registration", () => {
    const store = tempStore();
    const activator = fakeActivator();
    const router = createRouter(store, { roleActivator: activator });
    try {
      const registered = router.registerAgent({
        agent_id: "session-router-citizen",
        cli: "claude",
        capabilities: ["code"],
        topics: [],
        heartbeat_ttl_ms: 120_000,
        project_id: PROJECT_ID,
        session_id: "session-router-citizen",
      });
      assert.equal(registered.ok, true);
      assert.equal(activator.calls.length, 1);
      assert.equal(activator.calls[0].trigger, "session_start");
      assert.deepEqual(activator.calls[0].role_key, CTO_KEY);

      activator.calls.length = 0;
      const published = router.handlePublish({
        from: "session-router-citizen",
        to: roleTopicAddress(CTO_KEY),
        topic: "role.work",
        payload: { task: "preserve me" },
      });

      assert.equal(published.ok, true);
      assert.equal(published.data.fanout_count, 0);
      assert.equal(published.data.activation.disposition, "started");
      assert.equal(published.data.activation.role_key_wire, CTO_WIRE);
      assert.equal(activator.calls.length, 1);
      assert.equal(activator.calls[0].trigger, "publish_no_holder");
      assert.deepEqual(
        store.listPendingRoleMessages(CTO_WIRE, Date.now()).map((msg) => ({
          id: msg.id,
          status: msg.status,
          role_key_wire: msg.role_key_wire,
        })),
        [
          {
            id: published.data.message_id,
            status: "queued",
            role_key_wire: CTO_WIRE,
          },
        ],
      );
    } finally {
      store.close();
    }
  });

  it("routes legacy route(msg) and v2 handlePublish through the same scoped activation path", () => {
    const store = tempStore();
    const activator = fakeActivator();
    const router = createRouter(store, { roleActivator: activator });
    try {
      router.registerAgent({
        agent_id: "legacy-router-citizen",
        cli: "codex",
        capabilities: ["code"],
        topics: [],
        heartbeat_ttl_ms: 120_000,
        project_id: PROJECT_ID,
        session_id: "legacy-router-citizen",
      });
      activator.calls.length = 0;

      const legacyMessage = store.auditLog({
        type: "event",
        from: "legacy-router-citizen",
        to: "topic:cto",
        topic: "legacy.role.work",
        payload: { task: "legacy" },
      });
      assert.equal(router.route(legacyMessage), 0);
      router.handlePublish({
        from: "legacy-router-citizen",
        to: roleTopicAddress(CTO_KEY),
        topic: "v2.role.work",
        payload: { task: "v2" },
      });

      assert.equal(activator.calls.length, 2);
      assert.deepEqual(
        activator.calls.map((call) => call.role_key),
        [CTO_KEY, CTO_KEY],
      );
      assert.deepEqual(
        activator.calls.map((call) => call.trigger),
        ["publish_no_holder", "publish_no_holder"],
      );
    } finally {
      store.close();
    }
  });

  it("keeps a no-holder publish durable when activation reservation throws", () => {
    const store = tempStore();
    const router = createRouter(store, {
      roleActivator: {
        requestEnsureRole() {
          const error = new Error("database busy");
          error.code = "SQLITE_BUSY";
          throw error;
        },
        getRoleSnapshot: () => null,
      },
    });
    try {
      router.registerAgent({
        agent_id: "fault-router-citizen",
        cli: "claude",
        capabilities: ["code"],
        topics: [],
        heartbeat_ttl_ms: 120_000,
        project_id: PROJECT_ID,
        session_id: "fault-router-citizen",
      });
      const published = router.handlePublish({
        from: "fault-router-citizen",
        to: roleTopicAddress(CTO_KEY),
        topic: "role.work",
        payload: { task: "preserve on activator fault" },
      });
      assert.equal(published.ok, true);
      assert.equal(published.data.fanout_count, 0);
      assert.equal(published.data.activation, undefined);
      assert.equal(
        store.listPendingRoleMessages(CTO_WIRE, Date.now()).length,
        1,
      );
    } finally {
      store.close();
    }
  });

  it("preserves legacy topic:cto delivery while the v2 manager is disabled", () => {
    const store = tempStore();
    const activator = {
      requestEnsureRole: () => ({
        accepted: false,
        disposition: "manager_disabled",
        role_key_wire: CTO_WIRE,
        state: "electable",
        epoch: 0,
      }),
      getRoleSnapshot: () => null,
      isRoleManaged: () => false,
    };
    const router = createRouter(store, { roleActivator: activator });
    try {
      router.registerAgent({
        agent_id: "legacy-cto-holder",
        cli: "claude",
        capabilities: ["code"],
        topics: ["cto"],
        heartbeat_ttl_ms: 120_000,
        metadata: { is_cto: true },
        project_id: PROJECT_ID,
        session_id: "legacy-cto-holder",
      });
      const published = router.handlePublish({
        from: "legacy-cto-holder",
        to: "topic:cto",
        topic: "legacy.compat",
        payload: { project_id: PROJECT_ID, task: "deliver through v1" },
      });
      assert.equal(published.data.fanout_count, 1);
      assert.equal(
        router.getPendingMessages("legacy-cto-holder")[0].id,
        published.data.message_id,
      );
    } finally {
      store.close();
    }
  });

  it("connects the stale-role sweeper to scoped lease expiry activation", () => {
    const store = tempStore();
    const activator = fakeActivator();
    const router = createRouter(store, { roleActivator: activator });
    try {
      router.reelectStaleRoles({ reason: "lease-test" });
      assert.equal(activator.expiryCalls.length, 1);
      assert.equal(Number.isFinite(activator.expiryCalls[0]), true);
    } finally {
      store.close();
    }
  });

  it("keeps legacy CTO re-election alive when scoped expiry activation throws", () => {
    const store = tempStore();
    const warnings = [];
    const activatorError = new Error("role store unavailable");
    const router = createRouter(store, {
      roleActivator: {
        ensureExpiredRoles() {
          throw activatorError;
        },
      },
      logger: {
        warn(payload, event) {
          warnings.push({ payload, event });
        },
      },
    });
    try {
      store.registerAgent({
        agent_id: "legacy-cto-fallback",
        cli: "claude",
        capabilities: ["cto"],
        topics: [],
        metadata: { role: "cto", cto_priority: 10 },
        heartbeat_ttl_ms: 120_000,
      });

      router.reelectStaleRoles({ reason: "activator-fault" });

      assert.equal(
        router.getStatus("hub").data.roles.cto.leader_agent_id,
        "legacy-cto-fallback",
      );
      assert.deepEqual(warnings, [
        {
          payload: { err: activatorError },
          event: "role_activator.expiry_sweep_degraded",
        },
      ]);
    } finally {
      store.close();
    }
  });

  it("transfers scoped backlog only for the current active holder fence", () => {
    const store = tempStore();
    const activator = fakeActivator();
    const router = createRouter(store, { roleActivator: activator });
    try {
      router.registerAgent({
        agent_id: "current-role-holder",
        cli: "codex",
        capabilities: ["role:cto:candidate"],
        topics: [],
        heartbeat_ttl_ms: 120_000,
        project_id: PROJECT_ID,
        session_id: "current-role-holder",
      });
      const published = router.handlePublish({
        from: "current-role-holder",
        to: roleTopicAddress(CTO_KEY),
        topic: "role.work",
        payload: { task: "fenced backlog" },
      });
      assert.equal(published.data.fanout_count, 0);

      const reserved = store.upsertRoleReservation({
        role_key_wire: CTO_WIRE,
        holder_agent_id: "current-role-holder",
        holder_lease_expires_ms: Date.now() + 60_000,
        state: "elected-probing",
        activation_id: "activation-current",
        activation_deadline_ms: Date.now() + 45_000,
        charter_version: "charter.v1",
        last_transition_ms: Date.now(),
        last_reason: "test_reservation",
      });
      const activated = store.compareAndSetRole({
        role_key_wire: CTO_WIRE,
        expected_version: reserved.role.version,
        expected_epoch: reserved.role.epoch,
        expected_activation_seq: reserved.role.activation_seq,
        expected_activation_id: reserved.role.activation_id,
        patch: {
          state: "active",
          charter_acked_epoch: reserved.role.epoch,
          activation_deadline_ms: null,
          last_reason: "activation_acked",
        },
      });
      assert.equal(activated.ok, true);

      assert.equal(
        router.activateScopedRoleHolder({
          ...activated.role,
          holder_agent_id: "stale-role-holder",
        }),
        0,
      );
      assert.equal(router.countPendingMessages("current-role-holder"), 0);

      assert.equal(router.activateScopedRoleHolder(activated.role), 1);
      assert.equal(router.countPendingMessages("current-role-holder"), 1);
      assert.equal(
        router.getPendingMessages("current-role-holder")[0].id,
        published.data.message_id,
      );
    } finally {
      store.close();
    }
  });

  it("keeps backlog and makes zero transport calls when the manager is disabled", () => {
    const store = tempStore();
    let transportCalls = 0;
    const activator = createRoleActivator({
      store,
      adapter: {
        supports: () => true,
        probe: async () => {
          transportCalls += 1;
        },
        wake: async () => {
          transportCalls += 1;
        },
        standup: async () => {
          transportCalls += 1;
        },
        cancel: async () => {},
      },
      getControlSnapshot: () => ({
        generation: 1,
        master_enabled: true,
        cto_manager_enabled: false,
        lead_manager_enabled: false,
      }),
      getCharterVersion: () => "charter.v1",
    });
    const router = createRouter(store, { roleActivator: activator });
    try {
      router.registerAgent({
        agent_id: "ordinary-caller",
        cli: "claude",
        capabilities: ["code"],
        topics: [],
        heartbeat_ttl_ms: 120_000,
        project_id: PROJECT_ID,
        session_id: "ordinary-caller",
      });
      const published = router.handlePublish({
        from: "ordinary-caller",
        to: roleTopicAddress(CTO_KEY),
        topic: "role.work",
        payload: { task: "stay queued" },
      });

      assert.equal(published.data.fanout_count, 0);
      assert.equal(published.data.activation.disposition, "manager_disabled");
      assert.equal(transportCalls, 0);
      assert.equal(store.getRole(CTO_WIRE), null);
      assert.equal(
        store.listPendingRoleMessages(CTO_WIRE, Date.now()).length,
        1,
      );
    } finally {
      activator.close();
      store.close();
    }
  });
});
