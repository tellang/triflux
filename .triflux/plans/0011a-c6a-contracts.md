# C6a 계약 스펙 — triflux 능동 CTO/scoped-lead 역할 시스템 v2

> 상태: **ADR-0011 acceptance 전 구현 게이트**  
> 규범어 `MUST`, `MUST NOT`, `SHOULD`는 구현·테스트 요구사항이다.  
> 현재 구현은 단일 `cto` 문자열, 메모리 상태, liveness 기반 즉시 선출에 묶여 있다([hub/router.mjs:14](/Users/tellang/Projects/tools/triflux/hub/router.mjs:14), [hub/router.mjs:125](/Users/tellang/Projects/tools/triflux/hub/router.mjs:125), [hub/router.mjs:253](/Users/tellang/Projects/tools/triflux/hub/router.mjs:253)). C6a는 이를 scoped/durable/reachable 역할 kernel로 교체하는 규범이다.

공통 구현 경계:

- 역할 상태기계·RoleKey·projection은 순수 core 모듈이어야 한다.
- 로컬 `tfx-live` 실행은 runtime adapter로 분리한다. remote server는 core router를 import하므로 로컬 실행기를 core에 넣으면 안 된다([scripts/pack.mjs:23](/Users/tellang/Projects/tools/triflux/scripts/pack.mjs:23), [packages/remote/hub/server.mjs:63](/Users/tellang/Projects/tools/triflux/packages/remote/hub/server.mjs:63)).
- 모든 시간·UUID·random·transport는 테스트에서 주입 가능해야 한다.

---

## 1. `role_kind`와 `role_key` 분리

### 정의

`role_kind`는 capability·charter·정책을 선택하는 정적 분류다. `role_key`는 선출·holder·epoch·메시지·status를 소유하는 동적 인스턴스 식별자다.

- `role_kind`: `"cto" | "lead"`
- CTO key: `{project_id, role_kind:"cto"}`
- lead key: `{project_id, role_kind:"lead", scope_id}`
- `ROLE_KINDS`를 순회해 role instance를 발견해서는 안 된다.
- `topic` 구독은 후보 자격을 부여하지 않는다.

### 구체 스펙

```ts
type ProjectId = `prj_${string}`; // 128-bit base64url, 정확히 22 chars
type ScopeId = `scp_${string}`;   // 128-bit base64url, 정확히 22 chars
type RoleKind = "cto" | "lead";

type RoleKey =
  | {
      project_id: ProjectId;
      role_kind: "cto";
      scope_id?: never;
    }
  | {
      project_id: ProjectId;
      role_kind: "lead";
      scope_id: ScopeId;
    };
```

검증 규칙:

- `project_id`: `^prj_[A-Za-z0-9_-]{22}$`
- `scope_id`: `^scp_[A-Za-z0-9_-]{22}$`
- CTO에 `scope_id`가 있으면 `ROLE_SCOPE_FORBIDDEN`.
- lead에 `scope_id`가 없으면 `SCOPE_REQUIRED`.
- 알 수 없는 kind는 `ROLE_KIND_UNSUPPORTED`.
- 입력 key의 미등록 필드는 거부한다.
- project/scope ID는 case-sensitive이며 자동 소문자화하지 않는다.

정규 API:

```ts
normalizeRoleKey(input: unknown): RoleKey;
encodeRoleKey(key: RoleKey): string;
decodeRoleKey(wire: string): RoleKey;
roleTopicAddress(key: RoleKey): string;
```

wire 형식:

```text
role_key_wire = "rk2." + base64url(UTF8(JCS(role_key)))
role address  = "topic:role:" + role_key_wire
```

- JCS 입력 key 순서는 `project_id`, `role_kind`, `scope_id`다.
- base64 padding은 금지한다.
- decoder는 decode 후 재인코딩 결과가 원문과 같지 않으면 `ROLE_KEY_NON_CANONICAL`로 거부한다.
- wire 최대 길이는 512 bytes다.
- 절대경로, lake root, hostname은 포함할 수 없다.

동적 인덱스:

```ts
roleKeys: Set<RoleKeyWire>;
roleKeysByProject: Map<ProjectId, Set<RoleKeyWire>>;
roleKeysByAgent: Map<AgentId, Set<RoleKeyWire>>;
```

- SSOT는 persistent `role_registry`다.
- 시작 시 store에서 open role keys를 로드한다.
- CTO key는 project 등록/`ensure_role` 때 생성한다.
- lead key는 authorized lead scope 생성 때만 추가한다.
- heartbeat는 `roleKeysByAgent[agent]`만 갱신한다.
- sweeper는 `store.listRolesWithExpiredHolder(now)` 결과만 처리한다.
- status는 `store.listRoleKeys(filter)`를 사용한다.
- lead 종료 시 모든 인덱스에서 제거한다.

### 영향 함수 `file:line`

- 문자열 kind 검증과 정적 set: [hub/router.mjs:14](/Users/tellang/Projects/tools/triflux/hub/router.mjs:14), [hub/router.mjs:28](/Users/tellang/Projects/tools/triflux/hub/router.mjs:28)
- 메모리 role state: [hub/router.mjs:159](/Users/tellang/Projects/tools/triflux/hub/router.mjs:159)
- `is_cto`/topic fallback 후보 판정: [hub/router.mjs:190](/Users/tellang/Projects/tools/triflux/hub/router.mjs:190)
- 정적 candidate 갱신: [hub/router.mjs:226](/Users/tellang/Projects/tools/triflux/hub/router.mjs:226)
- role message 판정/주소 해석: [hub/router.mjs:304](/Users/tellang/Projects/tools/triflux/hub/router.mjs:304)
- recipient 해석: [hub/router.mjs:545](/Users/tellang/Projects/tools/triflux/hub/router.mjs:545)
- register/heartbeat/status 정적 순회: [hub/router.mjs:857](/Users/tellang/Projects/tools/triflux/hub/router.mjs:857), [hub/router.mjs:1506](/Users/tellang/Projects/tools/triflux/hub/router.mjs:1506)
- sweeper 정적 순회: [hub/router.mjs:1469](/Users/tellang/Projects/tools/triflux/hub/router.mjs:1469)

### 수용 테스트

1. 같은 project의 CTO와 서로 다른 두 lead scope가 독립 epoch/holder를 가진다.
2. 동일 `RoleKey`는 프로퍼티 입력 순서와 무관하게 같은 wire를 만든다.
3. 비정규 base64/JCS wire는 거부된다.
4. CTO key의 scope 및 lead key의 scope 누락은 각각 지정 오류로 실패한다.
5. `topics:["cto"]`, `metadata.is_cto=true`만으로 v2 후보가 되지 않는다.
6. heartbeat가 agent와 무관한 role key를 재선출하지 않는다.
7. 1,000개 scoped lead가 있어도 sweeper는 만료 holder가 있는 key만 조회한다.
8. wire에 repo 절대경로 문자열이 포함되지 않는다.

---

## 2. Reachability 상태기계

### 정의

liveness와 reachability는 별개다.

```text
liveness    = agent.status == online && lease_expires_ms > now
reachability = activator가 등록 transport를 probe/wake할 수 있음
active      = liveness + reachability + 현재 epoch activation/charter ACK
```

