// hub/store.mjs — SQLite 감사 로그/메타데이터/역할 레지스트리 저장소
// 실시간 배달은 router/pipe가 담당하고, 역할 권한과 복구 상태는 SQLite가 보존한다.

import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clampDurationMs,
  DEFAULT_ASSIGN_TIMEOUT_MS,
  DEFAULT_ASSIGN_TTL_MS,
} from "@triflux/core/hub/lib/timeout-defaults.mjs";
import { uuidv7 } from "@triflux/core/hub/lib/uuidv7.mjs";
import { recalcConfidence } from "@triflux/core/hub/reflexion.mjs";
import {
  decodeRoleKey,
  ROLE_REACHABILITY_STATES,
} from "@triflux/core/hub/role-contract.mjs";

export { uuidv7 };

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function parseJson(str, fallback = null) {
  if (str == null) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function parseAgentRow(row) {
  if (!row) return null;
  const { capabilities_json, topics_json, metadata_json, ...rest } = row;
  return {
    ...rest,
    capabilities: parseJson(capabilities_json, []),
    topics: parseJson(topics_json, []),
    metadata: parseJson(metadata_json, {}),
  };
}

function parseMessageRow(row) {
  if (!row) return null;
  const { payload_json, ...rest } = row;
  return { ...rest, payload: parseJson(payload_json, {}) };
}

function parseHumanRequestRow(row) {
  if (!row) return null;
  const { schema_json, response_json, ...rest } = row;
  return {
    ...rest,
    schema: parseJson(schema_json, {}),
    response: parseJson(response_json, null),
  };
}

function parseAssignRow(row) {
  if (!row) return null;
  const { payload_json, result_json, error_json, ...rest } = row;
  return {
    ...rest,
    payload: parseJson(payload_json, {}),
    result: parseJson(result_json, null),
    error: parseJson(error_json, null),
  };
}

function parseReflexionRow(row) {
  if (!row) return null;
  const { context_json, adaptive_state_json, ...rest } = row;
  return {
    ...rest,
    type: rest.type || "reflexion",
    context: parseJson(context_json, {}),
    adaptive_state: parseJson(adaptive_state_json, {}),
  };
}

function parseRoleCandidateRow(row) {
  if (!row) return null;
  const { transport_locators_json, ...rest } = row;
  return {
    ...rest,
    transport_locators: parseJson(transport_locators_json, []),
  };
}

function hasTable(db, tableName) {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(tableName);
}

function hasColumn(db, tableName, columnName) {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return rows.some((row) => row.name === columnName);
}

function ensureColumn(db, tableName, columnName, definition) {
  if (hasColumn(db, tableName, columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

function ensureV6Columns(db) {
  if (hasTable(db, "agents")) {
    ensureColumn(db, "agents", "project_id", "TEXT");
    ensureColumn(db, "agents", "session_id", "TEXT");
    ensureColumn(db, "agents", "host_id", "TEXT");
    ensureColumn(
      db,
      "agents",
      "transport_locators_json",
      "TEXT NOT NULL DEFAULT '[]'",
    );
  }
  if (hasTable(db, "messages")) {
    ensureColumn(db, "messages", "role_key_wire", "TEXT");
  }
}

/**
 * 저장소 생성
 * @param {string} dbPath
 */
export async function importBetterSqlite3() {
  const mod = await import("better-sqlite3");
  return mod.default ?? mod;
}

function resolveBetterSqlite3(options = {}) {
  if (options.DatabaseCtor) return options.DatabaseCtor;
  const mod = require("better-sqlite3");
  return mod.default ?? mod;
}

export function createStore(dbPath, options = {}) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const Database = resolveBetterSqlite3(options);
  const db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("wal_autocheckpoint = 1000");

  const schemaSQL = readFileSync(join(__dirname, "schema.sql"), "utf8");
  db.exec(
    "CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT)",
  );
  const SCHEMA_VERSION = "6";
  const curVer = (() => {
    try {
      return db
        .prepare("SELECT value FROM _meta WHERE key='schema_version'")
        .pluck()
        .get();
    } catch {
      return null;
    }
  })();
  // 마이그레이션 전략: 스키마 버전이 다르면 schema.sql을 재실행한다.
  // schema.sql은 CREATE TABLE IF NOT EXISTS 패턴을 사용하므로 멱등하게 적용된다.
  // 비파괴적 컬럼 추가는 자동으로 처리되지만, 컬럼 제거/이름 변경은 수동 마이그레이션이 필요하다.
  // v5 테이블에는 schema.sql의 v6 인덱스가 참조하는 컬럼이 없으므로
  // CREATE IF NOT EXISTS 재실행 전에 멱등 컬럼 seam을 먼저 적용한다.
  ensureV6Columns(db);
  if (curVer !== SCHEMA_VERSION) {
    if (curVer != null) {
      // 이미 버전이 기록된 DB에서 버전 불일치가 발생한 경우 경고한다.
      console.warn(
        `[store] schema version mismatch: found=${curVer} expected=${SCHEMA_VERSION}. Applying schema.sql (idempotent).`,
      );
    }
    db.exec(schemaSQL);
    db.prepare(
      "INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', ?)",
    ).run(SCHEMA_VERSION);
  }
  // 매 부팅 실행해 부분 적용된 마이그레이션도 안전하게 복구한다.
  ensureV6Columns(db);
  ensureColumn(
    db,
    "reflexion_entries",
    "type",
    "TEXT NOT NULL DEFAULT 'reflexion'",
  );
  ensureColumn(db, "assign_jobs", "dispatched_at_ms", "INTEGER");
  ensureColumn(
    db,
    "reflexion_entries",
    "adaptive_state_json",
    "TEXT NOT NULL DEFAULT '{}'",
  );

  const S = {
    upsertAgent: db.prepare(`
      INSERT INTO agents (agent_id, cli, pid, capabilities_json, topics_json, last_seen_ms, lease_expires_ms, status, metadata_json)
      VALUES (@agent_id, @cli, @pid, @capabilities_json, @topics_json, @last_seen_ms, @lease_expires_ms, @status, @metadata_json)
      ON CONFLICT(agent_id) DO UPDATE SET
        cli=excluded.cli,
        pid=excluded.pid,
        capabilities_json=excluded.capabilities_json,
        topics_json=excluded.topics_json,
        last_seen_ms=excluded.last_seen_ms,
        lease_expires_ms=excluded.lease_expires_ms,
        status=excluded.status,
        metadata_json=excluded.metadata_json`),
    getAgent: db.prepare("SELECT * FROM agents WHERE agent_id = ?"),
    setAgentTopics: db.prepare(
      "UPDATE agents SET topics_json=?, last_seen_ms=? WHERE agent_id=?",
    ),
    heartbeat: db.prepare(
      "UPDATE agents SET last_seen_ms=?, lease_expires_ms=?, status='online' WHERE agent_id=?",
    ),
    setAgentStatus: db.prepare("UPDATE agents SET status=? WHERE agent_id=?"),
    onlineAgents: db.prepare("SELECT * FROM agents WHERE status != 'offline'"),
    allAgents: db.prepare("SELECT * FROM agents"),
    agentsByTopic: db.prepare(
      "SELECT a.* FROM agents a, json_each(a.topics_json) t WHERE t.value=? AND a.status != 'offline'",
    ),
    markStale: db.prepare(
      "UPDATE agents SET status='stale' WHERE status='online' AND lease_expires_ms < ?",
    ),
    markOffline: db.prepare(
      "UPDATE agents SET status='offline' WHERE status='stale' AND lease_expires_ms < ? - 300000",
    ),

    getRole: db.prepare(
      "SELECT * FROM role_registry WHERE role_key_wire = ?",
    ),
    insertRoleReservation: db.prepare(`
      INSERT INTO role_registry (
        role_key_wire, project_id, role_kind, scope_id, state,
        holder_agent_id, previous_holder_agent_id, epoch, activation_seq,
        activation_id, activation_deadline_ms, holder_lease_expires_ms,
        charter_version, charter_acked_epoch, retry_count, next_probe_ms,
        blocked_reason, last_transition_ms, last_reason, version
      ) VALUES (
        @role_key_wire, @project_id, @role_kind, @scope_id, @state,
        @holder_agent_id, @previous_holder_agent_id, @epoch, @activation_seq,
        @activation_id, @activation_deadline_ms, @holder_lease_expires_ms,
        @charter_version, @charter_acked_epoch, @retry_count, @next_probe_ms,
        @blocked_reason, @last_transition_ms, @last_reason, @version
      )`),
    updateRoleReservation: db.prepare(`
      UPDATE role_registry SET
        state=@state,
        holder_agent_id=@holder_agent_id,
        previous_holder_agent_id=@previous_holder_agent_id,
        epoch=@epoch,
        activation_seq=@activation_seq,
        activation_id=@activation_id,
        activation_deadline_ms=@activation_deadline_ms,
        holder_lease_expires_ms=@holder_lease_expires_ms,
        charter_version=@charter_version,
        charter_acked_epoch=@charter_acked_epoch,
        retry_count=@retry_count,
        next_probe_ms=@next_probe_ms,
        blocked_reason=@blocked_reason,
        last_transition_ms=@last_transition_ms,
        last_reason=@last_reason,
        version=version + 1
      WHERE role_key_wire=@role_key_wire
        AND version=@expected_version
        AND epoch=@expected_epoch`),
    compareAndSetRole: db.prepare(`
      UPDATE role_registry SET
        state=@state,
        holder_agent_id=@holder_agent_id,
        previous_holder_agent_id=@previous_holder_agent_id,
        activation_id=@activation_id,
        activation_deadline_ms=@activation_deadline_ms,
        holder_lease_expires_ms=@holder_lease_expires_ms,
        charter_version=@charter_version,
        charter_acked_epoch=@charter_acked_epoch,
        retry_count=@retry_count,
        next_probe_ms=@next_probe_ms,
        blocked_reason=@blocked_reason,
        last_transition_ms=@last_transition_ms,
        last_reason=@last_reason,
        version=version + 1
      WHERE role_key_wire=@role_key_wire
        AND epoch=@expected_epoch
        AND activation_seq=@expected_activation_seq
        AND activation_id IS @expected_activation_id
        AND version=@expected_version`),
    listRoles: db.prepare(
      "SELECT * FROM role_registry ORDER BY role_key_wire",
    ),
    expiredHolderRoles: db.prepare(`
      SELECT * FROM role_registry
      WHERE holder_agent_id IS NOT NULL
        AND (holder_lease_expires_ms IS NULL OR holder_lease_expires_ms <= ?)
      ORDER BY role_key_wire`),
    listRoleCandidates: db.prepare(`
      SELECT * FROM role_candidates
      WHERE role_key_wire = ?
      ORDER BY priority DESC, updated_at_ms DESC, agent_id`),
    getRoleCandidate: db.prepare(`
      SELECT * FROM role_candidates
      WHERE role_key_wire = ? AND agent_id = ?`),
    upsertRoleCandidate: db.prepare(`
      INSERT INTO role_candidates (
        role_key_wire, agent_id, source, priority, transport_locators_json,
        consecutive_probe_failures, excluded_until_ms, last_probe_ms,
        last_probe_code, updated_at_ms
      ) VALUES (
        @role_key_wire, @agent_id, @source, @priority,
        @transport_locators_json, @consecutive_probe_failures,
        @excluded_until_ms, @last_probe_ms, @last_probe_code, @updated_at_ms
      )
      ON CONFLICT(role_key_wire, agent_id) DO UPDATE SET
        source=excluded.source,
        priority=excluded.priority,
        transport_locators_json=excluded.transport_locators_json,
        consecutive_probe_failures=excluded.consecutive_probe_failures,
        excluded_until_ms=excluded.excluded_until_ms,
        last_probe_ms=excluded.last_probe_ms,
        last_probe_code=excluded.last_probe_code,
        updated_at_ms=excluded.updated_at_ms`),
    updateCandidateReachability: db.prepare(`
      UPDATE role_candidates SET
        consecutive_probe_failures=@consecutive_probe_failures,
        excluded_until_ms=@excluded_until_ms,
        last_probe_ms=@last_probe_ms,
        last_probe_code=@last_probe_code,
        updated_at_ms=@updated_at_ms
      WHERE role_key_wire=@role_key_wire AND agent_id=@agent_id`),
    pendingRoleMessages: db.prepare(`
      SELECT * FROM messages
      WHERE role_key_wire=?
        AND status IN ('queued','delivered')
        AND expires_at_ms > ?
      ORDER BY priority DESC, created_at_ms ASC, id`),
    recoverExpiredRole: db.prepare(`
      UPDATE role_registry SET
        state='electable',
        previous_holder_agent_id=holder_agent_id,
        holder_agent_id=NULL,
        epoch=epoch + 1,
        activation_seq=activation_seq + 1,
        activation_id=NULL,
        activation_deadline_ms=NULL,
        holder_lease_expires_ms=NULL,
        charter_acked_epoch=NULL,
        blocked_reason=NULL,
        last_transition_ms=@now,
        last_reason='restart_holder_lease_expired',
        version=version + 1
      WHERE role_key_wire=@role_key_wire
        AND version=@expected_version
        AND epoch=@expected_epoch`),
    recoverLiveRole: db.prepare(`
      UPDATE role_registry SET
        state='elected-probing',
        epoch=epoch + 1,
        activation_seq=activation_seq + 1,
        activation_id=@activation_id,
        activation_deadline_ms=NULL,
        charter_acked_epoch=NULL,
        blocked_reason=NULL,
        last_transition_ms=@now,
        last_reason='restart_reprobe_required',
        version=version + 1
      WHERE role_key_wire=@role_key_wire
        AND version=@expected_version
        AND epoch=@expected_epoch`),
    recoverOrphanedActivation: db.prepare(`
      UPDATE role_registry SET
        state='electable',
        epoch=epoch + 1,
        activation_seq=activation_seq + 1,
        activation_id=NULL,
        activation_deadline_ms=NULL,
        charter_acked_epoch=NULL,
        last_transition_ms=@now,
        last_reason='restart_activation_fenced',
        version=version + 1
      WHERE role_key_wire=@role_key_wire
        AND version=@expected_version
        AND epoch=@expected_epoch`),

    insertAuditMessage: db.prepare(`
      INSERT INTO messages (id, type, from_agent, to_agent, topic, priority, ttl_ms, created_at_ms, expires_at_ms, correlation_id, trace_id, payload_json, status, role_key_wire)
      VALUES (@id, @type, @from_agent, @to_agent, @topic, @priority, @ttl_ms, @created_at_ms, @expires_at_ms, @correlation_id, @trace_id, @payload_json, @status, @role_key_wire)`),
    getMsg: db.prepare("SELECT * FROM messages WHERE id=?"),
    getResponse: db.prepare(
      "SELECT * FROM messages WHERE correlation_id=? AND type='response' ORDER BY created_at_ms DESC LIMIT 1",
    ),
    getMsgsByTrace: db.prepare(
      "SELECT * FROM messages WHERE trace_id=? ORDER BY created_at_ms",
    ),
    setMsgStatus: db.prepare("UPDATE messages SET status=? WHERE id=?"),
    recentAgentMessages: db.prepare(`
      SELECT * FROM messages
      WHERE to_agent=?
      ORDER BY created_at_ms DESC
      LIMIT ?`),
    recentAgentMessagesWithTopics: db.prepare(`
      SELECT * FROM messages
      WHERE to_agent=?
         OR (
           substr(to_agent, 1, 6)='topic:'
           AND topic IN (SELECT value FROM json_each(?))
         )
      ORDER BY created_at_ms DESC
      LIMIT ?`),

    insertHR: db.prepare(`
      INSERT INTO human_requests (request_id, requester_agent, kind, prompt, schema_json, state, deadline_ms, default_action, correlation_id, trace_id, response_json)
      VALUES (@request_id, @requester_agent, @kind, @prompt, @schema_json, @state, @deadline_ms, @default_action, @correlation_id, @trace_id, @response_json)`),
    getHR: db.prepare("SELECT * FROM human_requests WHERE request_id=?"),
    updateHR: db.prepare(
      "UPDATE human_requests SET state=?, response_json=? WHERE request_id=?",
    ),
    pendingHR: db.prepare("SELECT * FROM human_requests WHERE state='pending'"),
    expireHR: db.prepare(
      "UPDATE human_requests SET state='timed_out' WHERE state='pending' AND deadline_ms < ?",
    ),

    insertDL: db.prepare(
      "INSERT OR REPLACE INTO dead_letters (message_id, reason, failed_at_ms, last_error) VALUES (?,?,?,?)",
    ),
    getDL: db.prepare(
      "SELECT * FROM dead_letters ORDER BY failed_at_ms DESC LIMIT ?",
    ),

    insertAssign: db.prepare(`
      INSERT INTO assign_jobs (
        job_id, supervisor_agent, worker_agent, topic, task, payload_json,
        status, attempt, retry_count, max_retries, priority, ttl_ms, timeout_ms, deadline_ms,
        trace_id, correlation_id, last_message_id, result_json, error_json,
        created_at_ms, updated_at_ms, started_at_ms, dispatched_at_ms, completed_at_ms, last_retry_at_ms
      ) VALUES (
        @job_id, @supervisor_agent, @worker_agent, @topic, @task, @payload_json,
        @status, @attempt, @retry_count, @max_retries, @priority, @ttl_ms, @timeout_ms, @deadline_ms,
        @trace_id, @correlation_id, @last_message_id, @result_json, @error_json,
        @created_at_ms, @updated_at_ms, @started_at_ms, @dispatched_at_ms, @completed_at_ms, @last_retry_at_ms
      )`),
    getAssign: db.prepare("SELECT * FROM assign_jobs WHERE job_id = ?"),
    updateAssign: db.prepare(`
      UPDATE assign_jobs SET
        supervisor_agent=@supervisor_agent,
        worker_agent=@worker_agent,
        topic=@topic,
        task=@task,
        payload_json=@payload_json,
        status=@status,
        attempt=@attempt,
        retry_count=@retry_count,
        max_retries=@max_retries,
        priority=@priority,
        ttl_ms=@ttl_ms,
        timeout_ms=@timeout_ms,
        deadline_ms=@deadline_ms,
        trace_id=@trace_id,
        correlation_id=@correlation_id,
        last_message_id=@last_message_id,
        result_json=@result_json,
        error_json=@error_json,
        updated_at_ms=@updated_at_ms,
        started_at_ms=@started_at_ms,
        dispatched_at_ms=@dispatched_at_ms,
        completed_at_ms=@completed_at_ms,
        last_retry_at_ms=@last_retry_at_ms
      WHERE job_id=@job_id`),

    findExpired: db.prepare(
      "SELECT id FROM messages WHERE status='queued' AND expires_at_ms < ?",
    ),
    urgentDepth: db.prepare(
      "SELECT COUNT(*) as cnt FROM messages WHERE status='queued' AND priority >= 7",
    ),
    normalDepth: db.prepare(
      "SELECT COUNT(*) as cnt FROM messages WHERE status='queued' AND priority < 7",
    ),
    onlineCount: db.prepare(
      "SELECT COUNT(*) as cnt FROM agents WHERE status='online'",
    ),
    msgCount: db.prepare("SELECT COUNT(*) as cnt FROM messages"),
    dlqDepth: db.prepare("SELECT COUNT(*) as cnt FROM dead_letters"),
    ackedRecent: db.prepare(
      "SELECT COUNT(*) as cnt FROM messages WHERE status='acked' AND created_at_ms > ? - 300000",
    ),
    assignCountByStatus: db.prepare(
      "SELECT COUNT(*) as cnt FROM assign_jobs WHERE status = ?",
    ),
    activeAssignCount: db.prepare(
      "SELECT COUNT(*) as cnt FROM assign_jobs WHERE status IN ('queued','running')",
    ),

    // reflexion
    insertReflexion: db.prepare(`
      INSERT INTO reflexion_entries (id, type, error_pattern, error_message, context_json, solution, solution_code, adaptive_state_json, confidence, hit_count, success_count, last_hit_ms, created_at_ms, updated_at_ms)
      VALUES (@id, @type, @error_pattern, @error_message, @context_json, @solution, @solution_code, @adaptive_state_json, @confidence, @hit_count, @success_count, @last_hit_ms, @created_at_ms, @updated_at_ms)`),
    getReflexionById: db.prepare(
      "SELECT * FROM reflexion_entries WHERE id = ?",
    ),
    findReflexionExact: db.prepare(
      "SELECT * FROM reflexion_entries WHERE error_pattern = ? ORDER BY confidence DESC",
    ),
    findReflexionLike: db.prepare(
      "SELECT * FROM reflexion_entries WHERE error_pattern LIKE ? ESCAPE '\\' ORDER BY confidence DESC LIMIT 10",
    ),
    updateReflexionHitSuccess: db.prepare(
      "UPDATE reflexion_entries SET hit_count = hit_count + 1, success_count = success_count + 1, last_hit_ms = ?, updated_at_ms = ? WHERE id = ?",
    ),
    updateReflexionHitOnly: db.prepare(
      "UPDATE reflexion_entries SET hit_count = hit_count + 1, last_hit_ms = ?, updated_at_ms = ? WHERE id = ?",
    ),
    updateReflexionConfidence: db.prepare(
      "UPDATE reflexion_entries SET confidence = ?, updated_at_ms = ? WHERE id = ?",
    ),
    pruneReflexionEntries: db.prepare(
      "DELETE FROM reflexion_entries WHERE updated_at_ms < ? AND confidence < ?",
    ),
    listReflexionEntries: db.prepare(
      "SELECT * FROM reflexion_entries ORDER BY confidence DESC, updated_at_ms DESC",
    ),
    deleteReflexionEntry: db.prepare(
      "DELETE FROM reflexion_entries WHERE id = ?",
    ),
  };

  const assignStatusListeners = new Set();

  function buildAssignCallbackEvent(row) {
    return {
      job_id: row.job_id,
      status: row.status,
      result: row.result ?? row.error ?? null,
      timestamp: new Date(row.updated_at_ms || Date.now()).toISOString(),
    };
  }

  function notifyAssignStatusListeners(row) {
    const event = buildAssignCallbackEvent(row);
    for (const listener of Array.from(assignStatusListeners)) {
      try {
        listener(event, row);
      } catch {}
    }
  }

  function clampMaxMessages(value, fallback = 20) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(1, Math.min(Math.trunc(num), 100));
  }

  function clampPriority(value, fallback = 5) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(1, Math.min(Math.trunc(num), 9));
  }

  function roleIdentity(input) {
    const roleKeyWire = input?.role_key_wire ?? input?.roleKeyWire;
    const decoded = decodeRoleKey(roleKeyWire);
    const identity = {
      role_key_wire: roleKeyWire,
      project_id: decoded.project_id,
      role_kind: decoded.role_kind,
      scope_id: decoded.scope_id ?? "",
    };
    for (const field of ["project_id", "role_kind", "scope_id"]) {
      if (Object.hasOwn(input, field) && input[field] !== identity[field]) {
        throw new Error(`role key identity mismatch: ${field}`);
      }
    }
    return identity;
  }

  function roleFailureReason(current, expected) {
    if (!current) return "not_found";
    if (current.version !== expected.version) return "stale_version";
    if (current.epoch !== expected.epoch) return "stale_epoch";
    if (current.activation_seq !== expected.activation_seq) {
      return "stale_activation_seq";
    }
    if (current.activation_id !== expected.activation_id) {
      return "stale_activation_id";
    }
    return "cas_conflict";
  }

  const reserveRole = db.transaction((input) => {
    const identity = roleIdentity(input);
    const current = S.getRole.get(identity.role_key_wire) ?? null;
    const expectedVersion =
      input.expected_version ?? input.expectedVersion ?? current?.version;
    const expectedEpoch =
      input.expected_epoch ?? input.expectedEpoch ?? current?.epoch;

    if (current && expectedVersion !== current.version) {
      return { ok: false, reason: "stale_version", role: current };
    }
    if (current && expectedEpoch !== current.epoch) {
      return { ok: false, reason: "stale_epoch", role: current };
    }

    const nextEpoch =
      input.epoch ?? input.next_epoch ?? (current ? current.epoch + 1 : 0);
    if (current && nextEpoch !== current.epoch + 1) {
      return { ok: false, reason: "stale_epoch", role: current };
    }
    const nextActivationSeq =
      input.activation_seq ??
      input.next_activation_seq ??
      (current ? current.activation_seq + 1 : 0);
    if (current && nextActivationSeq !== current.activation_seq + 1) {
      return { ok: false, reason: "stale_activation_seq", role: current };
    }

    const state =
      input.state ?? (input.holder_agent_id ? "elected-probing" : "electable");
    if (!ROLE_REACHABILITY_STATES.includes(state)) {
      throw new Error(`invalid role reachability state: ${state}`);
    }
    const row = {
      ...identity,
      state,
      holder_agent_id: input.holder_agent_id ?? null,
      previous_holder_agent_id:
        input.previous_holder_agent_id ??
        (current?.holder_agent_id !== input.holder_agent_id
          ? current?.holder_agent_id ?? null
          : current?.previous_holder_agent_id ?? null),
      epoch: nextEpoch,
      activation_seq: nextActivationSeq,
      activation_id:
        input.activation_id ??
        (input.holder_agent_id ? uuidv7() : current?.activation_id ?? null),
      activation_deadline_ms:
        input.activation_deadline_ms ?? current?.activation_deadline_ms ?? null,
      holder_lease_expires_ms:
        input.holder_lease_expires_ms ??
        current?.holder_lease_expires_ms ??
        null,
      charter_version: input.charter_version ?? current?.charter_version ?? null,
      charter_acked_epoch:
        input.charter_acked_epoch ?? current?.charter_acked_epoch ?? null,
      retry_count: input.retry_count ?? current?.retry_count ?? 0,
      next_probe_ms: input.next_probe_ms ?? current?.next_probe_ms ?? null,
      blocked_reason:
        input.blocked_reason === undefined
          ? current?.blocked_reason ?? null
          : input.blocked_reason,
      last_transition_ms: input.last_transition_ms ?? Date.now(),
      last_reason: input.last_reason ?? "role_reserved",
      version: 0,
      expected_version: current?.version,
      expected_epoch: current?.epoch,
    };

    if (!current) {
      S.insertRoleReservation.run(row);
    } else if (S.updateRoleReservation.run(row).changes !== 1) {
      const latest = S.getRole.get(identity.role_key_wire) ?? null;
      return {
        ok: false,
        reason: roleFailureReason(latest, {
          version: current.version,
          epoch: current.epoch,
          activation_seq: current.activation_seq,
          activation_id: current.activation_id,
        }),
        role: latest,
      };
    }
    return { ok: true, role: S.getRole.get(identity.role_key_wire) };
  });

  const recoverRegistry = db.transaction((now) => {
    for (const role of S.listRoles.all()) {
      const guard = {
        role_key_wire: role.role_key_wire,
        expected_version: role.version,
        expected_epoch: role.epoch,
        now,
      };
      if (
        role.holder_agent_id &&
        (role.holder_lease_expires_ms == null ||
          role.holder_lease_expires_ms <= now)
      ) {
        S.recoverExpiredRole.run(guard);
      } else if (role.holder_agent_id) {
        S.recoverLiveRole.run({ ...guard, activation_id: uuidv7() });
      } else if (role.activation_id || role.state === "elected-probing") {
        S.recoverOrphanedActivation.run(guard);
      }
    }

    const roles = S.listRoles.all();
    return {
      roles,
      candidates: roles.flatMap((role) =>
        S.listRoleCandidates
          .all(role.role_key_wire)
          .map(parseRoleCandidateRow),
      ),
      pending_messages: roles.flatMap((role) =>
        S.pendingRoleMessages
          .all(role.role_key_wire, now)
          .map(parseMessageRow),
      ),
    };
  });

  const store = {
    db,
    uuidv7,

    close() {
      db.close();
    },

    registerAgent({
      agent_id,
      cli,
      pid,
      capabilities = [],
      topics = [],
      heartbeat_ttl_ms = 30000,
      metadata = {},
    }) {
      const now = Date.now();
      const leaseExpires = now + heartbeat_ttl_ms;
      const leaseId = uuidv7();
      const write = S.upsertAgent.run({
        agent_id,
        cli,
        pid: pid ?? null,
        capabilities_json: JSON.stringify(capabilities),
        topics_json: JSON.stringify(topics),
        last_seen_ms: now,
        lease_expires_ms: leaseExpires,
        status: "online",
        metadata_json: JSON.stringify(metadata),
      });
      const persisted = parseAgentRow(S.getAgent.get(agent_id));
      return {
        agent_id,
        lease_id: leaseId,
        lease_expires_ms: leaseExpires,
        server_time_ms: now,
        effective: {
          updated: write.changes > 0,
          online:
            persisted?.status === "online" &&
            Number(persisted.lease_expires_ms) === leaseExpires,
          status: persisted?.status ?? null,
          last_seen_ms: persisted?.last_seen_ms ?? null,
          lease_expires_ms: persisted?.lease_expires_ms ?? null,
          store_type: "sqlite",
          db_path: dbPath ?? null,
        },
      };
    },

    getAgent(id) {
      return parseAgentRow(S.getAgent.get(id));
    },

    refreshLease(agentId, ttlMs = 30000) {
      const now = Date.now();
      const write = S.heartbeat.run(now, now + ttlMs, agentId);
      return {
        agent_id: agentId,
        lease_expires_ms: now + ttlMs,
        server_time_ms: now,
        effective: {
          updated: write.changes > 0,
          store_type: "sqlite",
          db_path: dbPath ?? null,
        },
      };
    },

    updateAgentTopics(agentId, topics = []) {
      const now = Date.now();
      return (
        S.setAgentTopics.run(JSON.stringify(topics), now, agentId).changes > 0
      );
    },

    listOnlineAgents() {
      return S.onlineAgents.all().map(parseAgentRow);
    },

    listAllAgents() {
      return S.allAgents.all().map(parseAgentRow);
    },

    getAgentsByTopic(topic) {
      return S.agentsByTopic.all(topic).map(parseAgentRow);
    },

    sweepStaleAgents() {
      const now = Date.now();
      return {
        stale: S.markStale.run(now).changes,
        offline: S.markOffline.run(now).changes,
      };
    },

    updateAgentStatus(agentId, status) {
      return S.setAgentStatus.run(status, agentId).changes > 0;
    },

    getRole(roleKeyWire) {
      decodeRoleKey(roleKeyWire);
      return S.getRole.get(roleKeyWire) ?? null;
    },

    upsertRoleReservation(input) {
      return reserveRole.immediate(input);
    },

    compareAndSetRole(input) {
      const identity = roleIdentity(input);
      const current = S.getRole.get(identity.role_key_wire) ?? null;
      if (!current) return { ok: false, reason: "not_found", role: null };

      const hasExpectedActivationSeq =
        Object.hasOwn(input, "expected_activation_seq") ||
        Object.hasOwn(input, "expectedActivationSeq") ||
        Object.hasOwn(input, "activation_seq");
      const hasExpectedActivationId =
        Object.hasOwn(input, "expected_activation_id") ||
        Object.hasOwn(input, "expectedActivationId") ||
        Object.hasOwn(input, "activation_id");
      const expected = {
        version: input.expected_version ?? input.expectedVersion ?? input.version,
        epoch: input.expected_epoch ?? input.expectedEpoch ?? input.epoch,
        activation_seq:
          input.expected_activation_seq ??
          input.expectedActivationSeq ??
          input.activation_seq,
        activation_id: Object.hasOwn(input, "expected_activation_id")
          ? input.expected_activation_id
          : Object.hasOwn(input, "expectedActivationId")
            ? input.expectedActivationId
            : input.activation_id,
      };
      if (
        expected.version == null ||
        expected.epoch == null ||
        !hasExpectedActivationSeq ||
        !hasExpectedActivationId
      ) {
        return { ok: false, reason: "invalid_cas", role: current };
      }

      const reason = roleFailureReason(current, expected);
      if (reason !== "cas_conflict") {
        return { ok: false, reason, role: current };
      }

      const patch = input.patch ?? input.changes ?? {};
      const state = patch.state ?? current.state;
      if (!ROLE_REACHABILITY_STATES.includes(state)) {
        throw new Error(`invalid role reachability state: ${state}`);
      }
      const next = {
        role_key_wire: identity.role_key_wire,
        expected_version: expected.version,
        expected_epoch: expected.epoch,
        expected_activation_seq: expected.activation_seq,
        expected_activation_id: expected.activation_id,
        state,
        holder_agent_id:
          patch.holder_agent_id === undefined
            ? current.holder_agent_id
            : patch.holder_agent_id,
        previous_holder_agent_id:
          patch.previous_holder_agent_id === undefined
            ? current.previous_holder_agent_id
            : patch.previous_holder_agent_id,
        activation_id:
          patch.activation_id === undefined
            ? current.activation_id
            : patch.activation_id,
        activation_deadline_ms:
          patch.activation_deadline_ms === undefined
            ? current.activation_deadline_ms
            : patch.activation_deadline_ms,
        holder_lease_expires_ms:
          patch.holder_lease_expires_ms === undefined
            ? current.holder_lease_expires_ms
            : patch.holder_lease_expires_ms,
        charter_version:
          patch.charter_version === undefined
            ? current.charter_version
            : patch.charter_version,
        charter_acked_epoch:
          patch.charter_acked_epoch === undefined
            ? current.charter_acked_epoch
            : patch.charter_acked_epoch,
        retry_count: patch.retry_count ?? current.retry_count,
        next_probe_ms:
          patch.next_probe_ms === undefined
            ? current.next_probe_ms
            : patch.next_probe_ms,
        blocked_reason:
          patch.blocked_reason === undefined
            ? current.blocked_reason
            : patch.blocked_reason,
        last_transition_ms: patch.last_transition_ms ?? Date.now(),
        last_reason: patch.last_reason ?? current.last_reason,
      };
      if (S.compareAndSetRole.run(next).changes !== 1) {
        const latest = S.getRole.get(identity.role_key_wire) ?? null;
        return {
          ok: false,
          reason: roleFailureReason(latest, expected),
          role: latest,
        };
      }
      return { ok: true, role: S.getRole.get(identity.role_key_wire) };
    },

    listRoleKeys(filter = {}) {
      const clauses = [];
      const params = {};
      for (const field of ["project_id", "role_kind", "scope_id", "state"]) {
        if (filter[field] !== undefined) {
          clauses.push(`${field}=@${field}`);
          params[field] = filter[field];
        }
      }
      if (Array.isArray(filter.states) && filter.states.length > 0) {
        clauses.push(
          `state IN (${filter.states.map((_, index) => `@state_${index}`).join(",")})`,
        );
        filter.states.forEach((state, index) => {
          params[`state_${index}`] = state;
        });
      }
      const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
      return db
        .prepare(
          `SELECT role_key_wire FROM role_registry${where} ORDER BY role_key_wire`,
        )
        .pluck()
        .all(params);
    },

    listRolesWithExpiredHolder(now) {
      return S.expiredHolderRoles.all(now);
    },

    listRoleCandidates(roleKeyWire) {
      decodeRoleKey(roleKeyWire);
      return S.listRoleCandidates.all(roleKeyWire).map(parseRoleCandidateRow);
    },

    upsertRoleCandidate(input) {
      const { role_key_wire } = roleIdentity(input);
      const current = S.getRoleCandidate.get(role_key_wire, input.agent_id);
      S.upsertRoleCandidate.run({
        role_key_wire,
        agent_id: input.agent_id,
        source: input.source ?? current?.source ?? "operator",
        priority: input.priority ?? current?.priority ?? 0,
        transport_locators_json: JSON.stringify(
          input.transport_locators ??
            parseJson(current?.transport_locators_json, []),
        ),
        consecutive_probe_failures:
          input.consecutive_probe_failures ??
          current?.consecutive_probe_failures ??
          0,
        excluded_until_ms:
          input.excluded_until_ms === undefined
            ? current?.excluded_until_ms ?? null
            : input.excluded_until_ms,
        last_probe_ms:
          input.last_probe_ms === undefined
            ? current?.last_probe_ms ?? null
            : input.last_probe_ms,
        last_probe_code:
          input.last_probe_code === undefined
            ? current?.last_probe_code ?? null
            : input.last_probe_code,
        updated_at_ms: input.updated_at_ms ?? Date.now(),
      });
      return parseRoleCandidateRow(
        S.getRoleCandidate.get(role_key_wire, input.agent_id),
      );
    },

    updateCandidateReachability(input) {
      const { role_key_wire } = roleIdentity(input);
      const current = S.getRoleCandidate.get(role_key_wire, input.agent_id);
      if (!current) return { ok: false, reason: "not_found" };

      let failures =
        input.consecutive_probe_failures ??
        current.consecutive_probe_failures;
      if (input.probe_failed === true || input.increment_probe_failures === true) {
        failures = current.consecutive_probe_failures + 1;
      } else if (input.probe_succeeded === true) {
        failures = 0;
      }
      S.updateCandidateReachability.run({
        role_key_wire,
        agent_id: input.agent_id,
        consecutive_probe_failures: failures,
        excluded_until_ms:
          input.excluded_until_ms === undefined
            ? current.excluded_until_ms
            : input.excluded_until_ms,
        last_probe_ms: input.last_probe_ms ?? Date.now(),
        last_probe_code:
          input.last_probe_code === undefined
            ? current.last_probe_code
            : input.last_probe_code,
        updated_at_ms: input.updated_at_ms ?? Date.now(),
      });
      return {
        ok: true,
        candidate: parseRoleCandidateRow(
          S.getRoleCandidate.get(role_key_wire, input.agent_id),
        ),
      };
    },

    listPendingRoleMessages(roleKeyWire, now) {
      decodeRoleKey(roleKeyWire);
      return S.pendingRoleMessages.all(roleKeyWire, now).map(parseMessageRow);
    },

    recoverRoleRegistry(now) {
      return recoverRegistry.immediate(now);
    },

    auditLog({
      type,
      from,
      to,
      topic,
      priority = 5,
      ttl_ms = 300000,
      payload = {},
      trace_id,
      correlation_id,
      status = "queued",
      role_key_wire = null,
    }) {
      const now = Date.now();
      const row = {
        id: uuidv7(),
        type,
        from_agent: from,
        to_agent: to,
        topic,
        priority,
        ttl_ms,
        created_at_ms: now,
        expires_at_ms: now + ttl_ms,
        correlation_id: correlation_id || uuidv7(),
        trace_id: trace_id || uuidv7(),
        payload_json: JSON.stringify(payload),
        status,
        role_key_wire,
      };
      S.insertAuditMessage.run(row);
      return { ...row, payload };
    },

    // 하위 호환: 기존 enqueueMessage 호출은 auditLog로 위임한다.
    enqueueMessage(args) {
      return store.auditLog(args);
    },

    getMessage(id) {
      return parseMessageRow(S.getMsg.get(id));
    },

    getResponseByCorrelation(cid) {
      return parseMessageRow(S.getResponse.get(cid));
    },

    getMessagesByTrace(tid) {
      return S.getMsgsByTrace.all(tid).map(parseMessageRow);
    },

    updateMessageStatus(id, status) {
      return S.setMsgStatus.run(status, id).changes > 0;
    },

    getAuditMessagesForAgent(
      agentId,
      { max_messages = 20, include_topics = null } = {},
    ) {
      const limit = clampMaxMessages(max_messages);
      const topics =
        Array.isArray(include_topics) && include_topics.length
          ? include_topics
          : store.getAgent(agentId)?.topics || [];

      const rows = topics.length
        ? S.recentAgentMessagesWithTopics.all(
            agentId,
            JSON.stringify(topics),
            limit,
          )
        : S.recentAgentMessages.all(agentId, limit);

      return rows.map(parseMessageRow);
    },

    // 하위 호환: 실시간 수신함 대신 감사 로그 재생 결과를 반환한다.
    deliverToAgent(messageId, agentId) {
      return !!store.getMessage(messageId) && !!agentId;
    },

    deliverToTopic(messageId, topic) {
      void messageId;
      return store.getAgentsByTopic(topic).length;
    },

    pollForAgent(agentId, { max_messages = 20, include_topics = null } = {}) {
      return store.getAuditMessagesForAgent(agentId, {
        max_messages,
        include_topics,
      });
    },

    ackMessages() {
      return 0;
    },

    insertHumanRequest({
      requester_agent,
      kind,
      prompt,
      requested_schema = {},
      deadline_ms,
      default_action,
      correlation_id,
      trace_id,
    }) {
      const requestId = uuidv7();
      const now = Date.now();
      const deadlineAt = now + deadline_ms;
      S.insertHR.run({
        request_id: requestId,
        requester_agent,
        kind,
        prompt,
        schema_json: JSON.stringify(requested_schema),
        state: "pending",
        deadline_ms: deadlineAt,
        default_action,
        correlation_id: correlation_id || uuidv7(),
        trace_id: trace_id || uuidv7(),
        response_json: null,
      });
      return {
        request_id: requestId,
        state: "pending",
        deadline_ms: deadlineAt,
      };
    },

    getHumanRequest(id) {
      return parseHumanRequestRow(S.getHR.get(id));
    },

    updateHumanRequest(id, state, resp = null) {
      return (
        S.updateHR.run(state, resp ? JSON.stringify(resp) : null, id).changes >
        0
      );
    },

    getPendingHumanRequests() {
      return S.pendingHR.all().map(parseHumanRequestRow);
    },

    expireHumanRequests() {
      return S.expireHR.run(Date.now()).changes;
    },

    moveToDeadLetter(messageId, reason, lastError = null) {
      db.transaction(() => {
        S.setMsgStatus.run("dead_letter", messageId);
        S.insertDL.run(messageId, reason, Date.now(), lastError);
      })();
      return true;
    },

    getDeadLetters(limit = 50) {
      return S.getDL.all(limit);
    },

    createAssign({
      job_id,
      supervisor_agent,
      worker_agent,
      topic = "assign.job",
      task = "",
      payload = {},
      status = "queued",
      attempt = 1,
      retry_count = 0,
      max_retries = 0,
      priority = 5,
      ttl_ms = DEFAULT_ASSIGN_TTL_MS,
      timeout_ms = DEFAULT_ASSIGN_TIMEOUT_MS,
      deadline_ms,
      dispatched_at_ms = null,
      trace_id,
      correlation_id,
      last_message_id = null,
      result = null,
      error = null,
    }) {
      const now = Date.now();
      const normalizedTimeout = clampDurationMs(
        timeout_ms,
        DEFAULT_ASSIGN_TIMEOUT_MS,
      );
      const row = {
        job_id: job_id || uuidv7(),
        supervisor_agent,
        worker_agent,
        topic: String(topic || "assign.job"),
        task: String(task || ""),
        payload_json: JSON.stringify(payload || {}),
        status,
        attempt: Math.max(1, Number(attempt) || 1),
        retry_count: Math.max(0, Number(retry_count) || 0),
        max_retries: Math.max(0, Number(max_retries) || 0),
        priority: clampPriority(priority, 5),
        ttl_ms: clampDurationMs(ttl_ms, normalizedTimeout),
        timeout_ms: normalizedTimeout,
        deadline_ms: Number.isFinite(Number(deadline_ms))
          ? Math.trunc(Number(deadline_ms))
          : now + normalizedTimeout,
        trace_id: trace_id || uuidv7(),
        correlation_id: correlation_id || uuidv7(),
        last_message_id,
        result_json: result == null ? null : JSON.stringify(result),
        error_json: error == null ? null : JSON.stringify(error),
        created_at_ms: now,
        updated_at_ms: now,
        started_at_ms: status === "running" ? now : null,
        dispatched_at_ms:
          dispatched_at_ms == null || !Number.isFinite(Number(dispatched_at_ms))
            ? null
            : Math.trunc(Number(dispatched_at_ms)),
        completed_at_ms: ["succeeded", "failed", "timed_out"].includes(status)
          ? now
          : null,
        last_retry_at_ms: retry_count > 0 ? now : null,
      };
      S.insertAssign.run(row);
      const inserted = store.getAssign(row.job_id);
      notifyAssignStatusListeners(inserted);
      return inserted;
    },

    getAssign(jobId) {
      return parseAssignRow(S.getAssign.get(jobId));
    },

    updateAssignStatus(jobId, status, patch = {}) {
      const current = store.getAssign(jobId);
      if (!current) return null;

      const now = Date.now();
      const nextStatus = status || current.status;
      const isTerminal = ["succeeded", "failed", "timed_out"].includes(
        nextStatus,
      );
      const nextTimeout = clampDurationMs(
        patch.timeout_ms ?? current.timeout_ms,
        current.timeout_ms,
      );
      const nextRow = {
        job_id: current.job_id,
        supervisor_agent: patch.supervisor_agent ?? current.supervisor_agent,
        worker_agent: patch.worker_agent ?? current.worker_agent,
        topic: patch.topic ?? current.topic,
        task: patch.task ?? current.task,
        payload_json: JSON.stringify(patch.payload ?? current.payload ?? {}),
        status: nextStatus,
        attempt: Math.max(
          1,
          Number(patch.attempt ?? current.attempt) || current.attempt || 1,
        ),
        retry_count: Math.max(
          0,
          Number(patch.retry_count ?? current.retry_count) || 0,
        ),
        max_retries: Math.max(
          0,
          Number(patch.max_retries ?? current.max_retries) || 0,
        ),
        priority: clampPriority(
          patch.priority ?? current.priority,
          current.priority || 5,
        ),
        ttl_ms: clampDurationMs(
          patch.ttl_ms ?? current.ttl_ms,
          current.ttl_ms || nextTimeout,
        ),
        timeout_ms: nextTimeout,
        deadline_ms: (() => {
          if (Object.hasOwn(patch, "deadline_ms")) {
            return patch.deadline_ms == null
              ? null
              : Math.trunc(Number(patch.deadline_ms));
          }
          if (isTerminal) return null;
          if (nextStatus === "running" && !current.deadline_ms)
            return now + nextTimeout;
          return current.deadline_ms;
        })(),
        trace_id: patch.trace_id ?? current.trace_id,
        correlation_id: patch.correlation_id ?? current.correlation_id,
        last_message_id: Object.hasOwn(patch, "last_message_id")
          ? patch.last_message_id
          : current.last_message_id,
        result_json: Object.hasOwn(patch, "result")
          ? patch.result == null
            ? null
            : JSON.stringify(patch.result)
          : current.result == null
            ? null
            : JSON.stringify(current.result),
        error_json: Object.hasOwn(patch, "error")
          ? patch.error == null
            ? null
            : JSON.stringify(patch.error)
          : current.error == null
            ? null
            : JSON.stringify(current.error),
        updated_at_ms: now,
        started_at_ms: Object.hasOwn(patch, "started_at_ms")
          ? patch.started_at_ms
          : nextStatus === "running"
            ? current.started_at_ms || now
            : current.started_at_ms,
        dispatched_at_ms: Object.hasOwn(patch, "dispatched_at_ms")
          ? patch.dispatched_at_ms
          : current.dispatched_at_ms,
        completed_at_ms: Object.hasOwn(patch, "completed_at_ms")
          ? patch.completed_at_ms
          : isTerminal
            ? current.completed_at_ms || now
            : current.completed_at_ms,
        last_retry_at_ms: Object.hasOwn(patch, "last_retry_at_ms")
          ? patch.last_retry_at_ms
          : current.last_retry_at_ms,
      };
      S.updateAssign.run(nextRow);
      const updated = store.getAssign(jobId);
      if (updated && current.status !== updated.status) {
        notifyAssignStatusListeners(updated);
      }
      return updated;
    },

    listAssigns({
      supervisor_agent,
      worker_agent,
      status,
      statuses,
      trace_id,
      correlation_id,
      active_before_ms,
      limit = 50,
    } = {}) {
      const clauses = [];
      const values = [];

      if (supervisor_agent) {
        clauses.push("supervisor_agent = ?");
        values.push(supervisor_agent);
      }
      if (worker_agent) {
        clauses.push("worker_agent = ?");
        values.push(worker_agent);
      }
      if (trace_id) {
        clauses.push("trace_id = ?");
        values.push(trace_id);
      }
      if (correlation_id) {
        clauses.push("correlation_id = ?");
        values.push(correlation_id);
      }

      const statusList =
        Array.isArray(statuses) && statuses.length
          ? statuses
          : status
            ? [status]
            : [];
      if (statusList.length) {
        clauses.push(`status IN (${statusList.map(() => "?").join(",")})`);
        values.push(...statusList);
      }

      if (Number.isFinite(Number(active_before_ms))) {
        clauses.push("deadline_ms IS NOT NULL AND deadline_ms <= ?");
        values.push(Math.trunc(Number(active_before_ms)));
      }

      // WHERE 절은 호출마다 달라지므로 prepared statement를 미리 캐시할 수 없다.
      // db.prepare()는 호출당 한 번 실행되며, better-sqlite3 내부에서 SQLite 구문 파싱을
      // 수행한다. 필터 조합이 2^6 = 64가지이므로 정적 캐시 대신 동적 생성을 선택했다.
      // 이 함수는 hot path(heartbeat/poll)가 아닌 관리/조회 경로에서만 호출되므로 허용한다.
      const sql = `
        SELECT * FROM assign_jobs
        ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
        ORDER BY updated_at_ms DESC
        LIMIT ?`;
      values.push(clampMaxMessages(limit, 50));
      return db
        .prepare(sql)
        .all(...values)
        .map(parseAssignRow);
    },

    retryAssign(jobId, patch = {}) {
      const current = store.getAssign(jobId);
      if (!current) return null;

      const nextRetryCount = Math.max(
        0,
        Number(patch.retry_count ?? current.retry_count + 1) || 0,
      );
      const nextAttempt = Math.max(
        current.attempt + 1,
        Number(patch.attempt ?? current.attempt + 1) || 1,
      );
      const nextTimeout = clampDurationMs(
        patch.timeout_ms ?? current.timeout_ms,
        current.timeout_ms,
      );
      return store.updateAssignStatus(jobId, "queued", {
        retry_count: nextRetryCount,
        attempt: nextAttempt,
        timeout_ms: nextTimeout,
        ttl_ms: patch.ttl_ms ?? current.ttl_ms,
        deadline_ms: Date.now() + nextTimeout,
        completed_at_ms: null,
        started_at_ms: null,
        dispatched_at_ms: null,
        last_retry_at_ms: Date.now(),
        result: patch.result ?? null,
        error: Object.hasOwn(patch, "error") ? patch.error : current.error,
        last_message_id: null,
      });
    },

    sweepExpired() {
      const now = Date.now();
      return db.transaction(() => {
        const expired = S.findExpired.all(now);
        for (const { id } of expired) {
          S.setMsgStatus.run("dead_letter", id);
          S.insertDL.run(id, "ttl_expired", now, null);
        }
        const humanRequests = S.expireHR.run(now).changes;
        return { messages: expired.length, human_requests: humanRequests };
      })();
    },

    getQueueDepths() {
      return {
        urgent: S.urgentDepth.get().cnt,
        normal: S.normalDepth.get().cnt,
        dlq: S.dlqDepth.get().cnt,
      };
    },

    onAssignStatusChange(listener) {
      if (typeof listener !== "function") {
        return () => {};
      }
      assignStatusListeners.add(listener);
      return () => {
        assignStatusListeners.delete(listener);
      };
    },

    getDeliveryStats() {
      return {
        total_deliveries: S.ackedRecent.get(Date.now()).cnt,
        avg_delivery_ms: 0,
      };
    },

    getHubStats() {
      return {
        online_agents: S.onlineCount.get().cnt,
        total_messages: S.msgCount.get().cnt,
        active_assign_jobs: S.activeAssignCount.get().cnt,
        ...store.getQueueDepths(),
      };
    },

    getAuditStats() {
      return {
        online_agents: S.onlineCount.get().cnt,
        total_messages: S.msgCount.get().cnt,
        dlq: S.dlqDepth.get().cnt,
        assign_queued: S.assignCountByStatus.get("queued").cnt,
        assign_running: S.assignCountByStatus.get("running").cnt,
        assign_failed: S.assignCountByStatus.get("failed").cnt,
        assign_timed_out: S.assignCountByStatus.get("timed_out").cnt,
      };
    },

    // --- Reflexion CRUD ---

    addReflexion({
      type = "reflexion",
      error_pattern,
      error_message,
      context = {},
      solution,
      solution_code = null,
      adaptive_state = {},
      confidence = 0.5,
      hit_count = 1,
      success_count = 0,
      last_hit_ms,
      created_at_ms,
      updated_at_ms,
    }) {
      const now = Date.now();
      const id = uuidv7();
      S.insertReflexion.run({
        id,
        type,
        error_pattern,
        error_message,
        context_json: JSON.stringify(context),
        solution,
        solution_code,
        adaptive_state_json: JSON.stringify(adaptive_state),
        confidence,
        hit_count,
        success_count,
        last_hit_ms: last_hit_ms ?? now,
        created_at_ms: created_at_ms ?? now,
        updated_at_ms: updated_at_ms ?? now,
      });
      return store.getReflexion(id);
    },

    getReflexion(id) {
      return parseReflexionRow(S.getReflexionById.get(id));
    },

    findReflexion(errorPattern, context = {}) {
      const ctxKeys = Object.keys(context).filter((k) => context[k] != null);
      const ctxWhere = ctxKeys
        .map((k) => ` AND json_extract(context_json, '$.${k}') = ?`)
        .join("");
      const ctxVals = ctxKeys.map((k) => context[k]);

      if (ctxKeys.length === 0) {
        let rows = S.findReflexionExact.all(errorPattern);
        if (rows.length) return rows.map(parseReflexionRow);
        const escaped = errorPattern.replace(/[%_\\]/g, "\\$&");
        rows = S.findReflexionLike.all(`%${escaped.slice(0, 100)}%`);
        return rows.map(parseReflexionRow);
      }

      const exactSql = `SELECT * FROM reflexion_entries WHERE error_pattern = ?${ctxWhere} ORDER BY confidence DESC`;
      let rows = db.prepare(exactSql).all(errorPattern, ...ctxVals);
      if (rows.length) return rows.map(parseReflexionRow);

      const escaped = errorPattern.replace(/[%_\\]/g, "\\$&");
      const likeSql = `SELECT * FROM reflexion_entries WHERE error_pattern LIKE ? ESCAPE '\\'${ctxWhere} ORDER BY confidence DESC LIMIT 10`;
      rows = db.prepare(likeSql).all(`%${escaped.slice(0, 100)}%`, ...ctxVals);
      return rows.map(parseReflexionRow);
    },

    updateReflexionHit(id, success = false) {
      const now = Date.now();
      if (success) {
        S.updateReflexionHitSuccess.run(now, now, id);
      } else {
        S.updateReflexionHitOnly.run(now, now, id);
      }
      const entry = store.getReflexion(id);
      if (entry && entry.hit_count > 0) {
        const conf = recalcConfidence(entry);
        S.updateReflexionConfidence.run(
          Math.max(0, Math.min(1, conf)),
          now,
          id,
        );
      }
      return store.getReflexion(id);
    },

    listReflexion(filters = {}) {
      const {
        type,
        minConfidence = Number.NEGATIVE_INFINITY,
        projectSlug,
      } = filters;
      return S.listReflexionEntries
        .all()
        .map(parseReflexionRow)
        .filter((entry) => !type || entry.type === type)
        .filter((entry) => entry.confidence >= minConfidence)
        .filter(
          (entry) =>
            !projectSlug || entry.adaptive_state?.project_slug === projectSlug,
        );
    },

    patchReflexion(id, patch = {}) {
      const current = store.getReflexion(id);
      if (!current) return null;
      const next = {
        ...current,
        ...patch,
        context: patch.context ?? current.context,
        adaptive_state: patch.adaptive_state ?? current.adaptive_state,
        updated_at_ms: patch.updated_at_ms ?? Date.now(),
      };
      const sets = [
        ["type", next.type],
        ["error_pattern", next.error_pattern],
        ["error_message", next.error_message],
        ["context_json", JSON.stringify(next.context ?? {})],
        ["solution", next.solution],
        ["solution_code", next.solution_code ?? null],
        ["adaptive_state_json", JSON.stringify(next.adaptive_state ?? {})],
        ["confidence", next.confidence],
        ["hit_count", next.hit_count],
        ["success_count", next.success_count],
        ["last_hit_ms", next.last_hit_ms],
        ["updated_at_ms", next.updated_at_ms],
      ];
      const sql = `UPDATE reflexion_entries SET ${sets.map(([key]) => `${key} = ?`).join(", ")} WHERE id = ?`;
      db.prepare(sql).run(...sets.map(([, value]) => value), id);
      return store.getReflexion(id);
    },

    deleteReflexion(id) {
      return S.deleteReflexionEntry.run(id).changes > 0;
    },

    pruneReflexion(maxAge_ms = 30 * 24 * 3600 * 1000, minConfidence = 0.2) {
      const cutoff = Date.now() - maxAge_ms;
      return S.pruneReflexionEntries.run(cutoff, minConfidence).changes;
    },
  };

  return store;
}
