# triflux 아키텍처

이 문서는 triflux가 **지금 어떻게 생겼는지**(빌드된 구조)를 설명한다.
왜 그렇게 결정했는지(근거)는 [`docs/adr/`](docs/adr/README.md)에,
운영 정책의 단일 정본(SSOT)은 [`.claude/rules/`](.claude/rules/)에 있다.

## 개요

triflux는 Claude Code용 **플러그인 + npm CLI**로, AI 코딩 작업을
**Codex / Claude / Antigravity** 세 CLI에 라우팅하고 오케스트레이션하는
멀티모델 도구다. 사용자는 `/tfx-auto` 스킬 또는 `tfx` CLI로 작업을 요청한다. 로컬·원격 팀 실행,
가드(guard)가 실제 실행을 관리한다.

## 패키지 레이아웃

triflux는 root와 3개의 published 패키지를 **동시에** 유지한다. root가
source of truth(SSOT)이고, `packages/*`는 배포용 미러다.

| 레이어 | 역할 | 미러 방식 |
|--------|------|-----------|
| **root** | 개발 SSOT: 모든 런타임 파일의 정본 | 해당 없음 |
| `packages/core` (`@triflux/core`) | 공용 라이브러리 (`hub/`, `hud/`, `hooks/`, `scripts/` helper) | root와 byte-identical `cp` |
| `packages/remote` (`@triflux/remote`) | 원격 실행용 서브셋 (`hub/`, `scripts/`) | root 서브셋 + `@triflux/core/...` import 경로 변환 |
| `packages/triflux` (`triflux` npm) | 사용자 대상 CLI/런타임 (`bin/`, `config/`, `hooks/`, `hub/`, `hud/`, `scripts/`, `skills/`, `docs/`) | npm `files` 기준 byte-identical 미러 |

3-layer 미러의 상세 규칙(레이어별 cp/Edit 정책, tests 제외, binary 폭증 방지,
검증 체크리스트)은 [`.claude/rules/tfx-mirror-policy.md`](.claude/rules/tfx-mirror-policy.md)를
따른다. 이 문서에서는 중복 서술하지 않는다.

## 핵심 컴포넌트

주요 디렉터리와 역할:

| 디렉토리 | 역할 | 대표 파일 |
|----------|------|-----------|
| `bin/` | CLI 실행 엔트리포인트 | `triflux.mjs`(메인 `tfx`), `tfx-setup.mjs`, `tfx-doctor.mjs`, `tfx-live.mjs` |
| `hub/` | 실행 엔진 공용부: bridge CLI, CLI 어댑터 | `bridge.mjs`, `codex-adapter.mjs`, `cli-adapter-base.mjs` |
| `hub/team/` | 팀/멀티에이전트 오케스트레이션 | `headless.mjs`, `claude-daemon-control.mjs`, `notify.mjs` |
| `hub/` 하위 | 세분 모듈 | `diagnostics/`, `lib/`, `workers/` |
| `hooks/` | Codex 세션 기록과 Antigravity 빈 훅 | `codex-session-hook.mjs`, `agy-session-hook.mjs` |
| `hud/` | 상태 표시(HUD) / 모니터 | `context-monitor.mjs`, `renderers.mjs`, `providers/` |
| `scripts/` | 라우팅 스크립트 + 릴리즈 게이트 | `tfx-route.sh`(라우팅 엔진), `scripts/release/`(릴리즈 자동화), `scripts/lib/`(공용 helper) |
| `skills/` | Claude Code 스킬 정의 (`SKILL.md`) | `tfx-auto`, `tfx-remote`, `tfx-doctor` 등 |
| `config/` | MCP 서버 설정 | `mcp-registry.json` |
| `adapters/` | CLI 어댑터 지원 파일 | `codex/` |
| `experiments/` | 실험 자료 | `native-bridge-feasibility/` |
| `references/` | 분석 참고 자료 | `codex-plugin-cc-analysis.md`, `codex-plugin-cc-code-patterns.md` |