현재 코드는 online+lease만으로 leader를 active로 간주한다([hub/router.mjs:253](/Users/tellang/Projects/tools/triflux/hub/router.mjs:253), [hub/router.mjs:409](/Users/tellang/Projects/tools/triflux/hub/router.mjs:409)). v2에서는 lease가 살아 있어도 transport probe 전에는 `active`가 아니다.

### 구체 스펙

```ts
type RoleReachabilityState =
  | "electable"
  | "elected-probing"
  | "active"
  | "unreachable"
  | "quarantined";
```

상태 의미:

| 상태 | 의미 |
|---|---|
| `electable` | active holder가 없고 선출/standup을 시도할 수 있음. 후보 0명도 포함 |
| `elected-probing` | 특정 holder와 epoch가 예약됐으나 probe+activation ACK가 미완료 |
| `active` | holder liveness, transport, epoch, charter ACK가 모두 유효 |
| `unreachable` | 이번 holder/locator의 probe·wake·ACK가 실패했으며 retry/failover가 필요 |
| `quarantined` | 알려진 후보가 모두 일시 제외됐거나 standup도 불가능하여 다음 eligibility 이벤트를 기다림 |

전이표:

| 현재 | trigger/guard | 다음 | 필수 action |
|---|---|---|---|
| `electable` | eligible candidate 선택 | `elected-probing` | holder 예약, epoch 증가, activation token 저장 |
| `electable` | 후보 없음 + standup 가능 | `elected-probing` | standup token 예약 후 새 세션 생성 |
| `electable` | 후보 없음 + standup 불가 | `electable` | `blocked_reason=no_candidate` |
| `electable` | 모든 후보 exclusion 중 | `quarantined` | 가장 빠른 `excluded_until_ms` 예약 |
| `elected-probing` | probe 성공 | `elected-probing` | wake/charter activation 전송 |
| `elected-probing` | 유효 activation+charter ACK | `active` | ACK와 reachability timestamp 저장 |
| `elected-probing` | probe/wake/ACK timeout | `unreachable` | 실패 locator/candidate exclusion |
| `elected-probing` | holder lease 만료 | `electable` | holder revoke, epoch fence; probe 실패 횟수는 증가시키지 않음 |
| `active` | holder lease 만료/offline | `electable` | revoke, backlog 보존, 새 ensure 예약 |
| `active` | transport probe/wake 실패 | `unreachable` | active authority 즉시 fence |
| `unreachable` | 대체 후보 존재 | `electable` | 실패 후보 제외 후 즉시 failover |
| `unreachable` | retry due, 실패 횟수 미달 | `elected-probing` | 같은 후보라도 새 epoch/token으로 재시도 |
| `unreachable` | 모든 후보 retry 소진 | `quarantined` | quarantine deadline 저장 |
| `quarantined` | exclusion 만료 | `electable` | 실패 후보 재허용 |
| `quarantined` | 새 후보/locator/capability 등록 | `electable` | quarantine 조기 해제 |
| `*` | stale ACK | 동일 | 상태 변경 없이 `STALE_EPOCH` |
| `*` | scope closed | registry 제거 | 계약 10의 terminal fencing/GC |

retry 파라미터:

```ts
probe_timeout_ms = 10_000;
probe_cache_ttl_ms = 15_000;
activation_ack_timeout_ms = 45_000;
standup_timeout_ms = 60_000;
max_probe_failures = 3;
backoff_base_ms = 1_000;
backoff_factor = 2;
backoff_max_ms = 30_000;
backoff_jitter_ratio = 0.20;
candidate_quarantine_ms = 120_000;
```

```text
delay(n) =
  min(backoff_base_ms * 2^(n-1), backoff_max_ms)
  * (1 + uniform(-0.20, +0.20))
```

- 한 locator가 실패하면 즉시 현재 ensure cycle에서 제외하고 다음 locator를 본다.
- 후보의 모든 probeable locator가 실패하면 후보를 제외한다.
- probe 성공 시 해당 locator/candidate의 consecutive failure를 0으로 초기화한다.
- liveness 실패는 reachability failure count에 포함하지 않는다.

### 영향 함수 `file:line`

- liveness 판정: [hub/router.mjs:253](/Users/tellang/Projects/tools/triflux/hub/router.mjs:253)
- 현재 후보 정렬/선출: [hub/router.mjs:279](/Users/tellang/Projects/tools/triflux/hub/router.mjs:279)
- 현재 snapshot 상태 축약: [hub/router.mjs:409](/Users/tellang/Projects/tools/triflux/hub/router.mjs:409)
- 즉시 active로 만드는 선출: [hub/router.mjs:455](/Users/tellang/Projects/tools/triflux/hub/router.mjs:455)
- stale sweep: [hub/router.mjs:1469](/Users/tellang/Projects/tools/triflux/hub/router.mjs:1469)

### 수용 테스트

1. lease가 살아 있지만 probe 실패한 후보는 `active`가 되지 않는다.
2. 첫 후보 probe 실패 시 같은 ensure cycle에서 다음 후보가 선택된다.
3. 세 번 실패한 후보는 120초 동안 제외된다.
4. locator 갱신은 quarantine을 즉시 해제한다.
5. lease 만료는 probe failure count를 증가시키지 않는다.
6. ACK timeout 후 늦게 온 ACK는 `STALE_EPOCH`로 거부된다.
7. injected clock/RNG로 backoff와 jitter 경계를 결정적으로 검증한다.
8. 상태 전이표에 없는 전이는 reducer가 `INVALID_ROLE_TRANSITION`으로 거부한다.

---

## 3. `ensure_role` API

### 정의

`ensure_role`은 “호출 세션이 역할을 대행”하는 API가 아니다. 정확한 role key가 active holder를 갖도록 선출·probe·wake·standup을 비동기 예약하는 API다.

### 구체 스펙

```ts
type EnsureRoleTrigger =
  | "session_start"
  | "publish_no_holder"
  | "lease_expired"
  | "restart_recovery"
  | "hygiene_changed"
  | "charter_issued"
  | "manual";

interface EnsureRoleRequest {
  schema_version: "tfx.ensure-role.v1";
  role_key: RoleKey;
  trigger: EnsureRoleTrigger;
  cause_id: string;          // session_id, message_id, sweep id 등
  requested_at_ms?: number;  // server가 덮어씀
}

interface EnsureRoleReceipt {
  accepted: boolean;
  disposition:
    | "started"
    | "joined"
    | "already_active"
    | "manager_disabled"
    | "scope_closed";
  role_key_wire: string;
  state: RoleReachabilityState;
  epoch: number;
  activation_id?: string;
  blocked_reason?: string;
}
```

내부 API:

```ts
requestEnsureRole(
  request: EnsureRoleRequest,
  context: { principal: Principal }
): EnsureRoleReceipt; // 동기: 예약만

ensureRole(
  request: EnsureRoleRequest,
  context: {
    principal: Principal;
    signal: AbortSignal;
  }
): Promise<EnsureRoleOutcome>; // 비동기 실행
```

wire action:

```json
{
  "action": "ensure_role",
  "schema_version": "tfx.ensure-role.v1",
  "role_key": {
    "project_id": "prj_…",
    "role_kind": "cto"
  },
  "trigger": "manual",
  "cause_id": "…"
}
```

호출 연결:

