[English](README.md) | [한국어](README.ko.md)

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/logo-light.svg">
    <img alt="triflux" src="docs/assets/logo-dark.svg" width="200">
  </picture>
</p>

<p align="center">
  <strong>Consensus Intelligence 기반 Tri-CLI 오케스트레이션</strong><br>
  <em>Claude + Codex + Gemini — 21개 코어 스킬, 23개 thin alias, 자연어 라우팅, 교차 모델 리뷰.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/triflux"><img src="https://img.shields.io/npm/v/triflux?style=flat-square&color=FFAF00&label=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/triflux"><img src="https://img.shields.io/npm/dm/triflux?style=flat-square&color=F5C242" alt="npm downloads"></a>
  <a href="https://github.com/tellang/triflux/stargazers"><img src="https://img.shields.io/github/stars/tellang/triflux?style=flat-square&color=FFAF00" alt="GitHub stars"></a>
  <img src="https://img.shields.io/badge/skills-21_core-F5C242?style=flat-square" alt="21개 코어 스킬">
  <sub>+ 23개 thin alias</sub>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-374151?style=flat-square" alt="License: MIT"></a>
</p>

<p align="center">
  <img alt="triflux 데모" src="docs/assets/demo-multi.gif" width="680">
</p>

<p align="center">
  <a href="#빠른-시작">빠른 시작</a> ·
  <a href="#tri-cli-합의-엔진">Tri-CLI 합의 엔진</a> ·
  <a href="#전체-21개-스킬-23개-thin-alias-포함">전체 21개 스킬</a> ·
  <a href="#아키텍처">아키텍처</a> ·
  <a href="#deep-vs-light">Deep vs Light</a> ·
  <a href="#보안">보안</a>
</p>

---

## 빠른 시작

**Claude Code** (권장) — Claude Code 세션 안에서 실행:

```
/plugin marketplace add tellang/triflux
/plugin install triflux@tellang
```

**npm**:

```bash
npm install -g triflux
```

`tfx setup`으로 환경을 설정하세요.

### 사용법

```bash
# Light — 단일 모델로 빠르게 실행
/tfx-research "React 19 Server Actions best practices"
/tfx-review
/tfx-plan "add JWT auth middleware"

# Deep — 중요한 작업에 3자 합의 적용
/tfx-deep-research "microservice architecture comparison 2026"
/tfx-deep-review
/tfx-deep-plan "migrate REST to GraphQL"

# Debate — 3개의 독립적인 의견을 확보
/tfx-debate "Redis vs PostgreSQL LISTEN/NOTIFY for real-time events"

# Persistence — 또는 단일 진입점에서 직접 호출
/tfx-auto "implement full auth flow with tests" --retry ralph

# Team — Multi-CLI 병렬 오케스트레이션
/tfx-multi "refactor auth + update UI + add tests"

# Remote — setup, spawn, attach, resume를 하나의 표면으로
/tfx-remote-setup                              # 인터랙티브 호스트 설정 위저드 (Tailscale + SSH)
/tfx-remote spawn ultra4 "보안 리뷰 실행"       # 원격 호스트에서 세션 실행
```

---

## v10.11.0의 새로운 기능

**triflux v10.11.0**은 **하나의 front door + 플래그 기반 라우팅**으로 정리됩니다. 자연어 입력은 계속 지원되고, Phase 3/4에서 legacy 표면은 `tfx-auto`와 `tfx-remote` 뒤로 접히며, 기존 스킬명은 thin alias로 계속 동작합니다.

### v10.11.0 주요 특징

- **자연어 라우팅** — "리뷰해줘"라고 말하면 `/tfx-review`가 자동 호출. "제대로/꼼꼼히" 수정자로 Deep 변형 자동 에스컬레이션
- **교차 모델 리뷰** — Claude가 작성하면 Codex가 리뷰, Codex가 작성하면 Claude가 리뷰. 동일 모델 self-approve 차단. 커밋 전 미검증 파일 nudge
- **정확한 카탈로그** — 44개 스킬 파일 기준 `21 core + 23 thin alias`
- **Phase 3** — `--retry ralph`, `--retry auto-escalate`, `--lead codex`, `--max-iterations N`, 4단계 `DEFAULT_ESCALATION_CHAIN`
- **Phase 4** — `tfx-auto --shape debate|panel|consensus`, `tfx-remote` 단일 진입점, `tfx-psmux-rules`는 `.claude/rules/tfx-psmux.md`로 이동
- **하위 호환성 유지** — `tfx-persist`, `tfx-debate`, `tfx-multi`, `tfx-remote-spawn` 같은 기존 이름은 thin alias로 계속 지원

