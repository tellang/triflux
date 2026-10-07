# triflux Codex 가이드

상세 운영 지시는 `CLAUDE.md`에 있습니다. Codex는 `@import`를 지원하지 않으므로 필요할 때 직접 읽습니다.

## 핵심 규칙 (triflux 환경 특화)
- Codex 직접 호출 금지. `tfx-auto --cli codex`를 거친다. 코드 변경 병렬 작업은 작업별 worktree와 세션을 분리하고 각 세션에서 `tfx-auto`를 사용한다.
- 프롬프트는 `--` 뒤의 인자로 넘기고 표준 입력은 닫는다(`… -- "$prompt" < /dev/null`). `codex < prompt.md`는 비대화식 실행이라 실패한다.
- `config.toml`에 `approval_policy`, `sandbox_mode` 기본값을 두고 CLI는 `--profile`만 지정한다. 중복 플래그를 쓰지 않는다.
- Claude가 작성한 코드는 Codex로 교차 검증한다. 스스로 승인하지 않는다.
- 비대화식 결과는 작업 알림이 완료된 뒤에만 읽는다.

## 비대화식 실행 경로
- `codex exec` / `agy --dangerously-skip-permissions --print=` 를 직접 호출하지 않는다. 자동 차단 훅(headless-guard)은 2026-09-07 에 제거되었으므로 호출자가 지킨다.
- 반드시 `tfx-auto --cli codex`를 거친다. 코드 변경 병렬 작업은 작업별 worktree와 세션을 분리한다.

## 추론 수준 예외 경로
- 기본 역할 라우팅은 `low`/`medium`/`high`/`xhigh` 프로필을 유지합니다.
- 최난도 단일 작업만 `TFX_CODEX_PROFILE=max` (`gpt6_astra_max`).
- `ultra`는 최상위 단독 `deep-executor`/`scientist-deep`에서만 허용하고, 팀·비대화식·워커
  내부의 `ultra` 요청은 중첩 분산 실행을 막기 위해 `gpt6_astra_max`로 낮춥니다.
- `--retry auto-escalate`의 Codex 단계도 `gpt6_astra_max`입니다.

## 비대화식 결과 회수
- 완료 마커: `=== HEADLESS_COMPLETE succeeded=N failed=N total=N ===`
- 워커 상세: `$TMPDIR/tfx-headless/{sessionName}-worker-N.txt`

## SSH 방식
- `hosts.json`의 `os` 필드로 셸을 판단합니다 (windows=PowerShell, darwin=zsh, linux=bash).
- SSH 너머로 Codex를 직접 실행하지 않는다(`config.toml` 충돌과 TTY 문제). 원격에서 Codex가 필요하면
  `tfx-remote` → Claude Code → Claude가 내부에서 codex 호출.

## 작업 합의
- 한국어 우선, 기술 용어는 원어 유지.
- 커밋: `type(scope): 한국어 설명`. type은 소문자이며 **`Co-Authored-By`와 AI 꼬리표를 넣지 않는다.**
- 변경 후 린트·타입 검사·테스트를 실행한다. 비밀 정보(API 키·토큰·세션)를 하드코딩하지 않는다.

## 코드 작성 원칙
- 코드는 간결하게 쓰고 의미 있는 이름을 쓴다. 주석은 이유만 짧게 한국어로 쓴다.
- 테스트는 회귀를 막는 핵심 경로만 최소한으로 둔다.
- 제거 여부는 해당 파일을 끝까지 직접 읽고 판단한다.

## CTO 기준 방향
- `.triflux/lake/current.md`는 에이전트 간 기준 방향 요약입니다. 정렬을 위해 읽되 새 작업으로 취급하지 않습니다.
- 프로그램용 정본은 `tfx cto status --json`입니다. 안정 키는 `schema_version`, `repo`, `sources`, `summary`, `ledger_tail`, `hygiene`입니다.
- 읽기 전용 정렬 문맥입니다.
