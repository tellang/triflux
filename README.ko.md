[English](README.md) | [한국어](README.ko.md)

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/logo-light.svg">
    <img alt="triflux" src="docs/assets/logo-dark.svg" width="200">
  </picture>
</p>

<p align="center">
  <strong>Claude Code를 위한 멀티모델 오케스트레이션 허브</strong><br>
  <em>Claude 토큰 절약의 핵심. 고성능 Hub IPC를 통해 모든 작업을 Codex와 Gemini로 라우팅하세요.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/triflux"><img src="https://img.shields.io/npm/v/triflux?style=flat-square&color=FFAF00&label=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/triflux"><img src="https://img.shields.io/npm/dm/triflux?style=flat-square&color=F5C242" alt="npm downloads"></a>
  <a href="https://github.com/tellang/triflux/stargazers"><img src="https://img.shields.io/github/stars/tellang/triflux?style=flat-square&color=FFAF00" alt="GitHub stars"></a>
  <a href="https://github.com/tellang/triflux/actions"><img src="https://img.shields.io/github/actions/workflow/status/tellang/triflux/ci.yml?style=flat-square&label=CI" alt="CI"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-374151?style=flat-square" alt="License: MIT"></a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/demo-dark.gif">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/demo-light.gif">
    <img alt="triflux 데모" src="docs/assets/demo-dark.gif" width="680">
  </picture>
</p>

<p align="center">
  <a href="#빠른-시작">빠른 시작</a> ·
  <a href="#아키텍처">아키텍처</a> ·
  <a href="#파이프라인-thorough-모드">파이프라인</a> ·
  <a href="#위임delegator-mcp">위임 MCP</a> ·
  <a href="#에이전트-타입-21">에이전트 타입</a> ·
  <a href="#보안">보안</a>
</p>

---

## v5의 새로운 기능

**triflux v5**는 v4의 오케스트레이션 기반을 유지하면서 파이프라인을 더 똑똑하고, 더 phase-aware하게, 더 협업적으로 발전시켰습니다. 멀티태스크 오케스트레이션에서는 이제 `--thorough`가 기본 경로이므로, 계획, 승인, 검증, 복구가 기본값으로 활성화됩니다.

### 주요 특징

- **`--thorough` 기본화** — 멀티태스크 오케스트레이션은 기본적으로 `plan` → `prd` → `exec` → `verify` → `fix` 전체 파이프라인을 실행합니다. 경량 경로가 필요할 때만 `--quick`을 명시합니다.
- **Opus × Codex Scout 계획 협업** — `plan` 단계에서 Opus가 설계를 주도하고 Codex scout 워커가 코드베이스를 병렬 탐색한 뒤 최종 계획에 반영합니다.
- **DAG 기반 라우팅 휴리스틱** — `dag_width`와 `complexity`를 함께 반영해 `quick_single`, `thorough_single`, `quick_team`, `thorough_team`, `batch_single` 전략 중 하나를 선택합니다.
- **피드백 루프 복원** — 워커는 여러 차례 재실행될 수 있고, 최종 완료 전 리드의 피드백을 다시 받아 반영할 수 있습니다.
- **HITL 승인 게이트** — `pipeline_advance_gated`를 통해 단계 전이 전에 사람 승인 체크포인트를 삽입합니다.
- **Phase-aware MCP 필터링** — 파이프라인 단계에 따라 MCP 노출을 조정해 `plan`, `prd`, `verify`는 읽기 중심으로 유지하고 `exec`는 더 넓은 도구 세트를 사용합니다.
- **Plan 파일 영속화** — 최종 계획 Markdown을 `.tfx/plans/{team}-plan.md`에 저장하고 파이프라인 artifact로 추적합니다.
- **Hub IPC 아키텍처** — Named Pipe 및 HTTP MCP 브리지를 활용한 초고속 상주형 허브 서버.
- **위임(Delegator) MCP** — 에이전트와 유연하게 상호작용할 수 있는 전용 MCP 도구(`delegate`, `reply`, `status`).
- **psmux / Windows 네이티브** — `tmux` (WSL)와 `psmux` (Windows Terminal 네이티브)를 모두 지원하는 하이브리드 세션 관리.
- **QoS 대시보드** — AIMD 기반 동적 배치 사이징 및 실시간 상태 모니터링.
- **21종 이상의 전문 에이전트** — `scientist-deep`부터 `spark_fast`까지, 작업에 최적화된 에이전트 라인업.

---

## 아키텍처

triflux는 **Hub-and-Spoke** 아키텍처를 사용합니다. 상주형 허브가 상태, 인증, 작업 라우팅을 총괄하며 고성능 네임드 파이프를 통해 통신합니다.

```mermaid
graph TD
    User([사용자 / Claude Code]) <-->|슬래시 명령어| TFX_CLI[tfx CLI]
    TFX_CLI <-->|Named Pipe / HTTP| HUB[triflux Hub 서버]
    
    subgraph "오케스트레이션 허브"
        HUB <--> STORE[(SQLite 저장소)]
        HUB <--> DASH[QoS 대시보드]
        HUB <--> DELEGATOR[위임 서비스]
    end
    
    DELEGATOR <-->|Spawn| CODEX[Codex CLI]
    DELEGATOR <-->|Spawn| GEMINI[Gemini CLI]
    DELEGATOR <-->|Native| CLAUDE[Claude Code]
    
    HUB -.->|MCP 브리지| External[외부 MCP 클라이언트]
```

---

## 빠른 시작

### 1. 설치

