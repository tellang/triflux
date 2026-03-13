# Triflux 세션 핸드오프: Hub 복구 검증 + MCP 동적 필터링 + 슬림 래퍼 버그 수정 (2026-03-13)

이 문서는 `triflux` 프로젝트의 2026년 3월 13일 두 번째 세션 성과와 다음 세션을 위한 액션 플랜을 정리합니다.

## 세션 정보
- **날짜**: 2026-03-13 (금) 2차 세션
- **버전**: `triflux@3.3.0-dev.4`
- **브랜치**: `dev`
- **테스트 상태**: 331 pass / 0 fail (이전 296 → +35)
- **이전 핸드오프**: `docs/handoff/21-tfx-gemini-handoff-2026-03-13.md`

## 1. 이번 세션 성과

### Hub try_restart_hub() 검증 테스트 (Tier 1-1)
- `tests/integration/hub-restart.test.mjs` 신규 작성 (7건)
- Named Pipe 단절, Hub 프로세스 종료/재시작, 슬립 복귀, 포트 추출, team_claim_task 재시도 커버
- Windows Git Bash `spawnSync` + background process `disown` 호환 이슈 해결

### Gemini 전용 통합 테스트 (Tier 1-2)
- `tests/integration/gemini.test.mjs` 신규 작성 (20건)
- Gemini 모델 리매핑(Pro/Flash), MCP 필터링, 지수 백오프, CLI 모드 전환 커버
- `tests/fixtures/bin/gemini` bash 래퍼 + `fake-gemini-cli.mjs` 확장

### 슬림 래퍼 Bypass 방지 (.issues/006) (Tier 1-3)
- `hub/team/native.mjs` — buildSlimWrapperAgent() 추가, HARD CONSTRAINT 강화
- `hub/team/native-supervisor.mjs` — 워커 종료 후 tfx-route.sh 경유 검증, 미검출 시 abnormal 마킹
- `hub/team/cli-team-status.mjs` — 비정상 완료 상태 `[abnormal:missing_tfx_route_evidence]` 표시

### MCP 동적 필터링 M단계 (.issues/003) (Tier 2)
- `scripts/lib/mcp-filter.mjs` — 정적 case문 → 키워드 매칭 + 도메인 태그 기반 점수화 top-k 반환
- `scripts/lib/mcp-server-catalog.mjs` — 서버 카탈로그 분리 (단일 소스)
- `scripts/mcp-check.mjs` — tool_count, domain_tags 메트릭 추가
- `scripts/tfx-route.sh` — 캐시 파일을 `--inventory-file`로 전달

### CLI 상주 서비스 설계 (추가 요청)
- `docs/design/cli-resident-service.md` — Hub를 resident CLI runtime으로 승격하는 설계
- Hub Named Pipe → CLI 진입점 재사용, .issues/001 warm session 연계 (866ms→0.5ms)
- bash/zsh/fish completion + 상태 캐시 전략

### 패리티 문서 (Tier 3)
- `docs/guides/codex-vs-gemini-parity.md` — tfx-codex vs tfx-gemini 기능 차이 비교표

### Verifier 정책 + Health Check 설계 (Tier 2)
- `docs/design/verifier-policy-healthcheck.md` — Gemini 모드에서 verifier Claude-native 유지 옵션
- TFX_VERIFIER_OVERRIDE 환경변수, 재시도 튜닝, try_restart_hub 확장 검토

### 세션 중 버그 수정 (2건)
1. **Stream wrapper exit=1**: claude-native 역할이 팀 non-tty 환경에서 `=== TFX_NEEDS_FALLBACK ===` 구조화 출력으로 명시적 fallback 시그널 전송
2. **Task status 미동기화**: 슬림 래퍼 프롬프트에서 Bash 완료 후 TaskUpdate + SendMessage 직접 호출 허용 → Hub와 Claude Code 태스크 상태 동기화

## 2. 주요 이슈 및 리스크

