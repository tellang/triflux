import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { encodeRoleKey } from "../../hub/role-contract.mjs";
import { createStore } from "../../hub/store.mjs";
import { SQLITE_SKIP } from "../helpers/sqlite.mjs";

const TEMP_DIRS = [];
const PROJECT_A = `prj_${"a".repeat(22)}`;
const PROJECT_B = `prj_${"b".repeat(22)}`;
const SCOPE_A = `scp_${"a".repeat(22)}`;
const CTO_A = encodeRoleKey({ project_id: PROJECT_A, role_kind: "cto" });
const CTO_B = encodeRoleKey({ project_id: PROJECT_B, role_kind: "cto" });
const LEAD_A = encodeRoleKey({
  project_id: PROJECT_A,
  role_kind: "lead",
  scope_id: SCOPE_A,
});

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), "tfx-role-registry-"));
  TEMP_DIRS.push(dir);
  return join(dir, "hub.db");
}

function reserve(store, overrides = {}) {
  return store.upsertRoleReservation({
    role_key_wire: CTO_A,
    holder_agent_id: "agent-1",
    holder_lease_expires_ms: 500,
    activation_id: "activation-1",
    last_transition_ms: 100,
    last_reason: "candidate_selected",
    ...overrides,
  });
}

function insertRawRole(store, row) {
  store.db
    .prepare(`
      INSERT INTO role_registry (
        role_key_wire, project_id, role_kind, scope_id, state,
        last_transition_ms, last_reason
      ) VALUES (
        @role_key_wire, @project_id, @role_kind, @scope_id, @state,
        1, 'test'
      )
    `)
    .run(row);
}

afterEach(() => {
  while (TEMP_DIRS.length > 0) {
    rmSync(TEMP_DIRS.pop(), { recursive: true, force: true });
  }
});