```bash
npm install -g triflux
```

### 2. 설정 (필수)

스크립트를 동기화하고 Claude Code에 스킬을 등록하며 HUD를 설정합니다.

```bash
tfx setup
```

### 3. 사용 방법

```bash
# 자동 모드 — 허브를 통한 thorough 멀티태스크 오케스트레이션
/tfx-auto "인증 리팩터링 + UI 업데이트 + 테스트 추가"

# quick 모드 — 전체 계획/검증 루프 생략
/tfx-auto --quick "작은 회귀 버그 수정"

# 직접 위임
/tfx-delegate "최신 React 패턴 조사" --provider gemini
```

v5에서는 멀티태스크 오케스트레이션이 기본적으로 `--thorough`로 실행되며, 더 가벼운 경로가 필요할 때 `--quick`을 사용합니다.

---

## 파이프라인: `--thorough` 모드

v5 파이프라인은 복잡한 엔지니어링 작업에서 기본이 되는 thorough 실행 루프입니다. Plan 산출물은 영속화되고, PRD 핸드오프에는 사람 승인 게이트를 둘 수 있으며, verify/fix 단계는 워커 피드백 루프를 복원합니다.

| 단계 | 설명 |
|------|------|
| **plan** | Opus가 설계를 주도하고 Codex scout가 병렬 탐색을 수행하며, 계획 산출물을 파일로 영속화합니다. |
| **prd** | 상세한 기술 명세서(Technical Spec / PRD)를 생성하고 승인 체크포인트를 준비합니다. |
| **exec** | 실제 코드 구현을 수행합니다. |
| **verify** | 테스트를 실행하고 구현 결과가 PRD와 일치하는지 검증합니다. |
| **fix** | (루프) 검증 단계에서 발견된 실패를 리드 피드백과 함께 재실행하여 수정합니다 (최대 3회). |
| **ralph** | (재시작) 수정 루프 실패 시, 새로운 통찰을 바탕으로 `plan`부터 다시 시작합니다 (최대 10회). |

Phase-aware MCP 필터링으로 `plan`, `prd`, `verify`는 읽기 중심으로 제한되며, `prd` → `exec` 전이는 `pipeline_advance_gated`로 승인 대기를 걸 수 있습니다.

---

## 위임(Delegator) MCP

MCP 도구를 통해 허브와 직접 상호작용하세요.

- **`delegate`**: 프롬프트를 특정 프로바이더로 라우팅하거나 허브에 판단을 맡깁니다. `sync`(동기) 및 `async`(비동기) 모드를 지원합니다.
- **`reply`**: 실행 중인 에이전트와 대화를 이어갑니다 (현재 Gemini 직접 실행 모드 지원).
- **`status`**: 비동기 백그라운드 작업의 진행 상황을 확인합니다.

---

## 에이전트 타입 (21종+)

| 에이전트 | CLI | 용도 |
|---------|-----|------|
| **executor** | Codex | 표준적인 코드 구현 및 리팩터링. |
| **build-fixer** | Codex/Gemini | 빌드 및 타입 에러 즉시 수정. |
| **architect** | Codex | 상위 레벨 시스템 설계 및 계획. |
| **scientist-deep** | Codex | 철저한 조사 및 심층 분석. |
| **code-reviewer** | Codex | 보안 및 로직 중심의 코드 리뷰. |
| **security-reviewer**| Codex | 취약점 및 권한 설정 감사. |
| **quality-reviewer** | Codex | 로직 결함 및 유지보수성 감사. |
| **designer** | Gemini | UI/UX 및 문서 디자인. |
| **writer** | Gemini | 기술 문서 작성 및 설명. |
| **spark** | Gemini | 가벼운 프로토타이핑 및 빠른 처리. |
| **verifier** | Claude | 최종 검증 및 유효성 확인. |
| **test-engineer** | Claude | 포괄적인 테스트 스위트 생성. |
| *...기타* | | `debugger`, `planner`, `critic`, `analyst`, `scientist`, `explore`, `qa-tester` |

---

## 보안

triflux v5는 안전한 전문 개발 환경을 위해 설계되었습니다.

- **허브 토큰 인증** — `TFX_HUB_TOKEN`을 이용한 보안 IPC (Bearer 인증).
- **Localhost 전용** — 허브가 기본적으로 `127.0.0.1`에만 바인딩되어 외부 접근을 차단합니다.
- **CORS 잠금** — QoS 대시보드에 대한 엄격한 오리진(Origin) 체크.
- **인젝션 방어** — `psmux` 및 `tmux` 실행 시 쉘 명령어 새니타이징(Sanitizing).

---

## QoS 대시보드

`http://localhost:27888/dashboard`에서 오케스트레이션 상태를 모니터링하세요.

- **AIMD 배치 사이징** — 작업 성공률에 따라 병렬 작업 수(3 → 10)를 자동으로 조절합니다.
- **토큰 절약량** — Codex/Gemini 라우팅을 통해 절약된 Claude 토큰을 실시간으로 추적합니다.
- **할당량 추적** — Codex 및 Gemini의 속도 제한(Rate Limit)을 실시간으로 확인합니다.

---

## 플랫폼 지원

- **Linux / macOS**: 네이티브 `tmux` 통합 지원.
- **Windows**: **psmux** (PowerShell Multiplexer)와 Windows Terminal을 활용한 네이티브 윈도우 환경 지원.

---

<p align="center">
  <sub>MIT License · Made with ❤️ by <a href="https://github.com/tellang">tellang</a></sub>
</p>
