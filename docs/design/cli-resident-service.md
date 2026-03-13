# Triflux CLI Resident Service Design

## 요약

Triflux CLI를 "매번 새 Node 프로세스를 기동하는 도구"가 아니라 "이미 메모리에 올라와 있는 서비스에 붙는 얇은 클라이언트"로 바꾼다. 권장안은 **별도 새 데몬을 만들기보다 기존 Hub 프로세스를 resident runtime으로 승격**하는 것이다.

핵심 방향은 세 가지다.

1. `tfx` 진입점은 얇은 launcher로 축소한다.
2. 실제 명령 처리와 warm session은 Hub의 Named Pipe/Unix socket에서 수행한다.
3. `--require preload`와 V8 snapshot은 **프로세스 부팅 비용 감소용 보조 수단**으로만 쓰고, 대화형/상태ful 성능은 resident Hub가 담당한다.

이 설계의 핵심 경로는 아래와 같다.

```text
tfx launcher
  -> Hub pipe (existing primary transport)
    -> resident CLI service
      -> Delegator warm pool
        -> CodexMcpWorker / GeminiWorker reuse
```

`.issues/001`의 벤치마크를 그대로 활용하면, `tfx-route.sh` subprocess 경로의 약 `866ms` 비용을 제거하고, **warm session hit의 내부 dispatch는 약 `0.5ms` 수준**으로 유지할 수 있다. 사용자 체감 지연은 pipe 왕복과 출력 렌더링이 더해져 그보다 크지만, 병목의 본체인 subprocess boot는 hot path에서 제거된다.

## 현재 상태와 근거

- 현재 CLI 진입점은 `bin/triflux.mjs` 하나에 많은 서브커맨드와 캐시 로직이 묶여 있다.
- Hub는 이미 resident 후보에 가깝다. `hub/server.mjs:74-86`은 Hub 시작 시 router/store/pipe를 만들고, `hub/server.mjs:544-551`은 PID/pipe 정보를 기록한다.
- Bridge는 이미 **pipe 우선, HTTP fallback** 구조다. `hub/bridge.mjs:29-45`, `hub/bridge.mjs:110-135`.
- Named Pipe/Unix socket 서버는 이미 존재한다. `hub/pipe.mjs:21-58`.
- Delegator는 이미 `sessionKey` 기반 warm reuse를 지원한다. `hub/workers/codex-mcp.mjs:138-157`, `hub/workers/codex-mcp.mjs:244-289`, `tests/integration/delegator-mcp.test.mjs:83-114`.
- `.issues/001-delegator-mcp-server.md`는 현재 병목과 목표를 명시한다.
  - `tfx-route exec 평균: 866ms`
  - `CodexMcpWorker cold: 173ms`
  - `CodexMcpWorker warm: 0.5ms`
- 상태 캐시는 이미 산발적으로 존재한다.
  - `scripts/preflight-cache.mjs:10-11`의 `tfx-preflight.json`
  - `scripts/mcp-check.mjs:14`의 `mcp-inventory.json`
  - `bin/triflux.mjs:1239-1261`의 update cache

즉, triflux에는 이미 resident 설계의 부품이 대부분 있다. 부족한 것은 **CLI 진입점을 Hub resident path로 일원화하는 계층**이다.

## 설계 목표

- `tfx help`, `tfx version`, `tfx list`, `tfx hub status`가 warm 상태에서 즉시 응답에 가깝게 동작할 것
- `Delegator MCP warm session`을 CLI 프로세스 생명주기와 분리해 재사용할 것
- Windows Named Pipe와 POSIX Unix socket을 모두 유지할 것
- 기존 `hub/bridge.mjs`의 pipe-first / HTTP-fallback 계약을 깨지 않을 것
- bash/zsh/fish 자동완성을 동일한 command manifest에서 생성할 것
- 캐시는 "메모리 1차, 디스크 2차" 구조로 정리할 것

## 비목표

- 첫 단계에서 모든 명령을 resident 전용으로 강제하지 않는다.
- 첫 단계에서 HTTP bridge를 제거하지 않는다.
- 첫 단계에서 live socket/FD를 snapshot에 넣지 않는다.

## 선택지 비교

| 선택지 | 장점 | 단점 | 결론 |
|---|---|---|---|
| A. `bin/triflux.mjs` 최적화만 수행 | 구현이 가장 쉽다 | subprocess/warm session 문제를 해결하지 못한다 | 불충분 |
| B. preload + snapshot만 도입 | cold start는 줄어든다 | 세션 재사용, async 상태, completion 동기화가 약하다 | 보조 수단 |
| C. 별도 `tfxd` 데몬 추가 | 모델이 명확하다 | Hub와 상태/캐시가 이원화된다 | 비권장 |
| D. **Hub를 resident CLI service로 승격** | 기존 pipe, store, bridge, autostart를 재사용한다 | Hub 내부 모듈 분리가 필요하다 | **권장** |

