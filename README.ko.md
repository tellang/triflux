[English](README.md) | [한국어](README.ko.md)

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/logo-light.svg">
    <img alt="triflux" src="docs/assets/logo-dark.svg" width="200">
  </picture>
</p>

<p align="center">
  <strong>CLI 기반 멀티모델 오케스트레이터</strong><br>
  <em>Codex, Gemini, Claude에 작업을 라우팅 — 적합한 모델에 작업을 라우팅하여 Claude 토큰을 절약하세요</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/triflux"><img src="https://img.shields.io/npm/v/triflux?style=flat-square&color=FFAF00&label=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/triflux"><img src="https://img.shields.io/npm/dm/triflux?style=flat-square&color=F5C242" alt="npm downloads"></a>
  <a href="https://github.com/tellang/triflux/stargazers"><img src="https://img.shields.io/github/stars/tellang/triflux?style=flat-square&color=FFAF00" alt="GitHub stars"></a>
  <a href="https://github.com/tellang/triflux/actions"><img src="https://img.shields.io/github/actions/workflow/status/tellang/triflux/ci.yml?style=flat-square&label=CI" alt="CI"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-374151?style=flat-square" alt="License: MIT"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D18-374151?style=flat-square" alt="Node.js >= 18"></a>
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
  <a href="#스킬">스킬</a> ·
  <a href="#아키텍처">아키텍처</a> ·
  <a href="#설정-가이드">설정 가이드</a>
</p>

---

## 왜 triflux인가?

- **비용 지능형 라우팅** — Codex와 Gemini에 먼저 작업을 보내고, Claude 토큰은 최소화
- **DAG 기반 병렬 실행** — 복잡한 작업을 의존 그래프로 분해하여 동시 실행
- **자동 트리아지** — Codex가 분류 + Opus가 분해, 수동 에이전트 선택 불필요
- **16가지 에이전트** — executor부터 architect까지, 각각 최적의 CLI와 effort 레벨에 매핑
- **HUD 상태 표시줄** — CLI 상태, 토큰 절약량, 속도 제한 실시간 모니터링
- **제로 설정** — 설치 후 Claude Code에서 바로 슬래시 명령어 사용

<details>
<summary><strong>설치</strong></summary>

### 플러그인 (권장)

```bash
/plugin marketplace add https://github.com/tellang/triflux
/plugin install triflux
```

### npm (전역)

```bash
npm install -g triflux
```

### npx (일회성)

```bash
npx triflux doctor
```

### 설치 확인

```bash
tfx doctor
```

</details>

## 빠른 시작

```bash
# 자동 모드 — AI가 분류 + 분해 + 병렬 실행
/tfx-auto "인증 모듈 리팩터링 + 로그인 UI 개선 + 테스트 추가"

# 수동 모드 — 에이전트 수와 타입 직접 지정
/tfx-auto 3:codex "src/api, src/auth, src/payment 각각 리뷰"

# 커맨드 숏컷 — 단일 에이전트 즉시 실행
/implement "JWT 인증 미들웨어 추가"
/analyze "결제 모듈 보안 리뷰"
/research "최신 React Server Components 패턴"

# 단일 CLI 모드
/tfx-codex "리팩터링 + 리뷰"    # Codex만 사용
/tfx-gemini "구현 + 문서화"      # Gemini만 사용
```

## 스킬

| 스킬 | 모드 | 설명 |
|------|------|------|
| `/tfx-auto` | 자동 | 트리아지 → 분해 → DAG 병렬 실행 |
| `/tfx-codex` | Codex 전용 | 모든 CLI 작업을 Codex로 라우팅 |
| `/tfx-gemini` | Gemini 전용 | 모든 CLI 작업을 Gemini로 라우팅 |
| `/tfx-setup` | 설정 | 파일 동기화, HUD 설정, CLI 진단 |

### 커맨드 숏컷

트리아지 없이 즉시 단일 에이전트 실행:

| 커맨드 | 에이전트 | CLI | 용도 |
|--------|---------|-----|------|
| `/implement` | executor | Codex | 코드 구현 |
| `/build` | build-fixer | Codex | 빌드/타입 에러 수정 |
| `/research` | document-specialist | Codex | 문서 조사 |
| `/brainstorm` | analyst | Codex | 요구사항 분석 |
| `/design` | architect | Codex | 아키텍처 설계 |
| `/troubleshoot` | debugger | Codex | 버그 분석 |
| `/cleanup` | executor | Codex | 코드 정리 |
| `/analyze` | quality + security | Codex | 병렬 리뷰 (2 에이전트) |
| `/spec-panel` | architect + analyst + critic | Codex | 스펙 리뷰 (3 에이전트) |
| `/explain` | writer | Gemini | 코드 설명 |
| `/document` | writer | Gemini | 문서 작성 |
| `/test` | test-engineer | Claude | 테스트 전략 |
| `/reflect` | verifier | Claude | 검증 |

## 아키텍처

