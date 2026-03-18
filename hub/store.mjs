// hub/store.mjs — SQLite 감사 로그/메타데이터 저장소
// 실시간 배달 큐는 router/pipe가 담당하고, SQLite는 재생/감사 용도로만 유지한다.
import Database from 'better-sqlite3';
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
  const SCHEMA_VERSION = '1';
  const curVer = (() => {
    try { return db.prepare("SELECT value FROM _meta WHERE key='schema_version'").pluck().get(); }
    catch { return null; }
  })();
  if (curVer !== SCHEMA_VERSION) {
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

    findExpired: db.prepare("SELECT id FROM messages WHERE status='queued' AND expires_at_ms < ?"),
    urgentDepth: db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE status='queued' AND priority >= 7"),
    normalDepth: db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE status='queued' AND priority < 7"),
    onlineCount: db.prepare("SELECT COUNT(*) as cnt FROM agents WHERE status='online'"),
    msgCount: db.prepare('SELECT COUNT(*) as cnt FROM messages'),
    dlqDepth: db.prepare('SELECT COUNT(*) as cnt FROM dead_letters'),
    ackedRecent: db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE status='acked' AND created_at_ms > ? - 300000"),
  };

  function clampMaxMessages(value, fallback = 20) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(1, Math.min(Math.trunc(num), 100));
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
        ...store.getQueueDepths(),
      };
    },

    getAuditStats() {
      return {
        online_agents: S.onlineCount.get().cnt,
        total_messages: S.msgCount.get().cnt,
        dlq: S.dlqDepth.get().cnt,
      };
    },
  };

  return store;
}
