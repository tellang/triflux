---
title: "triflux 아키텍처 (리딩 노트)"
type: reading-note
source: "ARCHITECTURE.md"
polish_grade: B
tags: [reading-note, wiki-harness, architecture]
created: "2026-07-07"
---

# triflux 아키텍처 (리딩 노트)

> 원문 `ARCHITECTURE.md`를 옵시디언 리딩 노트로 재조판. 약어·프로젝트 전용
> 용어·코드 참조를 각주로 빼 본문을 가볍게 했다. 각주에 마우스를 올리면
> 옵시디언이 정의를 미리 보여준다. 표와 코드블록은 원문 그대로 둔다.

이 문서는 triflux가 **지금 어떻게 생겼는지**(빌드된 구조)를 설명한다.
왜 그렇게 결정했는지(근거)는 [`docs/adr/`](adr/README.md)에,
운영 정책의 단일 정본(SSOT)은 [`.claude/rules/`](../.claude/rules/)에 있다.

## 개요

triflux는 Claude Code용 **플러그인 + npm CLI**로, AI 코딩 작업을
**Codex / Claude / Antigravity** 세 CLI에 라우팅하고 오케스트레이션하는
멀티모델 도구다. 사용자는 `/tfx-auto`(Claude Code 스킬 프런트 도어) 또는
`tfx`(셸 CLI) 하나만 알면 되고 그 뒤에서 로컬/원격 팀·스웜[^term-swarm] 실행,
가드[^en-guard], 허브[^en-hub] 메시지 버스가 실제 실행을 관리한다.

## 패키지 레이아웃

triflux는 root와 3개의 published 패키지를 **동시에** 유지한다. root가
source of truth[^abbr-ssot]이고, `packages/*`는 배포용 미러다.

| 레이어 | 역할 | 미러 방식 |
|--------|------|-----------|
| **root** | 개발 SSOT — 모든 런타임 파일의 정본 | — |
| `packages/core` (`@triflux/core`) | 공용 라이브러리 (`hub/`, `hud/`, `mesh/`, `hooks/`, `scripts/` helper) | root와 byte-identical `cp` |
| `packages/remote` (`@triflux/remote`) | 원격 실행용 서브셋 (`hub/`, `cto/`, `scripts/`) | root 서브셋 + `@triflux/core/...` import 경로 변환 |
| `packages/triflux` (`triflux` npm) | 사용자 대상 CLI/런타임 (`bin/`, `config/`, `hooks/`, `hub/`, `hud/`, `mesh/`, `cto/`, `scripts/`, `skills/`, `tui/`, `docs/`) | npm `files` 기준 byte-identical 미러 |

3-layer 미러의 상세 규칙(레이어별 cp/Edit 정책, tests 제외, binary 폭증 방지,
검증 체크리스트)은 [`.claude/rules/tfx-mirror-policy.md`](../.claude/rules/tfx-mirror-policy.md)를
따른다. 이 문서에서는 중복 서술하지 않는다.

## 핵심 컴포넌트

최상위 런타임 디렉토리와 각 역할:

| 디렉토리 | 역할 | 대표 파일 |
|----------|------|-----------|
| `bin/` | CLI 실행 엔트리포인트 | `triflux.mjs`(메인 `tfx`), `tfx-setup.mjs`, `tfx-doctor.mjs`, `tfx-profile.mjs`, `tfx-live.mjs` |
| `hub/` | 로컬 허브 — 라우팅, 서버, MCP 브리지, 계정 브로커 | `router.mjs`, `server.mjs`, `bridge.mjs`, `hub-lifecycle.mjs`, `account-broker.mjs`, `codex-adapter.mjs`, `gemini-adapter.mjs` |
| `hub/team/` | 팀/멀티에이전트 오케스트레이션 | `conductor.mjs`, `headless.mjs`, `dashboard.mjs`, `cto-auto-collect.mjs`, `claude-native-bridge.mjs`, `notify.mjs` |
| `hub/` 하위 | 세분 모듈 | `delegator/`, `diagnostics/`, `lib/`, `middleware/`, `pipeline/`, `quality/`, `routing/`, `workers/` |
| `mesh/` | 에이전트 간 메시지 메시 프로토콜 | `mesh-protocol.mjs`, `mesh-router.mjs`, `mesh-registry.mjs`, `mesh-queue.mjs`, `mesh-heartbeat.mjs`, `mesh-budget.mjs` |
| `hooks/` | Claude Code 세션 훅 + 가드 | `session-start-fast.mjs`, `session-start-lake.mjs`, `session-end-cleanup.mjs`, `safety-guard.mjs`, `hook-orchestrator.mjs`, `keyword-rules.json` |
| `hud/` | 상태 표시(HUD) / 모니터 | `context-monitor.mjs`, `mission-board.mjs`, `renderers.mjs`, `providers/` |
| `cto/` | CTO 콘솔 — 멀티세션 수집·요약·위생(hygiene) | `collect.mjs`, `brief.mjs`, `dashboard.mjs`, `status.mjs`, `hygiene.mjs` |
| `scripts/` | 라우팅 스크립트 + 릴리즈 게이트 | `tfx-route.sh`(라우팅 엔진), `scripts/release/`(릴리즈 자동화), `scripts/lib/`(공용 helper) |
| `skills/` | Claude Code 스킬 정의 (`SKILL.md`) | `tfx-auto`, `tfx-remote`, `tfx-doctor` 등 |

## 실행 경로

넓은 흐름은 다음과 같다.

