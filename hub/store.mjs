// hub/store.mjs — SQLite WAL 상태 저장소
// tfx-hub 메시지 버스의 영속 상태를 관리
import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** UUIDv7 생성 (RFC 9562) */
export function uuidv7() {
  const now = BigInt(Date.now());
  const buf = randomBytes(16);
  buf[0] = Number((now >> 40n) & 0xffn);
  buf[1] = Number((now >> 32n) & 0xffn);
  buf[2] = Number((now >> 24n) & 0xffn);
  buf[3] = Number((now >> 16n) & 0xffn);
  buf[4] = Number((now >> 8n) & 0xffn);
  buf[5] = Number(now & 0xffn);
  buf[6] = (buf[6] & 0x0f) | 0x70;  // version 7
  buf[8] = (buf[8] & 0x3f) | 0x80;  // variant 10xx
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
  return { ...rest, capabilities: parseJson(capabilities_json, []), topics: parseJson(topics_json, []), metadata: parseJson(metadata_json, {}) };
}

function parseMessageRow(row) {
  if (!row) return null;
  const { payload_json, ...rest } = row;
  return { ...rest, payload: parseJson(payload_json, {}) };
}

function parseHumanRequestRow(row) {
  if (!row) return null;
  const { schema_json, response_json, ...rest } = row;
  return { ...rest, schema: parseJson(schema_json, {}), response: parseJson(response_json, null) };
}

/**
 * 상태 저장소 생성
 * @param {string} dbPath — SQLite DB 파일 경로
 */
