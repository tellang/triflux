# ADR — triflux 아키텍처 의사결정 기록

triflux의 아키텍처·정책·횡단 결정을 ADR(Architecture Decision Record)로 남긴다.
**상태보드에 행이 없는 ADR은 존재로 인정하지 않는다.** 규약(어떻게)은 [CONVENTIONS.md](CONVENTIONS.md), 근거(왜)는 각 ADR.

## 상태보드

| ADR | 결정 | 상태 | 관련 |
|---|---|---|---|
| [0001](0001-record-architecture-decisions.md) | ADR로 아키텍처 결정을 기록한다 | Accepted | — |
| [0002](0002-doc-and-devflow-architecture.md) | 문서 파운데이션 + 개발 플로우 아키텍처 | Accepted | 0001 |
| [0003](0003-tfx-skill-passing-prose-injection.md) | headless CLI 스킬 전달 = 즉석 prose 주입 | Accepted | 0002 |
| [0004](0004-codex-as-default-cli.md) | 기본 구현 CLI = Codex | Accepted | 0002 |
| [0005](0005-packages-three-layer-mirror.md) | packages/ 3-layer single-source 미러 | Accepted | 0002 |
| [0006](../_archive/adr/0006-escalation-chain-codex-to-claude-opus.md) | 재시도 승격 체인 codex→claude opus 2단계 | Superseded | 0002, 0004, 0016 |
| [0007](../_archive/adr/0007-hub-default-port-27888.md) | hub 기본 포트 27888 고정 | Deprecated | 0002, 0023 |
| [0008](0008-native-bridge-ui-default-on.md) | headless 워커 native-bridge 기본 노출 | Accepted | 0002 |
| [0009](0009-stack-coexistence-three-layer.md) | gstack·sp·triflux 단방향 3-layer 공존 | Accepted | 0002 |
| [0010](../_archive/adr/0010-cto-lake-hub-role-boundary.md) | CTO lake ↔ Hub role 경계 — liveness/history 평면 분리 | Superseded | 0005, 0007, 0023 |
| [0011](../_archive/adr/0011-active-role-system-cto-scoped-lead.md) | 능동 역할 시스템 — CTO + scoped lead (C+A 하이브리드) | Superseded | 0010, 0024 |
| [0012](0012-orphaned-design-doc-deprecation.md) | 제거된 구현의 설계 문서 폐기 표시 | Accepted | 0002 |
| [0013](../_archive/adr/0013-synapse-expiry-window-unification.md) | synapse 만료 창 단일화 | Withdrawn | 0010, 0023 |
| [0014](0014-claude-credentials-keychain-source-of-truth.md) | Claude 자격증명은 macOS Keychain 정본, 읽은 저장소에만 되쓰기 | Accepted | 0002 |
| [0015](0015-codex-lane-exec-transport-and-last-message.md) | Codex 레인은 exec 전송 + 최종 메시지 파일이 결과 계약 | Accepted | 0004, 0006 |
| [0016](0016-codex-astra-top-tier-and-fable-escalation.md) | Codex 최상위 tier = Astra, 최종 승격 = Fable | Accepted | 0004, 0006, 0015 |
| [0017](0017-gpt6-sol-luna-lanes.md) | Terra/Luna 레인 = GPT-6 Sol/Luna | Accepted | 0004, 0015, 0016 |
| [0018](../_archive/adr/0018-cto-auto-behaviors-opt-in.md) | CTO 자동 동작은 명시적으로 켜야 실행 | Superseded | 0010, 0011, 0023 |
| [0019](0019-gpt61-sol-and-sonnet-55.md) | Sol 레인 = GPT-6.1 Sol, sonnet 별칭 = Sonnet 5.5 | Accepted | 0004, 0016, 0017 |
| [0020](0020-skill-surface-reduction.md) | tfx 스킬 표면 = 12개 + Windows 1개, 스킬 frontmatter `platform` 필터 | Accepted | 0004, 0009 |
| [0021](0021-keyword-hook-explicit-first.md) | 키워드 훅은 명시 토큰만 MUST, 자연어는 제안(suggest), gstack 이름은 설치본 기준 | Accepted | 0009, 0020 |
| [0022](0022-remove-cto-tray.md) | CTO 트레이를 패키지에서 제거 | Accepted | 0010, 0018 |
| [0023](0023-remove-command-hooks-hub-and-adopt-mods.md) | command hook, 키워드 라우팅, MCP gateway, synapse, 허브를 걷어내고 Claude Code mods 로 옮긴다 | Proposed | 0007, 0010, 0013, 0018, 0020, 0021, 0022 |
| [0024](0024-cto-explicit-queries-only.md) | CTO 는 조회만 남긴다 | Accepted | 0010, 0018, 0022 |
| [0025](0025-retire-swarm-execution-engine.md) | swarm 실행 엔진 퇴역 | Accepted | 0005, 0008, 0024 |
| [0026](0026-agents-row-tmux-attach.md) | claude agents 행을 워커 tmux 방의 attach client 로 만든다 | Proposed | 0008, 0025 |
| [0027](0027-codex-message-queue-default.md) | Codex 세션 메시지 전송은 codex queue 기본, tmux 입력은 폴백과 슬래시 명령 전용 | Proposed | 0015 |
| [0028](0028-per-run-codex-mcp-selection.md) | Codex MCP 선택은 전역 설정 교체 대신 실행별 -c 설정으로 한다 | Accepted | 0015 |
| [0029](0029-lead-session-operating-model.md) | 리드가 세션의 생성부터 종료까지 소유한다 | Proposed | 0004, 0023, 0032 |
| [0030](0030-tests-and-worktrees-do-not-write-user-state.md) | 테스트와 worktree는 실제 사용자 상태에 쓰지 않는다 | Proposed | 0028 |
| [0031](0031-cli-and-distribution-surface-reduction.md) | CLI와 배포 표면을 줄인다 (2026-10 슬롭 정리 2단계) | Proposed | 0020, 0023, 0025 |
| [0032](0032-lead-role-skill-tfx-lead.md) | 리드 역할 절차를 tfx-lead 스킬로 분리한다 | Proposed | 0020, 0029 |

상태 범례: **Proposed**(제안) · **Accepted**(확정, 불변) · **Superseded**(대체됨 → `_archive/`) · **Deprecated**/**Rejected**/**Withdrawn**(무효화 → `_archive/`).

## 새 ADR 작성

1. 다음 번호로 `docs/adr/NNNN-kebab-title.md` 생성([CONVENTIONS.md](CONVENTIONS.md) 템플릿 사용).
2. 본문에 `## 결정`과 `## 검토한 대안`을 반드시 포함.
3. 위 상태보드에 행 추가(미등재 = 존재 부정).
4. 논의가 필요하면 `proposed`로 시작, 합의 후 `accepted`.