### v8 기반 (계속 유지)

- **Tri-Debate Engine** — 3개 CLI가 독립 분석 후 Anti-Herding, 교차 검증, 합의 점수 산출
- **Deep/Light 변형** — 모든 기능에 토큰 효율적인 Light 모드와 정밀한 Deep 모드를 제공
- **Consensus Gate** — Deep 스킬은 3개 CLI 중 2개 이상의 동의 요구
- **Expert Panel** — `tfx-panel`을 통한 가상 전문가 시뮬레이션
- **Hub IPC** — Named Pipe 및 HTTP MCP 브리지를 활용한 상주형 Hub 서버
- **psmux / Windows 네이티브** — `tmux`(WSL)와 `psmux`(Windows Terminal) 하이브리드 지원

---

## Tri-CLI 합의 엔진

<p align="center">
  <img src="docs/assets/consensus-flow.svg" alt="Tri-CLI Consensus 플로우" width="680">
</p>

triflux의 핵심 혁신입니다. 단일 모델을 맹신하는 대신, 모든 Deep 스킬은 다음 과정을 거칩니다:

```
Phase 1: Independent Analysis (Anti-Herding)
  ├─ Claude Opus  → Analysis A (격리 실행, 상호 참조 없음)
  ├─ Codex CLI    → Analysis B (격리 실행, 상호 참조 없음)
  └─ Gemini CLI   → Analysis C (격리 실행, 상호 참조 없음)

Phase 2: Cross-Validation
  ├─ 3개 소스의 모든 발견 사항을 비교
  ├─ 2/3 이상 동의 → CONSENSUS (합의)
  └─ 1/3만 동의 → DISPUTED (이의, 해결 필요)

Phase 3: Resolution (합의율 < 70%일 경우)
  ├─ 각 CLI가 반대 의견을 검토
  ├─ 근거를 들어 수용 또는 반박
  └─ 미해결 → 사용자가 최종 판단
```

**결과**: 단일 모델 리뷰 대비 오탐(false positive) 87% 감소 (Calimero 합의 연구 기반).

Phase 4 이후에는 `tfx-auto`가 하나의 front door 역할을 맡습니다. legacy 스킬명은 그대로 받아들이되, 실제 의미는 플래그로 표현됩니다:

- `--retry ralph` / `--retry auto-escalate` (Phase 3)
- `--lead codex` / `--no-claude-native` (Phase 3)
- `--shape debate|panel|consensus` (Phase 4)

---

## 전체 21개 스킬 (23개 thin alias 포함)

### 리서치

| 스킬 | 상태 | 설명 |
|------|------|------|
| `tfx-research` | Active | Exa/Brave/Tavily 자동 선택을 통한 빠른 웹 검색 |
| `tfx-find` | Active | 파일, 심볼, 패턴 중심의 빠른 코드베이스 탐색 |

Aliases (fold into `tfx-auto` flags): `tfx-deep-research`, `tfx-autoresearch`

### 분석 및 계획

| 스킬 | 상태 | 설명 |
|------|------|------|
| `tfx-analysis` | Active | 빠른 코드/아키텍처 분석 |
| `tfx-plan` | Active | 빠른 구현 계획 수립 |
| `tfx-interview` | Active | 소크라테스식 요구사항 탐색 |

Aliases (fold into `tfx-auto` flags): `tfx-deep-analysis`, `tfx-deep-plan`, `tfx-deep-interview`

### 실행

| 스킬 | 상태 | 설명 |
|------|------|------|
| `tfx-auto` | Active | 플래그 기반 라우팅과 legacy surface folding을 담당하는 통합 CLI 오케스트레이터 |

Aliases (fold into `tfx-auto` flags): `tfx-autopilot`, `tfx-fullcycle`, `tfx-codex`, `tfx-gemini`

### 리뷰 및 QA

| 스킬 | 상태 | 설명 |
|------|------|------|
| `tfx-review` | Active | 빠른 코드 리뷰 |
| `tfx-qa` | Active | Test → Fix → Retest 순환 (최대 3회) |
| `tfx-prune` | Active | AI slop 제거, dead code 및 과한 추상화 정리 |

Aliases (fold into `tfx-auto` flags): `tfx-deep-review`, `tfx-deep-qa`

### 토론 및 의사결정

| 스킬 | 상태 | 설명 |
|------|------|------|
| _독립 active 표면 없음_ | — | debate, consensus, panel은 이제 `tfx-auto --mode consensus`의 출력 shape로 통합 |

