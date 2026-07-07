# 브랜치 정책 (branch policy)

> triflux 개발 브랜치 계약. 단일 maintainer + 다중 에이전트(worktree/swarm/remote) 환경을 전제로 한다.
> 정본(SSOT)은 [`.claude/rules/`](../../.claude/rules/)와 [`CLAUDE.md`](../../CLAUDE.md)다. 이 문서는 그 규칙을 사람이 읽는 형태로 **가리킬 뿐** 새 규칙을 발명하지 않는다.
> 근거·결정 배경은 [ADR-0002](../adr/0002-doc-and-devflow-architecture.md), 요구는 [PRD 01](../prd/release-governance/01-branch-issue-pr-governance.md).

## 모델: trunk-first

지금 규모에 맞게 **trunk-first**를 쓴다. `main` 하나가 항상 배포 가능 상태를 목표로 하고, 나머지는 짧게 살다 머지되는 작업 브랜치다. Git Flow 같은 장기 지원 브랜치 모델은 도입하지 않는다.

## 브랜치 클래스

| 클래스 | 형식 | 용도 | 머지 |
|---|---|---|---|
| main | `main` | 항상 배포 가능(트렁크) | 직접 push 금지 |
| 기능 | `feat/<issue>-<slug>` | 사용자·시스템 기능 | PR 경유 |
| 버그 | `fix/<issue>-<slug>` | 버그 수정 | PR 경유 |
| 문서 | `docs/<issue>-<slug>` | 문서만 변경 | PR 경유 |
| 리팩터 | `refactor/<issue>-<slug>` | 동작 보존 정리 | PR 경유 |
| 릴리즈(선택) | `release/<version>` | 단기 안정화 브랜치 | 필요 시에만 |
| 스파이크 | `spike/<date>-<slug>` | 폐기용 조사 | promote 없으면 머지 금지 |
| 워크트리 | `worktree-*` | 격리 작업(에이전트/실험) | promote 후 위 클래스로 재명명 |
| 스웜 샤드 | swarm shard 브랜치 | PRD별 worktree 격리 실행 | swarm auto merge (검증 후) |

### 네이밍 규칙

- `<issue>`는 GitHub issue 번호(없으면 explicit intent). `<slug>`는 kebab-case 짧은 요약.
- `worktree-*`와 swarm shard는 에이전트가 자동 생성하는 격리 브랜치다. issue id 또는 명시적 의도 없이 만들어진 브랜치는 **머지 금지**로 둔다.
- 스파이크는 던져버리는 조사용이다. 결과를 살릴 값어치가 있으면 정식 클래스로 promote한 뒤 머지한다.

## main 보호

| 규칙 | 내용 |
|---|---|
| 직접 push 금지 | 모든 변경은 PR을 경유한다. |
| PR 경유 필수 | 머지 전 [PR 리뷰 계약](pr-review-contract.md)의 검증 게이트를 통과한다. |
| CI green 필수 | `main` 머지는 CI가 green일 때만. red면 머지하지 않는다. |
| 항상 배포 가능 | `main`은 언제든 릴리즈 가능한 상태를 목표로 한다. |

## 워크트리 / 스웜 규약

코드 변경 병렬은 **worktree 격리**가 원칙이다. cwd를 공유하는 read-only 병렬만 multi로 처리한다. 격리 기준·엔진 선택·안티패턴은 [`.claude/rules/tfx-execution-skill-map.md`](../../.claude/rules/tfx-execution-skill-map.md)가 정본이다.

| 상황 | 경로 | 격리 |
|---|---|---|
| 2+ 태스크 + 코드 변경 | `tfx-swarm` (PRD별 worktree) | YES (샤드별 working tree) |
| 2+ 태스크 + read-only | `tfx-multi` (로컬 headless 병렬) | NO (cwd 공유) |
| 원격 + 코드 변경 | `tfx-swarm` (shard `host:`) | YES |
| 원격 + 탐색/대화형 | `tfx-remote` | NO (SSH 단일 세션) |

핵심 룰(요약): **코드 변경 = worktree 격리**. cwd를 공유한 채 여러 워커가 같은 파일을 만지면 race가 난다. 상세는 위 rules 파일 참조.

## 세션/워크트리 연속성

resume·compaction 이후 또는 링크된 worktree 안에서 편집을 시작하기 전, `git status --short --branch`와 현재 cwd를 재확인한다. 엉뚱한 브랜치·stale 컨텍스트 위에서 작업이 이어지지 않게 한다.

## 릴리즈 브랜치 / 태그

릴리즈는 [`/tfx-ship`](../../skills/) 경유가 유일한 정본 경로다.

- **로컬 publish 금지.** npm publish는 GitHub Actions가 OIDC Trusted Publishing으로 수행한다. 로컬 `npm login`/`npm publish`를 쓰지 않는다.
- 버전 bump·CHANGELOG·태그는 `/tfx-ship`의 릴리즈 래퍼(`scripts/release/*`)가 처리한다.
- 릴리즈 커밋/태그/PR에는 AI attribution(Co-Authored-By, Generated with 등)을 넣지 않는다.
- 상세 릴리즈 게이트는 [PR 리뷰 계약](pr-review-contract.md)과 [`.claude/rules/tfx-mirror-policy.md`](../../.claude/rules/tfx-mirror-policy.md)(packages 미러 검증) 참조.

## 관련 문서

- [PR 리뷰 계약](pr-review-contract.md) — 교차리뷰·머지 전 검증 게이트
- [`.claude/rules/tfx-execution-skill-map.md`](../../.claude/rules/tfx-execution-skill-map.md) — worktree/swarm/multi 격리 기준
- [`.claude/rules/tfx-routing.md`](../../.claude/rules/tfx-routing.md) — 실행/라우팅 정책
- [PRD 01: 브랜치+Issue/PR 거버넌스](../prd/release-governance/01-branch-issue-pr-governance.md)
