# tfx-auto 분석 (dev 기준)

## 1. 프로젝트 구조 개요

`triflux`는 CLI-first 멀티 모델 오케스트레이터다.

- `bin/`: 사용자 CLI 진입점 (`tfx`, `triflux`)
- `scripts/`: 라우팅/설치/후처리 스크립트 (`tfx-route.sh` 등)
- `skills/`: 실행 스킬 정의 (`tfx-auto`, `tfx-codex`, `tfx-team` 등)
- `hub/`: 팀/메시지 버스 런타임
- `hooks/`, `hud/`: Claude 쪽 훅/HUD 연동 파일
- `docs/`: 설계/운영/리서치 문서

## 2. tfx-auto 핵심 동작

`skills/tfx-auto/SKILL.md`는 아래를 정의한다.

- 입력 파싱(자동/수동)
- Codex 분류 -> (문서상) Opus 인라인 분해
- DAG 기반 병렬 실행
- 결과 수집, 실패 fallback, 보고

실행 경로는 `~/.claude/scripts/tfx-route.sh` 중심이며, 실제 라우팅은 `scripts/tfx-route.sh`와 동일한 규칙을 따른다.

## 3. 실행 라우팅의 실제 제약점

`scripts/tfx-route.sh` 기준:

- Codex/Gemini 역할은 CLI로 실행
- 아래 4개는 `claude-native`로 분기됨
  - `explore`
  - `verifier`
  - `test-engineer`
  - `qa-tester`

즉 `tfx-auto` 문서가 Codex 우선을 강조해도, 특정 역할은 기본적으로 Claude 의존이 남아 있다.

## 4. 브랜치 이력 (main..dev)

`main..dev` 구간의 핵심 변화:

- `tfx-team` / `codex-team` 런타임 강화
- Windows Terminal attach/fallback 개선
- Codex 프로필 점검/보정 강화

반면 `skills/tfx-auto/SKILL.md`는 이 구간에서 직접 변경되지 않았다.

## 5. 요약

- `tfx-auto`는 이미 고도화된 DAG 오케스트레이션 문서를 갖고 있다.
- 하지만 역할 일부가 Claude 네이티브로 고정되어 Codex-only 관점의 일관성이 떨어진다.
- 따라서 Codex 환경을 위한 별도 스킬/모드와 라우터 보완이 필요하다.

