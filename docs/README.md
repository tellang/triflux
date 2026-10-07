# triflux 문서 인덱스

## 주요 문서

| 알고 싶은 것 | 먼저 볼 문서 |
|---|---|
| **무엇을 만드나 / 요구사항** | [prd/](prd/): 제품 요구(PRD) · 템플릿 [prd/_template.md](prd/_template.md) |
| **원문 요구와 확정 요구 (추적성)** | [req/](req/): raw(원문 ask)와 refined(확정 요구사항)의 양방향 링크. PRD보다 앞 단계 |
| **왜 이렇게 정했나 (결정 근거)** | [adr/](adr/): 번호화된 불변 ADR · 상태보드 [adr/README.md](adr/README.md) · 운영 규약 [adr/CONVENTIONS.md](adr/CONVENTIONS.md) · 경량 결정로그 [DECISIONS.md](DECISIONS.md) |
| **CTO 조회 범위** | [ADR-0024](adr/0024-cto-explicit-queries-only.md) : 명시적 `collect`·`status`와 제거한 운영 기능 |
| **swarm 퇴역** | [ADR-0025](adr/0025-retire-swarm-execution-engine.md) : 제거한 실행 엔진과 worktree 격리 방향 |
| **항상 지킬 에이전트 규칙** | [../.claude/rules/](../.claude/rules/): 정책 SSOT. 하네스가 auto-load한다. 문서는 이 규칙을 "가리키기만" 한다 |
| **Codex 실행 관례** | [codex-conventions.md](codex-conventions.md) |
| **시스템 구조** | [../ARCHITECTURE.md](../ARCHITECTURE.md): 패키지·데이터 흐름·미러 관계 |
| **개발 / 기여 프로세스** | [process/](process/): 브랜치 정책·PR 리뷰 계약 · 진입점 [../CONTRIBUTING.md](../CONTRIBUTING.md) |
| **설계 서사 (design)** | [design/](design/): 설계 노트·office-hours·실행 모드 등 서술형 설계 자료 |
| **조사 / 근거 자료** | [research/](research/): 리서치·감사·분석 리포트 |
| **운영 런북 (복구 / 트러블슈팅 / MCP)** | [recovery/](recovery/)(git·메모리·이슈PR 복구 기록) · [troubleshooting/](troubleshooting/)(알려진 이슈 해결) |

## 보조 파일

- 공개 자산: [assets/](assets/). README가 사용하는 [demo-multi.gif](assets/demo-multi.gif)를 유지한다.
- 폐기한 리딩 노트와 부속 설정은 [보관 인덱스](_archive/README.md)에 원래 경로와 함께 등재한다.

## 공개 범위

공개 표면은 다음 파일을 기준으로 구분한다.

| 표면 | 지배 파일 | 대상 |
|---|---|---|
| **GitHub (공개 커밋)** | `.gitignore` | `docs/{adr,prd,req,design,research,process,recovery,troubleshooting,_archive}/`, `docs/DECISIONS.md`, `../.claude/rules/`, 루트 `README`·`CONTRIBUTING`·`ARCHITECTURE`·`CHANGELOG`·`CLAUDE`·`AGENTS`·`CODEX`·`GEMINI`, `.document-harness.toml`, `.triflux/plans/` |
| **LOCAL (git-ignore, 커밋 안 함)** | `.gitignore` | `.omx/`·`.omc/`·`.tfx/` 런타임, `.triflux/{lake,reports,swarm-logs,subagents}/`, `docs/superpowers/plans/`, 토큰·시크릿·호스트 등 비공개 값 |
| **npm tarball** | `package.json`의 `files` | `docs/assets`의 README 데모·로고·공유 이미지 5개만 명시적으로 포함(나머지 docs 제외) |

> 규칙: ADR·문서에 토큰·계정명·개인 호스트·로컬 절대경로·비공개 고객 내용은 넣지 않는다. 그런 값은 LOCAL 문서에만 둔다.

## 보관 문서

- **[_archive/](_archive/)** : 대체되거나 폐기된 문서 보존본. [보관 인덱스](_archive/README.md)에 이번 이동 42개와 ADR-0011을 등재한다. 기존 보관 PRD 32개, 종료 계획 4개, 리딩 노트와 부속 설정 5개, 제거된 원격 TUI 설계 1개를 보존한다.
  - [swarm 인프라 PRD](_archive/prd/p3-swarm-infra-fixes.md)와 [Issue #281 계획](_archive/triflux/plans/issue-281-auto-router-swarm-dispatch.md), [shard A](_archive/triflux/plans/issue-281-shard-a-staged-file-detect.md), [shard B](_archive/triflux/plans/issue-281-shard-b-router-escalate.md), [shard C](_archive/triflux/plans/issue-281-shard-c-integration-ssot-mirror.md), [swarm 실행 계획](_archive/triflux/plans/issue-281-swarm.md), [swarm smoke test](_archive/prd/archived/swarm-smoke-test.md), [mesh router/queue PRD](_archive/prd/archived/lake5-mesh-router-queue.md), [mesh 활성화 PRD](_archive/prd/archived/mesh-production-activation.md), [worktree lifecycle 테스트 PRD](_archive/prd/archived/worktree-lifecycle-test.md)를 ADR-0025에 따라 보존한다.
  - [Lake 4 스킬 템플릿 엔진 PRD](_archive/prd/archived/lake4-skill-templates.md)를 템플릿 엔진 폐기에 따라 보존한다.
  - [Lake 4 공유 세그먼트 PRD](_archive/prd/archived/lake4-token-shared-segments.md)를 템플릿 엔진 폐기에 따라 보존한다.
  - [Lake 4 텔레메트리 PRD](_archive/prd/archived/lake4-token-telemetry.md)를 템플릿 엔진 폐기에 따라 보존한다.
  - [native bridge daemon adoption PRD](_archive/prd/native-bridge-daemon-adoption.md)와 [interactive-attach 계획](_archive/triflux/plans/native-bridge-interactive-attach.md)은 S5에서 interactive-attach 모드를 삭제해 보존한다.

## 문서 경계

- **정본 우선(SSOT)**: 같은 주제에 문서가 여럿이면 위 표의 진입점이 정본이다. 모순 발견 시 정본 쪽으로 정렬하고 반대편은 위임/deprecate한다.
- **경계**: 정책은 `../.claude/rules/`(SSOT), 결정 근거는 `adr/`, 요구는 `prd/`, 실행은 `../.triflux/plans/`가 소유한다.