export function createStore(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);

  // PRAGMA
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('wal_autocheckpoint = 1000');

  // 스키마 초기화 (schema.sql 전체 실행 — 주석 포함 안전 처리)
  const schemaSQL = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schemaSQL);

  // ── 준비된 구문 ──

  const S = {
    // 에이전트
    upsertAgent: db.prepare(`
      INSERT INTO agents (agent_id, cli, pid, capabilities_json, topics_json, last_seen_ms, lease_expires_ms, status, metadata_json)
      VALUES (@agent_id, @cli, @pid, @capabilities_json, @topics_json, @last_seen_ms, @lease_expires_ms, @status, @metadata_json)
      ON CONFLICT(agent_id) DO UPDATE SET
        cli=excluded.cli, pid=excluded.pid, capabilities_json=excluded.capabilities_json,
        topics_json=excluded.topics_json, last_seen_ms=excluded.last_seen_ms,
        lease_expires_ms=excluded.lease_expires_ms, status=excluded.status, metadata_json=excluded.metadata_json`),
    getAgent: db.prepare('SELECT * FROM agents WHERE agent_id = ?'),
    heartbeat: db.prepare("UPDATE agents SET last_seen_ms=?, lease_expires_ms=?, status='online' WHERE agent_id=?"),
    setAgentStatus: db.prepare('UPDATE agents SET status=? WHERE agent_id=?'),
    onlineAgents: db.prepare("SELECT * FROM agents WHERE status != 'offline'"),
    allAgents: db.prepare('SELECT * FROM agents'),
    agentsByTopic: db.prepare("SELECT a.* FROM agents a, json_each(a.topics_json) t WHERE t.value=? AND a.status != 'offline'"),
    markStale: db.prepare("UPDATE agents SET status='stale' WHERE status='online' AND lease_expires_ms < ?"),
    markOffline: db.prepare("UPDATE agents SET status='offline' WHERE status='stale' AND lease_expires_ms < ? - 300000"),

    // 메시지
    insertMsg: db.prepare(`
      INSERT INTO messages (id, type, from_agent, to_agent, topic, priority, ttl_ms, created_at_ms, expires_at_ms, correlation_id, trace_id, payload_json, status)
      VALUES (@id, @type, @from_agent, @to_agent, @topic, @priority, @ttl_ms, @created_at_ms, @expires_at_ms, @correlation_id, @trace_id, @payload_json, @status)`),
    getMsg: db.prepare('SELECT * FROM messages WHERE id=?'),
    getResponse: db.prepare("SELECT * FROM messages WHERE correlation_id=? AND type='response' ORDER BY created_at_ms DESC LIMIT 1"),
    getMsgsByTrace: db.prepare('SELECT * FROM messages WHERE trace_id=? ORDER BY created_at_ms'),
    setMsgStatus: db.prepare('UPDATE messages SET status=? WHERE id=?'),

    // 수신함
    insertInbox: db.prepare('INSERT OR IGNORE INTO message_inbox (message_id, agent_id, attempts) VALUES (?,?,0)'),
    poll: db.prepare(`
      SELECT m.*, i.delivery_id FROM messages m
      JOIN message_inbox i ON m.id=i.message_id
      WHERE i.agent_id=? AND i.delivered_at_ms IS NULL
        AND m.status IN ('queued','delivered') AND m.expires_at_ms > ?
      ORDER BY m.priority DESC, m.created_at_ms ASC LIMIT ?`),
    pollTopics: db.prepare(`
      SELECT m.*, i.delivery_id FROM messages m
      JOIN message_inbox i ON m.id=i.message_id
      WHERE i.agent_id=? AND i.delivered_at_ms IS NULL
        AND m.status IN ('queued','delivered') AND m.expires_at_ms > ?
        AND m.topic IN (SELECT value FROM json_each(?))
      ORDER BY m.priority DESC, m.created_at_ms ASC LIMIT ?`),
    markDelivered: db.prepare('UPDATE message_inbox SET delivered_at_ms=?, attempts=attempts+1 WHERE message_id=? AND agent_id=?'),
    ackInbox: db.prepare('UPDATE message_inbox SET acked_at_ms=? WHERE message_id=? AND agent_id=? AND acked_at_ms IS NULL'),
    tryAckMsg: db.prepare("UPDATE messages SET status='acked' WHERE id=? AND NOT EXISTS (SELECT 1 FROM message_inbox WHERE message_id=? AND acked_at_ms IS NULL)"),

    // 사용자 입력
    insertHR: db.prepare(`
      INSERT INTO human_requests (request_id, requester_agent, kind, prompt, schema_json, state, deadline_ms, default_action, correlation_id, trace_id, response_json)
      VALUES (@request_id, @requester_agent, @kind, @prompt, @schema_json, @state, @deadline_ms, @default_action, @correlation_id, @trace_id, @response_json)`),
    getHR: db.prepare('SELECT * FROM human_requests WHERE request_id=?'),
    updateHR: db.prepare('UPDATE human_requests SET state=?, response_json=? WHERE request_id=?'),
    pendingHR: db.prepare("SELECT * FROM human_requests WHERE state='pending'"),
    expireHR: db.prepare("UPDATE human_requests SET state='timed_out' WHERE state='pending' AND deadline_ms < ?"),

    // 데드 레터
    insertDL: db.prepare('INSERT OR REPLACE INTO dead_letters (message_id, reason, failed_at_ms, last_error) VALUES (?,?,?,?)'),
    getDL: db.prepare('SELECT * FROM dead_letters ORDER BY failed_at_ms DESC LIMIT ?'),

    // 스위퍼
    findExpired: db.prepare("SELECT id FROM messages WHERE status IN ('queued','delivered') AND expires_at_ms < ?"),

    // 메트릭
    urgentDepth: db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE status IN ('queued','delivered') AND priority >= 7"),
    normalDepth: db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE status IN ('queued','delivered') AND priority < 7"),
    dlqDepth: db.prepare('SELECT COUNT(*) as cnt FROM dead_letters'),
    onlineCount: db.prepare("SELECT COUNT(*) as cnt FROM agents WHERE status='online'"),
    msgCount: db.prepare('SELECT COUNT(*) as cnt FROM messages'),
    deliveryAvg: db.prepare(`
      SELECT COUNT(*) as total, AVG(i.delivered_at_ms - m.created_at_ms) as avg_ms
      FROM message_inbox i JOIN messages m ON i.message_id=m.id
      WHERE i.delivered_at_ms IS NOT NULL AND i.delivered_at_ms > ? - 300000`),
  };

  // ── API ──

  const store = {
    db,
    uuidv7,
    close() { db.close(); },

    // ── 에이전트 ──

    registerAgent({ agent_id, cli, pid, capabilities = [], topics = [], heartbeat_ttl_ms = 30000, metadata = {} }) {
      const now = Date.now();
      const leaseExpires = now + heartbeat_ttl_ms;
      S.upsertAgent.run({
        agent_id, cli, pid: pid ?? null,
        capabilities_json: JSON.stringify(capabilities),
        topics_json: JSON.stringify(topics),
        last_seen_ms: now, lease_expires_ms: leaseExpires,
        status: 'online', metadata_json: JSON.stringify(metadata),
      });
      return { agent_id, lease_id: uuidv7(), lease_expires_ms: leaseExpires, server_time_ms: now };
    },

    getAgent(id) { return parseAgentRow(S.getAgent.get(id)); },

    refreshLease(agentId, ttlMs = 30000) {
      const now = Date.now();
      S.heartbeat.run(now, now + ttlMs, agentId);
      return { agent_id: agentId, lease_expires_ms: now + ttlMs };
    },

    listOnlineAgents() { return S.onlineAgents.all().map(parseAgentRow); },
    listAllAgents() { return S.allAgents.all().map(parseAgentRow); },
    getAgentsByTopic(topic) { return S.agentsByTopic.all(topic).map(parseAgentRow); },

    sweepStaleAgents() {
      const now = Date.now();
      return { stale: S.markStale.run(now).changes, offline: S.markOffline.run(now).changes };
    },

    // ── 메시지 ──

    enqueueMessage({ type, from, to, topic, priority = 5, ttl_ms = 300000, payload = {}, trace_id, correlation_id }) {
      const now = Date.now();
      const id = uuidv7();
      const row = {
        id, type, from_agent: from, to_agent: to, topic, priority, ttl_ms,
        created_at_ms: now, expires_at_ms: now + ttl_ms,
        correlation_id: correlation_id || uuidv7(),
        trace_id: trace_id || uuidv7(),
        payload_json: JSON.stringify(payload), status: 'queued',
      };
      S.insertMsg.run(row);
      return { ...row, payload };
    },

    getMessage(id) { return parseMessageRow(S.getMsg.get(id)); },
    getResponseByCorrelation(cid) { return parseMessageRow(S.getResponse.get(cid)); },
    getMessagesByTrace(tid) { return S.getMsgsByTrace.all(tid).map(parseMessageRow); },
    updateMessageStatus(id, status) { return S.setMsgStatus.run(status, id).changes > 0; },

    // ── 수신함 ──

    deliverToAgent(messageId, agentId) {
      S.insertInbox.run(messageId, agentId);
      S.setMsgStatus.run('delivered', messageId);
      return true;
    },

    deliverToTopic(messageId, topic) {
      const agents = S.agentsByTopic.all(topic);
      return db.transaction(() => {
        for (const a of agents) S.insertInbox.run(messageId, a.agent_id);
        if (agents.length) S.setMsgStatus.run('delivered', messageId);
        return agents.length;
      })();
    },

    pollForAgent(agentId, { max_messages = 20, include_topics = null, auto_ack = false } = {}) {
      const now = Date.now();
      const rows = (include_topics?.length)
        ? S.pollTopics.all(agentId, now, JSON.stringify(include_topics), max_messages)
        : S.poll.all(agentId, now, max_messages);

      db.transaction(() => {
        for (const r of rows) {
          S.markDelivered.run(now, r.id, agentId);
          if (auto_ack) { S.ackInbox.run(now, r.id, agentId); S.tryAckMsg.run(r.id, r.id); }
        }
      })();

      // poll = heartbeat (에이전트 등록 TTL 사용, 미등록 시 30초 기본값)
      const agentInfo = S.getAgent.get(agentId);
      const ttl = agentInfo ? (agentInfo.lease_expires_ms - agentInfo.last_seen_ms) || 30000 : 30000;
      S.heartbeat.run(now, now + ttl, agentId);
      return rows.map(parseMessageRow);
    },

    ackMessages(ids, agentId) {
      const now = Date.now();
      return db.transaction(() => {
        let n = 0;
        for (const id of ids) {
          if (S.ackInbox.run(now, id, agentId).changes > 0) { S.tryAckMsg.run(id, id); n++; }
        }
        return n;
      })();
    },

    // ── 사용자 입력 ──

    insertHumanRequest({ requester_agent, kind, prompt, requested_schema = {}, deadline_ms, default_action, correlation_id, trace_id }) {
      const rid = uuidv7();
      const now = Date.now();
      const abs = now + deadline_ms;
      S.insertHR.run({
        request_id: rid, requester_agent, kind, prompt,
        schema_json: JSON.stringify(requested_schema),
        state: 'pending', deadline_ms: abs, default_action,
        correlation_id: correlation_id || uuidv7(),
        trace_id: trace_id || uuidv7(),
        response_json: null,
      });
      return { request_id: rid, state: 'pending', deadline_ms: abs };
    },

    getHumanRequest(id) { return parseHumanRequestRow(S.getHR.get(id)); },
    updateHumanRequest(id, state, resp = null) { return S.updateHR.run(state, resp ? JSON.stringify(resp) : null, id).changes > 0; },
    getPendingHumanRequests() { return S.pendingHR.all().map(parseHumanRequestRow); },

    // ── 데드 레터 ──

    moveToDeadLetter(messageId, reason, lastError = null) {
      db.transaction(() => {
        S.setMsgStatus.run('dead_letter', messageId);
        S.insertDL.run(messageId, reason, Date.now(), lastError);
      })();
      return true;
    },

    getDeadLetters(limit = 50) { return S.getDL.all(limit); },

    // ── 스위퍼 ──

    sweepExpired() {
      const now = Date.now();
      return db.transaction(() => {
        const expired = S.findExpired.all(now);
        for (const { id } of expired) {
          S.setMsgStatus.run('dead_letter', id);
          S.insertDL.run(id, 'ttl_expired', now, null);
        }
        const hr = S.expireHR.run(now).changes;
        return { messages: expired.length, human_requests: hr };
      })();
    },

    // ── 메트릭 ──

    getQueueDepths() {
      return { urgent: S.urgentDepth.get().cnt, normal: S.normalDepth.get().cnt, dlq: S.dlqDepth.get().cnt };
    },

    getDeliveryStats() {
      const r = S.deliveryAvg.get(Date.now());
      return { total_deliveries: r?.total || 0, avg_delivery_ms: Math.round(r?.avg_ms || 0) };
    },

    getHubStats() {
      return { online_agents: S.onlineCount.get().cnt, total_messages: S.msgCount.get().cnt, ...store.getQueueDepths() };
    },
  };

  return store;
}
