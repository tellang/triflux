import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

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
    '["code"]',
    '["legacy"]',
    100,
    200,
    "online",
    '{"kept":true}',
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

describe("hub store schema v6 migration", { skip: SQLITE_SKIP }, () => {
  it("migrates a real v5 database without losing agents or messages", () => {
    const dbPath = makeV5Database();
    const first = createStore(dbPath);

    assert.equal(
      first.db
        .prepare("SELECT value FROM _meta WHERE key='schema_version'")
        .pluck()
        .get(),
      "6",
    );
    assert.deepEqual(first.getAgent("legacy-agent"), {
      agent_id: "legacy-agent",
      cli: "codex",
      pid: 42,
      last_seen_ms: 100,
      lease_expires_ms: 200,
      status: "online",
      project_id: null,
      session_id: null,
      host_id: null,
      transport_locators_json: "[]",
      capabilities: ["code"],
      topics: ["legacy"],
      metadata: { kept: true },
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
});