1. `route()` 및 `handlePublish()`가 role-addressed 메시지를 durable backlog에 기록했으나 recipient가 0이면 `requestEnsureRole(...publish_no_holder)`를 호출한다.
2. publish 응답은 activation 완료를 기다리지 않는다.
3. SessionStart는 project identity와 일반 liveness 등록 후 CTO ensure를 fire-and-forget한다. lead ensure는 exact lead binding이 있는 세션만 요청한다.
4. lease sweeper는 만료 holder를 fence한 트랜잭션 이후 영향받은 dynamic role keys를 ensure한다.
5. restart recovery는 persistent registry를 읽은 뒤 각 복구 대상 key를 ensure한다.
6. 어떠한 경로도 호출 participant를 임시 holder로 자동 승격하지 않는다.

publish 응답:

```ts
{
  ok: true;
  data: {
    message_id: string;
    fanout_count: number;
    expires_at_ms: number;
    role: RoleSnapshotV2;
    activation?: EnsureRoleReceipt;
  };
}
```

### 영향 함수 `file:line`

- legacy `route()` no-recipient 보존: [hub/router.mjs:916](/Users/tellang/Projects/tools/triflux/hub/router.mjs:916)
- publish 경로: [hub/router.mjs:1061](/Users/tellang/Projects/tools/triflux/hub/router.mjs:1061)
- SessionStart registration: [hooks/session-start-fast.mjs:243](/Users/tellang/Projects/tools/triflux/hooks/session-start-fast.mjs:243)
- SessionStart가 현재 Synapse만 등록하는 경로: [hooks/session-start-fast.mjs:255](/Users/tellang/Projects/tools/triflux/hooks/session-start-fast.mjs:255)
- sweeper/lease expiry 연결점: [hub/router.mjs:1440](/Users/tellang/Projects/tools/triflux/hub/router.mjs:1440)
- pipe command dispatch: [hub/pipe.mjs:221](/Users/tellang/Projects/tools/triflux/hub/pipe.mjs:221)

### 수용 테스트

1. no-holder publish는 즉시 반환하고 메시지를 잃지 않으며 activation receipt를 포함한다.
2. 느린 probe/standup이 publish와 SessionStart latency를 블록하지 않는다.
3. lease expiry가 정확한 scoped key만 ensure한다.
4. disabled manager에서는 backlog는 남지만 transport 호출은 0회다.
5. closed lead scope ensure는 `scope_closed`다.
6. rejected ensure에도 호출 세션이 holder로 대행 등록되지 않는다.
7. legacy `route(msg)`와 v2 `handlePublish()` 모두 동일 activation 경로를 사용한다.

---

## 4. 동시성: singleflight, epoch fencing, activation ACK

### 정의

동시 SessionStart, no-holder publish, heartbeat, sweeper가 같은 role key에 대해 중복 standup하거나 서로 다른 holder를 active로 만들 수 없어야 한다.

### 구체 스펙

동시성은 세 층으로 고정한다.

1. **프로세스 singleflight**

```ts
Map<RoleKeyWire, Promise<EnsureRoleOutcome>>
```

동일 key 요청은 기존 Promise에 join한다. 서로 다른 key는 병렬 실행한다.

2. **persistent reservation**

SQLite `BEGIN IMMEDIATE` 트랜잭션에서:

- registry row와 `version`을 읽는다.
- active invariant를 재확인한다.
- `epoch += 1`
- `activation_seq += 1`
- UUIDv7 `activation_id`를 생성한다.
- holder, `elected-probing`, deadline을 저장한다.
- 트랜잭션을 종료한 뒤에만 network probe/wake를 수행한다.

네트워크 await 중 SQLite 트랜잭션을 유지하면 안 된다.

3. **CAS completion**

모든 비동기 결과는 다음 predicate로만 반영한다.

```sql
WHERE role_key_wire = ?
  AND epoch = ?
  AND activation_seq = ?
  AND activation_id = ?
  AND version = ?
```

activation ACK:

```ts
interface ActivationAckV1 {
  schema_version: "tfx.role-activation-ack.v1";
  activation_id: string;
  role_key: RoleKey;
  epoch: number;
  activation_seq: number;
  holder_agent_id: string;
  reachable: true;
  charter_ack: {
    role_key: RoleKey;
    epoch: number;
    charter_version: string;
  };
}
```

승인 조건:

- ACK principal의 agent가 현재 holder와 같아야 한다.
- `activation_id`, role key, epoch, sequence가 모두 현재 row와 같아야 한다.
- `charter_version`이 현재 kind charter와 정확히 같아야 한다.
- holder lease가 ACK 시점에도 살아 있어야 한다.
- 모든 조건을 만족한 한 ACK만 `active` 전이를 수행한다.
- 동일 ACK 재전송은 멱등 성공한다.
- 과거 ACK는 `STALE_EPOCH`, 다른 holder ACK는 `HOLDER_MISMATCH`다.

kill-switch·scope close·holder revoke는 activation token을 지우고 epoch를 증가시켜 in-flight 결과를 fence한다.

### 영향 함수 `file:line`

- 동시성 보호 없는 메모리 registry: [hub/router.mjs:125](/Users/tellang/Projects/tools/triflux/hub/router.mjs:125)
- 동기 선출: [hub/router.mjs:455](/Users/tellang/Projects/tools/triflux/hub/router.mjs:455)
- register/heartbeat 재선출 경쟁점: [hub/router.mjs:857](/Users/tellang/Projects/tools/triflux/hub/router.mjs:857)
- 명시 takeover 경쟁점: [hub/router.mjs:1095](/Users/tellang/Projects/tools/triflux/hub/router.mjs:1095)
- sweeper 경쟁점: [hub/router.mjs:1469](/Users/tellang/Projects/tools/triflux/hub/router.mjs:1469)

### 수용 테스트

1. 50개 동시 ensure에서 standup 호출은 정확히 1회다.
2. 서로 다른 두 scoped lead는 병렬 standup할 수 있다.
3. probe 중 takeover가 발생하면 이전 probe/ACK는 상태를 바꾸지 못한다.
4. kill-switch cancellation 뒤 도착한 ACK는 stale다.
5. ACK 재전송은 epoch나 transition count를 증가시키지 않는다.
6. CAS 실패 후 stale worker가 backlog를 이전하지 못한다.
7. same-holder retry도 새 epoch/token을 사용한다.
8. SQLite fault injection 후 중복 active holder가 생기지 않는다.

---

## 5. Hub 재시작 durability

### 정의

`role_registry`, holder, epoch, activation, candidate exclusion은 SQLite SSOT다. 메모리 map은 cache/index일 뿐이다. 현재 `roleStates`는 Hub 재시작 때 사라진다([hub/router.mjs:125](/Users/tellang/Projects/tools/triflux/hub/router.mjs:125)).

### 구체 스펙

schema version은 `5 → 6`으로 증가한다([hub/store.mjs:119](/Users/tellang/Projects/tools/triflux/hub/store.mjs:119)).

`agents` 추가 컬럼:

```sql
ALTER TABLE agents ADD COLUMN project_id TEXT;
ALTER TABLE agents ADD COLUMN session_id TEXT;
ALTER TABLE agents ADD COLUMN host_id TEXT;
ALTER TABLE agents ADD COLUMN transport_locators_json TEXT NOT NULL DEFAULT '[]';
```

`messages` 추가 컬럼:

```sql
ALTER TABLE messages ADD COLUMN role_key_wire TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_role_key
  ON messages(role_key_wire, status, expires_at_ms);
```

신규 테이블:

```sql
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
```

store API:

