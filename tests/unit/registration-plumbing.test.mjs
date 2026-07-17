import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { decodeRoleKey, encodeRoleKey } from "../../hub/role-contract.mjs";
import { createRouter } from "../../hub/router.mjs";
import { createStore } from "../../hub/store.mjs";
import { buildSynapseRegistrationMeta } from "../../hub/team/synapse-http.mjs";
import { SQLITE_SKIP } from "../helpers/sqlite.mjs";

const PROJECT_ID = `prj_${"A".repeat(22)}`;
const HOST_ID = `hst_${"B".repeat(22)}`;
const TEMP_DIRS = [];

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "tfx-registration-plumbing-"));
  TEMP_DIRS.push(dir);
  const store = createStore(join(dir, "hub.db"));
  return { store, router: createRouter(store) };
}

function tmuxLocator(expiresAtMs = Date.now() + 60000) {
  return {
    schema_version: "tfx.transport-locator.v1",
    transport_id: "trn_codex_tmux",
    kind: "tmux",
    host_id: HOST_ID,
    capabilities: ["probe", "wake", "activate", "interrupt"],
    priority: 100,
    expires_at_ms: expiresAtMs,
    locator: {
      session_name: "codex-worker",
      mux_server_id: "mux_local",
    },
  };
}

afterEach(() => {
  while (TEMP_DIRS.length > 0) {
    rmSync(TEMP_DIRS.pop(), { recursive: true, force: true });
  }
});

describe("registration scoped identity plumbing", { skip: SQLITE_SKIP }, () => {
  it("stores scoped identity and normalized transport locators round-trip", () => {
    const { store, router } = tempStore();
    try {
      const locator = tmuxLocator();
      const result = router.registerAgent({
        agent_id: "codex-registration-roundtrip",
        cli: "codex",
        capabilities: ["code"],
        topics: [],
        heartbeat_ttl_ms: 120000,
        project_id: PROJECT_ID,
        session_id: "session-registration-roundtrip",
        host_id: HOST_ID,
        transport_locators_json: JSON.stringify([locator]),
      });

      assert.equal(result.ok, true);
      const row = store.db
        .prepare(
          "SELECT project_id, session_id, host_id, transport_locators_json FROM agents WHERE agent_id = ?",
        )
        .get("codex-registration-roundtrip");
      assert.equal(row.project_id, PROJECT_ID);
      assert.equal(row.session_id, "session-registration-roundtrip");
      assert.equal(row.host_id, HOST_ID);
      assert.deepEqual(JSON.parse(row.transport_locators_json), [locator]);
    } finally {
      store.close();
    }
  });

  it("keeps legacy registration successful with v6 defaults", () => {
    const { store, router } = tempStore();
    try {
      const result = router.registerAgent({
        agent_id: "legacy-registration",
        cli: "claude",
        capabilities: ["code"],
        topics: [],
        heartbeat_ttl_ms: 30000,
      });

      assert.equal(result.ok, true);
      const row = store.db
        .prepare(
          "SELECT project_id, session_id, host_id, transport_locators_json FROM agents WHERE agent_id = ?",
        )
        .get("legacy-registration");
      assert.equal(row.project_id, null);
      assert.equal(row.session_id, null);
      assert.equal(row.host_id, null);
      assert.equal(row.transport_locators_json, "[]");
    } finally {
      store.close();
    }
  });

  it("rejects non-normalized locator shapes and unsupported Codex UDS", () => {
    const { store, router } = tempStore();
    try {
      assert.throws(
        () =>
          router.registerAgent({
            agent_id: "invalid-locator-path",
            cli: "codex",
            capabilities: ["code"],
            topics: [],
            heartbeat_ttl_ms: 120000,
            host_id: HOST_ID,
            transport_locators_json: JSON.stringify([
              {
                ...tmuxLocator(),
                locator: {
                  ...tmuxLocator().locator,
                  cwd: "/private/project",
                },
              },
            ]),
          }),
        { code: "TRANSPORT_LOCATOR_INVALID" },
      );
      assert.throws(
        () =>
          router.registerAgent({
            agent_id: "invalid-codex-uds",
            cli: "codex",
            capabilities: ["code"],
            topics: [],
            heartbeat_ttl_ms: 120000,
            host_id: HOST_ID,
            transport_locators_json: [
              {
                schema_version: "tfx.transport-locator.v1",
                transport_id: "trn_codex_uds",
                kind: "claude-uds",
                host_id: HOST_ID,
                capabilities: ["probe"],
                priority: 100,
                expires_at_ms: Date.now() + 60000,
                locator: {
                  session_id: "codex-session",
                  bridge_id: "local-hub",
                },
              },
            ],
          }),
        { code: "CODEX_TRANSPORT_UNSUPPORTED" },
      );
      assert.equal(store.getAgent("invalid-locator-path"), null);
      assert.equal(store.getAgent("invalid-codex-uds"), null);
    } finally {
      store.close();
    }
  });

  it("round-trips stable opaque project identity through RoleKey wire encoding", () => {
    const roleKey = { project_id: PROJECT_ID, role_kind: "cto" };
    const wire = encodeRoleKey(roleKey);
    assert.deepEqual(decodeRoleKey(wire), roleKey);
    assert.equal(wire.includes(process.cwd()), false);
  });
});

describe("SessionStart scoped registration metadata", () => {
  it("normalizes a raw TFX_HOST_ID into a valid opaque locator identity", () => {
    const previous = process.env.TFX_HOST_ID;
    process.env.TFX_HOST_ID = "MacBook Pro / raw host";
    try {
      const identity = buildSynapseRegistrationMeta(
        { sessionKind: "interactive", sessionId: "host-normalization" },
        { nowMs: () => 1000 },
      );
      assert.match(identity.host_id, /^hst_[A-Za-z0-9_-]{22}$/u);
      assert.equal(identity.project_id, undefined);
      assert.equal(Object.hasOwn(identity, "project_id"), false);
      assert.equal(
        JSON.parse(identity.transport_locators_json)[0].host_id,
        identity.host_id,
      );
    } finally {
      if (previous === undefined) delete process.env.TFX_HOST_ID;
      else process.env.TFX_HOST_ID = previous;
    }
  });

  it("loads tracked project identity and emits only detectable Codex tmux locator", () => {
    const root = mkdtempSync(join(tmpdir(), "tfx-session-registration-"));
    TEMP_DIRS.push(root);
    mkdirSync(join(root, ".triflux"), { recursive: true });
    writeFileSync(
      join(root, ".triflux", "project.json"),
      JSON.stringify({
        schema_version: "tfx.project.v1",
        project_id: PROJECT_ID,
      }),
    );

    const identity = buildSynapseRegistrationMeta(
      {
        sessionKind: "interactive",
        sessionId: "codex-session",
        cwd: join(root, "nested"),
        host_id: HOST_ID,
        tmux_session: "codex-worker",
        mux_server_id: "mux-explicit",
      },
      { nowMs: () => 1000, entrypoint: "hooks/codex-session-hook.mjs" },
    );

    assert.equal(identity.project_id, PROJECT_ID);
    assert.equal(identity.session_id, "codex-session");
    assert.equal(identity.host_id, HOST_ID);
    const locators = JSON.parse(identity.transport_locators_json);
    assert.equal(locators.length, 1);
    assert.equal(locators[0].kind, "tmux");
    assert.deepEqual(locators[0].locator, {
      session_name: "codex-worker",
      mux_server_id: locators[0].locator.mux_server_id,
    });
    assert.equal(JSON.stringify(locators).includes(root), false);
  });
});
