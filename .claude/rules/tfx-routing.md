# 자연어 → 스킬 라우팅

사용자가 스킬명을 모르더라도 자연어로 요청하면 아래 규칙에 따라 적절한 스킬을 호출한다.

## 기본 워크플로우 ladder

넓은 운영 순서와 스택 간 책임 경계는 이 파일에 둔다. 개별 `SKILL.md`
description에는 해당 스킬을 고르는 데 필요한 좁은 activation phrase만 넣는다.

| 상황 | 기본 순서 | 비고 |
|------|-----------|------|
| 메타 라우팅/스킬 선택 | `/tfx-harness` | 어떤 스킬/순서가 맞는지 먼저 판정해야 할 때 쓰는 단일 진입점. |
| 신규 제품/아이디어 | `/office-hours` → `/autoplan` → `/writing-plans` → `/tfx-auto` | 먼저 문제/범위를 잡고, 리뷰된 계획을 실행으로 넘긴다. |
| 기존 작업 계속 | `/gstack-context-restore` → `/tfx-auto` | 저장된 맥락을 복원한 뒤 실행한다. |
| 직접 구현/수정 | `/tfx-auto` (Codex 우선) | "이거 고쳐줘", "구현해줘". 기존 작업 연장이면 `/gstack-context-restore` 먼저. |
| 디버그 | `/tfx-find` → `/superpowers:systematic-debugging` → `/tfx-auto` | 코드 위치/사용처 확인과 원인 분석을 분리한다. |
| 리서치 | `/tfx-research` 또는 `/multilingual-parallel-research` | 외부/최신/도구 가능 여부 의문문은 `/tfx-research`; 언어권 병렬 조사는 multilingual 경로. |
| 검증 | `/superpowers:review` + `/gstack /qa` + `/superpowers:verification-before-completion` | 코드 판정은 review, 브라우저/워크플로우 게이트는 qa, 완료 주장 전 evidence 수집은 verification. |
| 디자인 검토 | `/gstack /design-review` | 시각/UX 판정. 코드 판정과 분리. |
| TDD 시작 | `/superpowers:test-driven-development` | 테스트부터 짜는 흐름. 구현 전에 invoke. |
| PRD/worktree 격리 실행 | `/tfx-swarm` | PRD 별 worktree + 다중 모델/기기. 코드 변경 포함 병렬에 필수. |
| 병렬 작업 (read-only) | `/tfx-multi` 또는 `/superpowers:dispatching-parallel-agents` | cwd 공유 가능한 read-only 병렬. 코드 변경 시 swarm 으로 격상. |
| plan 실행 (체크포인트 별도) | `/superpowers:executing-plans` | 다른 세션에서 plan 을 단계별 실행. |
| 머지 직전 정리 | `/superpowers:finishing-a-development-branch` → `/tfx-ship` 또는 `/ship` | merge/PR/cleanup 결정 후 ship. |
| 리뷰 응답 | `/superpowers:receiving-code-review` | 검토 의견에 기술적 rigor 로 응답. blind apply 금지. |
| triflux 릴리즈 | `/tfx-ship` | triflux 본체는 AI trailer 금지 정책이 있는 전용 ship 경로를 쓴다. |
| 일반 PR/배포 | `/ship` | 로컬 `/ship`도 AI attribution footer/trailer 없이 실행되어야 한다. |
| 저장/복원 | `/gstack-context-save` / `/gstack-context-restore` | 진행 상태는 gstack checkpoint 계열이 소유한다. |
| 회고/슬롭 정리 | `/gstack /retro` 또는 `/tfx-prune` | 세션 회고는 gstack, AI 생성 슬롭 제거는 triflux. |

## 행동 유형 → 스킬 매핑

