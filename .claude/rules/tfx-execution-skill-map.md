# 실행 스킬 맵 — tfx-auto 중심

## 멘탈 모델

단일 CLI 작업은 `tfx-auto`로 실행한다. 읽기 전용 병렬 작업은 `tfx multi`를 쓸 수 있다. 코드 변경을 병렬로 진행할 때는 작업마다 worktree를 나누고 세션을 하나씩 배정한다. Claude Agent를 쓰면 `isolation: worktree`를 지정할 수 있다. 각 세션의 CLI 실행은 `tfx-auto`를 거친다.

실행 전 요구사항은 host `deep-interview`, 실행 계획은 superpowers `writing-plans`로 정리한다. TFX 다중모델 계획·실행은 `tfx-auto --mode deep`, 목표 변환은 Claude Code 기본 `/goal`을 쓴다. Codex 프로필은 `~/.codex/<프로필>.config.toml`에서 직접 관리한다.

## 실행 경로

| 입력 특성 | 실행 경로 |
|---|---|
| 단일 작업 | `tfx-auto` |
| 공유 cwd에서 가능한 읽기 전용 병렬 작업 | `tfx multi` 또는 Claude Agent 병렬 |
| 병렬 코드 변경 | 작업별 worktree와 세션을 나누고 각 세션에서 `tfx-auto` 실행 |
| 원격 탐색·대화형 작업 | `tfx-remote` |

서로 다른 세션이 같은 작업 트리에서 코드를 수정하면 파일 충돌이 날 수 있다. worktree별 변경은 검증과 리뷰를 거쳐 통합한다. 자동 병합을 전제로 작업을 시작하지 않는다.

## OMC 비교 경계

OMC PSM의 세 구성요소 도식은 과거 구조와의 비교 참고일 뿐이다. native Claude teammate lifecycle과
CLI/tmux worker lifecycle은 분리하고, Triflux가 CLI launch·observation·cleanup을 계속 소유한다.
자세한 근거와 향후 worktree 재사용 검증 후보는
[OMC 런타임 운용 비교 노트](../../docs/research/omc-runtime-knowhow-2026-08-14.md)를 따른다.

## CLI tmux 관전 기본값

> **MANDATORY**: 개별 Codex/Antigravity CLI 디스패치는 사람이 진행을 관전할 수 있도록 기본적으로 tmux split-pane으로 연다. 사용자가 "조용히"/"백그라운드로만"을 명시했거나 tmux가 불가한 경우에만 raw background로 되돌아간다.

이 절이 **언제 관전할지**의 auto-load 정책 SSOT다. 명시적으로 headless를 택한 엔진 경로는
그 명시 선택을 따른다. 세션 생성, 시작 배너 확인, attach, 정리, `tfx-live` 및 폭 기반 pane
배치의 **어떻게**는 [`skills/tfx-auto/SKILL.md`](../../skills/tfx-auto/SKILL.md)의
`tmux 라이브 관전` 절이 정본이다.

## Retry 정책 (Phase 3+)

| `--retry` 값 | 동작 | 적용 모드 |
|-------------|------|---------|
| `0` | 재시도 없음 | 모든 모드 |
| `1` (기본) | bounded verify→fix loop 3회, 같은 CLI | 모든 모드 |
| `ralph` | true state machine — `--max-iterations 0` (unlimited) 기본, stuck 3회 중단 | 스킬 경유 시 unlimited, CLI 직접 호출 시 bounded 1 |
| `auto-escalate` | CLI/모델 승격 체인 — `.claude/rules/tfx-escalation-chain.md` 규약 | `--max-iterations N` 으로 단계당 상한 |

`ralph`/`auto-escalate` 는 `hub/team/retry-state-machine.mjs` 가 구동. state 는 `.omc/state/retry-<sessionId>.json` 에 저장 (compaction survive). Bridge: `node hub/bridge.mjs retry-run --snapshot X --event ...`.