## 실행 경로

넓은 흐름은 다음과 같다.

```
사용자 (Claude Code 프롬프트 / 셸)
  → /tfx-auto (스킬 프런트 도어) 또는 tfx CLI
  → tfx-route.sh + 가드 (intent → mode/parallel/retry/CLI lane 정규화)
  → CLI lane 실행: Codex (기본) / Antigravity / Claude
  → headless 워커 (로컬 병렬)
  → retry · 결과 백업 · 상태는 로컬 파일로 기록
```

- **기본 CLI lane은 Codex다.** Antigravity는 cross-check / quota 대체,
  Claude는 메타 라우팅과 최종 수단 lane이다.
- 라우팅 판정(자연어 → 스킬, Layer 1~3, 충돌 해소)은
  [`.claude/rules/tfx-routing.md`](.claude/rules/tfx-routing.md),
  실행 경로와 코드 변경 병렬 작업의 격리 기준은
  [`.claude/rules/tfx-execution-skill-map.md`](.claude/rules/tfx-execution-skill-map.md)를 따른다.

### 실행 경계

triflux는 위험한 실행을 관리된 경로 뒤에 둔다. 직접 `codex exec`,
관리되지 않은 `agy`, 폐기된 `gemini` 경로는 라우팅 규약으로 금지한다(자동 차단
훅 headless-guard 는 2026-09-07 에 제거). psmux/Windows Terminal 흐름은
관리 API를 사용한다.
CLI 호출은 `tfx-route.sh` / headless 워커 / `tfx` CLI를 경유해야 한다.

### 세션 전송과 결과 회수

- **Codex 세션 메시지**: `tfx-live ask --cli codex`는 `codex queue`로 메시지를 쌓는다.
  queue를 못 쓰거나 슬래시 명령이면 tmux 입력으로 폴백하고 이유를 남긴다
  ([ADR-0027](docs/adr/0027-codex-message-queue-default.md)).
- **리드 흐름**: `/tfx-lead`를 맡은 세션이 `tfx-live`로 Claude, Codex 세션을 띄우고
  지시서, 교차 리뷰, 머지, 종료까지 소유한다
  ([ADR-0029](docs/adr/0029-lead-session-operating-model.md), [ADR-0032](docs/adr/0032-lead-role-skill-tfx-lead.md)).
- **headless 결과 색인**: 실행마다 `$TMPDIR/tfx-headless/<세션>.results.json` 하나에 워커별 상태,
  exit 코드, 출력 경로를 기록한다. 결과를 읽는 쪽은 화면 문자열 대신 이 파일을 읽는다
  ([ADR-0034](docs/adr/0034-headless-session-results-index.md)).
- **`claude agents` 행**: headless 워커는 tmux 방에서 돌고, 행은 그 방에 붙는 attach client다.
  행에서 Enter를 누르면 워커 tmux pane이 열린다
  ([ADR-0026](docs/adr/0026-agents-row-tmux-attach.md)).

## 스택 공존

triflux는 gstack·superpowers와 **레이어 분리** 관계로 공존한다.

| 레이어 | 시스템 | 역할 |
|--------|--------|------|
| 워크플로우 | gstack | 워크플로우 게이트 (`/gstack-ship`, `/gstack-qa`, `/gstack-context-save`) |
| 검토 | superpowers | 리뷰 프리미티브 (diff → verdict) |
| 실행 | **triflux** | 오케스트레이션 (병렬 워커·모델 선택·실행) |

의존은 **단방향**이다: `gstack → triflux`, `superpowers → triflux`는 허용,
`triflux → gstack/superpowers`는 금지. 상세 책임 매트릭스와 충돌 해소는
[`.claude/rules/tfx-stack-coexistence.md`](.claude/rules/tfx-stack-coexistence.md)를 따른다.
