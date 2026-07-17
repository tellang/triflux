import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { createRouter } from "../../hub/router.mjs";
import { createStore } from "../../hub/store.mjs";
import { loadBetterSqlite3ForTest, SQLITE_SKIP } from "../helpers/sqlite.mjs";

const TEMP_DIRS = [];

function makeV5Database() {
  const dir = mkdtempSync(join(tmpdir(), "tfx-store-v6-migration-"));
  TEMP_DIRS.push(dir);
  const dbPath = join(dir, "hub.db");
  const Database = loadBetterSqlite3ForTest();
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO _meta (key, value) VALUES ('schema_version', '5');

    CREATE TABLE agents (
      agent_id TEXT PRIMARY KEY,
      cli TEXT NOT NULL CHECK (cli IN ('codex','gemini','claude','other')),
      pid INTEGER,
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      topics_json TEXT NOT NULL DEFAULT '[]',
      last_seen_ms INTEGER NOT NULL,
      lease_expires_ms INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('online','stale','offline')),
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('request','response','event','handoff','human_request','human_response','system')),
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      topic TEXT NOT NULL,
      priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 9),
      ttl_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      correlation_id TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL CHECK (status IN ('queued','delivered','acked','expired','dead_letter'))
    );
  `);
  db.prepare(`
    INSERT INTO agents (
      agent_id, cli, pid, capabilities_json, topics_json, last_seen_ms,
      lease_expires_ms, status, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "legacy-agent",
    "codex",
    42,
    '["code","cto"]',
    '["cto"]',
    100,
    200,
    "online",
    '{"kept":true,"role":"cto"}',
  );
  db.prepare(`
    INSERT INTO messages (
      id, type, from_agent, to_agent, topic, priority, ttl_ms,
      created_at_ms, expires_at_ms, correlation_id, trace_id,
      payload_json, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "legacy-message",
    "event",
    "legacy-agent",
    "topic:legacy",
    "legacy",
    5,
    1000,
    100,
    1100,
    "legacy-correlation",
    "legacy-trace",
    '{"kept":true}',
    "queued",
  );
  db.close();
  return dbPath;
}

afterEach(() => {
  while (TEMP_DIRS.length > 0) {
    rmSync(TEMP_DIRS.pop(), { recursive: true, force: true });
  }
});

describe("hub store schema v8 migration", { skip: SQLITE_SKIP }, () => {
  it("migrates a real v5 database without losing agents or messages", () => {
    const dbPath = makeV5Database();
    const first = createStore(dbPath);

    assert.equal(
      first.db
        .prepare("SELECT value FROM _meta WHERE key='schema_version'")
        .pluck()
        .get(),
      "8",
    );
    assert.deepEqual(first.getAgent("legacy-agent"), {
      agent_id: "legacy-agent",
      cli: "codex",
      pid: 42,
      last_seen_ms: 100,
      lease_expires_ms: 200,
      presence_generation: 0,
      status: "online",
      project_id: null,
      session_id: null,
      host_id: null,
      transport_locators_json: "[]",
      capabilities: ["code", "cto"],
      topics: ["cto"],
      metadata: { kept: true, role: "cto" },
    });
    assert.equal(first.getMessage("legacy-message").payload.kept, true);
    assert.equal(first.getMessage("legacy-message").role_key_wire, null);
    assert.equal(
      first.db
        .prepare(
          "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_messages_role_key'",
        )
        .pluck()
        .get(),
      1,
    );
    first.close();

    const second = createStore(dbPath);
    assert.equal(second.getAgent("legacy-agent").metadata.kept, true);
    assert.equal(second.getMessage("legacy-message").payload.kept, true);
    assert.equal(
      second.db.prepare("SELECT COUNT(*) FROM role_registry").pluck().get(),
      0,
    );
    second.close();
  });

  it("generation=0으로 마이그레이션된 장기 lease CTO는 legacy heartbeat 후 재등록으로 self-heal한다", () => {
    const store = createStore(makeV5Database());
    const router = createRouter(store);
    try {
      const legacy = store.getAgent("legacy-agent");
      assert.equal(legacy.presence_generation, 0);
      assert.equal(legacy.metadata.role, "cto");

      const heartbeat = router.refreshAgentLease("legacy-agent", 7_200_000);
      assert.equal(heartbeat.ok, true);
      assert.equal(heartbeat.data.effective.updated, true);

      const renewed = router.registerAgent({
        agent_id: "legacy-agent",
        cli: "codex",
        capabilities: ["code", "cto"],
        topics: ["cto"],
        heartbeat_ttl_ms: 7_200_000,
        metadata: { kept: true, role: "cto" },
      });
      assert.equal(renewed.ok, true);
      assert.equal(renewed.data.presence_generation, 1);
    } finally {
      router.stopSweeper();
      store.close();
    }
  });
});

function makeLegacyRoleRegistryDatabase() {
  const dir = mkdtempSync(join(tmpdir(), "tfx-store-role-legacy-"));
  TEMP_DIRS.push(dir);
  const dbPath = join(dir, "hub.db");
  const Database = loadBetterSqlite3ForTest();
  const db = new Database(dbPath);
  // v8 이전 role_registry에는 active + holder NULL을 막는 CHECK가 없다.
  db.exec(`
    CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO _meta (key, value) VALUES ('schema_version', '6');

    CREATE TABLE role_registry (
      role_key_wire TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      role_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL,
      holder_agent_id TEXT,
      previous_holder_agent_id TEXT,
      epoch INTEGER NOT NULL DEFAULT 0,
      activation_seq INTEGER NOT NULL DEFAULT 0,
      activation_id TEXT,
      activation_deadline_ms INTEGER,
      holder_lease_expires_ms INTEGER,
      charter_version TEXT,
      charter_acked_epoch INTEGER,
      retry_count INTEGER NOT NULL DEFAULT 0,
      next_probe_ms INTEGER,
      blocked_reason TEXT,
      last_transition_ms INTEGER NOT NULL DEFAULT 0,
      last_reason TEXT,
      version INTEGER NOT NULL DEFAULT 0,
      UNIQUE(project_id, role_kind, scope_id)
    );

    INSERT INTO role_registry (role_key_wire, project_id, role_kind, scope_id, state)
    VALUES ('legacy-phantom-cto', 'prj_AAAAAAAAAAAAAAAAAAAAAA', 'cto', '', 'active');
  `);
  db.close();
  return dbPath;
}

describe("hub store role registry legacy integrity guards", {
  skip: SQLITE_SKIP,
}, () => {
  it("CHECK가 없는 legacy 테이블을 트리거로 방어하고 기존 phantom active를 electable로 되돌린다", () => {
    const store = createStore(makeLegacyRoleRegistryDatabase());
    try {
      // CREATE TABLE IF NOT EXISTS는 기존 테이블에 CHECK를 소급하지 못한다.
      // 따라서 매 부팅 실행되는 트리거가 legacy DB의 유일한 방어선이다.
      const tableSql = store.db
        .prepare("SELECT sql FROM sqlite_master WHERE name='role_registry'")
        .pluck()
        .get();
      assert.equal(/holder_agent_id IS NOT NULL/u.test(tableSql), false);

      assert.throws(
        () =>
          store.db
            .prepare(
              `INSERT INTO role_registry (role_key_wire, project_id, role_kind, scope_id, state)
               VALUES ('new-phantom-cto', 'prj_BBBBBBBBBBBBBBBBBBBBBB', 'cto', '', 'active')`,
            )
            .run(),
        /CHECK constraint failed/u,
      );

      // 트리거는 신규 유입만 막으므로, 이미 들어와 있던 행은 복구가 처리해야 한다.
      assert.deepEqual(
        store.db
          .prepare(
            "SELECT state, holder_agent_id FROM role_registry WHERE role_key_wire='legacy-phantom-cto'",
          )
          .get(),
        { state: "active", holder_agent_id: null },
      );

      store.recoverRoleRegistry(Date.now());

      assert.deepEqual(
        store.db
          .prepare(
            "SELECT state, holder_agent_id FROM role_registry WHERE role_key_wire='legacy-phantom-cto'",
          )
          .get(),
        { state: "electable", holder_agent_id: null },
      );
    } finally {
      store.close();
    }
  });
});