권장안은 **D + B의 조합**이다.

- **핵심 실행 경로**는 Hub resident service로 옮긴다.
- `--require preload`와 V8 snapshot은 CLI launcher의 초기 parse/load 비용을 줄이는 보조 계층으로 둔다.

## 권장 아키텍처

### 1. 프로세스 역할

#### 1-1. Thin launcher

새 진입점을 `bin/triflux.cjs`로 둔다. 이 파일은 아래만 담당한다.

- 최소 인자 파싱
- preload 수행
- Hub pipe 연결 시도
- fast path 명령을 daemon에 위임하거나, daemon 부재 시 로컬 fallback 수행

권장 엔트리 분리는 아래와 같다.

```text
bin/triflux.cjs          # npm bin target, CJS launcher
bin/preload-cli.cjs      # very small preload
bin/triflux-entry.mjs    # full CLI fallback / compatibility entry
bin/command-registry.mjs # command manifest source of truth
```

`node --require preload`는 분명히 유용하지만, **전역 `NODE_OPTIONS` 방식은 피한다**. Node 공식 CLI 문서는 `--require`로 preload된 모듈이 main thread뿐 아니라 worker threads, forked processes, clustered processes에도 적용된다고 명시한다. 따라서 `NODE_OPTIONS=--require ...`를 전역으로 걸면 `hub-ensure`, `mcp-check`, worker bootstrap에도 preload가 침투해 부작용이 생긴다.

따라서 triflux에서는 아래 둘 중 하나를 쓴다.

- 내부 벤치/개발/직접 실행: `node --require ./bin/preload-cli.cjs ./bin/triflux-entry.mjs`
- 배포 엔트리: `bin/triflux.cjs`가 같은 preload 파일을 `require()`한 뒤 resident client를 시작

즉, **preload 로직은 공유하되, 전역 `NODE_OPTIONS`는 쓰지 않는다**.

#### 1-2. Hub resident CLI service

기존 Hub 프로세스 안에 `hub/cli/service.mjs`를 추가한다. 이 서비스가 실제 resident runtime이다.

책임:

- 명령 라우팅
- warm session pool 유지
- 캐시 보관 및 TTL 관리
- completion 응답
- long-running 작업의 progress / async status 전달

권장 신규 action:

```text
command: cli_execute
query:   cli_status
query:   cli_complete
query:   cli_cache_get
command: cli_cache_invalidate
```

이 action들은 **기존 `hub/pipe.mjs` 채널 위에 그대로 얹는다**. 즉, 새 daemon socket을 만들지 않고, 이미 배포된 pipe path를 CLI 진입점으로 재사용한다.

### 2. Hub socket을 CLI 진입점으로 활용

이미 triflux는 아래 체인을 가지고 있다.

- Hub 시작 시 pipe 생성: `hub/server.mjs:86`
- PID/pipe path 기록: `hub/server.mjs:544-551`
- bridge에서 pipe-first 연결: `hub/bridge.mjs:45`, `hub/bridge.mjs:110-135`

따라서 resident CLI는 아래처럼 구성한다.

```text
tfx launcher
  -> read ~/.claude/cache/tfx-hub/hub.pid
  -> connect pipe_path
  -> send cli_execute / cli_complete / cli_status
  -> read NDJSON frames
```

권장 프레임 형식:

```json
{"type":"command","request_id":"...","payload":{"action":"cli_execute","argv":["hub","status"],"cwd":"...","tty":true}}
{"type":"response","request_id":"...","ok":true,"data":{"phase":"ack","resident":true}}
{"type":"event","event":"progress","payload":{"message":"warm codex session hit","percent":15}}
{"type":"response","request_id":"...","ok":true,"data":{"phase":"done","exitCode":0,"stdout":"...","stderr":""}}
```

포인트는 두 가지다.

- **즉시 ack**를 보내서 CLI가 바로 살아있는 것처럼 보이게 한다.
- 최종 결과까지 기다리더라도, 사용자 체감은 "이미 메모리에 올라와 있는 명령"처럼 만든다.

### 3. Delegator MCP warm session 연계

Resident 설계의 본체는 이 부분이다.

