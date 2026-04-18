# 실행 스킬 맵 — tfx-auto 중심

## 멘탈 모델

사용자는 `tfx-auto`만 알아도 된다. auto가 내부에서 multi/swarm을 자동 선택한다. 명시 오버라이드는 magic keyword: "스웜", "멀티".

## 내부 라우팅 (auto가 판정)

| 입력 특성 | auto가 dispatch할 엔진 |
|-----------|---------------------|
| 1 태스크 + 작음 (S) | 직접 실행 (fire-and-forget) |
| 1 태스크 + 큼 (M+) | pipeline (plan → PRD → exec → verify) |
| 2+ 태스크 + 코드 변경 **없음** | **tfx-multi** (로컬 headless 병렬) |
| 2+ 태스크 + 코드 변경 **포함** | **tfx-swarm** (worktree 격리 필수) |
| 원격 + 코드 변경 | **tfx-swarm** (shard `host:`) |
| 원격 + 탐색/대화형 | **tfx-remote-spawn** (세션 관리 + resume) |

## 엔진 역할

| 엔진 | 역할 | 호출 경로 |
|------|------|----------|
| tfx-multi | 로컬 headless 병렬 (cwd 공유, worktree 불필요) | auto 내부 dispatch 또는 `/tfx-multi` |
| tfx-swarm | 격리 + 다기기 + auto merge (로컬/원격) | auto 내부 dispatch 또는 `/tfx-swarm` |
| tfx-remote-spawn | 단일 세션 관리 (list/attach/send/resume/탐색) | 직접 `/tfx-remote-spawn` |
| tfx-codex-swarm | **DEPRECATED** — tfx-swarm으로 통합됨 | 사용 금지 |

## 핵심 차이 (격리 기준)

| 항목 | tfx-swarm | tfx-remote-spawn | tfx-multi |
|------|-----------|------------------|-----------|
| Working tree 격리 | **YES** (shard별 `.codex-swarm/wt-*`) | NO (cwd 공유) | NO (cwd 공유) |
| 원격 지원 | shard별 `host:` 자동 분배 (격리 유지) | SSH 단일 세션 | 로컬 전용 |
| 자동 merge | YES | NO | NO |
| 입력 | PRD 파일 | 자연어 프롬프트 | `--assign 'cli:prompt:role'` |

## 안티패턴 (실제 사고)

- PR conflict 해결을 `tfx-remote-spawn`으로 실행 → WT 세션 `git checkout feat/X` → 메인 세션 working tree도 함께 전환 → race (2026-04-17 PR #72 사고)
- 단일 파일 수정을 `tfx-swarm`으로 → PRD + worktree 오버헤드 과잉 → `tfx-autopilot` 사용
- `tfx-multi`로 코드 수정 병렬 → cwd 공유 파일 race → `tfx-swarm`

## 핵심 룰

> **코드 변경 = tfx-swarm만** (로컬/원격 동일). remote-spawn은 원격 대화형/탐색 전용. multi는 로컬 headless 병렬 (worktree 불필요 read-only 작업).

## Retry 정책 (Phase 3+)

| `--retry` 값 | 동작 | 적용 모드 |
|-------------|------|---------|
| `0` | 재시도 없음 | 모든 모드 |
| `1` (기본) | bounded verify→fix loop 3회, 같은 CLI | 모든 모드 |
| `ralph` | true state machine — `--max-iterations 0` (unlimited) 기본, stuck 3회 중단 | 스킬 경유 시 unlimited, CLI 직접 호출 시 bounded 1 |
| `auto-escalate` | CLI/모델 승격 체인 — `.claude/rules/tfx-escalation-chain.md` 규약 | `--max-iterations N` 으로 단계당 상한 |

`ralph`/`auto-escalate` 는 `hub/team/retry-state-machine.mjs` 가 구동. state 는 `.omc/state/retry-<sessionId>.json` 에 저장 (compaction survive). Bridge: `node hub/bridge.mjs retry-run --snapshot X --event ...`.

## 알려진 한계

현재 `tfx-auto`는 2+ 태스크를 만나면 **multi로만 dispatch**한다. 코드 변경 포함 시 자동 swarm dispatch 로직은 Issue #87 (auto 라우터 강화)에서 추적.