| ID | 우선순위 | 상태 | 요약 |
|----|---------|------|------|
| .issues/001 | High | OPEN | Delegator MCP — Gemini multi-turn(--resume) 미구현. cli-resident-service.md 설계 완료 |
| .issues/003 | Low | **RESOLVED** | 동적 MCP 필터링 M단계 구현 완료 (키워드 매칭 기반) |
| .issues/006 | High | **RESOLVED** | 슬림 래퍼 bypass 방지 — HARD CONSTRAINT + supervisor 검증 |
| .issues/007 | - | RESOLVED | Silent Exit 현상 수정 완료 (이전 세션) |
| - | Medium | **RESOLVED** | Stream wrapper fallback 시그널 구현 |
| - | Medium | **RESOLVED** | 슬림 래퍼 TaskUpdate 동기화 구현 |
| - | Medium | NEW | Gemini 통합 테스트 20건 중 concurrent 워커 간섭 시 6건 실패 가능성 (격리 필요) |

## 3. 코드 및 테스트 갭

- **MCP 필터링 L단계**: FTS/BM25 기반 서버/툴 검색은 M단계로 충분하여 보류
- **Delegator MCP MVP**: cli-resident-service.md 설계 기반 구현 미착수
- **Verifier Override 구현**: 설계 문서는 완료, TFX_VERIFIER_OVERRIDE 코드 적용 미시작
- **Hub 복구 확장**: try_restart_hub()이 team_claim_task()에만 적용 — team_complete_task/team_send_message 확장 미시작

## 4. 다음 세션 Action Plan

### Tier 1: 안정성 (필수)
1. **Gemini 테스트 격리**: concurrent 워커 간 파일 충돌 방지를 위한 테스트 격리 메커니즘
2. **Hub 복구 확장**: try_restart_hub()을 team_complete_task(), team_send_message()에도 적용
3. **전체 테스트 유지**: 331 pass 유지 확인 (CI 통합 권장)

### Tier 2: 기능 고도화
4. **Delegator MCP MVP (.issues/001)**: cli-resident-service.md 기반 구현 착수
   - Codex-only MVP: delegate + delegate-reply + status
   - Hub Named Pipe를 CLI 진입점으로 활용
5. **Verifier Override 구현**: TFX_VERIFIER_OVERRIDE=claude 환경변수 코드 적용
6. **Gemini Multi-turn**: gemini --resume 플래그 활용한 대화 맥락 유지

### Tier 3: DX 개선
7. **CLI 상주 서비스 프로토타입**: Hub 소켓 기반 tfx 명령 즉시 응답
8. **탭 자동완성**: bash/zsh/fish completion 스크립트 생성
9. **MCP 필터링 모니터링**: 키워드 매칭 정확도 메트릭 수집

## 5. 참조 및 실행 가이드

### 주요 변경 코드
- `scripts/tfx-route.sh:184-216`: try_restart_hub() + team_claim_task 재시도
- `scripts/tfx-route.sh:997-1012`: claude-native TFX_NEEDS_FALLBACK 시그널
- `scripts/lib/mcp-filter.mjs`: 키워드 매칭 기반 동적 필터링 전면 리팩터링
- `scripts/lib/mcp-server-catalog.mjs`: 서버 카탈로그 (신규)
- `hub/team/native.mjs:147-174`: 슬림 래퍼 TaskUpdate+SendMessage 동기화 프롬프트

### 설계 문서
- `docs/design/cli-resident-service.md`: CLI 상주 서비스 아키텍처
- `docs/design/verifier-policy-healthcheck.md`: Verifier 정책 유연화
- `docs/guides/codex-vs-gemini-parity.md`: Codex vs Gemini 패리티 가이드

### 테스트 실행
```bash
# 전체 테스트 (331 pass 유지 확인)
npm test

# Hub 복구 테스트만
node --test tests/integration/hub-restart.test.mjs

# Gemini 통합 테스트만
node --test tests/integration/gemini.test.mjs

# Hub 상태 확인
curl -sf http://127.0.0.1:27888/status | node -e 'process.stdin.pipe(process.stdout)'
```