```ts
getRole(roleKeyWire);
upsertRoleReservation(input);
compareAndSetRole(input);
listRoleKeys(filter);
listRolesWithExpiredHolder(now);
listRoleCandidates(roleKeyWire);
upsertRoleCandidate(input);
updateCandidateReachability(input);
listPendingRoleMessages(roleKeyWire, now);
recoverRoleRegistry(now);
```

재시작 복구:

1. store에서 open role keys와 candidate bindings를 로드한다.
2. persisted `active`를 그대로 active로 복원하면 안 된다.
3. holder lease가 만료됐으면 holder를 clear하고 epoch를 증가시켜 `electable`로 만든다.
4. lease가 살아 있고 지원 transport가 있으면 같은 holder를 새 epoch의 `elected-probing`으로 전환하고 probe+ACK를 다시 요구한다.
5. locator가 없거나 현재 activator가 지원하지 않으면 후보를 제외하고 failover한다.
6. persisted in-flight activation은 모두 취소하고 새 activation token을 발급한다.
7. manager가 disabled이면 holder/activation을 fence하고 `blocked_reason`을 기록하되 자동 ensure하지 않는다.
8. `role_key_wire`가 있는 unexpired `queued|delivered` 메시지는 at-least-once backlog로 재구성한다. 같은 message ID 중복 전달은 허용하지만 유실은 금지한다.
9. old charter ACK는 복구 후 증가한 epoch 때문에 stale다.
10. epoch는 어떤 복구 경로에서도 감소하지 않는다.

### 영향 함수 `file:line`

- 현재 “SQLite는 감사 로그만” 계약: [hub/router.mjs:1](/Users/tellang/Projects/tools/triflux/hub/router.mjs:1), [hub/store.mjs:1](/Users/tellang/Projects/tools/triflux/hub/store.mjs:1)
- agent schema: [hub/schema.sql:5](/Users/tellang/Projects/tools/triflux/hub/schema.sql:5)
- 현재 message/inbox schema: [hub/schema.sql:18](/Users/tellang/Projects/tools/triflux/hub/schema.sql:18), [hub/schema.sql:35](/Users/tellang/Projects/tools/triflux/hub/schema.sql:35)
- schema migration: [hub/store.mjs:115](/Users/tellang/Projects/tools/triflux/hub/store.mjs:115)
- agent register persistence: [hub/store.mjs:374](/Users/tellang/Projects/tools/triflux/hub/store.mjs:374)
- lease/stale 처리: [hub/store.mjs:421](/Users/tellang/Projects/tools/triflux/hub/store.mjs:421), [hub/store.mjs:455](/Users/tellang/Projects/tools/triflux/hub/store.mjs:455)

### 수용 테스트

1. active CTO 상태에서 Hub를 재시작하면 바로 active가 아니라 probing을 거친다.
2. 재시작 전 epoch보다 복구 epoch가 크다.
3. 재시작 전 stale ACK가 거부된다.
4. unacked scoped-role backlog가 재시작 뒤 새 holder에게 전달된다.
5. closed/expired lead scope는 복구 인덱스에 들어오지 않는다.
6. quarantine deadline이 남아 있으면 재시작 후에도 보존된다.
7. 만료된 quarantine은 복구 중 electable로 전환된다.
8. v5 DB를 v6로 올려도 기존 agent/message 조회가 보존된다.

---

## 6. v1→v2 호환

### 정의

v2 내부 정본은 scoped role envelope다. `roles.cto`와 `topic:cto`는 project-scoped legacy projection일 뿐이며 독립 권위 데이터가 아니다.

### 구체 스펙

v2 status:

```ts
interface RoleStatusEnvelopeV2 {
  schema_version: "tfx.roles.v2";
  generated_at_ms: number;
  project_id?: ProjectId;
  items: RoleSnapshotV2[]; // role_key_wire 오름차순
}

interface RoleSnapshotV2 {
  role_key: RoleKey;
  role_key_wire: string;
  state: RoleReachabilityState;
  holder_agent_id: string | null;
  previous_holder_agent_id: string | null;
  epoch: number;
  lease_expires_ms: number | null;
  charter_version: string | null;
  charter_acked: boolean;
  activation_id: string | null;
  candidate_count: number;
  live_candidate_count: number;
  reachable_candidate_count: number;
  excluded_candidate_count: number;
  pending_count: number;
  last_transition_ms: number;
  last_reason: string;
  blocked_reason: string | null;
}
```

version negotiation:

- `status({api_version:2, project_id?})` → `data.roles`에 v2 envelope.
- `api_version` 누락 또는 `1` → legacy projection.
- in-repo 소비자가 모두 v2로 전환되기 전에는 기본값을 1로 유지한다.
- 다중 project 상태에서 v1 projection에 project context가 없으면 `SCOPE_REQUIRED`.

legacy projection:

```ts
projectLegacyCtoStatus(
  envelope: RoleStatusEnvelopeV2,
  projectId: ProjectId
): { cto: LegacyRoleSnapshot | null };
```

상태 매핑:

| v2 | legacy `status` |
|---|---|
| `active` | `active` |
| `electable`, `elected-probing` | `electable` |
| `unreachable`, `quarantined` | `offline` |

- legacy `leader_agent_id`는 v2가 `active`일 때만 holder를 노출한다.
- `leader_epoch`는 v2 epoch다.
- lead는 v1 projection에 노출하지 않는다.

v2 publish:

```ts
interface RolePublishTargetV2 {
  type: "role";
  role_key: RoleKey;
}
```

server는 이를 canonical `topic:role:<wire>`로 변환하고 `messages.role_key_wire`에 저장한다.

legacy `topic:cto`:

- 명시적 `project_id` 또는 connection-bound principal의 정확한 project가 있어야 한다.
- 두 context가 다르면 `SCOPE_MISMATCH`.
- context가 없으면 audit insert 전에 `SCOPE_REQUIRED`.
- 다중 project 중 임의 CTO를 고르면 안 된다.
- `topic:lead` legacy 주소는 scope가 없으므로 항상 `SCOPE_REQUIRED`.

### 영향 함수 `file:line`

- publish의 `topic:cto` 특례: [hub/router.mjs:1090](/Users/tellang/Projects/tools/triflux/hub/router.mjs:1090)
- 고정 `roles.cto`: [hub/router.mjs:1519](/Users/tellang/Projects/tools/triflux/hub/router.mjs:1519)
- pipe replay의 CTO 가정: [hub/pipe.mjs:471](/Users/tellang/Projects/tools/triflux/hub/pipe.mjs:471)
- tray status passthrough: [hub/tray-state.mjs:454](/Users/tellang/Projects/tools/triflux/hub/tray-state.mjs:454)
- tray `roles.cto` 소비: [hub/public/tray.html:376](/Users/tellang/Projects/tools/triflux/hub/public/tray.html:376)
- server tray merge: [hub/server.mjs:1481](/Users/tellang/Projects/tools/triflux/hub/server.mjs:1481)
- 기존 호환 회귀테스트: [tests/integration/router.test.mjs:319](/Users/tellang/Projects/tools/triflux/tests/integration/router.test.mjs:319), [tests/integration/pipe.test.mjs:367](/Users/tellang/Projects/tools/triflux/tests/integration/pipe.test.mjs:367)

### 수용 테스트

