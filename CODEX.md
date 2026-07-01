# triflux — Codex 프로젝트 지시

> 정책 SSOT는 `.claude/rules/`, 결정 근거는 `docs/adr/README.md`.

triflux 워크스페이스에서 Codex CLI의 역할과 운영 규칙. Claude/Gemini와 함께 3-CLI 합의·교차 검증·헤드리스 병렬 실행의 한 축으로 사용된다.

전체 프로젝트 컨텍스트는 `CLAUDE.md`를 참조한다 (이 파일은 Codex 관점만 다룸).

## Codex의 역할
- 교차 검증: Claude가 작성한 코드의 독립 리뷰 (동일 모델 self-approve 금지)
- 단일 파일 오토파일럿: tfx-autopilot, tfx-auto --cli codex
- 3-CLI 합의(consensus/debate/panel)에서 Codex 시점 제공
- swarm/multi headless 병렬 실행의 워커

## psmux에서 Codex 실행
- interactive `codex` 불가 (TTY 못 잡음)
- `codex < prompt.md` 불가 ("stdin is not a terminal")
- 사용 가능 패턴: `codex exec "$(cat prompt.md)" -s danger-full-access --dangerously-bypass-approvals-and-sandbox`
- `codex exec`는 config.toml의 approval_mode를 무시 → bypass 플래그 필수
- `-s` 유효값: read-only / workspace-write / danger-full-access

## config.toml 사용 규칙
- 이미 설정된 값은 CLI 플래그로 중복 지정 금지
  - `approval_mode = "auto"` 있으면 `-a` / `--full-auto` 생략
  - `sandbox = "workspace-write"` 있으면 `-s` / `--full-auto` 생략
- 안전 패턴: config.toml에 기본값 + CLI는 `--profile` 선택만

## headless-guard
- `codex exec` / `agy --dangerously-skip-permissions --print=` 직접 호출은 차단됨
- 반드시 tfx 스킬 경유: tfx-auto (--cli codex), tfx-multi, tfx-swarm 등

## Headless 결과 회수
- task-notification 완료 **후** output 파일 읽기 (그 전에는 시작 메시지만)
- 완료 마커: `=== HEADLESS_COMPLETE succeeded=N failed=N total=N ===`
- 워커 상세: `$TMPDIR/tfx-headless/{sessionName}-worker-N.txt`

## SSH 패턴
- `hosts.json`의 `os` 필드로 셸 판단 (windows=PowerShell, darwin=zsh, linux=bash)
- SSH 너머로 codex 직접 실행 금지 (config.toml 충돌 + TTY 문제)
- 원격에서 codex가 필요하면: tfx-remote → Claude Code → Claude가 내부에서 codex 호출

## Working agreements
- 한국어 우선, 기술 용어 원어 유지
- 커밋: `Type: 한국어 설명 (50자 이내)`. Co-Authored-By / AI trailer 금지
- 변경 후 lint/typecheck/test 실행
- 시크릿(API 키, 토큰, 세션) 하드코딩 금지
- 새 차단 규칙을 safety-guard에 추가할 때는 항상 대안 API를 같이 만들 것 (차단만 추가하면 데드락)
