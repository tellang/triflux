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
  presence_generation INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('online','stale','offline')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  project_id TEXT,
  session_id TEXT,
  host_id TEXT,
  transport_locators_json TEXT NOT NULL DEFAULT '[]'
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
  status TEXT NOT NULL CHECK (status IN ('queued','delivered','acked','expired','dead_letter')),
  role_key_wire TEXT
);

-- 동적 역할 레지스트리 (schema v6)
CREATE TABLE IF NOT EXISTS role_registry (
  role_key_wire TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  role_kind TEXT NOT NULL CHECK (role_kind IN ('cto','lead')),
  scope_id TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK (
    state IN (
      'electable',
      'elected-probing',
      'active',
      'unreachable',
      'quarantined'
    )
  ),
  holder_agent_id TEXT,
  previous_holder_agent_id TEXT,
  epoch INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  activation_seq INTEGER NOT NULL DEFAULT 0 CHECK (activation_seq >= 0),
  activation_id TEXT,
  activation_deadline_ms INTEGER,
  holder_lease_expires_ms INTEGER,
  charter_version TEXT,
  charter_acked_epoch INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_probe_ms INTEGER,
  blocked_reason TEXT,
  last_transition_ms INTEGER NOT NULL,
  last_reason TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  CHECK (
    (role_kind = 'cto' AND scope_id = '') OR
    (role_kind = 'lead' AND scope_id <> '')
  ),
  UNIQUE(project_id, role_kind, scope_id)
);

CREATE TABLE IF NOT EXISTS role_candidates (
  role_key_wire TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('grant','standup','operator')),
  priority INTEGER NOT NULL DEFAULT 0,
  transport_locators_json TEXT NOT NULL DEFAULT '[]',
  consecutive_probe_failures INTEGER NOT NULL DEFAULT 0,
  excluded_until_ms INTEGER,
  last_probe_ms INTEGER,
  last_probe_code TEXT,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(role_key_wire, agent_id),
  FOREIGN KEY(role_key_wire)
    REFERENCES role_registry(role_key_wire) ON DELETE CASCADE
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
CREATE INDEX IF NOT EXISTS idx_messages_role_key ON messages(role_key_wire, status, expires_at_ms);
CREATE INDEX IF NOT EXISTS idx_inbox_agent ON message_inbox(agent_id, delivered_at_ms);
CREATE INDEX IF NOT EXISTS idx_inbox_message ON message_inbox(message_id);
CREATE INDEX IF NOT EXISTS idx_human_requests_state ON human_requests(state);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_agents_lease ON agents(lease_expires_ms);

-- Assign Job 테이블
CREATE TABLE IF NOT EXISTS assign_jobs (
  job_id TEXT PRIMARY KEY,
  supervisor_agent TEXT NOT NULL,
  worker_agent TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT 'assign.job',
  task TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','timed_out')),
  attempt INTEGER NOT NULL DEFAULT 1,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 9),
  ttl_ms INTEGER NOT NULL DEFAULT 600000,
  timeout_ms INTEGER NOT NULL DEFAULT 600000,
  deadline_ms INTEGER,
  trace_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  last_message_id TEXT,
  result_json TEXT,
  error_json TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  dispatched_at_ms INTEGER,
  completed_at_ms INTEGER,
  last_retry_at_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_assign_jobs_status ON assign_jobs(status, updated_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_assign_jobs_supervisor ON assign_jobs(supervisor_agent, updated_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_assign_jobs_worker ON assign_jobs(worker_agent, updated_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_assign_jobs_deadline ON assign_jobs(deadline_ms, status);

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

-- Reflexion 에러 학습 테이블
CREATE TABLE IF NOT EXISTS reflexion_entries (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'reflexion', -- reflexion | adaptive
  error_pattern TEXT NOT NULL,          -- 에러 시그니처 (정규화)
  error_message TEXT NOT NULL,          -- 원본 에러 메시지
  context_json TEXT NOT NULL DEFAULT '{}', -- { file, function, cli, agent }
  solution TEXT NOT NULL,               -- 해결책 설명
  solution_code TEXT,                   -- 해결 코드 스니펫 (있으면)
  adaptive_state_json TEXT NOT NULL DEFAULT '{}', -- adaptive rule metadata
  confidence REAL NOT NULL DEFAULT 0.5, -- 솔루션 신뢰도 (0-1)
  hit_count INTEGER NOT NULL DEFAULT 1, -- 매칭 횟수
  success_count INTEGER NOT NULL DEFAULT 0, -- 성공 횟수
  last_hit_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reflexion_pattern ON reflexion_entries(error_pattern);
CREATE INDEX IF NOT EXISTS idx_reflexion_confidence ON reflexion_entries(confidence DESC);
