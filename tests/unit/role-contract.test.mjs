import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decodeRoleKey,
  encodeRoleKey,
  LEGACY_ROLE_SNAPSHOT_FIELDS,
  normalizeRoleKey,
  projectLegacyCtoStatus,
  ROLE_REACHABILITY_TRANSITIONS,
  reduceRoleReachabilityTransition,
  roleTopicAddress,
} from "../../hub/role-contract.mjs";

const PROJECT_ID = "prj_AbCdEfGhIjKlMnOpQrStUv";
const SCOPE_ID = "scp_ZyXwVuTsRqPoNmLkJiHgFe";

describe("role contract kernel", () => {
  it("canonicalizes RoleKeys independently of input property order", () => {
    const key = {
      role_kind: "lead",
      scope_id: SCOPE_ID,
      project_id: PROJECT_ID,
    };
    const canonical = {
      project_id: PROJECT_ID,
      role_kind: "lead",
      scope_id: SCOPE_ID,
    };

    const wire = encodeRoleKey(key);
    assert.equal(wire, encodeRoleKey(canonical));
    assert.deepEqual(decodeRoleKey(wire), canonical);
    assert.equal(roleTopicAddress(key), `topic:role:${wire}`);
  });

  it("rejects invalid, noncanonical, and structurally invalid RoleKeys", () => {
    assert.throws(
      () =>
        normalizeRoleKey({
          project_id: PROJECT_ID,
          role_kind: "cto",
          scope_id: SCOPE_ID,
        }),
      { code: "ROLE_SCOPE_FORBIDDEN" },
    );
    assert.throws(
      () => normalizeRoleKey({ project_id: PROJECT_ID, role_kind: "lead" }),
      { code: "SCOPE_REQUIRED" },
    );
    assert.throws(
      () => normalizeRoleKey({ project_id: PROJECT_ID, role_kind: "owner" }),
      { code: "ROLE_KIND_UNSUPPORTED" },
    );
    assert.throws(
      () =>
        normalizeRoleKey({
          project_id: PROJECT_ID,
          role_kind: "cto",
          extra: true,
        }),
      { code: "ROLE_KEY_FIELD_UNSUPPORTED" },
    );
    assert.throws(
      () =>
        decodeRoleKey(
          "rk2.eyJyb2xlX2tpbmQiOiJjdG8iLCJwcm9qZWN0X2lkIjoicHJqX0FiQ2RFZkdoSWpLbE1uT3BRclN0VXYifQ",
        ),
      {
        code: "ROLE_KEY_NON_CANONICAL",
      },
    );
  });

  it("implements every declared reachability transition including charter reissue", () => {
    for (const rule of ROLE_REACHABILITY_TRANSITIONS) {
      const result = reduceRoleReachabilityTransition(rule.from, rule.trigger);
      assert.equal(result.state, rule.to, `${rule.from} + ${rule.trigger}`);
    }

    assert.deepEqual(
      reduceRoleReachabilityTransition("active", "charter_reissued"),
      { state: "elected-probing", action: "reserve_reack" },
    );
    assert.throws(
      () => reduceRoleReachabilityTransition("active", "probe_succeeded"),
      {
        code: "INVALID_ROLE_TRANSITION",
      },
    );
  });

  it("projects a v2 CTO snapshot to every legacy snapshot field", () => {
    const result = projectLegacyCtoStatus(
      {
        schema_version: "tfx.roles.v2",
        generated_at_ms: 123,
        items: [
          {
            role_key: { project_id: PROJECT_ID, role_kind: "cto" },
            role_key_wire: encodeRoleKey({
              project_id: PROJECT_ID,
              role_kind: "cto",
            }),
            state: "active",
            holder_agent_id: "agent-1",
            previous_holder_agent_id: "agent-0",
            epoch: 4,
            lease_expires_ms: 456,
            charter_version: "charter-1",
            charter_acked: true,
            activation_id: "act-1",
            candidate_count: 2,
            live_candidate_count: 1,
            reachable_candidate_count: 1,
            excluded_candidate_count: 0,
            pending_count: 3,
            last_transition_ms: 100,
            last_reason: "activation_acked",
            blocked_reason: null,
            legacy: {
              candidate_source: "grant",
              transferred_count: 5,
              candidates: [
                {
                  agent_id: "agent-1",
                  status: "online",
                  source: "grant",
                  priority: 1,
                  last_seen_ms: 99,
                  lease_expires_ms: 456,
                },
              ],
            },
          },
        ],
      },
      PROJECT_ID,
    );

    assert.deepEqual(Object.keys(result.cto), LEGACY_ROLE_SNAPSHOT_FIELDS);
    assert.equal(result.cto.status, "active");
    assert.equal(result.cto.leader_agent_id, "agent-1");
    assert.equal(result.cto.transferred_count, 5);
    assert.equal(result.cto.candidates.length, 1);
  });
});
