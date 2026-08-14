# 실행 스킬 맵 — tfx-auto 중심

## 멘탈 모델

사용자는 `tfx-auto`만 알아도 된다. auto가 내부에서 multi/swarm을 자동 선택한다. 명시 오버라이드는 magic keyword: "스웜", "멀티".

## 내부 라우팅 (auto가 판정)

| 입력 특성 | auto가 dispatch할 엔진 |
|-----------|---------------------|
| 1 태스크 + 작음 (S) | 직접 실행 (fire-and-forget) |
| 1 태스크 + 큼 (M+) | pipeline (plan → PRD → exec → verify) |
| 2+ 태스크 + 코드 변경 **없음** | **tfx-multi** (로컬 병렬; mode 생략=`auto`) |
| 2+ 태스크 + 코드 변경 **포함** | **tfx-swarm** (worktree 격리 필수) |
| 원격 + 코드 변경 | **tfx-swarm** (shard `host:`) |
| 원격 + 탐색/대화형 | **tfx-remote** (세션 관리 + resume) |

## 엔진 역할

| 엔진 | 역할 | 호출 경로 |
|------|------|----------|
| tfx-multi | 로컬 병렬 (cwd 공유, worktree 불필요; mode 생략=`auto`) | auto 내부 dispatch 또는 `/tfx-auto --parallel N --mode deep` |
| tfx-swarm | 격리 + 다기기 + auto merge (로컬/원격) | auto 내부 dispatch 또는 `/tfx-auto --parallel swarm --mode consensus --isolation worktree` |
| tfx-remote | 단일 세션 관리 (list/attach/send/resume/탐색) | 직접 호출: `/tfx-remote` |
| tfx-remote-spawn | **DEPRECATED** — tfx-remote로 통합됨 | 사용 금지 |
| tfx-codex-swarm | **DEPRECATED** — tfx-swarm으로 통합됨 | 사용 금지 |

## 핵심 차이 (격리 기준)

| 항목 | tfx-swarm | tfx-remote | tfx-multi |
|------|-----------|------------------|-----------|
| Working tree 격리 | **YES** (shard별 `.codex-swarm/wt-*`) | NO (cwd 공유) | NO (cwd 공유) |
| 원격 지원 | shard별 `host:` 자동 분배 (격리 유지) | SSH 단일 세션 | 로컬 전용 |
| 자동 merge | YES | NO | NO |
| 입력 | PRD 파일 | 자연어 프롬프트 | `--assign 'cli:prompt:role'` |

## 안티패턴 (실제 사고)

| 패턴 | 문제 | 대체 |
|------|------|------|
| PR conflict 해결을 `tfx-remote`로 실행 | WT 세션 `git checkout feat/X` → 메인 세션 working tree도 함께 전환 → race (2026-04-17 PR #72 사고) | `tfx-swarm` |
| 단일 파일 수정을 `tfx-swarm`으로 실행 | PRD + worktree 오버헤드 과잉 | `tfx-autopilot` |
| `tfx-multi`로 코드 수정 병렬 | cwd 공유 파일 race | `tfx-swarm` |
| `tfx-auto --parallel N` 명시 + 코드 변경 | warning 후 사용자 결정 존중 | swarm 권장이지만 사용자 명시 override 시 multi 진행 (Issue #281 closed) |

## 핵심 룰

> **코드 변경 = tfx-swarm 우선** (로컬/원격 동일). tfx-remote는 원격 대화형/탐색 전용. multi는 로컬 공유-cwd 병렬이며, headless는 명시 선택이다 (worktree 불필요 read-only 작업).
> **MANDATORY**: `tfx-auto` 는 2+ 태스크 + 코드 변경 자동 감지 시 swarm 으로 escalate (Issue #281 closed). 사용자 명시 `--parallel N` override 시 warning 후 사용자 결정 존중.

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