```
사용자 (Claude Code 프롬프트 / 셸)
  → /tfx-auto (스킬 프런트 도어) 또는 tfx CLI
  → tfx-route.sh + 가드 (intent → mode/parallel/retry/risk-tier/CLI lane 정규화)
  → CLI lane 실행: Codex (기본) / Antigravity / Claude
  → headless / swarm 워커 (로컬 병렬 또는 worktree 격리)
  → Hub 가 team 메시지 · 리스 · retry · handoff · 상태를 기록
```

- **기본 CLI lane은 Codex다.** Antigravity는 cross-check[^term-cross-check] /
  quota 대체, Claude opus는 메타 라우팅[^term-meta-routing]과 최종 수단
  lane이다.
- 라우팅 판정(자연어 → 스킬, Layer 1~3, 충돌 해소)은
  [`.claude/rules/tfx-routing.md`](../.claude/rules/tfx-routing.md),
  실행 엔진 매핑(auto가 multi/swarm 중 무엇을 dispatch하는지, 격리 기준)은
  [`.claude/rules/tfx-execution-skill-map.md`](../.claude/rules/tfx-execution-skill-map.md)를 따른다.

### Hub

Hub는 팀·원격 세션·MCP[^abbr-mcp] 도구·상태 표면을 잇는 로컬 메시지 버스다.
localhost에 바인딩하며 `tfx hub ensure` / `tfx hub status` / `tfx hub stop`으로
관리한다.

### 가드(Guards)

직접 `codex exec`, 관리되지 않은 `agy`, 폐기된 `gemini` 경로는
headless-guard[^code-headless-guard]가 차단하고 psmux[^term-psmux]/Windows
Terminal 흐름은 safety-guard[^code-safety-guard]가 관리 API로만 우회하도록
강제한다. CLI 호출은 tfx-route.sh[^code-tfx-route] / Hub 워커 / `tfx` CLI를
경유해야 한다.

## 스택 공존

triflux는 gstack·superpowers와 **레이어 분리** 관계로 공존한다.

| 레이어 | 시스템 | 역할 |
|--------|--------|------|
| 무대(Stage) | gstack | 워크플로우 게이트 (`/ship`, `/qa`, `/checkpoint`) |
| 엔진(Engine) | superpowers | 리뷰 프리미티브 (diff → verdict) |
| 백엔드(Backend) | **triflux** | 오케스트레이션 (병렬 워커·모델 선택·실행) |

의존은 **단방향**이다: `gstack → triflux`, `superpowers → triflux`는 허용,
`triflux → gstack/superpowers`는 금지. 상세 책임 매트릭스와 충돌 해소는
[`.claude/rules/tfx-stack-coexistence.md`](../.claude/rules/tfx-stack-coexistence.md)를 따른다.

---

정책의 단일 정본은 [`.claude/rules/`](../.claude/rules/), 아키텍처 결정의 근거는 [`docs/adr/`](adr/README.md)에 있다.

<!-- wiki-harness:start -->
[^term-swarm]: 스웜 — PRD 단위로 worktree를 격리하고 여러 모델·기기에 워커를 병렬 배정해 코드 변경을 동시에 진행시키는 triflux 실행 모드(`tfx-swarm`). 완료 후 자동 병합까지 포함한다.
[^en-guard]: guard.
[^en-hub]: Hub.
[^abbr-ssot]: SSOT — Single Source of Truth(단일 진실 공급원). 같은 정보가 여러 곳에 있을 때 "여기가 정본"이라고 가리키는 한 곳.
[^term-cross-check]: cross-check — Codex가 만든 결과를 Antigravity가 다시 읽고 가독성·논리를 검증하는 2차 확인. 실행 권한을 넘기는 게 아니라 검토만 한다.
[^term-meta-routing]: 메타 라우팅 — Claude가 직접 코드를 실행하지 않고 "이 작업을 어떤 스킬·CLI로 보낼지"만 판정하는 역할. `/tfx-harness`가 대표적이다.
[^abbr-mcp]: MCP — Model Context Protocol. 에이전트가 외부 도구(hub 포함)를 표준화된 방식으로 호출하게 해주는 프로토콜.
[^code-headless-guard]: `scripts/headless-guard.mjs:187` · `async function main()` · PreToolUse 훅 — primary multiplexer가 있으면 Bash(tfx-route.sh) 개별 호출을 headless 명령으로 자동 변환하고, `codex exec`/`agy`/`gemini` 직접 래핑을 차단한다. [▸ 코드 열기](vscode://file/Users/tellang/Projects/tools/triflux/scripts/headless-guard.mjs:187)
[^term-psmux]: psmux — Windows 전용 tmux 유사 터미널 멀티플렉서. triflux가 Windows Terminal 패인·세션을 관리 API 경유로만 조작하도록 강제할 때 대상이 되는 도구다.
[^code-safety-guard]: `hooks/safety-guard.mjs:312` · `function main()` · PreToolUse:Bash 훅 — 위험한 Bash 명령을 사전 차단(exit 2)하거나 경고(additionalContext)한다. [▸ 코드 열기](vscode://file/Users/tellang/Projects/tools/triflux/hooks/safety-guard.mjs:312)
[^code-tfx-route]: `scripts/tfx-route.sh:290` · `case "${1:-}" in` · CLI 라우팅 엔진 진입점 — agent_type/prompt/mcp_profile/timeout/context_file 인자를 받아 Codex/Antigravity/Claude lane으로 dispatch한다. [▸ 코드 열기](vscode://file/Users/tellang/Projects/tools/triflux/scripts/tfx-route.sh:290)
<!-- wiki-harness:end -->
