# triflux v8.10.0 → v8.12.1 릴리즈 노트: MCP Gateway 영속화 여정
## 1. Executive Summary
본 문서는 Windows 환경에서 Claude Code 세션 종료 시 MCP(Model Context Protocol) 서버 프로세스가 정리되지 않고 잔류하는 '고아 프로세스(Orphan Process)' 문제를 해결하기 위한 기술적 여정을 다룹니다. 긴급 대응(Stop 훅)부터 근본적인 아키텍처 전환(stdio → SSE Gateway)까지의 과정을 기록하며, triflux v8.12.1에 적용된 안정성 및 보안 개선 사항을 포함합니다.
---
## 2. 문제 발견 (Problem Discovery)
- **현상**: Windows 작업 관리자에서 460개 이상의 터미널(conhost, node, cmd) 프로세스 포착.
- **상세 데이터**: `node` 270개, `cmd` 221개, `conhost` 55개, `pwsh` 33개 확인.
- **분석**: 활성화된 7개의 MCP 서버가 세션마다 독립적으로 spawn되어 누적됨 (7개 서버 × 12~24 인스턴스).
---
## 3. 원인 분석 (Root Cause Analysis)
3-CLI(Claude, Codex, Gemini) 병렬 Deep Research를 통해 다음과 같은 결론을 도출했습니다.
- **Claude Code 버그**: Windows OS에서 서브 프로세스 트리를 강제 종료하지 못하는 기지의 이슈 확인 (GitHub #1935, #15211, #28126).
- **MCP stdio 스펙**: 기본적으로 1프로세스당 1세션을 전제로 설계되어, 세션이 반복될수록 프로세스가 기하급수적으로 증가함.
- **결론**: triflux 자체의 결함이 아닌, 상위 런타임(Claude Code)의 Windows 대응 미비로 판명.
---
## 4. Phase 1: 긴급 대응 - Stop 훅 (v8.10.0)
문제의 확산을 막기 위해 프로세스 강제 종료 메커니즘을 먼저 도입했습니다.
- **해결책**: PowerShell 기반의 `scripts/mcp-cleanup.ps1` 생성.
- **통합**: `setup.mjs` 실행 시 자동으로 세션 종료 훅을 등록하도록 수정.
- **배포**: `skills/tfx-remote-setup`을 통해 원격 호스트에도 해당 훅이 배포되도록 확장.
- **기록**: `docs/research/mcp-orphan-process-analysis.md`에 분석 결과 자산화.
---
## 5. Phase 2: 근본 해결 리서치 - Gateway 아키텍처
프로세스를 매번 띄우는 대신, 하나만 띄워놓고 공유하는 '재사용(Reuse)' 방식을 연구했습니다.
- **핵심 기술**: `supergateway` (stdio 기반 MCP를 SSE 엔드포인트로 변환).
- **글로벌 에코시스템 조사**: 6개 에이전트 병렬 가동으로 전 세계 80개 이상의 MCP CLI 도구 및 러시아/일본의 특화 생태계(1C:Enterprise 등) 조사 완료.
- **검증**: `context7` 서버를 supergateway로 래핑하여 Claude Code의 `type: "sse"` 모드와 정상 통신 확인.
- **기록**: `docs/research/mcp-cli-tools-survey.md` 생성.
---
## 6. 구현 상세 (Implementation Details)
v8.11.0 ~ v8.12.0에 걸쳐 `psmux` spawn 세션을 활용한 자율 구현이 진행되었습니다.
### 6.1 파일별 역할
- `scripts/mcp-gateway-start.mjs`: 6개 주요 MCP 서버를 supergateway SSE로 래핑하여 구동 (194 LoC).
- `scripts/mcp-gateway-start.ps1`: Windows 환경 최적화 PowerShell 스크립트.
- `scripts/mcp-gateway-config.mjs`: Claude Code의 `config.json` 내 stdio 설정을 SSE URL로 자동 전환.
- `scripts/mcp-gateway-ensure.mjs`: 게이트웨이 상시 가동 보장 로직.
- `scripts/mcp-gateway-verify.mjs`: 각 포트별 SSE 헬스체크 및 상태 검증.
### 6.2 포트 할당 표
| 포트 | MCP 서버 | 필수 환경변수 |
|------|---------|---------|
| 8100 | context7 | - |
| 8101 | brave-search | `BRAVE_API_KEY` |
| 8102 | exa | `EXA_API_KEY` |
| 8103 | tavily | `TAVILY_API_KEY` |
| 8104 | jira | `JIRA_*` 관련 변수 |
| 8105 | serena | - |
| 8106 | notion | `NOTION_TOKEN` |
| 8107 | notion-guest | `NOTION_TOKEN` |
### 6.3 아키텍처 다이어그램
```text
[AS-IS: stdio 방식]
Claude Session 1 (spawn) ──▶ MCP Process A
Claude Session 2 (spawn) ──▶ MCP Process B (고아 발생 위험)
[TO-BE: SSE Gateway 방식]
Claude Session 1 (HTTP) ──┐
Claude Session 2 (HTTP) ──┼──▶ [supergateway (Port 810x)] ──▶ MCP Process (영속)
Claude Session N (HTTP) ──┘
```
---
## 7. 품질 검증 - Deep QA (v8.12.1)
Claude Opus, Codex, Gemini 3-CLI를 통한 독립 검증 및 Consensus Scoring을 실시했습니다.
### 7.1 주요 수정 사항 (QA 합의 항목)
- **F-01 (CRITICAL)**: `mcp-gateway-verify.mjs`에서 `process.exit()` 호출 시 비동기 핸들이 닫히지 않아 발생하는 `UV_HANDLE_CLOSING` 크래시 수정 → `process.exitCode` 설정 방식으로 변경.
- **SEC-002 (HIGH)**: `supergateway` 포트가 외부 인터페이스(0.0.0.0)에 노출될 위험 방지 → `netsh advfirewall` 명령을 통한 로컬 루프백 전용 방화벽 규칙 자동 등록 로직 보강.
- **Bypass**: `headless-guard`와 `psmux` 간의 세션 데드락 방지를 위해 `TFX_ALLOW_DIRECT_CLI=1` 환경변수를 통한 직접 실행 경로(Bypass) 확보.
---
## 8. 릴리즈 이력 (Commit History)
- `db41e7b`: feat: Windows MCP 고아 프로세스 자동 정리 Stop 훅 도입
- `1605c33`: feat: supergateway 기반 MCP 서버 영속화 스크립트 구현
- `33dccb1`: fix: psmux 세션 중첩 차단 해제 및 headless-guard CLI fallback 추가
- `0f6c78f`: feat: PRD v2 Milestone 1 — tfx-ralph 모듈 생성
- `7f047ee`: fix: mcp-gateway Windows spawn 생존성 개선 및 쿼팅 오류 수정
- `f3f309f`: fix: mcp-gateway 보안 및 안정성 강화 (Deep QA 피드백 반영)
---
## 9. 남은 작업 (Remaining Tasks)
1. **F-02 (HIGH)**: `Stop-AllGateways` 스크립트를 파일 핸들링 대신 WMI(Windows Management Instrumentation) 기반 프로세스 트리 추적으로 변경 (크로스 스크립트 호환성).
2. **통합 테스트**: 실제 Claude Code 설정 전환 후 도구 호출 시 고아 프로세스 0개 유지 여부 최종 검증.
3. **단위 테스트**: `mcp-gateway-*` 5개 핵심 스크립트에 대한 Jest/Vitest 테스트 코드 작성.
4. **자동화**: `setup.mjs` 단계에서 `gateway-ensure`를 서비스로 자동 등록하는 기능 통합.
5. **데몬화**: `pm2` 또는 `Windows Task Scheduler`를 통한 백그라운드 상시 가동 옵션 제공.
6. **Issue Close**: GitHub Issue #28 (psmux deadlock) 공식 종료 처리.
---
## 10. 참고 자료
- `docs/research/mcp-orphan-process-analysis.md`
- `docs/research/mcp-cli-tools-survey.md`
- `.sv/handoffs/triflux.md`
- 관련 GitHub Issues: #1935, #15211, #28126, #28 (psmux)