1. v2 status가 여러 project CTO와 scoped lead를 손실 없이 반환한다.
2. 단일 project의 v1 projection이 기존 `roles.cto` 필드를 보존한다.
3. v1 `topic:cto + project_id`가 정확한 v2 key로 번역된다.
4. context 없는 `topic:cto`는 `SCOPE_REQUIRED`이며 메시지 row도 생성하지 않는다.
5. 서로 다른 caller/explicit project는 `SCOPE_MISMATCH`다.
6. v2 role message replay는 같은 role key의 active holder에게만 허용된다.
7. tray-state와 tray UI가 v2 envelope를 직접 소비한 뒤 legacy fixture도 계속 렌더링한다.
8. default v1과 explicit v2 응답을 snapshot test로 고정한다.

---

## 7. Cross-CLI transport locator

### 정의

후보 등록은 “어떤 CLI인가”뿐 아니라 activator가 그 세션을 probe/wake할 수 있는 locator를 포함해야 한다. 선출 후보는 지원 가능한 transport를 가진 세션으로 제한한다.

### 구체 스펙

```ts
type TransportKind = "claude-uds" | "tmux";
type TransportCapability =
  | "probe"
  | "wake"
  | "activate"
  | "interrupt";

interface TransportLocatorV1 {
  schema_version: "tfx.transport-locator.v1";
  transport_id: string;
  kind: TransportKind;
  host_id: `hst_${string}`;
  capabilities: TransportCapability[];
  priority: number;
  expires_at_ms: number;
  locator:
    | {
        session_id: string;
        short?: string;
        bridge_id: string; // host-local logical ref, 경로 금지
      }
    | {
        session_name: string;
        mux_server_id: string;
      };
}
```

검증:

- Claude UDS는 `session_id` 또는 `short` 중 하나와 `bridge_id`가 필요하다.
- tmux는 `session_name`과 `mux_server_id`가 필요하다.
- locator에 `cwd`, socket path, bridge absolute path, shell command를 넣을 수 없다.
- locator expiry는 agent lease보다 늦을 수 없다.
- `host_id`가 local host이거나 등록된 remote relay가 없으면 해당 locator는 사용할 수 없다.
- Claude는 UDS와 tmux locator를 동시에 등록할 수 있다.
- Codex v1 지원 transport는 tmux다.
- CLI별 role kind를 만들지 않는다.

runtime adapter:

```ts
interface RoleTransportAdapter {
  supports(locator: TransportLocatorV1): boolean;

  probe(
    locator: TransportLocatorV1,
    options: { timeout_ms: number; signal: AbortSignal }
  ): Promise<TransportProbeResultV1>;

  wake(
    locator: TransportLocatorV1,
    activation: RoleActivationEnvelope,
    options: { signal: AbortSignal }
  ): Promise<WakeResultV1>;

  standup(
    roleKey: RoleKey,
    cli: "claude" | "codex",
    options: { signal: AbortSignal }
  ): Promise<TransportLocatorV1>;

  cancel(activationId: string): Promise<void>;
}
```

normalized probe 결과:

```ts
interface TransportProbeResultV1 {
  schema_version: "tfx-live.transport-probe.v1";
  ok: boolean;
  reachable: boolean;
  wakeable: boolean;
  transport_selected: TransportKind | null;
  transport_id: string;
  host_id: string;
  latency_ms: number;
  observed_at_ms: number;
  reason_code:
    | "ok"
    | "target_not_found"
    | "adapter_unavailable"
    | "timeout"
    | "permission_denied"
    | "protocol_mismatch"
    | "transport_error";
}
```

후보 필터:

```text
eligible =
  candidate qualification
  AND liveness
  AND not excluded
  AND exists locator:
      adapter.supports(locator)
      AND locator.capabilities includes probe,wake,activate
```

현재 `tfx-live probe`는 Claude daemon probe만 호출한다([bin/tfx-live.mjs:1874](/Users/tellang/Projects/tools/triflux/bin/tfx-live.mjs:1874)). 확장 후에는:

- `probe --transport uds` → daemon probe
- `probe --transport tmux` → session 존재+CLI readiness probe
- `probe --transport auto` → 등록 locator 우선순위대로 probe
- 호출자가 CLI/short/session 정보로 transport를 재추론하지 않고 등록 locator를 전달한다.
- 기존 기본 transport 정책은 legacy CLI 명령에만 유지한다([bin/tfx-live.mjs:1783](/Users/tellang/Projects/tools/triflux/bin/tfx-live.mjs:1783)).

### 영향 함수 `file:line`

- agent schema에 locator 부재: [hub/schema.sql:5](/Users/tellang/Projects/tools/triflux/hub/schema.sql:5)
- store register 필드: [hub/store.mjs:374](/Users/tellang/Projects/tools/triflux/hub/store.mjs:374)
- bridge register payload: [hub/bridge.mjs:616](/Users/tellang/Projects/tools/triflux/hub/bridge.mjs:616)
- HTTP register plumbing: [hub/server.mjs:1707](/Users/tellang/Projects/tools/triflux/hub/server.mjs:1707)
- tmux start/wake 구현: [bin/tfx-live.mjs:1254](/Users/tellang/Projects/tools/triflux/bin/tfx-live.mjs:1254), [bin/tfx-live.mjs:1300](/Users/tellang/Projects/tools/triflux/bin/tfx-live.mjs:1300)
- UDS attach 계약: [bin/tfx-live.mjs:1409](/Users/tellang/Projects/tools/triflux/bin/tfx-live.mjs:1409)

### 수용 테스트

1. Claude UDS 후보와 Codex tmux 후보가 같은 role key에서 priority 순으로 경쟁한다.
2. 우선 후보의 UDS가 실패하면 지원되는 Codex tmux 후보로 failover한다.
3. adapter가 모르는 locator version은 선출에서 제외된다.
4. liveness만 있고 locator가 없는 agent는 후보 snapshot에는 진단용으로 보이되 electable하지 않다.
5. Claude UDS 실패 후 동일 후보의 tmux locator가 성공하면 다른 후보로 넘기지 않는다.
6. raw absolute path가 locator JSON과 status에 나타나지 않는다.
7. remote `host_id`에 relay가 없으면 `adapter_unavailable`이다.
8. tfx-live UDS/tmux probe가 동일 normalized schema를 반환한다.

---

## 8. Kill-switch 우선순위

### 정의

`TFX_CTO`는 CTO 관련 기능 전체의 master switch다. manager·north-star·auto-collect의 개별 flag는 master가 켜진 경우에만 효력이 있다. lead manager는 CTO manager에 종속된다.

### 구체 스펙

```ts
interface RoleControlSnapshot {
  generation: number;
  master_enabled: boolean;
  cto_manager_enabled: boolean;
  lead_manager_enabled: boolean;
  north_star_enabled: boolean;
  auto_collect_enabled: boolean;
}
```

truth table:

| 조건 | CTO manager | lead manager | north-star | auto-collect |
|---|---:|---:|---:|---:|
| `TFX_CTO=0/off/false/no` | off | off | off | off |
| master on, `TFX_CTO_MANAGER!=1` | off | off | 개별 flag, 기본 on | 개별 flag, 기본 on |
| master on, CTO manager on, `TFX_LEAD_MANAGER!=1` | on | off | 개별 flag | 개별 flag |
| master on, CTO manager on, lead manager on | on | on | 개별 flag | 개별 flag |
| master on, `TFX_CTO_NORTH_STAR=0` | 무관 | 무관 | off | 무관 |
| master on, `TFX_CTO_AUTO_COLLECT=0` | 무관 | 무관 | 무관 | off |

