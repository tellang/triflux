# PRD: tfx-team v2.1 (Direct Native Teams via Hub MCP Proxy)

## 1) 아키텍처 다이어그램 (ASCII)

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Claude Lead Session                                                  │
│ - TeamCreate / TaskCreate / (optional) pre-assign owner             │
│ - 실행 트리거: bash scripts/tfx-route.sh ...                        │
└───────────────┬──────────────────────────────────────────────────────┘
                │
                │ (env: team/task/agent context)
                v
┌──────────────────────────────────────────────────────────────────────┐
│ scripts/tfx-route.sh                                                 │
│ 1) hub register (existing)                                           │
│ 2) team_task_update(claim→in_progress) via hub/bridge.mjs            │
│ 3) codex/gemini 실행                                                  │
│ 4) publish(task.result) + team_task_update(completed/failed)         │
│ 5) team_send_message(to=team-lead)                                   │
└───────────────┬──────────────────────────────────────────────────────┘
                │ REST (/bridge/*)
                v
┌──────────────────────────────────────────────────────────────────────┐
│ hub/server.mjs + hub/tools.mjs                                       │
│ - 기존 Hub 도구: register/publish/poll/ask/handoff                  │
│ - 신규 Team Proxy 도구:                                              │
│   team_info / team_task_list / team_task_update / team_send_message  │
└───────┬───────────────────────────────────────────┬──────────────────┘
        │                                           │
        │                                           │
        v                                           v
┌───────────────────────────────┐      ┌──────────────────────────────┐
│ Hub SQLite WAL (기존)         │      │ Claude Native Teams Files    │
│ - agent/message bus state      │      │ ~/.claude/teams/{team}/...   │
│                                │      │ ~/.claude/tasks/{team|sid}/..│
└───────────────────────────────┘      └──────────────────────────────┘
```

---

## 2) Hub MCP 확장 설계

### 2.1 신규 MCP 도구 4개

### A. `team_info`

**inputSchema**
```json
{
  "type": "object",
  "required": ["team_name"],
  "properties": {
    "team_name": { "type": "string", "minLength": 1, "maxLength": 128, "pattern": "^[a-z0-9][a-z0-9-]*$" },
    "include_members": { "type": "boolean", "default": true },
    "include_paths": { "type": "boolean", "default": true }
  }
}
```

**outputSchema**
```json
{
  "type": "object",
  "required": ["ok"],
  "properties": {
    "ok": { "type": "boolean" },
    "error": { "type": "object" },
    "data": {
      "type": "object",
      "properties": {
        "team": { "type": "object" },
        "lead": {
          "type": "object",
          "properties": {
            "lead_agent_id": { "type": "string" },
            "lead_session_id": { "type": "string" }
          }
        },
        "members": { "type": "array" },
        "paths": {
          "type": "object",
          "properties": {
            "config_path": { "type": "string" },
            "tasks_dir": { "type": "string" },
            "inboxes_dir": { "type": "string" },
            "tasks_dir_resolution": { "type": "string", "enum": ["team_name", "lead_session_id", "not_found"] }
          }
        }
      }
    }
  }
}
```

---

### B. `team_task_list`

**inputSchema**
```json
{
  "type": "object",
  "required": ["team_name"],
  "properties": {
    "team_name": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]*$" },
    "owner": { "type": "string" },
    "statuses": {
      "type": "array",
      "items": { "type": "string", "enum": ["pending", "in_progress", "completed", "failed", "deleted"] },
      "maxItems": 8
    },
    "include_internal": { "type": "boolean", "default": false },
    "limit": { "type": "integer", "minimum": 1, "maximum": 1000, "default": 200 }
  }
}
```

**outputSchema**
```json
{
  "type": "object",
  "required": ["ok"],
  "properties": {
    "ok": { "type": "boolean" },
    "error": { "type": "object" },
    "data": {
      "type": "object",
      "properties": {
        "tasks": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": { "type": "string" },
              "subject": { "type": "string" },
              "description": { "type": "string" },
              "activeForm": { "type": "string" },
              "owner": { "type": "string" },
              "status": { "type": "string" },
              "blocks": { "type": "array", "items": { "type": "string" } },
              "blockedBy": { "type": "array", "items": { "type": "string" } },
              "metadata": { "type": "object" },
              "task_file": { "type": "string" },
              "mtime_ms": { "type": "number" }
            }
          }
        },
        "count": { "type": "integer" }
      }
    }
  }
}
```

---

### C. `team_task_update`

**inputSchema**
```json
{
  "type": "object",
  "required": ["team_name", "task_id"],
  "properties": {
    "team_name": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]*$" },
    "task_id": { "type": "string", "minLength": 1, "maxLength": 64 },
    "claim": { "type": "boolean", "default": false },
    "owner": { "type": "string" },
    "status": { "type": "string", "enum": ["pending", "in_progress", "completed", "failed", "deleted"] },
    "subject": { "type": "string" },
    "description": { "type": "string" },
    "activeForm": { "type": "string" },
    "add_blocks": { "type": "array", "items": { "type": "string" } },
    "add_blocked_by": { "type": "array", "items": { "type": "string" } },
    "metadata_patch": { "type": "object" },
    "if_match_mtime_ms": { "type": "number" },
    "actor": { "type": "string" }
  }
}
```

**outputSchema**
```json
{
  "type": "object",
  "required": ["ok"],
  "properties": {
    "ok": { "type": "boolean" },
    "error": { "type": "object" },
    "data": {
      "type": "object",
      "properties": {
        "claimed": { "type": "boolean" },
        "updated": { "type": "boolean" },
        "task_before": { "type": "object" },
        "task_after": { "type": "object" },
        "task_file": { "type": "string" },
        "mtime_ms": { "type": "number" }
      }
    }
  }
}
```

`claim=true` 규칙:
- 기본 기대상태: `status == pending`
- `owner`가 비어있거나 동일 owner여야 성공
- 충돌 시 `ok=false`, `error.code="CLAIM_CONFLICT"` 반환

---

### D. `team_send_message`

**inputSchema**
```json
{
  "type": "object",
  "required": ["team_name", "from", "text"],
  "properties": {
    "team_name": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]*$" },
    "from": { "type": "string", "minLength": 1, "maxLength": 128 },
    "to": { "type": "string", "default": "team-lead" },
    "text": { "type": "string", "minLength": 1, "maxLength": 200000 },
    "summary": { "type": "string", "maxLength": 1000 },
    "color": { "type": "string", "default": "blue" }
  }
}
```

**outputSchema**
```json
{
  "type": "object",
  "required": ["ok"],
  "properties": {
    "ok": { "type": "boolean" },
    "error": { "type": "object" },
    "data": {
      "type": "object",
      "properties": {
        "message_id": { "type": "string" },
        "recipient": { "type": "string" },
        "inbox_file": { "type": "string" },
        "queued_at": { "type": "string" },
        "unread_count": { "type": "integer" }
      }
    }
  }
}
```

---

### 2.2 파일 읽기/쓰기 로직

1. 공통 경로 해석
- team config: `~/.claude/teams/{team}/config.json`
- inbox dir: `~/.claude/teams/{team}/inboxes/`
- tasks dir 후보:
  - `~/.claude/tasks/{team}/`
  - 없으면 `config.leadSessionId` 기반 `~/.claude/tasks/{leadSessionId}/` fallback
- 이유: 환경에 따라 task 저장 경로가 팀명/세션ID로 달라질 수 있음

2. 읽기
- JSON parse 실패 파일은 스킵 + 경고 카운트
- `team_task_list`는 `.lock`, `.highwatermark`, 비-`.json` 파일 제외
- 기본적으로 `metadata._internal === true`는 제외

3. 쓰기 (원자성)
- per-task lock: `{task_id}.json.lock` (open `wx`, 짧은 retry)
- write temp file → rename (`.tmp-{pid}-{ts}` 방식)
- `mtime_ms`를 ETag처럼 사용해 `if_match_mtime_ms` 충돌 감지

4. 메시지 append
- inbox 파일(`{recipient}.json`)을 배열로 읽고 append
- 메시지 형태: `{from,text,summary?,timestamp,color,read:false}`
- append 후 원자적 rewrite

---

### 2.3 `~/.claude/tasks/{team}/` task 파일 형식

```json
{
  "id": "1",
  "subject": "Fix type errors in src/auth/",
  "description": "Fix all TypeScript errors ...",
  "activeForm": "Fixing auth type errors",
  "owner": "codex-worker-1",
  "status": "in_progress",
  "blocks": [],
  "blockedBy": [],
  "metadata": {
    "_internal": false,
    "cli": "codex",
    "role": "executor"
  }
}
```

비고:
- `id`는 문자열(`"1"`, `"2"`)
- `status`는 최소 `pending/in_progress/completed` + triflux 확장 `failed` 허용
- 알 수 없는 필드는 보존(pass-through)

---

## 3) `scripts/tfx-route.sh` 변경사항

### 3.1 Team 직행 모드 입력(환경변수, 비파괴)
- `TFX_TEAM_NAME` (없으면 기존 동작)
- `TFX_TEAM_TASK_ID` (있으면 해당 task 대상)
- `TFX_TEAM_AGENT_NAME` (예: `codex-worker-1`)
- `TFX_TEAM_LEAD_NAME` (기본 `team-lead`)

### 3.2 실행 흐름 변경

1. 기존 Hub register 완료 후:
- `team_task_update(claim=true, status=in_progress, owner=TFX_TEAM_AGENT_NAME)` 호출
- 실패(`CLAIM_CONFLICT`) 시 실제 CLI 실행 건너뛰고 종료(중복 수행 방지)

2. CLI 실행 후:
- 기존 `bridge result` 발행 유지
- task 완료 처리:
  - exit code 0: `team_task_update(status=completed)`
  - 비0/timeout: `team_task_update(status=failed)`
- 리드 보고:
  - `team_send_message(to=TFX_TEAM_LEAD_NAME, summary, text)` 호출

3. 오류 내구성
- Team API 실패가 라우터 자체를 죽이지 않도록 `hub_bridge ... || true` 유지
- 단, claim 실패는 중복 실행 방지를 위해 hard-stop 처리

---

## 4) `skills/tfx-team/SKILL.md` 변경 요약 (Phase 3 직행 모드)

기존:
- Codex/Gemini용 Claude teammate를 spawn해서 래퍼처럼 `tfx-route.sh` 실행

변경:
1. Lead가 `TeamCreate + TaskCreate(+owner pre-assign)` 수행
2. Claude 래퍼 teammate를 만들지 않고 Lead가 바로 Bash 실행:
   - `bash ~/.claude/scripts/tfx-route.sh {role} '{subtask}' auto`
   - 팀 컨텍스트(env) 주입으로 route가 자동 claim/complete/report
3. 결과 수집:
   - Hub `poll_messages`로 `task.result` 수집 또는
   - Bash 프로세스 완료 대기
4. 완료 후 `team_task_list`로 전체 상태 검증

---

## 5) 파일 변경 목록 (신규/수정)

수정:
- `hub/tools.mjs` (신규 tool 4개 등록)
- `hub/server.mjs` (`/bridge/team/*` REST fallback 엔드포인트 추가)
- `hub/bridge.mjs` (`team-info`, `team-task-list`, `team-task-update`, `team-send-message` 명령 추가)
- `scripts/tfx-route.sh` (auto-claim / complete / lead message)
- `skills/tfx-team/SKILL.md` (Phase 3 direct 모드 문서화)

신규:
- `hub/team/nativeProxy.mjs` (Native Teams 파일 I/O, 경로 해석, lock/atomic write 유틸)

---

## 6) 리스크 및 완화

- 경로 불일치(`tasks/{team}` vs `tasks/{leadSessionId}`)
  - 완화: 다중 후보 경로 해석 + `tasks_dir_resolution` 진단 반환
- claim 레이스
  - 완화: per-task lock + claim precondition 검사 + conflict 명시 반환
- 파일 손상/중간쓰기
  - 완화: temp+rename 원자적 쓰기
- Team 파일 외부 접근/경로 주입
  - 완화: `team_name` slug validation, `..` 차단, 허용 루트 고정
- Hub 다운 시 자동화 저하
  - 완화: route는 기존 실행 경로 유지, team sync만 degraded
- 대용량 메시지/출력
  - 완화: `output_preview` 길이 제한 + summary 분리

---

## 7) 검증 기준

1. `team_info`가 팀 메타/멤버/경로를 정상 반환한다.
2. `team_task_list`가 owner/status 필터와 internal-task 필터를 정확히 적용한다.
3. 동일 task에 2개 프로세스 동시 claim 시 1개만 성공, 1개는 `CLAIM_CONFLICT`.
4. `tfx-route.sh` team env 설정 시 실행 전 task가 `in_progress`로 바뀐다.
5. 정상 종료 시 `completed`, 실패/timeout 시 `failed`로 반영된다.
6. 완료 후 `team_send_message`가 `inboxes/team-lead.json`에 append된다.
7. team env 미설정 시 기존 route 동작이 바뀌지 않는다(회귀 없음).
8. Lead 운영 E2E:
   - TeamCreate + TaskCreate
   - Bash 직행 실행
   - Hub result + Team task 상태 + inbox 메시지 3축이 일관된다.
