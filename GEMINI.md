# triflux — Gemini 프로젝트 지시

triflux 워크스페이스에서 Antigravity CLI의 역할과 운영 규칙. 1M context 활용·웹 검색·헤드리스 합의의 한 축으로 사용된다.

전체 프로젝트 컨텍스트는 `CLAUDE.md`를 참조한다 (이 파일은 Gemini 관점만 다룸).

## 행동 규칙 (파일 상단 우선 적용)
- 한국어 우선, 기술 용어 원어 유지
- 응답은 결정론적·구조적으로 — 마크다운 헤더 또는 XML 태그 일관 사용 (혼용 금지)
- 부정 지시도 효과적 (긍정과 동등한 adherence — A/B 검증)
- 커밋: `Type: 한국어 설명 (50자 이내)`. Co-Authored-By / AI trailer 금지
- 시크릿(API 키, 토큰, 세션) 하드코딩 금지

## Gemini의 역할
- 빠른 웹 검색 (Google Search 통합) — `tfx-research --quick`
- 3-CLI 합의(consensus/debate/panel)에서 Gemini 시점 제공
- 1M context 활용 — 큰 코드베이스 분석 / `tfx-deep-interview`는 Gemini 단독
- swarm/multi headless 병렬 실행의 워커

## headless-guard
- `agy --dangerously-skip-permissions --print=` 직접 호출은 차단됨
- 반드시 tfx 스킬 경유: tfx-auto, tfx-gemini, tfx-multi, tfx-swarm 등
- 일반 호출: `tfx-route.sh --cli gemini ...`

## 디렉터리 import 금지 (EISDIR)
- `@./path/` 처럼 디렉터리 import하면 Gemini ImportProcessor가 fs.readFile을 호출해 EISDIR로 크래시 (gemini-cli #6450, #4760)
- 디렉터리 경로를 문서에 남겨야 한다면 백틱(`)으로 감싸 import 스캔에서 제외

## 핵심 운영 컨텍스트 (요약 — 상세는 CLAUDE.md)
- psmux/WT 규칙: `tfx-psmux-rules` 스킬 / WT 프리징 방지 (exit → sleep 2 → kill)
- AccountBroker 싱글턴: 계정별 CircuitBreaker, busy 플래그, 이벤트 기반 HUD 연동
- 원격 실행: tfx-remote-spawn (SSH → Claude Code → 내부 tfx 라우팅)
- Headless 결과 회수: task-notification 완료 후 output 파일 읽기
  - 완료 마커: `=== HEADLESS_COMPLETE succeeded=N failed=N total=N ===`

## 교차 검증
- Claude 작성 코드 → Gemini/Codex 리뷰 가능
- Gemini 작성 코드 → Claude 또는 Codex 리뷰
- 동일 모델 self-approve 금지

## 검증
- 변경 후 lint/typecheck/test 실행
- 새 차단 규칙은 항상 대안 API와 함께 추가 (차단만 추가하면 데드락)