| 의도 | 자연어 신호 | 스킬 |
|------|-----------|------|
| 구현/수정 | 만들어, 고쳐, 구현해, 짜줘, 수정해, 바꿔 | tfx-auto |
| 리뷰 | 봐줘, 리뷰해, 검토해, 괜찮아? | tfx-review |
| 분석 | 분석해, 어떻게 돌아가?, 구조가 뭐야 | tfx-analysis |
| 계획 | 계획, 어떻게 하지, 설계해 | tfx-plan |
| 검색 | 찾아, 어디있어, 파일 찾아 | tfx-find |
| 리서치 (빠른) | 검색해줘, 찾아봐, 공식문서, 이거 뭐야 | tfx-research |
| 리서치 (자율) | 자율 리서치, 검색하고 정리해, research and plan | tfx-autoresearch |
| 테스트 | 테스트, 검증, 돌려봐, QA | tfx-qa |
| 정리 | 정리해, 슬롭 제거, 클린업 | tfx-prune |
| 토론/비교 | 뭐가 나을까, 비교해, A vs B | tfx-auto (`--mode consensus --shape debate`) |
| 합의 | 합의로 분석해, 3자 합의, consensus | tfx-auto (`--mode consensus`) |
| 패널 | panel, 패널, 전문가 의견, expert panel | tfx-auto (`--mode consensus --shape panel`) |

## 깊이 수정자

| 수정자 | 신호 | 효과 |
|--------|------|------|
| 기본 | (없음), 빠르게, 간단히 | Light 스킬 |
| 깊이 | 제대로, 꼼꼼히, 철저히 | `tfx-auto --mode deep` |
| 합의 | 3자, 교차, 다각도 | `tfx-auto --mode consensus` |
| 반복 | 끝까지, 멈추지마, ralph | `--retry ralph` (Phase 3 true state machine, `.claude/rules/tfx-escalation-chain.md` 참조) |
| 승격 | 알아서 승격, 안 되면 더 강한 모델 | `--retry auto-escalate` (Phase 3 CLI 체인 승격) |
| 자율 | 알아서, 자동으로, autopilot | autopilot 모드 |
| 최대 effort | ultracode, 울트라코드 | Claude Code 최대 effort — 기본적으로 멀티에이전트 Workflow 오케스트레이션, 토큰 비용 무관 철저성 우선 (tfx CLI 플래그 아님, Claude Code 하니스 모드) |

## CLI 우선순위 정책 — default = Codex

> 근거(why): [ADR-0004 — 기본 구현 CLI = Codex](../../docs/adr/0004-codex-as-default-cli.md). 이 절이 SSOT(어떻게), ADR은 결정 이력(왜).

triflux 본체 개발의 실측 운영 패턴 (v10.18.0 ~ v10.20.2, 2주, 25+ PR) 이 거의 전부 Codex 단독 또는 Codex worker spawn 으로 진행됐다. 이 운영 fact 를 default policy 로 명시한다.

| 우선순위 | CLI / 모델 | default 적용 lane |
|---------|-----------|-------------------|
| 1차 (default) | **Codex** (gpt-5.5) | 구현, 수정, 디버그, 리뷰, 분석, 테스트 작성, 회귀 가드, 릴리즈 prepare |
| 2차 | **Antigravity** | Codex quota exhaust, 가독성 cross-check, 별도 시각 검토 |
| 한정 (Claude 만) | **Claude** (opus-4-8) | 메타 라우팅 (`/tfx-harness`), planning gate (`/office-hours`, `/autoplan`), gstack-specific surface (`/gstack-context-*`, `/gstack /qa`), 또는 Codex/Antigravity 미가용 |

`tfx-auto`, `tfx-review`, `tfx-analysis`, `tfx-plan`, `tfx-find` 등 multi-CLI wrapper 는 이 정책을 따른다. 명시 플래그 (`--cli claude`, `--cli codex`) 가 있으면 override. `--mode consensus` (3-CLI 합의) 도 default head 는 Codex.

`--retry auto-escalate` 체인 (`.claude/rules/tfx-escalation-chain.md`) 의 1단계가 Codex 인 것도 이 정책과 정합한다 (2단계 claude opus-4-8 은 최종 수단).

## CLI 라우팅

headless-guard 가 `codex exec` / `agy -y -p` 직접 호출을 차단한다. tfx 스킬 경유 필수.

**Layer 1 — Light** (tfx-route.sh → 단일 CLI)

