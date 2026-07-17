import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import { createPipeServer } from "../../hub/pipe.mjs";
import { createTools } from "../../hub/tools.mjs";

const PROJECT_ID = `prj_${"w".repeat(22)}`;
const ROLE_KEY = { project_id: PROJECT_ID, role_kind: "cto" };

function routerDouble() {
  const ensureCalls = [];
  const ackCalls = [];
  return {
    ensureCalls,
    ackCalls,
    deliveryEmitter: new EventEmitter(),
    requestEnsureRole(request, context) {
      ensureCalls.push({ request, context });
      return {
        accepted: true,
        disposition: "started",
        role_key_wire: "rk2.test",
        state: "elected-probing",
        epoch: 1,
      };
    },
    ackRoleActivation(ack, context) {
      ackCalls.push({ ack, context });
      if (context?.principal?.agent_id !== ack.holder_agent_id) {
        return { ok: false, code: "HOLDER_MISMATCH" };
      }
      return { ok: true, role: { state: "active" } };
    },
  };
}

function ensurePayload() {
  return {
    schema_version: "tfx.ensure-role.v1",
    role_key: ROLE_KEY,
    trigger: "manual",
    cause_id: "wire-test",
  };
}

function ackPayload() {
  return {
    schema_version: "tfx.role-activation-ack.v1",
    activation_id: "activation-wire",
    role_key: ROLE_KEY,
    epoch: 1,
    activation_seq: 1,
    holder_agent_id: "role-holder",
    reachable: true,
    charter_ack: {
      role_key: ROLE_KEY,
      epoch: 1,
      charter_version: "charter.v1",
    },
  };
}

describe("role activator wire surfaces", () => {
  it("does not expose unauthenticated role lifecycle actions through MCP tools", () => {
    const router = routerDouble();
    const tools = createTools({}, router, null);
    const ensureTool = tools.find((tool) => tool.name === "ensure_role");
    const ackTool = tools.find((tool) => tool.name === "ack_role_activation");
    assert.equal(ensureTool, undefined);
    assert.equal(ackTool, undefined);
  });

  it("dispatches ensure_role and binds activation ACK to the pipe connection", async () => {
    const router = routerDouble();
    const pipe = createPipeServer({ router, sessionId: "role-wire-test" });

    const ensureResult = await pipe.executeCommand(
      "ensure_role",
      ensurePayload(),
    );
    const forgedAck = await pipe.executeCommand(
      "ack_role_activation",
      ackPayload(),
    );
    const ackResult = await pipe.executeCommand(
      "ack_role_activation",
      ackPayload(),
      { agent_id: "role-holder" },
    );

    assert.equal(ensureResult.disposition, "started");
    assert.equal(forgedAck.ok, false);
    assert.equal(forgedAck.code, "HOLDER_MISMATCH");
    assert.equal(ackResult.ok, true);
    assert.equal(router.ensureCalls.length, 1);
    assert.equal(router.ackCalls.length, 2);
    assert.equal(router.ackCalls[0].context.principal.agent_id, undefined);
    assert.equal(router.ackCalls[1].context.principal.agent_id, "role-holder");
  });

  it("rejects ensure_role from a pipe connection before agent registration", async () => {
    const router = routerDouble();
    const pipe = createPipeServer({ router, sessionId: "role-wire-auth-test" });

    const result = await pipe.executeCommand("ensure_role", ensurePayload(), {
      connection_bound: true,
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "PRINCIPAL_REQUIRED");
    assert.equal(router.ensureCalls.length, 0);
  });
});
