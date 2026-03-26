// hub/store.mjs — SQLite 감사 로그/메타데이터 저장소
// 실시간 배달 큐는 router/pipe가 담당하고, SQLite는 재생/감사 용도로만 유지한다.
import Database from 'better-sqlite3';
import { recalcConfidence } from './reflexion.mjs';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
let _rndPool = Buffer.alloc(0), _rndOff = 0;

function pooledRandom(n) {
  if (_rndOff + n > _rndPool.length) {
    _rndPool = randomBytes(256);
    _rndOff = 0;
  }
  const out = Buffer.from(_rndPool.subarray(_rndOff, _rndOff + n));
  _rndOff += n;
  return out;
}

/** UUIDv7 생성 (RFC 9562, 단조 증가 보장) */
let _lastMs = 0n;
let _seq = 0;
export function uuidv7() {
  let now = BigInt(Date.now());
  if (now <= _lastMs) {
    _seq++;
    // _seq > 0xfff (4095): 시퀀스 공간 소진 시 타임스탬프를 1ms 앞당겨 단조 증가를 보장.
    // 고처리량 환경에서는 타임스탬프가 실제 벽시계보다 앞서 드리프트될 수 있음 (설계상 의도).
    if (_seq > 0xfff) {
      now = _lastMs + 1n;
      _seq = 0;
    }
  } else {
    _seq = 0;
  }
  _lastMs = now;
  const buf = pooledRandom(16);
  buf[0] = Number((now >> 40n) & 0xffn);
  buf[1] = Number((now >> 32n) & 0xffn);
  buf[2] = Number((now >> 24n) & 0xffn);
  buf[3] = Number((now >> 16n) & 0xffn);
  buf[4] = Number((now >> 8n) & 0xffn);
  buf[5] = Number(now & 0xffn);
  buf[6] = ((_seq >> 8) & 0x0f) | 0x70;
  buf[7] = _seq & 0xff;
  buf[8] = (buf[8] & 0x3f) | 0x80;
  const h = buf.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function parseJson(str, fallback = null) {
  if (str == null) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
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
  const { context_json, ...rest } = row;
  return { ...rest, context: parseJson(context_json, {}) };
}

/**
 * 저장소 생성
 * @param {string} dbPath
 */
export function createStore(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('wal_autocheckpoint = 1000');

  const schemaSQL = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec("CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT)");
  const SCHEMA_VERSION = '3';
  const curVer = (() => {
    try { return db.prepare("SELECT value FROM _meta WHERE key='schema_version'").pluck().get(); }
    catch { return null; }
  })();
  // 마이그레이션 전략: 스키마 버전이 다르면 schema.sql을 재실행한다.
  // schema.sql은 CREATE TABLE IF NOT EXISTS 패턴을 사용하므로 멱등하게 적용된다.
  // 비파괴적 컬럼 추가는 자동으로 처리되지만, 컬럼 제거/이름 변경은 수동 마이그레이션이 필요하다.
  if (curVer !== SCHEMA_VERSION) {
    if (curVer != null) {
      // 이미 버전이 기록된 DB에서 버전 불일치가 발생한 경우 경고한다.
      console.warn(`[store] schema version mismatch: found=${curVer} expected=${SCHEMA_VERSION}. Applying schema.sql (idempotent).`);
    }
    db.exec(schemaSQL);
    db.prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION);
  }

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
    getAgent: db.prepare('SELECT * FROM agents WHERE agent_id = ?'),
    setAgentTopics: db.prepare('UPDATE agents SET topics_json=?, last_seen_ms=? WHERE agent_id=?'),
    heartbeat: db.prepare("UPDATE agents SET last_seen_ms=?, lease_expires_ms=?, status='online' WHERE agent_id=?"),
    setAgentStatus: db.prepare('UPDATE agents SET status=? WHERE agent_id=?'),
    onlineAgents: db.prepare("SELECT * FROM agents WHERE status != 'offline'"),
    allAgents: db.prepare('SELECT * FROM agents'),
    agentsByTopic: db.prepare("SELECT a.* FROM agents a, json_each(a.topics_json) t WHERE t.value=? AND a.status != 'offline'"),
    markStale: db.prepare("UPDATE agents SET status='stale' WHERE status='online' AND lease_expires_ms < ?"),
    markOffline: db.prepare("UPDATE agents SET status='offline' WHERE status='stale' AND lease_expires_ms < ? - 300000"),

    insertAuditMessage: db.prepare(`
      INSERT INTO messages (id, type, from_agent, to_agent, topic, priority, ttl_ms, created_at_ms, expires_at_ms, correlation_id, trace_id, payload_json, status)
      VALUES (@id, @type, @from_agent, @to_agent, @topic, @priority, @ttl_ms, @created_at_ms, @expires_at_ms, @correlation_id, @trace_id, @payload_json, @status)`),
    getMsg: db.prepare('SELECT * FROM messages WHERE id=?'),
    getResponse: db.prepare("SELECT * FROM messages WHERE correlation_id=? AND type='response' ORDER BY created_at_ms DESC LIMIT 1"),
    getMsgsByTrace: db.prepare('SELECT * FROM messages WHERE trace_id=? ORDER BY created_at_ms'),
    setMsgStatus: db.prepare('UPDATE messages SET status=? WHERE id=?'),
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
    getHR: db.prepare('SELECT * FROM human_requests WHERE request_id=?'),
    updateHR: db.prepare('UPDATE human_requests SET state=?, response_json=? WHERE request_id=?'),
    pendingHR: db.prepare("SELECT * FROM human_requests WHERE state='pending'"),
    expireHR: db.prepare("UPDATE human_requests SET state='timed_out' WHERE state='pending' AND deadline_ms < ?"),

    insertDL: db.prepare('INSERT OR REPLACE INTO dead_letters (message_id, reason, failed_at_ms, last_error) VALUES (?,?,?,?)'),
    getDL: db.prepare('SELECT * FROM dead_letters ORDER BY failed_at_ms DESC LIMIT ?'),

    insertAssign: db.prepare(`
      INSERT INTO assign_jobs (
        job_id, supervisor_agent, worker_agent, topic, task, payload_json,
        status, attempt, retry_count, max_retries, priority, ttl_ms, timeout_ms, deadline_ms,
        trace_id, correlation_id, last_message_id, result_json, error_json,
        created_at_ms, updated_at_ms, started_at_ms, completed_at_ms, last_retry_at_ms
      ) VALUES (
        @job_id, @supervisor_agent, @worker_agent, @topic, @task, @payload_json,
        @status, @attempt, @retry_count, @max_retries, @priority, @ttl_ms, @timeout_ms, @deadline_ms,
        @trace_id, @correlation_id, @last_message_id, @result_json, @error_json,
        @created_at_ms, @updated_at_ms, @started_at_ms, @completed_at_ms, @last_retry_at_ms
      )`),
    getAssign: db.prepare('SELECT * FROM assign_jobs WHERE job_id = ?'),
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
        completed_at_ms=@completed_at_ms,
        last_retry_at_ms=@last_retry_at_ms
      WHERE job_id=@job_id`),

    findExpired: db.prepare("SELECT id FROM messages WHERE status='queued' AND expires_at_ms < ?"),
    urgentDepth: db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE status='queued' AND priority >= 7"),
    normalDepth: db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE status='queued' AND priority < 7"),
    onlineCount: db.prepare("SELECT COUNT(*) as cnt FROM agents WHERE status='online'"),
    msgCount: db.prepare('SELECT COUNT(*) as cnt FROM messages'),
    dlqDepth: db.prepare('SELECT COUNT(*) as cnt FROM dead_letters'),
    ackedRecent: db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE status='acked' AND created_at_ms > ? - 300000"),
    assignCountByStatus: db.prepare('SELECT COUNT(*) as cnt FROM assign_jobs WHERE status = ?'),
    activeAssignCount: db.prepare("SELECT COUNT(*) as cnt FROM assign_jobs WHERE status IN ('queued','running')"),

    // reflexion
    insertReflexion: db.prepare(`
      INSERT INTO reflexion_entries (id, error_pattern, error_message, context_json, solution, solution_code, confidence, hit_count, success_count, last_hit_ms, created_at_ms, updated_at_ms)
      VALUES (@id, @error_pattern, @error_message, @context_json, @solution, @solution_code, @confidence, @hit_count, @success_count, @last_hit_ms, @created_at_ms, @updated_at_ms)`),
    getReflexionById: db.prepare('SELECT * FROM reflexion_entries WHERE id = ?'),
    findReflexionExact: db.prepare('SELECT * FROM reflexion_entries WHERE error_pattern = ? ORDER BY confidence DESC'),
    findReflexionLike: db.prepare("SELECT * FROM reflexion_entries WHERE error_pattern LIKE ? ESCAPE '\\' ORDER BY confidence DESC LIMIT 10"),
    updateReflexionHitSuccess: db.prepare('UPDATE reflexion_entries SET hit_count = hit_count + 1, success_count = success_count + 1, last_hit_ms = ?, updated_at_ms = ? WHERE id = ?'),
    updateReflexionHitOnly: db.prepare('UPDATE reflexion_entries SET hit_count = hit_count + 1, last_hit_ms = ?, updated_at_ms = ? WHERE id = ?'),
    updateReflexionConfidence: db.prepare('UPDATE reflexion_entries SET confidence = ?, updated_at_ms = ? WHERE id = ?'),
    pruneReflexionEntries: db.prepare('DELETE FROM reflexion_entries WHERE updated_at_ms < ? AND confidence < ?'),
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
      try { listener(event, row); } catch {}
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

  function clampDuration(value, fallback = 600000, min = 1000, max = 86400000) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(min, Math.min(Math.trunc(num), max));
  }

  const store = {
    db,
    uuidv7,

    close() {
      db.close();
    },

    registerAgent({ agent_id, cli, pid, capabilities = [], topics = [], heartbeat_ttl_ms = 30000, metadata = {} }) {
      const now = Date.now();
      const leaseExpires = now + heartbeat_ttl_ms;
      S.upsertAgent.run({
        agent_id,
        cli,
        pid: pid ?? null,
        capabilities_json: JSON.stringify(capabilities),
        topics_json: JSON.stringify(topics),
        last_seen_ms: now,
        lease_expires_ms: leaseExpires,
        status: 'online',
        metadata_json: JSON.stringify(metadata),
      });
      return { agent_id, lease_id: uuidv7(), lease_expires_ms: leaseExpires, server_time_ms: now };
    },

    getAgent(id) {
      return parseAgentRow(S.getAgent.get(id));
    },

    refreshLease(agentId, ttlMs = 30000) {
      const now = Date.now();
      S.heartbeat.run(now, now + ttlMs, agentId);
      return { agent_id: agentId, lease_expires_ms: now + ttlMs, server_time_ms: now };
    },

    updateAgentTopics(agentId, topics = []) {
      const now = Date.now();
      return S.setAgentTopics.run(JSON.stringify(topics), now, agentId).changes > 0;
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

    auditLog({ type, from, to, topic, priority = 5, ttl_ms = 300000, payload = {}, trace_id, correlation_id, status = 'queued' }) {
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

    getAuditMessagesForAgent(agentId, { max_messages = 20, include_topics = null } = {}) {
      const limit = clampMaxMessages(max_messages);
      const topics = Array.isArray(include_topics) && include_topics.length
        ? include_topics
        : (store.getAgent(agentId)?.topics || []);

      const rows = topics.length
        ? S.recentAgentMessagesWithTopics.all(agentId, JSON.stringify(topics), limit)
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

    insertHumanRequest({ requester_agent, kind, prompt, requested_schema = {}, deadline_ms, default_action, correlation_id, trace_id }) {
      const requestId = uuidv7();
      const now = Date.now();
      const deadlineAt = now + deadline_ms;
      S.insertHR.run({
        request_id: requestId,
        requester_agent,
        kind,
        prompt,
        schema_json: JSON.stringify(requested_schema),
        state: 'pending',
        deadline_ms: deadlineAt,
        default_action,
        correlation_id: correlation_id || uuidv7(),
        trace_id: trace_id || uuidv7(),
        response_json: null,
      });
      return { request_id: requestId, state: 'pending', deadline_ms: deadlineAt };
    },

    getHumanRequest(id) {
      return parseHumanRequestRow(S.getHR.get(id));
    },

    updateHumanRequest(id, state, resp = null) {
      return S.updateHR.run(state, resp ? JSON.stringify(resp) : null, id).changes > 0;
    },

    getPendingHumanRequests() {
      return S.pendingHR.all().map(parseHumanRequestRow);
    },

    expireHumanRequests() {
      return S.expireHR.run(Date.now()).changes;
    },

    moveToDeadLetter(messageId, reason, lastError = null) {
      db.transaction(() => {
        S.setMsgStatus.run('dead_letter', messageId);
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
      topic = 'assign.job',
      task = '',
      payload = {},
      status = 'queued',
      attempt = 1,
      retry_count = 0,
      max_retries = 0,
      priority = 5,
      ttl_ms = 600000,
      timeout_ms = 600000,
      deadline_ms,
      trace_id,
      correlation_id,
      last_message_id = null,
      result = null,
      error = null,
    }) {
      const now = Date.now();
      const normalizedTimeout = clampDuration(timeout_ms, 600000);
      const row = {
        job_id: job_id || uuidv7(),
        supervisor_agent,
        worker_agent,
        topic: String(topic || 'assign.job'),
        task: String(task || ''),
        payload_json: JSON.stringify(payload || {}),
        status,
        attempt: Math.max(1, Number(attempt) || 1),
        retry_count: Math.max(0, Number(retry_count) || 0),
        max_retries: Math.max(0, Number(max_retries) || 0),
        priority: clampPriority(priority, 5),
        ttl_ms: clampDuration(ttl_ms, normalizedTimeout),
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
        started_at_ms: status === 'running' ? now : null,
        completed_at_ms: ['succeeded', 'failed', 'timed_out'].includes(status) ? now : null,
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
      const isTerminal = ['succeeded', 'failed', 'timed_out'].includes(nextStatus);
      const nextTimeout = clampDuration(patch.timeout_ms ?? current.timeout_ms, current.timeout_ms);
      const nextRow = {
        job_id: current.job_id,
        supervisor_agent: patch.supervisor_agent ?? current.supervisor_agent,
        worker_agent: patch.worker_agent ?? current.worker_agent,
        topic: patch.topic ?? current.topic,
        task: patch.task ?? current.task,
        payload_json: JSON.stringify(patch.payload ?? current.payload ?? {}),
        status: nextStatus,
        attempt: Math.max(1, Number(patch.attempt ?? current.attempt) || current.attempt || 1),
        retry_count: Math.max(0, Number(patch.retry_count ?? current.retry_count) || 0),
        max_retries: Math.max(0, Number(patch.max_retries ?? current.max_retries) || 0),
        priority: clampPriority(patch.priority ?? current.priority, current.priority || 5),
        ttl_ms: clampDuration(patch.ttl_ms ?? current.ttl_ms, current.ttl_ms || nextTimeout),
        timeout_ms: nextTimeout,
        deadline_ms: (() => {
          if (Object.prototype.hasOwnProperty.call(patch, 'deadline_ms')) {
            return patch.deadline_ms == null ? null : Math.trunc(Number(patch.deadline_ms));
          }
          if (isTerminal) return null;
          if (nextStatus === 'running' && !current.deadline_ms) return now + nextTimeout;
          return current.deadline_ms;
        })(),
        trace_id: patch.trace_id ?? current.trace_id,
        correlation_id: patch.correlation_id ?? current.correlation_id,
        last_message_id: Object.prototype.hasOwnProperty.call(patch, 'last_message_id')
          ? patch.last_message_id
          : current.last_message_id,
        result_json: Object.prototype.hasOwnProperty.call(patch, 'result')
          ? (patch.result == null ? null : JSON.stringify(patch.result))
          : (current.result == null ? null : JSON.stringify(current.result)),
        error_json: Object.prototype.hasOwnProperty.call(patch, 'error')
          ? (patch.error == null ? null : JSON.stringify(patch.error))
          : (current.error == null ? null : JSON.stringify(current.error)),
        updated_at_ms: now,
        started_at_ms: Object.prototype.hasOwnProperty.call(patch, 'started_at_ms')
          ? patch.started_at_ms
          : (nextStatus === 'running' ? (current.started_at_ms || now) : current.started_at_ms),
        completed_at_ms: Object.prototype.hasOwnProperty.call(patch, 'completed_at_ms')
          ? patch.completed_at_ms
          : (isTerminal ? (current.completed_at_ms || now) : current.completed_at_ms),
        last_retry_at_ms: Object.prototype.hasOwnProperty.call(patch, 'last_retry_at_ms')
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
        clauses.push('supervisor_agent = ?');
        values.push(supervisor_agent);
      }
      if (worker_agent) {
        clauses.push('worker_agent = ?');
        values.push(worker_agent);
      }
      if (trace_id) {
        clauses.push('trace_id = ?');
        values.push(trace_id);
      }
      if (correlation_id) {
        clauses.push('correlation_id = ?');
        values.push(correlation_id);
      }

      const statusList = Array.isArray(statuses) && statuses.length
        ? statuses
        : (status ? [status] : []);
      if (statusList.length) {
        clauses.push(`status IN (${statusList.map(() => '?').join(',')})`);
        values.push(...statusList);
      }

      if (Number.isFinite(Number(active_before_ms))) {
        clauses.push('deadline_ms IS NOT NULL AND deadline_ms <= ?');
        values.push(Math.trunc(Number(active_before_ms)));
      }

      // WHERE 절은 호출마다 달라지므로 prepared statement를 미리 캐시할 수 없다.
      // db.prepare()는 호출당 한 번 실행되며, better-sqlite3 내부에서 SQLite 구문 파싱을
      // 수행한다. 필터 조합이 2^6 = 64가지이므로 정적 캐시 대신 동적 생성을 선택했다.
      // 이 함수는 hot path(heartbeat/poll)가 아닌 관리/조회 경로에서만 호출되므로 허용한다.
      const sql = `
        SELECT * FROM assign_jobs
        ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
        ORDER BY updated_at_ms DESC
        LIMIT ?`;
      values.push(clampMaxMessages(limit, 50));
      return db.prepare(sql).all(...values).map(parseAssignRow);
    },

    retryAssign(jobId, patch = {}) {
      const current = store.getAssign(jobId);
      if (!current) return null;

      const nextRetryCount = Math.max(0, Number(patch.retry_count ?? current.retry_count + 1) || 0);
      const nextAttempt = Math.max(current.attempt + 1, Number(patch.attempt ?? current.attempt + 1) || 1);
      const nextTimeout = clampDuration(patch.timeout_ms ?? current.timeout_ms, current.timeout_ms);
      return store.updateAssignStatus(jobId, 'queued', {
        retry_count: nextRetryCount,
        attempt: nextAttempt,
        timeout_ms: nextTimeout,
        ttl_ms: patch.ttl_ms ?? current.ttl_ms,
        deadline_ms: Date.now() + nextTimeout,
        completed_at_ms: null,
        started_at_ms: null,
        last_retry_at_ms: Date.now(),
        result: patch.result ?? null,
        error: Object.prototype.hasOwnProperty.call(patch, 'error') ? patch.error : current.error,
        last_message_id: null,
      });
    },

    sweepExpired() {
      const now = Date.now();
      return db.transaction(() => {
        const expired = S.findExpired.all(now);
        for (const { id } of expired) {
          S.setMsgStatus.run('dead_letter', id);
          S.insertDL.run(id, 'ttl_expired', now, null);
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
      if (typeof listener !== 'function') {
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
        assign_queued: S.assignCountByStatus.get('queued').cnt,
        assign_running: S.assignCountByStatus.get('running').cnt,
        assign_failed: S.assignCountByStatus.get('failed').cnt,
        assign_timed_out: S.assignCountByStatus.get('timed_out').cnt,
      };
    },

    // --- Reflexion CRUD ---

    addReflexion({ error_pattern, error_message, context = {}, solution, solution_code = null }) {
      const now = Date.now();
      const id = uuidv7();
      S.insertReflexion.run({
        id,
        error_pattern,
        error_message,
        context_json: JSON.stringify(context),
        solution,
        solution_code,
        confidence: 0.5,
        hit_count: 1,
        success_count: 0,
        last_hit_ms: now,
        created_at_ms: now,
        updated_at_ms: now,
      });
      return store.getReflexion(id);
    },

    getReflexion(id) {
      return parseReflexionRow(S.getReflexionById.get(id));
    },

    findReflexion(errorPattern, context = {}) {
      const ctxKeys = Object.keys(context).filter(k => context[k] != null);
      const ctxWhere = ctxKeys.map(k => ` AND json_extract(context_json, '$.${k}') = ?`).join('');
      const ctxVals = ctxKeys.map(k => context[k]);

      if (ctxKeys.length === 0) {
        let rows = S.findReflexionExact.all(errorPattern);
        if (rows.length) return rows.map(parseReflexionRow);
        const escaped = errorPattern.replace(/[%_\\]/g, '\\$&');
        rows = S.findReflexionLike.all(`%${escaped.slice(0, 100)}%`);
        return rows.map(parseReflexionRow);
      }

      const exactSql = `SELECT * FROM reflexion_entries WHERE error_pattern = ?${ctxWhere} ORDER BY confidence DESC`;
      let rows = db.prepare(exactSql).all(errorPattern, ...ctxVals);
      if (rows.length) return rows.map(parseReflexionRow);

      const escaped = errorPattern.replace(/[%_\\]/g, '\\$&');
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
        S.updateReflexionConfidence.run(Math.max(0, Math.min(1, conf)), now, id);
      }
      return store.getReflexion(id);
    },

    pruneReflexion(maxAge_ms = 30 * 24 * 3600 * 1000, minConfidence = 0.2) {
      const cutoff = Date.now() - maxAge_ms;
      return S.pruneReflexionEntries.run(cutoff, minConfidence).changes;
    },
  };

  return store;
}