현재 `CodexMcpWorker`는 `sessionKey -> threadId` map을 메모리에 들고 있고, `Delegator MCP`는 이를 사용해 같은 세션을 재호출할 수 있다. 하지만 이 이점은 **현재 프로세스가 살아 있는 동안만 유지**된다.

따라서 resident CLI service는 아래 풀을 가진다.

```text
WarmSessionPool key =
  provider + agentType + cwdHash + mcpProfile + sessionKey
```

보유 객체:

- `CodexMcpWorker`
- `GeminiWorker` 또는 Gemini session handle
- 최근 `threadId`
- 마지막 사용 시각
- 최근 실패 원인

핵심 경로:

1. `tfx` launcher가 `cli_execute` 호출
2. resident service가 route 결정
3. `provider=codex`이고 `sessionKey` hit면
4. 기존 `CodexMcpWorker.run(prompt, { sessionKey, threadId })`를 재사용
5. 내부 dispatch는 `.issues/001` 수준의 warm hit 경로를 유지

중요한 점:

- `0.5ms`는 **worker 내부 core path** 목표다.
- 실제 CLI round-trip SLA는 pipe 왕복과 출력 포함 기준으로 별도 관리해야 한다.

권장 확장:

- `hub/store`에 `cli_warm_sessions` 테이블을 추가해 `threadId`, `sessionKey`, `provider`, `cwd`, `updated_at`만 저장
- daemon 재시작 후에도 thread 재개를 best-effort로 시도
- live transport/socket 자체는 메모리에서만 유지

### 4. `--require preload` 적용 범위

`preload`는 아래만 해야 한다.

- package version, command manifest, small static help text load
- PID/token/cache 파일 경로 resolve
- perf mark 시작
- daemon client bootstrap에 필요한 작은 유틸 준비

`preload`에서 하면 안 되는 것:

- worker 프로세스 spawn
- 네트워크/pipe 영구 연결 열기
- 대형 의존성 import
- config 탐색의 전체 실행

이 단계는 cold start를 줄이는 보조 최적화이고, resident runtime을 대체하지 않는다.

### 5. V8 snapshot 적용 범위

Node CLI 문서는 `--build-snapshot`과 `--snapshot-blob`으로 application state를 blob으로 저장/복원할 수 있음을 제공한다. V8의 custom startup snapshots 글도, snapshot의 목적이 **JS heap 초기 상태를 미리 만들어 startup work를 줄이는 것**임을 설명한다.

triflux에서 snapshot에 넣을 수 있는 것:

- command registry
- help/usage text
- color table / constants
- completion grammar/template
- static route metadata

snapshot에 넣지 말아야 할 것:

- pipe/socket 핸들
- PID/토큰의 현재 값
- cwd별 상태
- cache TTL 결과
- live worker/session object

권장 blob 경로:

```text
~/.claude/cache/triflux/snapshots/
  triflux-v{pkg}-node{major.minor}-{platform}-{arch}.blob
```

권장 정책:

- Node major/minor 또는 package version 변경 시 blob 무효화
- blob 부재/실패 시 자동 fallback
- snapshot은 optional acceleration이다

즉, **snapshot은 static boot image**, **Hub resident service는 dynamic state owner**로 역할을 분리한다.

### 6. 상태 캐시 설계

캐시는 `메모리 1차 + 디스크 2차`로 정리한다.

1차 캐시:

- resident service의 in-memory TTL cache

2차 캐시:

- 기존 JSON 파일 유지
- 점진적으로 `hub/store` 또는 `cli_cache` 테이블로 통합

권장 캐시 키와 TTL:

| 키 | 현재 근거 | 권장 TTL | 비고 |
|---|---|---:|---|
| `preflight` | `scripts/preflight-cache.mjs` | 30초 | 기존 값 유지 |
| `hub_status` | Hub `/status` + pipe | 1초 | status UI용 |
| `mcp_inventory` | `scripts/mcp-check.mjs` | 5분 | 설치/설정 변경 시 invalidate |
| `rate_limits` | 기존 cache files | 15초 | HUD/doctor 공용 |
| `update_check` | `bin/triflux.mjs` | 1시간 | 기존 값 유지 |
| `completion_manifest` | 신규 | version bound | manifest 해시 변경 시 갱신 |

권장 정책:

- launcher는 stale 허용 캐시를 먼저 읽고, resident service가 백그라운드 갱신
- `tfx setup`, `tfx update`, `tfx hub restart`는 cache invalidate를 발행
- status 출력은 "cached / fresh / stale"를 명시

### 7. CLI 친화적 UX

#### 7-1. 즉시 응답