| 경로 | CLI | 용도 |
|------|-----|------|
| `tfx-auto` | 자동 | 통합 진입점 |
| `tfx-auto --cli codex` | Codex | Codex 전용 lane |
| `tfx-auto --cli antigravity` | Antigravity | Antigravity 전용 lane (agy 없으면 legacy gemini fallback) |
| `tfx-auto --mode quick` | Codex→검증 | 단일 파일, 5분 이내 |
| `tfx-auto --retry auto-escalate` | 자동 승격 | 실패→더 강한 모델 |

**Layer 2 — Deep** (headless 3-CLI 합의)

`tfx-auto --mode deep`, `tfx-auto --mode consensus --shape consensus|debate|panel`,
`tfx-auto --parallel swarm --mode consensus --isolation worktree`, `tfx-auto --retry ralph`

호환 alias:
- `tfx-consensus` → `tfx-auto --mode consensus`
- `tfx-debate` → `tfx-auto --mode consensus --shape debate`
- `tfx-panel` → `tfx-auto --mode consensus --shape panel`
- 위 3개 alias 는 deprecated 이며 stderr 경고 + stdout `[DEPRECATED]` + `.omc/state/alias-usage.log` append 규약을 따른다

**Layer 3 — Remote/병렬**

| 스킬 | 용도 |
|------|------|
| tfx-multi | 2+개 태스크 headless 병렬 |
| tfx-swarm | PRD별 worktree + 다중 모델(Codex/Antigravity/Claude) + 다중 기기(로컬+원격) |
| tfx-remote | Claude Code 원격 세션 (SSH, user-state hosts.json setup 필수; tfx-remote-spawn은 legacy alias) |

**Claude 네이티브** (CLI 불필요): tfx-find, tfx-forge, tfx-prune, tfx-index, tfx-setup, tfx-doctor, tfx-hooks, tfx-hub

**Headless UI default** — `tfx-auto`, `tfx multi`, `tfx swarm` 로컬 shard 의 headless 워커는 default 로 `claude agents` 패널에 노출 (`--native-bridge-ui agents`). opt-out: `--no-native-bridge-ui`. interactive (tmux/wt) 경로는 default-off. `tfx swarm` 원격 shard 는 `registerSwarmShard()` 가 warn + skip 만 하고 원격 daemon 등록은 후속 PRD. 상세 행동표는 `CLAUDE.md` 의 `<native-bridge>` 섹션. 근거(why): [ADR-0008 — headless 워커 native-bridge 기본 노출](../../docs/adr/0008-native-bridge-ui-default-on.md).

자원 우선순위: remote-spawn > swarm > multi > Light > 로컬 단독

원격 hosts 설정은 user-state 경로만 참조한다: macOS/Linux `~/.config/triflux/hosts.json`, Windows `%APPDATA%\triflux\hosts.json`. 기존 source-tree `references/hosts.json` 은 라우팅 입력으로 사용하지 않으며 첫 실행 lazy auto-migration 대상이다.

## 충돌 해소

- ralph = persist alias
- "auto" 단독 → tfx-auto. "알아서 해" → tfx-autopilot
- "코드에서 찾아" → tfx-find. "알아봐" → tfx-research
- 복합 의도: "구현하고 리뷰까지" → tfx-auto → cross-review hook
- "합의해서 비교해" 류 요청은 alias 대신 기본적으로 `tfx-auto --mode consensus --shape debate` 로 fold 한다
- `ralph` 표기는 항상 `--retry ralph` mode 를 지칭. persist 스킬도 동일 의미. `--retry auto-escalate` 와 동시 사용 불가 (escalation-chain.md 규약).
- `tfx-auto` 자동 swarm escalate: 2+ 태스크 + 코드 변경 ≥ 1건 시 자동. 명시 `--parallel N` override 가능 (warning).

## Q-Learning 동적 라우팅 (실험적)

- `TRIFLUX_DYNAMIC_ROUTING=true` 또는 `1` 설정 시 Q-Learning 기반 동적 스킬 라우팅 활성화
- `routing-weights.json` + Q-table로 스킬 선택 최적화
- 기본 비활성