- `TFX_CTO_MANAGER`와 `TFX_LEAD_MANAGER`는 명시적 on만 활성화한다.
- `TFX_LEAD_MANAGER=1`이어도 CTO manager가 off면 lead manager는 off다.
- gate는 ensure 진입, probe 전후, wake 전후, ACK 처리 전에 확인한다.
- control snapshot 변경은 `generation`을 증가시킨다.
- in-flight task는 시작 generation과 다르면 즉시 abort한다.

비활성화 처리:

1. 영향받는 role kind의 모든 `AbortController`를 abort한다.
2. runtime adapter의 `cancel(activation_id)`를 best-effort 호출한다.
3. persistent activation token을 clear하고 epoch를 증가시킨다.
4. v2 holder authority를 revoke한다.
5. role state는 `electable`, `blocked_reason=master_off|manager_disabled`로 남긴다.
6. backlog는 삭제하지 않는다.
7. cancellation 후 도착한 ACK는 stale다.
8. master-off에서 SessionStart north-star 출력과 auto-collect 실행도 반드시 0회다.

### 영향 함수 `file:line`

- 현재 master/manager 판독: [hub/lib/cto-env.mjs:18](/Users/tellang/Projects/tools/triflux/hub/lib/cto-env.mjs:18)
- north-star가 master를 무시하는 경로: [hooks/session-start-lake.mjs:37](/Users/tellang/Projects/tools/triflux/hooks/session-start-lake.mjs:37), [hooks/cto-north-star-brief.mjs:48](/Users/tellang/Projects/tools/triflux/hooks/cto-north-star-brief.mjs:48)
- auto-collect가 master를 무시하는 경로: [hub/team/cto-auto-collect.mjs:9](/Users/tellang/Projects/tools/triflux/hub/team/cto-auto-collect.mjs:9)
- Codex north-star shell 경로: [scripts/tfx-route.sh:456](/Users/tellang/Projects/tools/triflux/scripts/tfx-route.sh:456)

### 수용 테스트

1. `TFX_CTO=0`이면 다른 모든 flag가 `1`이어도 기능이 전부 꺼진다.
2. CTO manager off/lead manager on 조합에서 lead manager가 켜지지 않는다.
3. probe 중 master-off 전환 시 transport가 취소되고 ACK가 stale 처리된다.
4. persisted active holder를 manager-off Hub가 active로 복구하지 않는다.
5. master-off SessionStart가 north-star와 auto-collect를 모두 실행하지 않는다.
6. lead manager만 끄면 CTO ensure는 계속 동작한다.
7. feature-level north-star/collect off는 role manager를 취소하지 않는다.

---

## 9. Layer 0 제어 계약

### 정의

canary/probe 실패는 로그만 남기는 진단이 아니라 dispatch 제어 입력이다. 실패 범위에 따라 후보 제외, adapter disable, role failover, request block, manager disable 중 하나를 결정한다.

### 구체 스펙

결정표:

| 실패 | 범위 | 제어 action | failover |
|---|---|---|---|
| 후보 transport probe/wake 실패 | locator/candidate | locator 또는 candidate exclude | 대체 후보가 있으면 즉시 |
| transport adapter binary/API 누락 | adapter kind | adapter disable | 다른 kind 후보로 |
| candidate charter version 불일치 | candidate | candidate exclude | 가능 |
| standup capability 누락 | role key | standup dispatch block | 기존 후보만 시도 |
| role state/schema/CAS canary 실패 | global manager | manager disable | 금지 |
| persistence/epoch durability canary 실패 | global manager | manager disable | 금지 |
| logger event-shape canary 실패 | global manager | manager disable | 금지 |
| v2 request envelope 불일치 | 단일 request | request dispatch block | 금지 |
| optional/비제어 metadata drift | observation | log only | 없음 |
| active holder transport 상실 | holder | fence + candidate exclude | 가능 |

구조화 이벤트:

```ts
type RoleControlEventName =
  | "capability.degraded"
  | "drift.detected";

type ControlAction =
  | "log_only"
  | "candidate_exclude"
  | "adapter_disable"
  | "role_failover"
  | "dispatch_block"
  | "manager_disable";

interface RoleControlEventV1 {
  schema_version: "tfx.role-control-event.v1";
  event: RoleControlEventName;
  event_id: string;
  module: string;
  dur_ms: number;
  control_action: ControlAction;
  reason_code: string;
  project_id?: ProjectId;
  role_key_wire?: string;
  candidate_agent_id?: string;
  transport_id?: string;
  capability?: string;
  expected_version?: string;
  observed_version?: string;
  trace_id?: string;
  error_code?: string;
}
```

최종 JSON log required fields:

```text
service, env, module, event, event_id, dur_ms,
control_action, reason_code, level, time, msg
```

logger API:

```ts
buildRoleControlEvent(input): RoleControlEventV1;
emitRoleControlEvent(log, input): void;
```

- `event`는 Pino의 문자열 `msg`에만 두면 안 된다. object field로 반드시 전달한다.
- `msg`는 검색 편의를 위해 `event`와 동일하게 설정한다.
- domain input은 위 allowlist 밖의 필드를 전달하지 않는다.
- builder validation 실패 시 최소 JSON fallback을 stderr로 남기고 manager circuit을 연다.
- manager-disable 원인이 logger failure여도 fallback 출력 실패가 무한 재귀를 만들면 안 된다.
- canary는 Hub startup, package/version fingerprint 변경, runtime adapter reload 때 실행한다.

현재 logger는 service/env와 module만 자동으로 추가하며 `event`를 보장하지 않는다([scripts/lib/logger.mjs:34](/Users/tellang/Projects/tools/triflux/scripts/lib/logger.mjs:34), [scripts/lib/logger.mjs:90](/Users/tellang/Projects/tools/triflux/scripts/lib/logger.mjs:90)).

### 영향 함수 `file:line`

- logger base/formatter: [scripts/lib/logger.mjs:34](/Users/tellang/Projects/tools/triflux/scripts/lib/logger.mjs:34)
- module child logger: [scripts/lib/logger.mjs:90](/Users/tellang/Projects/tools/triflux/scripts/lib/logger.mjs:90)
- field allowlist 회귀테스트 패턴: [tests/unit/codex-mcp-profile-resolve.test.mjs:167](/Users/tellang/Projects/tools/triflux/tests/unit/codex-mcp-profile-resolve.test.mjs:167)
- transport fallback이 현재 진단 report만 쓰는 경로: [bin/tfx-live.mjs:1482](/Users/tellang/Projects/tools/triflux/bin/tfx-live.mjs:1482)
- 실제 dispatch 경로: [hub/router.mjs:653](/Users/tellang/Projects/tools/triflux/hub/router.mjs:653)

### 수용 테스트

1. 두 이벤트 모두 최종 JSON에 required fields가 존재한다.
2. 임의 필드를 넣어도 logger로 전달되지 않는다.
3. `event`가 없으면 builder가 실패하고 manager-disable fallback이 발생한다.
4. transport probe 실패가 candidate exclusion과 failover를 실제로 수행한다.
5. core schema canary 실패 후 transport dispatch 호출은 0회다.
6. adapter 한 종류 실패가 다른 adapter까지 global disable하지 않는다.
7. fallback stderr JSON도 secret/path를 포함하지 않는다.
8. `control_action`과 실제 state mutation이 다르면 테스트가 실패한다.

