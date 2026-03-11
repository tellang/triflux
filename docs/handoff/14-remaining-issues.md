# Handoff: 남은 이슈 현황 (2026-03-11)

> 이전 세션에서 30건 중 17건 해소. 남은 13건의 미착수 사유와 선행 조건 정리.

## 세션 성과 요약

| 커밋 | 내용 | 해소 이슈 |
|------|------|----------|
| `6015f8f` | Critical 수정 + 코드 정리 | #26, #27, #29, #33, #34, #35 |
| `c41f0f1` | 독립 이슈 일괄 + bridge 개선 | #36, #38, #40, #42, #43 |
| GitHub close | 파일 부재 / 이미 해결 | #37, #52 |

## 남은 독립 이슈 (5건) — ADR 무관

### #39 요구사항 문서 현행화
- **미착수 사유**: 문서 전용 작업. ADR 7개 확정 + 이슈 17건 해소 후 문서가 크게 변경됨
- **선행 조건**: 없음 (언제든 가능)
- **작업 범위**: `docs/codex-team-runtime-requirements.md` CR1~CR8을 ADR-001~007에 맞춰 갱신
- **추천 에이전트**: Gemini writer

### #41 독립 프로세스 테스트 불가
- **미착수 사유**: #53 (테스트 프레임워크 결정)과 연관. 프레임워크 미확정 상태에서 테스트 작성은 재작업 위험
- **선행 조건**: #53 결정
- **작업 범위**: Hub 서버/nativeProxy/bridge의 통합 테스트. 현재 `npm test` 미설정
- **추천**: #53과 묶어서 진행

### #44 TeamDelete 실패 시 자동 복구
- **미착수 사유**: `tfx-doctor.mjs` 확장 필요. stale team 감지 로직 설계 미확정
- **선행 조건**: 없음 (독립 진행 가능)
- **작업 범위**:
  1. `bin/tfx-doctor.mjs`에 stale team 감지 (생성 후 1시간 경과 + 비활성)
  2. `tfx doctor --fix`에 자동 정리 추가
  3. SKILL.md Phase 5 실패 시 재시도 (최대 3회)
- **추천 에이전트**: Codex executor

### #53 테스트 프레임워크 결정
- **미착수 사유**: 아키텍처 결정 필요. Node.js 내장 test runner vs vitest vs jest
- **선행 조건**: 팀 합의
- **고려사항**:
  - ESM 프로젝트 → jest는 ESM 지원 미흡
  - Node.js 22+ 내장 `node:test`가 가장 의존성 적음
  - Hub 서버 통합 테스트에는 supertest 또는 직접 fetch
- **권장**: `node:test` + `node:assert` (zero-dependency)

### #54 모듈 구조 결정
- **미착수 사유**: ADR-003 (SKILL.md primary) 후속. cli.mjs 54KB 파일 분해 방향 미확정
- **선행 조건**: ADR-003 구현 시작 시점
- **고려사항**:
  - cli.mjs → UI/네비게이션 전용으로 축소 (ADR-003)
  - 팀 실행 로직은 SKILL.md가 담당
  - 분해 후보: `cli-ui.mjs`, `cli-team-start.mjs`, `cli-team-status.mjs`

## ADR 구현 대기 (8건) — 로드맵 순서대로

### Phase 1: Named Pipe 제어 채널 (ADR-004)
**관련 이슈**: #28 (task 3중 경로), #31 (상태 저장소 단일화)

- **미착수 사유**: 핵심 인프라 변경. 파일 폴링 → Named Pipe 전환은 Hub 서버 + tools.mjs + nativeProxy.mjs 전반에 영향
- **선행 조건**: 없음 (Phase 0 ADR 확정 완료)
- **작업 범위**:
  - `net.createServer` 기반 Named Pipe: `\\.\pipe\triflux-{session}`
  - `tools.mjs` poll_messages를 pipe 이벤트로 교체
  - SQLite를 감사/재생 전용으로 역할 축소
- **예상 크기**: L (5~10개 파일 수정)
- **#40.3 (poll_messages busy-wait)도 이 Phase에서 해결됨**

### Phase 2: Codex MCP 서버 통합 (ADR-005)
**관련 이슈**: #48 (AGENT_TEAMS API 의존), #51 (비-TTY)

- **미착수 사유**: Phase 1의 Named Pipe가 제어 채널 기반. MCP 통합은 그 위에 구축
- **선행 조건**: Phase 1 완료 권장 (병렬 가능하나 통합 복잡)
- **작업 범위**:
  - `claude_desktop_config.json`에 `codex mcp-server` 등록
  - `tfx-route.sh` Codex 경로를 MCP tool call로 전환
  - threadId 기반 멀티턴 세션 관리
- **예상 크기**: L

### Phase 3: Gemini/Claude subprocess (ADR-006, ADR-007)
**관련 이슈**: #51 (비-TTY 부분)

- **미착수 사유**: Phase 2와 동일 패턴. 통합 worker 인터페이스(`IWorker`) 추상화 필요
- **선행 조건**: Phase 2 완료 (인터페이스 확정)
- **작업 범위**:
  - Gemini `--output-format stream-json` headless subprocess 래퍼
  - Claude `--input-format stream-json --output-format stream-json` subprocess 래퍼
- **예상 크기**: M

### Phase 4: psmux 통합 (ADR-001)
**관련 이슈**: #45 (psmux primary), #46 (psmux vs tmux), #49 (wt 리팩터링), #50 (node-pty)

- **미착수 사유**: 프로토타입(`scripts/psmux-steering-prototype.sh`, 344줄)은 완성. 프로덕션 모듈 승격만 남음
- **선행 조건**: 없음 (독립 진행 가능, 가장 빠른 ADR 구현)
- **작업 범위**:
  - 프로토타입 → `hub/team/psmux.mjs` 승격
  - session.mjs의 tmux 경로에 psmux 우선 분기 추가
  - worker pane 자동 생성/정리 라이프사이클
- **예상 크기**: S~M

### 나머지 ADR 관련 이슈
| # | 이슈 | Phase에서 해소 |
|---|------|--------------|
| #32 | v2.1 vs v2.2 방향 | ADR-002로 v2.2+ 확정 (close 가능) |
| #30, #47 | SKILL.md vs cli.mjs | ADR-003 확정 (close 가능, 구현은 #54) |

## 권장 다음 세션 우선순위

1. **Phase 4 psmux** — 프로토타입 있어 가장 빠름, Windows 환경 즉시 개선
2. **#44 stale team 복구** — 독립, 운영 안정성 직결
3. **#53 + #41** — 테스트 프레임워크 결정 → 테스트 작성
4. **Phase 1 Named Pipe** — 핵심 인프라, 나머지 Phase의 기반
5. **#30, #32 close** — ADR 확정 이슈 정리 (코드 불필요)

## 파일 동기화 상태

| 소스 (repo) | 실행 복사본 | 동기화 |
|------------|------------|--------|
| `scripts/tfx-route.sh` | `~/.claude/scripts/tfx-route.sh` | ✅ 완료 |
| `hub/team/shared.mjs` | 신규 생성 | ✅ repo only |
| `hub/team/nativeProxy.mjs` | — | ✅ repo only |