```
사용자: "/tfx-auto 인증 리팩터링 + UI 개선 + 테스트 추가"
         |
         v
   [Phase 1: 파싱] ─── 자동 모드 감지
         |
         v
   [Phase 2a: 분류] ─── Codex
   │  인증 리팩터링 → codex
   │  UI 개선       → gemini
   │  테스트 추가   → claude
         |
         v
   [Phase 2b: 분해] ─── Opus (인라인, Agent 스폰 없음)
   │  t1: executor (implement, src/auth/)     Level 0
   │  t2: designer (docs, src/components/)    Level 0
   │  t3: test-engineer (Claude 네이티브)     Level 1 ← t1 의존
         |
         v
   [Phase 3: 실행] ─── DAG 병렬
   │  Level 0: t1(Codex) + t2(Gemini)  ← 병렬
   │  Level 1: t3(Claude)               ← t1 완료 후
         |
         v
   [Phase 4-6: 수집 → 재시도 → 보고]
```

### 에이전트 라우팅 테이블

| 에이전트 | CLI | Effort | 타임아웃 | 모드 |
|---------|-----|--------|---------|------|
| executor | Codex | high | 360s | fg |
| build-fixer | Codex | fast | 180s | fg |
| debugger | Codex | high | 300s | bg |
| deep-executor | Codex | xhigh | 1200s | bg |
| architect | Codex | xhigh | 1200s | bg |
| planner | Codex | xhigh | 1200s | fg |
| critic | Codex | xhigh | 1200s | bg |
| analyst | Codex | xhigh | 1200s | fg |
| code-reviewer | Codex | thorough | 600s | bg |
| security-reviewer | Codex | thorough | 600s | bg |
| quality-reviewer | Codex | thorough | 600s | bg |
| scientist | Codex | high | 480s | bg |
| document-specialist | Codex | high | 480s | bg |
| designer | Gemini Pro 3.1 | — | 600s | bg |
| writer | Gemini Flash 3 | — | 600s | bg |
| explore | Claude Haiku | — | 300s | fg |
| verifier | Claude Sonnet | — | 300s | fg |
| test-engineer | Claude Sonnet | — | 300s | bg |

### 실패 처리

1. **1차 실패** → Claude 네이티브 에이전트로 fallback
2. **2차 실패** → 해당 서브태스크 실패 보고, 나머지 결과 종합
3. **타임아웃** → 부분 결과 보고

<details>
<summary><strong>설정 가이드</strong></summary>

### 사전 조건

- **Node.js** >= 18
- **Claude Code** (필수)
- **Codex CLI** (선택): `npm install -g @openai/codex`
- **Gemini CLI** (선택): `npm install -g @google/gemini-cli`

> Codex/Gemini 없이도 동작합니다. 자동으로 Claude 네이티브 에이전트로 fallback됩니다.

### 설치 후

```bash
# 파일 동기화 + HUD 설정
tfx setup

# 진단 실행
tfx doctor
```

### CLI 명령어

| 명령어 | 설명 |
|--------|------|
| `tfx setup` | 스크립트 + HUD + 스킬 동기화 |
| `tfx doctor` | CLI 진단 + 이슈 추적 |
| `tfx update` | 최신 버전으로 업데이트 |
| `tfx list` | 설치된 스킬 목록 |
| `tfx version` | 버전 표시 |

축약: `tfx` = `triflux`, `tfl` = `triflux`

### HUD 상태 표시줄

Claude Code 상태줄에서 실시간 모니터링:

- Claude / Codex / Gemini 토큰 사용량 및 속도 제한
- CLI 상태 (설치 여부, API 키 상태)
- 세션 비용 추적 및 절약 보고서

`tfx setup`으로 자동 설정됩니다.

</details>

<details>
<summary><strong>oh-my-claudecode 통합</strong></summary>

triflux는 단독으로 동작하거나 [oh-my-claudecode](https://github.com/nicepkg/oh-my-claudecode)와 함께 사용할 수 있습니다:

- OMC 플러그인 시스템을 통한 스킬 자동 등록
- `cli-route.sh`가 OMC 에이전트 카탈로그와 통합
- HUD가 OMC 상태줄을 확장
- OMC autopilot, ralph, team, ultrawork 모드와 호환

</details>

<details>
<summary><strong>변경 이력</strong></summary>

### 2.0.0

- `cx-skills`에서 `triflux`로 리브랜딩
- 새 CLI 명령어: `tfx`, `triflux`, `tfl`
- 스킬 업데이트: `/tfx-auto`, `/tfx-codex`, `/tfx-gemini`, `/tfx-setup`
- amber 브랜딩 시각적 리뉴얼
- 내부 참조 전면 업데이트 (`CX_CLI_MODE` → `TFX_CLI_MODE`)

### 이전 버전 (cx-skills)

v1.x 이력은 [cx-skills releases](https://github.com/tellang/cx-skills/releases) 참조.

</details>

---

<p align="center">
  <a href="https://github.com/tellang/triflux">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=tellang/triflux&type=Date&theme=dark">
      <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=tellang/triflux&type=Date">
      <img alt="Star History" src="https://api.star-history.com/svg?repos=tellang/triflux&type=Date" width="600">
    </picture>
  </a>
</p>

<p align="center">
  <sub>MIT License · Made by <a href="https://github.com/tellang">tellang</a></sub>
</p>