---

## 10. 권한, 후보 자격, charter ACK, lead GC, project identity

### 정의

일반 세션은 citizen이지 자동 CTO/lead 후보가 아니다. 후보 자격과 lifecycle 권한은 Hub가 검증한 grant와 connection-bound principal에서 온다. payload의 `requested_by`는 권한 근거가 될 수 없다.

### 구체 스펙

#### 10.1 Project identity

repo에 다음 tracked manifest를 둔다.

```json
{
  "schema_version": "tfx.project.v1",
  "project_id": "prj_<128-bit-base64url>"
}
```

경로:

```text
.triflux/project.json
```

- `tfx setup`이 CSPRNG 128-bit ID를 한 번 생성한다.
- SessionStart/Hub가 서로 독립적으로 자동 재생성하면 안 된다.
- manifest가 없으면 active role 등록/ensure는 `PROJECT_ID_REQUIRED`로 fail-closed한다.
- 같은 manifest를 가진 clone/worktree는 같은 project ID를 사용한다.
- `resolveLakeRootDir()`은 manifest를 찾는 local resolver로만 사용한다.
- raw root는 role key, message, status, locator에 직렬화하지 않는다.
- project ID는 scope identifier이지 인증 secret이 아니다.
- 현재 `.triflux/*`가 ignore되므로 구현 시 manifest allowlist가 필요하다([.gitignore:3](/Users/tellang/Projects/tools/triflux/.gitignore:3)).
- linked worktree를 raw absolute common-dir로 식별하는 현재 방식은 local lake lookup에만 유지한다([cto/lake-root.mjs:10](/Users/tellang/Projects/tools/triflux/cto/lake-root.mjs:10), [cto/lake-root.mjs:65](/Users/tellang/Projects/tools/triflux/cto/lake-root.mjs:65)).

#### 10.2 Principal

```ts
type Principal =
  | {
      type: "agent";
      agent_id: string;
      session_id: string;
      project_id: ProjectId;
    }
  | {
      type: "human";
      operator_id: string;
      project_id: ProjectId;
    }
  | {
      type: "system";
      service: "sweeper" | "session-hook" | "team-pipeline";
      project_id: ProjectId;
      delegation_id?: string;
    };
```

- principal은 authenticated pipe connection, loopback token 또는 server 내부 context에서 생성한다.
- caller payload로 받을 수 없다.
- `requested_by`는 principal에서 생성하는 audit projection이다.
- 기존 payload `requested_by`는 v2에서 무시하거나 `legacy_requested_by`로만 기록한다.

#### 10.3 Role grant

```ts
interface RoleGrant {
  grant_id: string;
  role_key_wire: string;
  grantee_agent_id: string;
  permission: "candidate" | "lead.lifecycle";
  issued_by_type: "human" | "role" | "system";
  issued_by_id: string;
  issuer_role_key_wire?: string;
  issuer_epoch?: number;
  expires_at_ms: number;
  revoked_at_ms?: number;
}
```

후보 자격:

| 세션 | CTO 후보 | lead 후보 |
|---|---|---|
| 일반 SessionStart citizen | 아니오 | 아니오 |
| `topic:cto` 구독자 | 아니오 | 아니오 |
| `metadata.is_cto=true`만 보유 | 아니오 | 아니오 |
| human bootstrap grant를 가진 세션 | exact CTO key 가능 | exact lead key 가능 |
| activator가 standup한 role 세션 | activation grant가 있으면 가능 | activation grant가 있으면 가능 |
| team pipeline lead | 아니오 | exact scope grant+open scope일 때 가능 |

모든 후보의 공통 조건:

1. exact project/role key binding
2. 유효 candidate grant
3. `role:<kind>:candidate` capability
4. current charter version 지원
5. online+lease
6. activator가 probe/wake 가능한 locator
7. 해당 manager kill-switch enabled
8. closed/revoked scope가 아님

#### 10.4 Lifecycle 권한

| action | 허용 principal |
|---|---|
| CTO candidate bootstrap/takeover | human operator |
| CTO relinquish | 현재 CTO holder의 current epoch 또는 human |
| lead scope create/charter/update/close | 같은 project의 active CTO current epoch 또는 human |
| lead takeover | 같은 project의 active CTO current epoch 또는 human |
| team pipeline lead 생성 | active CTO가 발급한 유효 `lead.lifecycle` delegation |
| `ensure_role` trigger | 같은 project citizen/system/human |
| activation/charter ACK | current holder agent만 |
| sweeper revoke/GC | system sweeper; charter 변경은 불가 |

v2 takeover:

```ts
takeoverRole(
  input: {
    role_key: RoleKey;
    agent_id: string;
    reason: string;
    actor_epoch?: number;
  },
  context: { principal: Principal }
): Promise<TakeoverResult>;
```

#### 10.5 Charter ACK

charter ACK의 identity는 정확히 다음 tuple이다.

```text
(role_key, epoch, charter_version)
```

```ts
ackRoleActivation(
  input: ActivationAckV1,
  context: { principal: Principal }
): Promise<AckResult>;
```

- principal agent는 holder와 같아야 한다.
- CTO/lead charter version은 각각 kind-level SSOT에서 선택한다.
- epoch 또는 version이 다르면 active로 전환할 수 없다.
- ACK row는 `(role_key_wire, epoch, charter_version)` unique다.
- role scope close, takeover, restart, kill-switch는 epoch를 증가시켜 old charter를 fence한다.

#### 10.6 Scoped lead 종료 GC

scope lifecycle:

```ts
type LeadScopeLifecycle =
  | "open"
  | "closing"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";
```

terminal 전환은 단일 트랜잭션에서:

1. lifecycle terminal 기록
2. in-flight activation 취소
3. epoch 증가 및 final epoch tombstone 저장
4. holder/candidates/grants revoke
5. unacked role backlog를 `dead_letter`로 이동하고 reason=`ROLE_SCOPE_CLOSED`
6. dynamic role indexes에서 제거
7. default v2 status에서 제거
8. `include_closed=true`에서만 terminal tombstone 노출
9. scope ID 영구 재사용 금지
10. stale ACK/takeover는 tombstone의 final epoch로 거부

### 영향 함수 `file:line`

- 현재 topic/`is_cto` 기반 후보 판정: [hub/router.mjs:190](/Users/tellang/Projects/tools/triflux/hub/router.mjs:190)
- 현재 takeover가 `requested_by`를 검증하지 않음: [hub/router.mjs:1095](/Users/tellang/Projects/tools/triflux/hub/router.mjs:1095)
- MCP takeover schema도 요청 문자열을 직접 받음: [hub/tools.mjs:188](/Users/tellang/Projects/tools/triflux/hub/tools.mjs:188)
- HTTP takeover도 payload를 그대로 전달: [hub/server.mjs:1685](/Users/tellang/Projects/tools/triflux/hub/server.mjs:1685)
- 일반 SessionStart 등록: [hooks/session-start-fast.mjs:243](/Users/tellang/Projects/tools/triflux/hooks/session-start-fast.mjs:243)
- 현재 lead 생성 표면: [hub/team/orchestrator.mjs:52](/Users/tellang/Projects/tools/triflux/hub/team/orchestrator.mjs:52)
- raw canonical root resolver: [cto/lake-root.mjs:29](/Users/tellang/Projects/tools/triflux/cto/lake-root.mjs:29)

### 수용 테스트