모든 resident 명령은 2단계 응답을 기본으로 한다.

1. `ack` 즉시 반환
2. `result` 또는 stream된 `progress` 후 최종 완료

예:

```text
$ tfx hub status
resident: connected (warm)
hub: healthy  pid=12345  pipe=\\.\\pipe\\triflux-12345
```

long-running 명령에서는 첫 줄을 빠르게 보여준다.

```text
$ tfx codex-team "..."
resident: connected, spawning team...
```

#### 7-2. 자동완성

새 command:

```text
tfx completion bash
tfx completion zsh
tfx completion fish
tfx __complete ...
```

원칙:

- 단일 source of truth는 `bin/command-registry.mjs`
- bash/zsh/fish 스크립트는 모두 이 manifest에서 생성
- 동적 후보는 `tfx __complete`가 resident service에 질의
- daemon 부재 시 static fallback 사용

권장 동적 completion 대상:

- 서브커맨드
- `tfx hub` 하위 명령
- `tfx codex-team` control verbs
- team name / task id
- completion 가능한 issue/doc IDs

`setup`은 아래를 설치한다.

- bash: `~/.bashrc` source
- zsh: `~/.zshrc` source
- fish: `~/.config/fish/completions/tfx.fish`

### 8. 장애 대응과 fallback

resident path 실패 시 동작은 명확해야 한다.

- pipe 연결 실패:
  - `scripts/hub-ensure.mjs`를 사용해 Hub 백그라운드 기동 시도
  - 동시에 read-only fast command는 로컬 fallback 수행
- Hub는 살아 있으나 `cli_execute` 미지원:
  - 기존 `bin/triflux-entry.mjs` 경로로 fallback
- snapshot mismatch:
  - snapshot 비활성화 후 계속 진행
- warm pool 메모리 증가:
  - idle TTL + LRU eviction + provider별 상한
- `sessionKey` 충돌:
  - key에 `cwdHash`와 `agentType`을 포함해 완화

## 구현 청사진

### 신규 모듈

```text
bin/triflux.cjs
bin/preload-cli.cjs
bin/triflux-entry.mjs
bin/command-registry.mjs
hub/cli/service.mjs
hub/cli/cache.mjs
hub/cli/session-pool.mjs
hub/cli/completion.mjs
scripts/build-cli-snapshot.mjs
scripts/generate-completions.mjs
```

### 수정 대상

```text
package.json
bin/triflux.mjs              # 기존 로직 분리 또는 entry로 축소
hub/server.mjs               # resident CLI service bootstrap + status 노출
hub/pipe.mjs                 # cli_execute / cli_complete / cli_status
hub/bridge.mjs               # hidden __complete / cli-status helper
hub/store.mjs                # cli_cache / cli_warm_sessions table
scripts/setup.mjs            # completion install + snapshot build/invalidate
tests/unit/*
tests/integration/*
```

## 단계별 구현 로드맵

### Phase 0. 계측과 기준선 확보

목표:

- 현재 cold/warm latency를 재측정하고 회귀 기준선을 만든다.

작업:

- `scripts/bench-cli-resident.mjs` 추가
- 아래 4개를 p50/p95로 측정
  - `tfx version`
  - `tfx list`
  - `tfx hub status`
  - delegator sync cold/warm

완료 기준:

- CI나 로컬에서 동일 명령 벤치가 재실행 가능

### Phase 1. Command registry와 thin launcher 분리

목표:

- `bin/triflux.mjs`를 monolith에서 분리하고, resident/fallback 양쪽이 같은 registry를 쓰게 한다.

작업:

- `bin/command-registry.mjs` 생성
- `package.json` bin target을 `bin/triflux.cjs`로 변경
- `bin/preload-cli.cjs`와 `bin/triflux-entry.mjs` 도입

완료 기준:

- 기존 CLI 동작 동일
- help/version/list 회귀 없음

### Phase 2. Hub resident CLI service 추가

목표:

- pipe를 CLI 주 진입점으로 만든다.

작업:

- `hub/cli/service.mjs` 추가
- `hub/pipe.mjs`에 `cli_execute`, `cli_status`, `cli_complete` 추가
- `hub/server.mjs` status에 `cli` 섹션 추가
- launcher가 pipe-first로 resident 호출

완료 기준:

- `tfx hub status`와 `tfx list`가 resident 경로로 동작
- pipe 실패 시 기존 fallback 유지

### Phase 3. Delegator warm pool 통합

목표:

- `.issues/001`의 warm path를 CLI invocations 사이에서도 유지한다.

작업:

- `hub/cli/session-pool.mjs` 구현
- `CodexMcpWorker`/`DelegatorMcpWorker` 인스턴스 재사용
- `cli_warm_sessions` persistence 추가
- async 작업은 `.issues/002` assign semantics와 연결

완료 기준:

- 동일 `sessionKey` 재호출 시 `threadId` 재사용 검증
- warm path가 subprocess 없는 resident 경로로 통과

### Phase 4. Completion과 상태 캐시 통합

목표:

- shell completion과 cache invalidation을 일관되게 만든다.

작업:

- `tfx completion bash|zsh|fish`
- `tfx __complete`
- `hub/cli/cache.mjs`
- `setup`에 completion 설치/갱신 추가

완료 기준:

- bash/zsh/fish에서 서브커맨드 completion 동작
- stale/fresh 상태 표시

### Phase 5. V8 snapshot 도입

목표:

- launcher의 static boot cost를 더 줄인다.

작업:

- `scripts/build-cli-snapshot.mjs`
- versioned blob 생성/정리
- launcher가 blob 사용 가능 시 활성화

완료 기준:

- snapshot 없을 때도 정상
- snapshot 있을 때 cold start 개선 확인

### Phase 6. 롤아웃과 안전장치

목표:

- resident path를 점진적으로 기본값으로 만든다.

작업:

- env flags
  - `TFX_DISABLE_RESIDENT_CLI=1`
  - `TFX_DISABLE_SNAPSHOT=1`
  - `TFX_DISABLE_PRELOAD=1`
- crash telemetry / debug output
- 문서와 doctor 업데이트

완료 기준:

- 문제 발생 시 즉시 fallback 가능
- doctor가 resident/snapshot 상태를 진단

## 수용 기준

- warm 상태에서 `tfx version`, `tfx list`, `tfx hub status` p50 ≤ 20ms
- `cli_execute -> ack` p50 ≤ 10ms
- Delegator warm hit의 internal dispatch는 `.issues/001` 수준을 유지
- resident path 실패 시 기존 CLI fallback으로 기능 유지
- bash/zsh/fish completion 설치/업데이트 자동화
- 캐시 freshness가 CLI에 노출

## 리스크와 대응

| 리스크 | 설명 | 대응 |
|---|---|---|
| Hub 비대화 | Hub가 CLI까지 품으면 God object가 될 수 있다 | `hub/cli/*` 하위 모듈로 분리 |
| preload 오염 | worker child까지 preload가 전파될 수 있다 | 전역 `NODE_OPTIONS` 금지 |
| snapshot 호환성 | Node version mismatch 시 깨질 수 있다 | versioned blob + auto fallback |
| warm session 메모리 증가 | session pool이 과도하게 커질 수 있다 | TTL/LRU/max sessions |
| 상태 이원화 | JSON cache와 DB cache가 엇갈릴 수 있다 | 메모리 primary, disk fallback, invalidate 명시 |

## 최종 권고

Triflux는 **새 resident daemon을 추가할 필요가 없다**. 이미 존재하는 Hub의 pipe-first 구조를 CLI 진입점으로 승격하고, Delegator warm session을 그 프로세스 안으로 옮기면 된다.

우선순위는 아래 순서가 맞다.

1. command registry + thin launcher
2. Hub resident CLI service
3. Delegator warm pool
4. completion + cache 통합
5. snapshot

이 순서를 따르면 low-risk 단계부터 바로 체감 성능을 얻고, 최종적으로는 "CLI가 메모리에 로드된 것처럼" 보이는 동작을 현실적인 변경량으로 달성할 수 있다.

## 참고 자료

내부 근거:

- `hub/server.mjs`
- `hub/pipe.mjs`
- `hub/bridge.mjs`
- `hub/workers/codex-mcp.mjs`
- `hub/workers/delegator-mcp.mjs`
- `.issues/001-delegator-mcp-server.md`
- `.issues/002-cao-assign-job-layer.md`
- `docs/research-2026-03-13-routing-optimization.md`
- `docs/adr/ADR-009-orchestration-architecture.md`

외부 근거:

- Node.js CLI docs: https://nodejs.org/docs/latest-v22.x/api/cli.html
- Node.js net docs: https://nodejs.org/docs/latest-v22.x/api/net.html
- V8 custom startup snapshots: https://v8.dev/blog/custom-startup-snapshots

검색 메모:

- `context7`, `tavily`, `exa`는 이 세션에서 quota/plan 제한으로 충분한 결과를 주지 못했다.
- 따라서 Node/V8 공식 문서를 직접 확인해 설계 판단에 사용했다.
