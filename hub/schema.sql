-- tfx-hub 상태 저장소 스키마
-- SQLite WAL 모드 기반 메시지 버스

-- 에이전트 등록 테이블
CREATE TABLE IF NOT EXISTS agents (
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

-- 메시지 테이블
CREATE TABLE IF NOT EXISTS messages (
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

-- 메시지 수신함 (배달 추적)
CREATE TABLE IF NOT EXISTS message_inbox (
  delivery_id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  delivered_at_ms INTEGER,
  acked_at_ms INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  UNIQUE(message_id, agent_id),
  FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
);

-- 사용자 입력 요청 테이블
CREATE TABLE IF NOT EXISTS human_requests (
  request_id TEXT PRIMARY KEY,
  requester_agent TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('captcha','approval','credential','choice','text')),
  prompt TEXT NOT NULL,
  schema_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL CHECK (state IN ('pending','accepted','declined','cancelled','timed_out')),
  deadline_ms INTEGER NOT NULL,
  default_action TEXT NOT NULL CHECK (default_action IN ('decline','cancel','timeout_continue')),
  correlation_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  response_json TEXT
);

-- 데드 레터 큐
CREATE TABLE IF NOT EXISTS dead_letters (
  message_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  failed_at_ms INTEGER NOT NULL,
  last_error TEXT
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
CREATE INDEX IF NOT EXISTS idx_messages_to_agent ON messages(to_agent, status);
CREATE INDEX IF NOT EXISTS idx_messages_correlation ON messages(correlation_id);
CREATE INDEX IF NOT EXISTS idx_messages_trace ON messages(trace_id);
CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages(expires_at_ms);
CREATE INDEX IF NOT EXISTS idx_messages_priority ON messages(priority DESC, created_at_ms ASC);
CREATE INDEX IF NOT EXISTS idx_inbox_agent ON message_inbox(agent_id, delivered_at_ms);
CREATE INDEX IF NOT EXISTS idx_inbox_message ON message_inbox(message_id);
CREATE INDEX IF NOT EXISTS idx_human_requests_state ON human_requests(state);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_agents_lease ON agents(lease_expires_ms);

-- 파이프라인 상태 테이블 (Phase 2)
CREATE TABLE IF NOT EXISTS pipeline_state (
  team_name TEXT PRIMARY KEY,
  phase TEXT NOT NULL DEFAULT 'plan',
  fix_attempt INTEGER DEFAULT 0,
  fix_max INTEGER DEFAULT 3,
  ralph_iteration INTEGER DEFAULT 0,
  ralph_max INTEGER DEFAULT 10,
  artifacts TEXT DEFAULT '{}',
  phase_history TEXT DEFAULT '[]',
  created_at INTEGER,
  updated_at INTEGER
);
