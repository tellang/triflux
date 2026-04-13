# PRD: MCP Broker — MCP 서버 생명주기 관리

## 배경

Codex `config.toml`에 14개 MCP 서버가 등록되어 있으나, `codex exec`는 프로필별 필터링 없이
**전부 시작 시도**한다. 서버가 불응답하면 초기화 hang → 전체 Codex 워크플로우 블로킹.

2026-04-13 세션에서 10회 연속 Codex stall 발생 (5 zone × 2 배치).

### 현재 갭 (q1~q4)

| # | 질문 | 현재 | 필요 |
|---|------|------|------|
| q1 | 목적별 MCP 선택 | config.toml 전체 로딩 | 프로필별 서버 세트 |
| q2 | 사전 상태 확인 | 없음 | pre-flight health probe |
| q3 | 불응답 자동 제외 | hang까지 대기 | circuit breaker + fallback |
| q4 | 지속 추적/관리 | 없음 | 상태 추적 + 자동 복구 |

## 설계

### 아키텍처

AccountBroker 패턴을 MCP 서버에 적용.

```
Hub (/mcp/*)
  ├─ McpBroker (싱글턴)
  │   ├─ ServerRegistry (config.toml 파싱 + 프로필 매핑)
  │   ├─ HealthProbe (주기적 상태 체크)
  │   ├─ CircuitBreaker (서버별 장애 격리)
  │   └─ ConfigGenerator (임시 config.toml 생성)
  │
  └─ Hub API
      ├─ GET  /mcp/status        — 전체 서버 상태
      ├─ GET  /mcp/health/:name  — 개별 서버 상태
      ├─ POST /mcp/probe         — 즉시 헬스체크
      └─ GET  /mcp/config/:profile — 프로필별 임시 config 생성
```

### 프로필별 MCP 서버 매핑

| 프로필 | 필수 MCP | 선택 MCP |
|--------|----------|----------|
| analyze | context7 | tavily, exa, brave-search |
| implement | context7, playwright | — |
| review | — | context7 |
| docs | context7 | notion |
| none | — | — |

### 조회 패턴

#### 1. Heartbeat (Pull, 주기적)

```
간격: 60초 (기본)
방식: 각 서버의 /health 또는 프로세스 alive 체크
타임아웃: 2초 per server
병렬: Promise.allSettled로 전체 동시 체크
```

- Hub 시작 시 즉시 1회 체크 (cold start)
- 이후 60초 간격 polling
- Codex 실행 요청 시 마지막 체크가 30초 이내면 캐시 사용

#### 2. On-demand Probe (Pull, 요청 시)

```
트리거: tfx-route.sh → Hub /mcp/probe 호출
방식: 해당 프로필의 필수 MCP만 체크
타임아웃: 3초 (heartbeat보다 관대)
결과: alive/dead/starting 상태 반환
```

- Codex 실행 직전에 1회 호출
- 캐시 TTL 30초 이내면 스킵

#### 3. Event-driven (Push, 상태 변경 시)

```
이벤트: serverUp, serverDown, circuitOpen, circuitClose, probeTimeout
구독: Hub EventEmitter → HUD 연동
```

- MCP 서버 프로세스 crash 감지 (pid 모니터링)
- Circuit breaker 상태 전이 시 이벤트 발행

### Circuit Breaker 정책

| 파라미터 | 값 | 설명 |
|----------|-----|------|
| failureThreshold | 3 | 연속 실패 N회 후 open |
| openDuration | 5분 | open 상태 유지 시간 |
| halfOpenProbe | 1회 | half-open에서 테스트 프로브 |
| cooldownMultiplier | 2x | 재실패 시 쿨다운 배가 (최대 30분) |

### Config Generator

tfx-route.sh 실행 플로우:

```
1. tfx-route.sh → curl http://127.0.0.1:27888/mcp/config/analyze
2. Hub McpBroker:
   a. 프로필 "analyze"의 필수/선택 MCP 목록 조회
   b. 각 서버의 현재 상태 확인 (alive만 포함)
   c. 임시 config.toml 생성 → /tmp/tfx-codex-config-{hash}.toml
   d. 경로 반환
3. tfx-route.sh → CODEX_CONFIG_DIR=/tmp/tfx-codex-config-{hash}/ codex exec ...
   (또는 config.toml을 ~/.codex/에 원자적 교체 → 실행 → 복원)
```

### 미결정 사항

1. **Codex config 오버라이드 방법**: `CODEX_CONFIG_DIR` 환경변수 지원 여부 확인 필요.
   미지원 시 `~/.codex/config.toml` 원자적 교체(swap → exec → restore) 또는 symlink 전략.

2. **npx 캐싱**: `npx -y @package@latest`는 매번 다운로드 시도.
   `npx -y @package`(버전 고정)로 바꾸면 캐시 히트율 상승.

3. **MCP 서버 프로세스 공유**: 5개 Codex가 동시 실행되면 같은 MCP 서버를 5개 인스턴스로 시작.
   Hub가 MCP 프록시 역할을 하면 1개 인스턴스를 공유할 수 있다 (Lake 3a의 MCP 싱글턴 패턴).

## 구현 범위

### Phase 1: 최소 기능 (MVP)

- [ ] `hub/mcp-broker.mjs` — ServerRegistry + HealthProbe + CircuitBreaker
- [ ] Hub 라우트: `/mcp/status`, `/mcp/health/:name`, `/mcp/probe`
- [ ] tfx-route.sh: 실행 전 `/mcp/probe` 호출 + dead 서버 제외
- [ ] config.toml 임시 생성 또는 swap 전략
- [ ] 테스트: mcp-broker.test.mjs

### Phase 2: 고급 기능

- [ ] HUD 연동: MCP 서버 상태 표시
- [ ] `/mcp/config/:profile` 엔드포인트
- [ ] MCP 싱글턴 프록시 (Hub가 MCP 서버를 대신 호스팅)
- [ ] Gemini CLI MCP 통합 (현재 Gemini는 MCP 미사용)

## 참조

- AccountBroker: `hub/account-broker.mjs` (CircuitBreaker 패턴)
- MCP 싱글톤 PRD: Lake 3a (9efdd61)
- Hub health probe: `hub/team/health-probe.mjs`
- config.toml 위치: `~/.codex/config.toml`