describe("hub store role registry", { skip: SQLITE_SKIP }, () => {
  it("round-trips reservations and lists filtered role keys", () => {
    const store = createStore(tempDbPath());
    try {
      const result = reserve(store);
      assert.equal(result.ok, true);
      assert.deepEqual(store.getRole(CTO_A), result.role);
      assert.deepEqual(store.listRoleKeys({ project_id: PROJECT_A }), [CTO_A]);

      const staleVersion = reserve(store, {
        expected_version: result.role.version - 1,
      });
      assert.equal(staleVersion.ok, false);
      assert.equal(staleVersion.reason, "stale_version");

      const staleEpoch = reserve(store, {
        expected_version: result.role.version,
        expected_epoch: result.role.epoch - 1,
      });
      assert.equal(staleEpoch.ok, false);
      assert.equal(staleEpoch.reason, "stale_epoch");
    } finally {
      store.close();
    }
  });

  it("applies CAS once and rejects stale version and epoch guards", () => {
    const store = createStore(tempDbPath());
    try {
      const reserved = reserve(store).role;
      const activated = store.compareAndSetRole({
        role_key_wire: CTO_A,
        expected_version: reserved.version,
        expected_epoch: reserved.epoch,
        expected_activation_seq: reserved.activation_seq,
        expected_activation_id: reserved.activation_id,
        patch: {
          state: "active",
          charter_acked_epoch: reserved.epoch,
          last_transition_ms: 200,
          last_reason: "activation_acked",
        },
      });
      assert.equal(activated.ok, true);
      assert.equal(activated.role.version, reserved.version + 1);
      assert.equal(activated.role.state, "active");

      const staleVersion = store.compareAndSetRole({
        role_key_wire: CTO_A,
        expected_version: reserved.version,
        expected_epoch: reserved.epoch,
        expected_activation_seq: reserved.activation_seq,
        expected_activation_id: reserved.activation_id,
        patch: { state: "unreachable" },
      });
      assert.equal(staleVersion.ok, false);
      assert.equal(staleVersion.reason, "stale_version");

      const staleEpoch = store.compareAndSetRole({
        role_key_wire: CTO_A,
        expected_version: activated.role.version,
        expected_epoch: activated.role.epoch - 1,
        expected_activation_seq: activated.role.activation_seq,
        expected_activation_id: activated.role.activation_id,
        patch: { state: "unreachable" },
      });
      assert.equal(staleEpoch.ok, false);
      assert.equal(staleEpoch.reason, "stale_epoch");

      const staleActivation = store.compareAndSetRole({
        role_key_wire: CTO_A,
        expected_version: activated.role.version,
        expected_epoch: activated.role.epoch,
        expected_activation_seq: activated.role.activation_seq,
        expected_activation_id: "older-activation",
        patch: { state: "unreachable" },
      });
      assert.equal(staleActivation.ok, false);
      assert.equal(staleActivation.reason, "stale_activation_id");
    } finally {
      store.close();
    }
  });

  it("enforces role kind/scope and reachability CHECK constraints", () => {
    const store = createStore(tempDbPath());
    try {
      const invalidRows = [
        {
          role_key_wire: "invalid-cto-scope",
          project_id: PROJECT_A,
          role_kind: "cto",
          scope_id: SCOPE_A,
          state: "electable",
        },
        {
          role_key_wire: "invalid-lead-scope",
          project_id: PROJECT_A,
          role_kind: "lead",
          scope_id: "",
          state: "electable",
        },
        {
          role_key_wire: "invalid-active-without-holder",
          project_id: PROJECT_A,
          role_kind: "cto",
          scope_id: "",
          state: "active",
        },
        {
          role_key_wire: "invalid-state",
          project_id: PROJECT_A,
          role_kind: "cto",
          scope_id: "",
          state: "offline",
        },
      ];
      for (const row of invalidRows) {
        assert.throws(
          () => insertRawRole(store, row),
          /CHECK constraint failed/,
        );
      }
    } finally {
      store.close();
    }
  });

  it("enforces unique project/kind/scope identity", () => {
    const store = createStore(tempDbPath());
    try {
      insertRawRole(store, {
        role_key_wire: CTO_A,
        project_id: PROJECT_A,
        role_kind: "cto",
        scope_id: "",
        state: "electable",
      });
      assert.throws(
        () =>
          insertRawRole(store, {
            role_key_wire: "different-wire-same-role",
            project_id: PROJECT_A,
            role_kind: "cto",
            scope_id: "",
            state: "electable",
          }),
        /UNIQUE constraint failed/,
      );
    } finally {
      store.close();
    }
  });

  it("persists roles across restart and exposes expired holders", () => {
    const dbPath = tempDbPath();
    const first = createStore(dbPath);
    const persisted = reserve(first, {
      state: "active",
      holder_lease_expires_ms: 999,
    }).role;
    first.close();

    const second = createStore(dbPath);
    try {
      assert.deepEqual(second.getRole(CTO_A), persisted);
      assert.deepEqual(
        second
          .listRolesWithExpiredHolder(1000)
          .map((role) => role.role_key_wire),
        [CTO_A],
      );
      assert.deepEqual(second.listRolesWithExpiredHolder(998), []);
    } finally {
      second.close();
    }
  });

  it("upserts candidate reachability and cascades deletes", () => {
    const store = createStore(tempDbPath());
    try {
      reserve(store);
      const candidate = store.upsertRoleCandidate({
        role_key_wire: CTO_A,
        agent_id: "candidate-1",
        source: "standup",
        priority: 10,
        transport_locators: [{ kind: "pipe", path: "/tmp/agent-1" }],
        updated_at_ms: 100,
      });
      assert.deepEqual(candidate.transport_locators, [
        { kind: "pipe", path: "/tmp/agent-1" },
      ]);

      const failed = store.updateCandidateReachability({
        role_key_wire: CTO_A,
        agent_id: "candidate-1",
        probe_failed: true,
        excluded_until_ms: 5000,
        last_probe_ms: 200,
        last_probe_code: "ECONNREFUSED",
        updated_at_ms: 201,
      });
      assert.equal(failed.ok, true);
      assert.equal(failed.candidate.consecutive_probe_failures, 1);
      assert.equal(failed.candidate.excluded_until_ms, 5000);
      assert.deepEqual(store.listRoleCandidates(CTO_A), [failed.candidate]);

      store.db
        .prepare("DELETE FROM role_registry WHERE role_key_wire=?")
        .run(CTO_A);
      assert.deepEqual(store.listRoleCandidates(CTO_A), []);
    } finally {
      store.close();
    }
  });

  it("lists durable pending messages and fences persisted activations on recovery", () => {
    const store = createStore(tempDbPath());
    try {
      reserve(store, { holder_lease_expires_ms: 50 });
      store.auditLog({
        type: "event",
        from: "agent-1",
        to: `topic:role:${CTO_A}`,
        topic: "role.work",
        ttl_ms: 1000,
        role_key_wire: CTO_A,
      });
      assert.equal(store.listPendingRoleMessages(CTO_A, Date.now()).length, 1);

      const recovered = store.recoverRoleRegistry(100);
      assert.equal(recovered.roles[0].state, "electable");
      assert.equal(recovered.roles[0].holder_agent_id, null);
      assert.equal(recovered.roles[0].epoch, 1);
      assert.equal(recovered.pending_messages.length, 1);

      reserve(store, {
        role_key_wire: CTO_B,
        holder_agent_id: null,
        state: "electable",
      });
      reserve(store, {
        role_key_wire: LEAD_A,
        holder_agent_id: null,
        state: "electable",
      });
      assert.deepEqual(store.listRoleKeys({ role_kind: "lead" }), [LEAD_A]);
    } finally {
      store.close();
    }
  });
});