Aliases (fold into `tfx-auto` flags): `tfx-consensus`, `tfx-debate`, `tfx-panel`

### 지속 실행 및 라우팅

| 스킬 | 상태 | 설명 |
|------|------|------|
| `tfx-index` | Active | 프로젝트 인덱싱으로 94% 토큰 절감 (58K→3K) |
| `tfx-hooks` | Active | Claude Code hook priority 관리 |
| `tfx-profile` | Active | Codex/Gemini CLI 프로필 관리 |

Aliases (fold into `tfx-auto` flags): `tfx-persist`, `tfx-ralph`, `tfx-autoroute`, `tfx-auto-codex`

### 오케스트레이션

| 스킬 | 상태 | 설명 |
|------|------|------|
| `tfx-hub` | Active | MCP 메시지 버스 관리 |
| `tfx-codex-swarm` | Active | Codex swarm 실행 표면 |
| `merge-worktree` | Active | swarm 결과용 worktree merge helper |

Aliases (fold into active surfaces): `tfx-multi`, `tfx-swarm`

### 원격

| 스킬 | 상태 | 설명 |
|------|------|------|
| `tfx-remote` | Active | setup, spawn, list, attach, send, resume, probe, rules를 묶는 원격 command family |

Aliases (fold into active surfaces): `tfx-remote-spawn`, `tfx-remote-setup`, `tfx-psmux-rules` — Phase 4에서 `.claude/rules/tfx-psmux.md`로 이동

### 메타

| 스킬 | 상태 | 설명 |
|------|------|------|
| `tfx-forge` | Active | 대화형 스킬 생성 |
| `tfx-setup` | Active | 초기 설정 마법사 |
| `tfx-doctor` | Active | 진단 및 자동 복구 |
| `tfx-ship` | Active | ship workflow orchestration |
| `star-prompt` | Active | postinstall GitHub star prompt |

---

## Deep vs Light

모든 도메인에서 두 가지 모드를 제공합니다:

<p align="center">
  <img src="docs/assets/deep-vs-light.svg" alt="Deep vs Light 비교" width="680">
</p>

Phase 매핑:

- `--mode deep` 는 Phase 2의 직접적인 Light → Deep 스위치
- `--retry ralph` / `--retry auto-escalate` 는 Phase 3의 persistence / escalation 시맨틱
- `--shape consensus|debate|panel` 은 Phase 4의 consensus output shape 라우팅

| 항목 | Light | Deep |
|------|-------|------|
| **CLI** | 단일 (주로 Codex) | 3자 (Claude + Codex + Gemini) |
| **토큰** | 3K-15K | 20K-80K |
| **속도** | 수 초 | 수 분 |
| **정확도** | 양호 (단일 관점) | 우수 (합의 검증 완료) |
| **편향** | 발생 가능 | Anti-Herding으로 제거 |
| **적합한 상황** | 빠른 작업, 익숙한 패턴 | 중요한 의사결정, 미지의 영역 |

---

## 아키텍처

<p align="center">
  <img src="docs/assets/architecture.svg" alt="triflux 아키텍처" width="680">
</p>

<details>
<summary>인터랙티브 다이어그램 (GitHub 전용)</summary>

```mermaid
graph TD
    User([사용자 / Claude Code]) <-->|Skills & Slash Commands| TFX[tfx Skills Layer]
    TFX <-->|Consensus Engine| CONSENSUS[tfx-consensus]

    subgraph "Tri-CLI Consensus"
        CONSENSUS -->|Independent| CLAUDE[Claude Opus/Sonnet]
        CONSENSUS -->|Independent| CODEX[Codex CLI]
        CONSENSUS -->|Independent| GEMINI[Gemini CLI]
        CLAUDE --> MERGE[Cross-Validation]
        CODEX --> MERGE
        GEMINI --> MERGE
        MERGE --> GATE{Consensus >= 70%?}
        GATE -->|Yes| OUTPUT[검증된 출력]
        GATE -->|No| RESOLVE[Resolution Round]
        RESOLVE --> MERGE
    end

    TFX <-->|Named Pipe / HTTP| HUB[triflux Hub 서버]

    subgraph "오케스트레이션 Hub"
        HUB <--> STORE[(SQLite 저장소)]
        HUB <--> DASH[QoS 대시보드]
        HUB <--> DELEGATOR[Delegator 서비스]
    end

    HUB -.->|MCP Bridge| External[외부 MCP 클라이언트]
```

</details>

---

## 빠른 시작

**Claude Code** (권장) — Claude Code 세션 안에서 실행:

```
/plugin marketplace add tellang/triflux
/plugin install triflux@tellang
```