1. 일반 세션과 topic subscriber는 CTO/lead 후보가 아니다.
2. forged `requested_by:"cto"`로 lead lifecycle을 변경할 수 없다.
3. 과거 CTO epoch의 lifecycle 명령은 `STALE_EPOCH`다.
4. current CTO는 같은 project의 lead만 생성/종료할 수 있다.
5. project가 다른 CTO의 명령은 `PROJECT_SCOPE_MISMATCH`다.
6. team pipeline은 valid delegation 없이는 lead scope를 만들 수 없다.
7. stale charter version/epoch ACK가 active 전이를 만들지 못한다.
8. 서로 다른 절대경로의 두 clone이 같은 manifest로 같은 RoleKey wire를 만든다.
9. manifest가 없을 때 raw path hash로 자동 대체하지 않는다.
10. lead 종료 후 holder/candidates/status가 사라지고 backlog가 DLQ로 이동한다.
11. 종료된 scope ID 재사용과 늦은 ACK가 거부된다.
12. status/message/locator JSON에 raw project root가 없다.

---

# 계약 간 의존 순서

```text
10a project identity + principal
  → 1 RoleKey/wire + dynamic role index
    → 5 durability schema/store
      ├→ 6 v2 envelope + legacy projection
      ├→ 8 kill-switch controller
      ├→ 9 Layer 0 event/control circuit
      └→ 7 transport locator/adapters
            → 2 reachability state machine
              → 4 singleflight/epoch/ACK
                → 3 ensure_role 연결
                  → 10b lead authority/grants/GC
                    → in-repo consumers 전환
                      → shadow rollout/failover drill
```

구현 gate:

1. 계약 1/5 없이 scoped router 구현 금지.
2. 계약 7/9 없이 activator dispatch 구현 금지.
3. 계약 2/4 없이 standup 구현 금지.
4. 계약 6 없이 기존 `topic:cto` 의미 변경 금지.
5. 계약 10의 principal/grant 없이 CTO→lead lifecycle API 노출 금지.

# 구현 1차 슬라이스 제안 — 가장 작은 안전한 첫 PR

**PR 제목:** `C6a-1: add inert role contract kernel and Layer0 control primitives`

포함:

- 신규 순수 모듈 `hub/role-contract.mjs`
  - `RoleKey` validation
  - JCS/base64url encode/decode
  - role address 생성
  - reachability enum과 transition reducer
  - v2 snapshot schema와 legacy CTO projection
- 신규 `hub/role-control-events.mjs`
  - event allowlist/required-field validation
  - `capability.degraded`/`drift.detected` builders
- `hub/lib/cto-env.mjs`
  - side-effect 없는 kill-switch truth-table resolver
- package ownership/pack mapping
- 순수 unit tests와 mirror/pack consistency tests

제외:

- router 동작 변경
- schema migration
- SessionStart 연결
- transport 실행
- standup/wake
- persisted holder 생성

PR 수용 기준:

- RoleKey canonical/round-trip/negative tests 통과
- 전체 상태 전이표 table-driven test 통과
- kill-switch truth table 전수 테스트 통과
- structured event field-allowlist 테스트 통과
- v1 projection fixture 테스트 통과
- lint/typecheck/unit/pack mirror 검증 통과

이 PR은 production dispatch를 전혀 바꾸지 않으면서 이후 schema/store/router가 의존할 단일 계약 정본을 먼저 만든다. 다음 PR은 `schema v6 + store CAS/recovery`여야 한다.

---

## 교차검증 반영 (2026-07-16, Claude opus 적대적 리뷰) — P1 3건 보정

총평: 코드 정합성 이례적으로 높음(인용 file:line 실측 대부분 정확), 10 REJECT 갭↔10계약 1:1 폐쇄, **1차 슬라이스 SAFE(production zero-impact 검증)**. 아래 P1 3건은 구현 착수 전 스펙 확정에 반영한다.

### P1-1. charter 재발행 경로 부재 (계약 2↔3↔10.5 사각)

계약 3의 `charter_issued` 트리거가 active 홀더에 대해 `already_active`로 단락되고, 계약 2 전이표의 `active` 행에는 charter 재발행 전이가 없다. 그러나 계약 10.5는 charter version 변경 시 epoch 증가 + old charter fence를 요구 → **active 홀더에 새 charter를 주입할 정의된 경로가 없다.**
**보정: 계약 2 전이표에 `active → elected-probing (charter_reissued)` 전이 추가.** 계약 3 `charter_issued`는 version 불일치 active 홀더에 대해 `already_active` 단락 대신 **epoch 증가 + 재ACK 예약**. charter ACK tuple `(role_key, epoch, charter_version)` 재검증.

### P1-2. 계약 5 마이그레이션 seam을 실제 store 코드에 정렬

스펙의 raw `ALTER TABLE agents ADD COLUMN`(비멱등)은 실제 store.mjs 마이그레이션과 불일치. 실제 seam: 버전 불일치 시 schema.sql 재실행(CREATE IF NOT EXISTS) + **비파괴 컬럼 추가는 `ensureColumn(db,table,col,def)`(store.mjs:84, 매 부팅 무조건)**.
**보정: 신규 컬럼은 `ensureColumn(db,"agents","project_id","TEXT")` 형태로. 신규 테이블은 schema.sql CREATE IF NOT EXISTS + `SCHEMA_VERSION "5"→"6"` 범프(store.mjs:119). 수용테스트 "v5→v6 조회 보존"을 store.mjs:130-157 실행경로에 바인딩.** raw ALTER는 재실행 에러라 금지.

### P1-3. 계약 6 LegacyRoleSnapshot 필드셋 확정

status 3-value 매핑(active/electable/offline)은 현행 router.mjs:426-430과 정확 일치(역공학 정확). 그러나 v2 snapshot이 드롭하는 현행 필드(`candidates[]`·`transferred_count`·`candidate_source`·`live_candidate_count`·`pending_count`, router.mjs:438-451)를 legacy projection이 어떻게 복원하는지 미명시.
**보정: `LegacyRoleSnapshot` 필드셋을 현행 buildRoleSnapshot(router.mjs:424-452) 출력과 1:1 열거하고, tray.html:376·tray-state.mjs:454 실소비 필드를 대조해 회귀 fixture로 고정.**

### P2/P3 (차단 아님, 구현 시 유의)

- P2: `requestEnsureRole` 동기 epoch ↔ singleflight joiner 경합(joiner의 epoch 의미 명확화). generation 상태성은 1차 슬라이스 순수 resolver에선 stub(무해).
- P3: 인용 라인 미세 어긋남(register 순회 실제 864/876/888/907, getStatus 순회 1553 — 영역 정확, 라인만). 계약 4의 epoch+seq+id+version 4중 CAS는 최소 실증 후 통합 여지 검토.

### 1차 슬라이스 (C6a-1 inert kernel) — SAFE 확정

`hub/role-contract.mjs`+`hub/role-control-events.mjs`(순수 신규, 미존재 확인) + cto-env.mjs 순수 resolver 추가(기존 export 무변경). packages/core 소속(remote는 @triflux/core import). **cto-env.mjs는 core+triflux 미러 대상 → 신규 export 양쪽 동시 + `.claude/rules/tfx-mirror-policy.md` 3-layer(remote 포함) 체크.** 제외 목록(router/schema/SessionStart/transport/standup/holder)이 부작용 표면 정확 배제.