**npm**:

```bash
npm install -g triflux
```

`tfx setup`으로 환경을 설정하세요.

### 사용법

```bash
# Light — 단일 모델로 빠르게 실행
/tfx-research "React 19 Server Actions best practices"
/tfx-review
/tfx-plan "add JWT auth middleware"

# Deep — 중요한 작업에 3자 합의 적용
/tfx-deep-research "microservice architecture comparison 2026"
/tfx-deep-review
/tfx-deep-plan "migrate REST to GraphQL"

# Debate — 3개의 독립적인 의견을 확보
/tfx-debate "Redis vs PostgreSQL LISTEN/NOTIFY for real-time events"

# Persistence — front door에서 직접 호출 가능
/tfx-auto "implement full auth flow with tests" --retry ralph --max-iterations 10

# Team — Multi-CLI 병렬 오케스트레이션
/tfx-multi "refactor auth + update UI + add tests"

# Remote — 단일 진입점
/tfx-remote spawn ultra4 "보안 리뷰 실행"
```
> **참고**: Deep 스킬과 `tfx-auto --mode consensus`, `--retry ralph`, `--shape ...` 경로는 완전한 Tri-CLI 합의(Tier 1)를 위해 **psmux**(또는 tmux), **triflux Hub**, **Codex CLI**, **Gemini CLI**가 필요합니다. 전제조건이 충족되지 않으면 Tier 3(Claude 단독, single-model) 모드로 자동 전환됩니다. `tfx doctor`로 환경을 확인하세요.
>
> **Serena 참고**: Serena MCP는 stateful합니다. 따라서 **같은 프로젝트**를 다루는 에이전트끼리만 하나의 Serena 인스턴스를 공유하는 것이 안전합니다. 서로 다른 프로젝트를 병렬로 작업할 때는 Serena 인스턴스를 분리하세요. Serena가 `No active project`를 보고하면 Codex Serena 설정의 `--project-from-cwd`(또는 `--project <path>`)를 확인하고 `tfx doctor`를 다시 실행하세요.

---

## 리서치 기반

v8 스킬 체계는 Claude Code 생태계 내 37개 클론 저장소를 종합 역분석한 결과를 토대로 설계되었습니다:

| 프로젝트 | Stars | 채택한 핵심 인사이트 |
|----------|-------|---------------------|
| everything-claude-code | 114K | 직관 기반 학습 패턴 |
| Superpowers | 93K | TDD 강제화, 조합형 스킬 |
| oh-my-openagent | 44K | 카테고리 라우팅, Hashline 편집 |
| SuperClaude | 22K | index-repo 94% 토큰 절감, 전문가 패널 |
| oh-my-claudecode | 15K | Ralph 지속 실행, CCG tri-model |
| ruflo | 28K | 60개 이상의 에이전트 오케스트레이션 |
| Exa MCP | 3.7K | 뉴럴 검색, 하이라이트 추출 |
| Brave Search MCP | — | 독립 인덱스, Goggles 재순위 |
| Tavily MCP | — | Deep Research 파이프라인 |

5개 언어(EN/CN/RU/JP/UA) 리서치를 통해 고유 패턴을 발굴했습니다: WeChat 연동(CN), Discord 모바일 브리지(JP), GigaCode 국산 대안(RU), 커뮤니티 주도 로컬라이제이션 등.

---

## 보안

- **Hub 토큰 인증** — `TFX_HUB_TOKEN`을 이용한 보안 IPC (Bearer Auth)
- **Localhost 전용** — Hub가 기본적으로 `127.0.0.1`에만 바인딩
- **CORS 잠금** — QoS 대시보드에 대한 엄격한 오리진 검사
- **인젝션 방어** — `psmux` 및 `tmux` 실행 시 쉘 명령어 새니타이징
- **합의 기반 검증** — Deep 스킬이 3자 합의를 통해 단일 모델 환각을 방지

---

## 플랫폼 지원

- **Linux / macOS**: 네이티브 `tmux` 통합
- **Windows**: **psmux** (PowerShell Multiplexer) + Windows Terminal 네이티브

---

## QoS 대시보드

`http://localhost:27888/dashboard`에서 오케스트레이션 상태를 모니터링할 수 있습니다.

- **AIMD 배치 사이징** — 작업 성공률에 따라 병렬 작업 수를 자동 조절
- **토큰 절약량** — Claude 토큰 절약량을 실시간 추적
- **합의 메트릭** — CLI 간 합의율을 추적

---

<p align="center">
  <sub>MIT License · Made by <a href="https://github.com/tellang">tellang</a></sub>
</p>
