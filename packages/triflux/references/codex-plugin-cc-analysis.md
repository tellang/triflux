# OpenAI `codex-plugin-cc` 리버스 엔지니어링 분석

작성일: 2026-04-17
대상 리포지토리: `C:\Users\tellang\Desktop\Projects\triflux`
산출물 목적: OpenAI `codex-plugin-cc`의 배포/구조/런타임/스킬/훅 설계를 Claude Code marketplace plugin 관점에서 해부하고, `triflux`와의 기능·아키텍처 차이를 정리한다.

---

## TL;DR

- **npm registry 기준으로는 `codex-plugin-cc`도 `@openai/codex-plugin-cc`도 현재 공개 배포되어 있지 않다.** 2026-04-17 기준 `npm view`와 registry URL 조회 모두 404였다.
- **실제 배포 단위는 npm 패키지가 아니라 GitHub marketplace repository**(`openai/codex-plugin-cc`)다. README 설치 흐름도 `/plugin marketplace add openai/codex-plugin-cc` → `/plugin install codex@openai-codex`를 사용한다.
- `codex-plugin-cc`는 **thin integration layer**에 가깝다. Claude Code 안에서 OpenAI Codex CLI / Codex app-server를 호출하는 **단일 목적 플러그인**이며, 핵심은:
  1. review/adversarial-review
  2. rescue(task delegation)
  3. status/result/cancel
  4. optional stop-time review gate
- 반면 `triflux`는 **thick orchestration platform**에 가깝다. Claude/Codex/Gemini 라우팅, DAG/허브/훅 오케스트레이션, 대규모 스킬 카탈로그, workspaces/packages까지 포함한 **멀티모델 운영체제형 구조**다.
- 구조적으로 보면 `codex-plugin-cc`는 **plugin-local commands/agents/hooks/skills/runtime scripts** 중심이고, `triflux`는 **npm publish + explicit plugin manifest + 대형 skills/hooks/scripts/packages ecosystem** 중심이다.

---

## 조사 근거

### 외부 소스

- npm registry (direct):
  - https://registry.npmjs.org/codex-plugin-cc
  - https://registry.npmjs.org/@openai%2fcodex-plugin-cc
- GitHub repo:
  - https://github.com/openai/codex-plugin-cc

### 로컬/복제 분석 대상

- 임시 복제 경로: `%TEMP%\\codex-plugin-cc`
- 분석한 주요 파일:
  - `.claude-plugin/marketplace.json`
  - `package.json`
  - `plugins/codex/.claude-plugin/plugin.json`
  - `plugins/codex/commands/*.md`
  - `plugins/codex/agents/codex-rescue.md`
  - `plugins/codex/hooks/hooks.json`
  - `plugins/codex/scripts/*.mjs`
  - `plugins/codex/scripts/lib/*.mjs`
  - `plugins/codex/skills/*/SKILL.md`
  - `plugins/codex/schemas/review-output.schema.json`
  - `tests/*.test.mjs`

### triflux 비교 기준 파일

- `.claude-plugin/marketplace.json`
- `.claude-plugin/plugin.json`
- `hooks/hooks.json`
- `hooks/hook-orchestrator.mjs`
- `hooks/hook-registry.json`
- `skills/*/SKILL.md`
- `package.json`

---

## 1) npm registry 조사 결과

### 1.1 결과

`codex-plugin-cc`와 `@openai/codex-plugin-cc` 모두 **npm registry에서 조회되지 않았다**.

- `npm view codex-plugin-cc ...` → `E404 Not Found`
- `npm view @openai/codex-plugin-cc ...` → `E404 Not Found`
- registry URL 직접 조회도 패키지 메타데이터를 반환하지 않음

### 1.2 해석

이 결과는 다음과 일치한다.

- GitHub repo의 루트 `package.json` 이름은 `@openai/codex-plugin-cc`지만,
- 같은 파일에 **`"private": true`** 가 설정되어 있다.

즉, 이 저장소는 **npm 공개 배포용 패키지 저장소라기보다 GitHub marketplace source repository**로 운영되는 것으로 보는 것이 맞다.

### 1.3 역으로 드러나는 배포 모델

`codex-plugin-cc`는 다음 경로로 설치된다.

1. GitHub marketplace repository 추가
2. 그 repository 안의 marketplace manifest에서 plugin source 발견
3. plugin source(`./plugins/codex`)를 Claude Code plugin으로 설치

즉, **npm tarball 소스 분석 대상이 아니라 GitHub repo 소스가 authoritative source**다.

---

## 2) GitHub `openai/codex-plugin-cc` 구조 분석

### 2.1 리포 존재 여부

존재한다.

- repo: `openai/codex-plugin-cc`
- 원격 브랜치: `main`
- 원격 태그: `v1.0.0`, `v1.0.1`, `v1.0.2`, `v1.0.3`
- 로컬 shallow clone HEAD 최신 커밋:
  - commit: `6a5c2ba53b734f3cdd8daacbd49f68f3e6c8c167`
  - date: `2026-04-09 05:48:50 +0800`
  - subject: `fix: quote $ARGUMENTS in cancel, result, and status commands (#168)`

GitHub 웹 UI 기준으로도 상위 구조는 다음과 같다.

- `.claude-plugin/`
- `.github/workflows/`
- `plugins/codex/`
- `scripts/`
- `tests/`
- `package.json`
- `README.md`

### 2.2 상위 구조 해석

이 리포는 **“repo root = marketplace container, plugin source = `plugins/codex`”** 구조를 취한다.

- 루트는 marketplace/release/test/build를 담당
- 실제 Claude Code plugin 자산은 `plugins/codex` 아래에 모여 있음

이는 `triflux`처럼 루트 전체를 하나의 plugin package로 보는 구조와 다르다.

---

## 3) Claude Code marketplace plugin 구조 기준 코드 단위 분석

아래 분석은 **`marketplace.json → plugin.json → hooks → commands/agents → skills → scripts/runtime`** 순서로 정리한다.

### 3.1 `marketplace.json` 레이어

#### `codex-plugin-cc`

파일: `%TEMP%\\codex-plugin-cc\\.claude-plugin\\marketplace.json`

핵심 포인트:

- marketplace name: `openai-codex`
- plugin entry: `codex`
- plugin source: `./plugins/codex`
- version: `1.0.3`
- owner/author: `OpenAI`

의미:

- **GitHub repo 자체가 marketplace source**다.
- plugin 설치 시 npm package가 아니라 **repo 내부 상대 경로 plugin source**를 참조한다.
- marketplace manifest는 오직 **catalog/index 역할**만 수행한다.

#### triflux

파일: `./.claude-plugin/marketplace.json`

핵심 포인트:

- marketplace name: `triflux`
- plugin entry도 `triflux`
- source는 상대 경로가 아니라 **npm package `triflux`**
- version: `10.9.29`

의미:

- `triflux`는 **npm-published marketplace plugin**이다.
- marketplace manifest가 GitHub source wrapper가 아니라 **registry package index** 역할을 수행한다.

#### 차이 요약

- `codex-plugin-cc`: **GitHub-source marketplace**
- `triflux`: **npm-source marketplace**

---

### 3.2 `plugin.json` 레이어

#### `codex-plugin-cc`

파일: `%TEMP%\\codex-plugin-cc\\plugins\\codex\\.claude-plugin\\plugin.json`

내용은 매우 작다.

- `name`, `version`, `description`, `author`
- **`skills` 경로나 `hooks` 경로를 명시하지 않는다**

해석:

- 이 플러그인은 **convention-based layout**를 전제로 두는 것으로 보인다.
- 실제 기능 자산은 plugin root의 sibling directories (`commands/`, `agents/`, `hooks/`, `skills/`, `scripts/`)에 배치되어 있다.
- 즉, `plugin.json`은 **최소 메타데이터 manifest**다.

#### triflux

파일: `./.claude-plugin/plugin.json`

내용:

- `skills: "./skills/"`
- `hooks: "./hooks/hooks.json"`
- 기타 repository/homepage/license/keywords 포함

해석:

- `triflux`는 **explicit manifest wiring**을 한다.
- plugin.json에서 **skills 디렉토리와 hooks 엔트리 파일을 명시**한다.

#### 차이 요약

- `codex-plugin-cc`: **minimal manifest + directory convention**
- `triflux`: **explicit manifest + wired paths**

---

### 3.3 `commands/` 레이어

#### `codex-plugin-cc`

`plugins/codex/commands/`에는 7개 명령이 있다.

- `review.md`
- `adversarial-review.md`
- `rescue.md`
- `status.md`
- `result.md`
- `cancel.md`
- `setup.md`

구조적 특징:

1. **명령은 거의 모두 markdown policy wrapper**다.
2. 실제 실행은 `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" ...` 로 위임한다.
3. `review.md`, `adversarial-review.md`는 **foreground/background를 AskUserQuestion으로 선택**하게 하고, review-only 제약을 강하게 건다.
4. `rescue.md`는 **Codex rescue subagent로 라우팅**하고, resume/fresh/model/effort/background/wait 플래그를 분리해 제어한다.

핵심 해석:

- 명령 파일은 **business logic가 아니라 orchestration contract**다.
- 실제 로직은 전부 `scripts/codex-companion.mjs` 및 `lib/*`로 집중된다.

#### triflux

루트 plugin 구조 기준으로는 **동등한 `commands/` 디렉토리를 직접 노출하지 않는다**.
대신 사용자 표면은 다음에 분산된다.

- 42개 `skills/*/SKILL.md`
- npm `bin` 명령 (`triflux`, `tfx`, `tfx-setup`, `tfx-doctor`, ...)
- hooks에 의한 자동 라우팅
- 내부 `hub/team/cli/commands` 계열 서브시스템

핵심 해석:

- `codex-plugin-cc`는 **slash command 중심 UI**
- `triflux`는 **skill-trigger + CLI orchestration 중심 UI**

---

### 3.4 `agents/` 레이어

#### `codex-plugin-cc`

`plugins/codex/agents/codex-rescue.md` 1개만 존재한다.

역할:

- Claude가 막혔을 때 Codex로 substantial task를 넘기는 **thin forwarding wrapper**
- 허용 도구는 사실상 `Bash` 중심
- repository inspection / status polling / summarization / follow-up orchestration 금지
- 기본값은 **Codex write-capable run**
- 필요 시 `gpt-5-4-prompting` skill로 prompt만 다듬고, 나머지는 직접 하지 않는다

핵심 해석:

- subagent는 독립 작업자가 아니라 **Codex runtime invoker**다.
- 즉, `codex-plugin-cc`의 agent 철학은 **“Claude inside, Codex outside”**가 아니라 **“Claude forwards, Codex does the work”**다.

#### triflux

루트 plugin에는 별도 `agents/`가 없지만, repo 내부에는 `.claude/agents/slim-wrapper.md` 및 hub/team 관련 서브시스템이 존재한다.

핵심 해석:

- `triflux`는 한 개의 thin rescue subagent보다 **다중 모델/다중 세션 orchestration layer**에 무게가 있다.
- agent는 plugin-local asset이라기보다 **시스템 전체 orchestration의 일부**다.

---

### 3.5 `hooks/` 레이어

#### `codex-plugin-cc`

파일: `plugins/codex/hooks/hooks.json`

정의된 이벤트:

- `SessionStart`
- `SessionEnd`
- `Stop`

연결 스크립트:

- `scripts/session-lifecycle-hook.mjs` (`SessionStart`, `SessionEnd`)
- `scripts/stop-review-gate-hook.mjs` (`Stop`)

구조적 특징:

1. **Hook surface가 매우 좁다.**
2. 목적은 두 가지뿐이다.
   - 세션 수명주기 관리
   - optional stop-time review gate
3. `Stop` 훅은 timeout 900초로 길게 잡혀 있어, 종료 직전에 Codex review를 돌릴 수 있다.

#### `session-lifecycle-hook.mjs`

역할:

- `SessionStart`: Claude env file에 `CODEX_COMPANION_SESSION_ID` 등을 export
- `SessionEnd`:
  - broker session shutdown
  - 세션 단위 job 정리
  - broker endpoint/pid/log/session dir teardown

즉, **세션 종료 시 shared Codex runtime 및 background jobs를 회수하는 cleanup hook**다.

#### `stop-review-gate-hook.mjs`

역할:

- workspace config에서 `stopReviewGate` 활성 여부 확인
- 활성 상태면 직전 Claude turn을 대상으로 stop-gate prompt 생성
- `codex-companion.mjs task --json` 으로 Codex를 호출
- 첫 줄이 `ALLOW:`/`BLOCK:` 형식인지 파싱
- BLOCK이면 Claude 종료를 막음

즉, **review gate는 별도 review command가 아니라 Stop lifecycle에 삽입된 guard**다.

#### triflux

파일:

- `hooks/hooks.json`
- `hooks/hook-orchestrator.mjs`
- `hooks/hook-registry.json`

정의된 이벤트(관찰된 것만 기준):

- `SessionStart`
- `UserPromptSubmit`
- `PreToolUse`
- `PostToolUse`
- `PostToolUseFailure`
- `Stop`
- `SubagentStop`

구조적 특징:

1. **모든 이벤트를 `hook-orchestrator.mjs` 하나로 라우팅**한다.
2. 실제 훅 우선순위/차단 여부/외부 훅 병합은 `hook-registry.json`에서 관리한다.
3. 기능 범위가 넓다.
   - 위험 Bash 차단
   - subagent context injection
   - cross-review gate/tracker
   - MCP config watcher
   - error context/adaptive collector
   - keyword detector
   - session/hub/gateway/bootstrap
   - pipeline stop blocking
   - 외부 session vault / cleanup 연동

핵심 차이:

- `codex-plugin-cc` 훅: **session lifecycle + stop gate 특화**
- `triflux` 훅: **전방위 orchestration bus**

---

### 3.6 `skills/` / `SKILL.md` 레이어

#### `codex-plugin-cc`

관찰된 SKILL은 3개다.

1. `codex-cli-runtime`
2. `codex-result-handling`
3. `gpt-5-4-prompting`

공통 특징:

- 모두 **internal helper skill** 성격이 강하다.
- `user-invocable: false`가 붙은 skill이 포함된다.
- 사용자의 업무를 폭넓게 분해하는 catalog가 아니라, **plugin runtime 품질을 보강하는 내부 규약**이다.

각 스킬 역할:

- `codex-cli-runtime`
  - `codex:codex-rescue`가 어떻게 `task`를 정확히 한 번 호출해야 하는지 규정
  - repo inspection 금지, follow-up 금지, prompt 전달만 허용
- `codex-result-handling`
  - 결과를 어떻게 verbatim / 구조 보존해서 보여줄지 규정
  - review 후 자동 수정 금지
- `gpt-5-4-prompting`
  - XML block 기반 compact prompt engineering 지침
  - Codex에 넘길 task prompt를 tighter하게 만드는 템플릿 역할

핵심 해석:

- `codex-plugin-cc`의 skills는 **feature catalog가 아니라 operational policy layer**다.

#### triflux

관찰된 user-facing SKILL 디렉토리 수: **42개**

예시:

- `tfx-auto`
- `tfx-multi`
- `tfx-deep-analysis`
- `tfx-deep-plan`
- `tfx-deep-review`
- `tfx-hooks`
- `tfx-hub`
- `tfx-setup`
- `tfx-profile`
- `tfx-remote-spawn`
- `tfx-review`
- `tfx-qa`
- `tfx-prune`
- `tfx-research`

구조적 특징:

1. **대형 skill catalog**를 제품 표면으로 삼는다.
2. many skills have:
   - trigger phrases
   - AskUserQuestion 기반 interactive flow
   - orchestration semantics
   - internal/external separation
3. skill이 단순 helper가 아니라 **실질적인 제품 기능 단위**다.

핵심 차이:

- `codex-plugin-cc`: **few internal helper skills**
- `triflux`: **many user-facing orchestration skills**

---

### 3.7 `scripts/` / runtime core 레이어

#### `codex-plugin-cc` 핵심 런타임 파일 맵

| 파일 | 역할 | 비고 |
|---|---|---|
| `plugins/codex/scripts/codex-companion.mjs` | 메인 CLI dispatcher (`setup/review/task/status/result/cancel`) | 사실상 plugin control plane |
| `plugins/codex/scripts/app-server-broker.mjs` | shared Codex app-server broker | 단일 세션에서 shared runtime reuse |
| `plugins/codex/scripts/session-lifecycle-hook.mjs` | session 시작/종료 lifecycle 관리 | env export + broker teardown |
| `plugins/codex/scripts/stop-review-gate-hook.mjs` | stop-time review gate | BLOCK/ALLOW decision emitter |
| `plugins/codex/scripts/lib/app-server.mjs` | Codex app-server JSONL client | direct/shared transport 지원 |
| `plugins/codex/scripts/lib/codex.mjs` | auth preflight, review/task run, thread resume/list | app-server wrapper 핵심 |
| `plugins/codex/scripts/lib/git.mjs` | working-tree/branch review context 수집 | inline diff vs self-collect 전략 |
| `plugins/codex/scripts/lib/state.mjs` | workspace-scoped state/jobs persistence | temp/CLAUDE_PLUGIN_DATA backing |
| `plugins/codex/scripts/lib/tracked-jobs.mjs` | background job tracking/logging | progress events, final output 저장 |
| `plugins/codex/scripts/lib/job-control.mjs` | status/result/cancel 대상 해석 | phase 추론, current session filter |
| `plugins/codex/scripts/lib/render.mjs` | human-readable report 렌더링 | review/task/setup/status 출력 변환 |
| `plugins/codex/schemas/review-output.schema.json` | structured review contract | `approve` / `needs-attention` + findings schema |

#### `codex-companion.mjs`의 아키텍처 의미

이 파일은 plugin의 모든 사용자-visible workflow를 집중 처리한다.

핵심 기능:

- `handleSetup`
- `handleReview`
- `handleTask`
- `handleStatus`
- `handleResult`
- `handleCancel`
- background queue / detached worker
- model alias (`spark -> gpt-5.3-codex-spark`)
- reasoning effort validation
- persistent task thread resume

즉, `commands/*.md`는 얇고, **실제 비즈니스 로직은 `codex-companion.mjs` 단일 진입점에 집중**된다.

#### `app-server-broker.mjs`의 의미

이 파일은 단순 subprocess wrapper가 아니라 **shared app-server multiplexing/serialization layer**다.

- 하나의 Codex app-server 연결을 세션 차원에서 재사용
- concurrent 요청 시 busy RPC code 반환
- streaming review/turn lifecycle 관리
- interrupt 요청은 예외적으로 통과

즉, `codex-plugin-cc`는 단순히 `codex` 바이너리를 매번 새로 띄우는 것이 아니라, **session-local shared runtime**까지 설계했다.

#### `lib/codex.mjs`의 의미

핵심 responsibilities:

- Codex CLI availability 확인 (`codex --version`, `codex app-server --help`)
- app-server 기반 auth/config 확인
- review/start, turn/start 호출
- thread list / latest task thread 탐색
- run 결과에서 reasoning, touched files, commands 추출
- structured output parsing

즉, plugin은 **Codex CLI wrapper**라기보다 **Codex app-server protocol client**에 가깝다.

#### tests 레이어

루트 `tests/`는 다음을 포함한다.

- `commands.test.mjs`
- `runtime.test.mjs`
- `git.test.mjs`
- `render.test.mjs`
- `state.test.mjs`
- `broker-endpoint.test.mjs`
- `process.test.mjs`
- `bump-version.test.mjs`
- `fake-codex-fixture.mjs`

핵심 의미:

- OpenAI는 이 plugin을 문서/manifest 수준에서 끝내지 않고,
- **runtime contract, broker endpoint, git context selection, render formatting, state pruning**까지 테스트한다.

---

## 4) `codex-plugin-cc` 구조를 Claude Code marketplace plugin 관점에서 재정리

### 4.1 구조도

```text
repo root
├─ .claude-plugin/marketplace.json        # marketplace container
├─ package.json                           # private repo/build/test metadata
├─ scripts/bump-version.mjs               # release manifest sync
├─ tests/*.test.mjs                       # runtime/command/state coverage
└─ plugins/codex/
   ├─ .claude-plugin/plugin.json          # minimal plugin manifest
   ├─ commands/*.md                       # slash command wrappers
   ├─ agents/codex-rescue.md              # thin forwarding subagent
   ├─ hooks/hooks.json                    # lifecycle hook bindings
   ├─ prompts/*.md                        # Codex prompt templates
   ├─ schemas/review-output.schema.json   # structured review contract
   ├─ skills/*/SKILL.md                   # internal helper skills
   └─ scripts/
      ├─ codex-companion.mjs              # control plane
      ├─ app-server-broker.mjs            # shared runtime broker
      ├─ session-lifecycle-hook.mjs       # session setup/teardown
      ├─ stop-review-gate-hook.mjs        # stop gate
      └─ lib/*.mjs                        # app-server/git/state/render helpers
```

### 4.2 설계 성격

이 구조는 **“Claude plugin shell around Codex app-server”**라는 한 문장으로 요약된다.

- plugin-local command surface는 작다
- agent/skills는 runtime 보조용이다
- real power는 `scripts/lib/*.mjs`에 있다
- review/task를 Claude-native capability처럼 보이게 하지만, 실제 계산은 Codex가 한다

---

## 5) `triflux`와의 비교표

## 5.1 상위 비교

| 항목 | `codex-plugin-cc` | `triflux` | 해석 |
|---|---|---|---|
| 배포 방식 | GitHub marketplace repo source | npm-published marketplace package | `codex-plugin-cc`는 repo-source, `triflux`는 registry package |
| npm 공개 상태 | 미공개(404, repo `package.json`도 `private: true`) | 공개 패키지(`marketplace.json`이 `package: triflux` 참조) | 유통 방식이 근본적으로 다름 |
| plugin source layout | `plugins/codex` 하위에 실제 plugin 수납 | repo root 전체가 plugin/runtime ecosystem | `codex-plugin-cc`가 더 compact |
| manifest style | minimal `plugin.json` | explicit `plugin.json` (`skills`, `hooks` wiring) | `triflux`가 wiring을 더 많이 노출 |
| 목적 | Codex를 Claude Code 안에 내장해 review/delegation 제공 | Claude/Codex/Gemini 멀티모델 orchestration 플랫폼 | `codex-plugin-cc`는 single-purpose, `triflux`는 platform |

## 5.2 기능 비교

| 기능 축 | `codex-plugin-cc` | `triflux` |
|---|---|---|
| 코드 리뷰 | `/codex:review`, `/codex:adversarial-review` | `tfx-review`, `tfx-deep-review`, cross-review gate, hook-based nudges |
| 작업 위임 | `/codex:rescue` + `codex-rescue` subagent | `tfx-auto`, `tfx-multi`, `tfx-codex`, `tfx-gemini`, swarm/remote/team 계열 |
| 상태 확인 | `/codex:status`, `/codex:result`, `/codex:cancel` | CLI/hub/hud/profile/setup/doctor 중심, multi-agent orchestration 상태 관리 |
| 인증/설치 점검 | `/codex:setup` | `tfx-setup`, `tfx-doctor`, profile/hub/remote setup 스킬 |
| 모델 선택 | Codex model/effort 전달, spark alias | Codex/Gemini/Claude 간 라우팅 + 프로파일 관리 |
| 세션 종료 가드 | optional stop review gate | pipeline stop, safety guard, hub ensure, session vault 등 더 광범위 |

## 5.3 아키텍처 비교

| 축 | `codex-plugin-cc` | `triflux` |
|---|---|---|
| 코어 런타임 | `codex-companion.mjs` 단일 control plane | `bin/`, `scripts/`, `hub/`, `hud/`, `mesh/`, `packages/*`로 분산된 플랫폼형 |
| 외부 엔진 의존성 | OpenAI Codex CLI + Codex app-server | Codex/Gemini/Claude + 자체 hub/hud/mesh |
| 상태 저장 | temp/`CLAUDE_PLUGIN_DATA` 기반 workspace state + jobs | repo 내부 `.omc`, `.omx`, 자체 캐시/허브/상태 레이어 |
| 동시성 모델 | shared app-server broker + background jobs | multi-CLI orchestration, hub/team/remote, DAG-like coordination |
| 리뷰 데이터 | git diff/context + structured JSON schema | skill/hook routing + cross-review + multi-model consensus 계열 |
| 설계 철학 | thin integration wrapper | thick orchestration platform |

## 5.4 스킬 비교

| 항목 | `codex-plugin-cc` | `triflux` |
|---|---|---|
| SKILL 수(관찰치) | 3 | 42 |
| 기본 성격 | internal helper / policy layer | user-facing product surface + internal orchestration |
| 대표 스킬 | `codex-cli-runtime`, `codex-result-handling`, `gpt-5-4-prompting` | `tfx-auto`, `tfx-multi`, `tfx-review`, `tfx-qa`, `tfx-hooks`, `tfx-hub`, `tfx-setup`, ... |
| 설계 목적 | rescue 품질 보조, 결과 formatting, prompt shaping | task routing, deep analysis, hub control, QA, remote spawn, safety, setup |
| 사용자 직접성 | 낮음 | 높음 |

## 5.5 훅 비교

| 항목 | `codex-plugin-cc` | `triflux` |
|---|---|---|
| 훅 이벤트 범위 | `SessionStart`, `SessionEnd`, `Stop` | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `SubagentStop` |
| 훅 구조 | 단순 직접 바인딩 | `hook-orchestrator.mjs` + `hook-registry.json` priority orchestration |
| 주 용도 | runtime lifecycle + optional review gate | safety, routing, bootstrap, error context, MCP watcher, keyword detector, stop gate |
| blocking 정책 | stop-review gate 중심 | pipeline stop, safety guard, hub ensure 등 다수 blocking hook |
| 복잡도 | 낮음 | 높음 |

---

## 6) 코드 단위 역설계 결론

### `codex-plugin-cc`의 본질

`codex-plugin-cc`는 Claude Code용 “OpenAI Codex bridge plugin”이다.

정확히는:

1. **Marketplace wrapper**가 repo root에 있다.
2. 실제 plugin은 `plugins/codex`에 있다.
3. command/agent/skill은 모두 **thin interface layer**다.
4. 실제 가치는 `scripts/lib/*.mjs`가 제공하는:
   - Codex app-server client
   - shared broker
   - git context collector
   - tracked jobs/state
   - stop gate
   에 있다.

즉, 이 플러그인은 **Codex app-server protocol을 Claude Code UX 안으로 끌어오는 adapter**다.

### `triflux`와 비교했을 때의 핵심 포지션 차이

- `codex-plugin-cc`는 **단일 엔진(Codex) 통합**에 최적화된 productized adapter
- `triflux`는 **다중 엔진 조정**에 최적화된 orchestration OS

다시 말해:

- `codex-plugin-cc`가 잘하는 것: **Codex를 Claude 안에 자연스럽게 넣기**
- `triflux`가 잘하는 것: **여러 모델과 런타임을 하나의 작업 시스템으로 묶기**

---

## 7) triflux 관점에서 얻을 수 있는 시사점

1. **배포 단순화**
   - `codex-plugin-cc`처럼 GitHub marketplace source model을 쓰면 npm publish 없이도 배포 가능하다.
   - 반대로 `triflux`의 npm package model은 재현성과 설치 편의성이 좋다.

2. **plugin surface 최소화**
   - `codex-plugin-cc`는 plugin surface를 작게 두고 runtime core에 집중한다.
   - `triflux`는 기능이 풍부하지만 surface area가 커서 유지보수 비용이 높다.

3. **review gate 제품화**
   - `codex-plugin-cc`의 stop-review gate는 작은 구조로도 사용자 가치를 만든다.
   - `triflux`는 이미 stop/pipeline guard가 있지만, 더 제품화된 compact gate UX로 재구성할 여지가 있다.

4. **internal skill 정리 방식**
   - `codex-plugin-cc`는 internal skill의 역할이 매우 선명하다.
   - `triflux`는 방대한 skill catalog 때문에 internal/user-facing 경계가 상대적으로 흐릴 수 있다.

---

## Appendix A — 관찰된 파일 수/볼륨

### `codex-plugin-cc` (`plugins/codex` 기준)

- commands: 7 files / 13,106 bytes
- agents: 1 file / 3,341 bytes
- hooks: 1 file / 883 bytes
- prompts: 2 files / 5,493 bytes
- schemas: 1 file / 1,844 bytes
- scripts: 19 files / 158,713 bytes
- skills: 6 files / 18,837 bytes

### `triflux` (repo root 주요 영역)

- `.claude-plugin`: 2 files / 1,520 bytes
- hooks: 15 files / 99,800 bytes
- skills: 242 files / 1,291,387 bytes
- scripts: 88 files / 650,427 bytes
- hub: 155 files / 1,380,220 bytes
- hud: 11 files / 114,711 bytes
- mesh: 7 files / 19,042 bytes
- packages: 854 files / 6,280,359 bytes

이 수치만 봐도 `triflux`가 훨씬 **platform-scale**이고, `codex-plugin-cc`는 **compact adapter-scale**임이 드러난다.

---

## Appendix B — 최종 판단

- **npm registry 분석 결론:** 공개 npm package source는 없다.
- **GitHub 분석 결론:** `openai/codex-plugin-cc`가 실제 authoritative source다.
- **구조 분석 결론:** Claude Code plugin 규약을 따르되, thin commands/agent + strong runtime core 조합이다.
- **triflux 비교 결론:** 두 프로젝트는 경쟁 구조라기보다 **목표 계층이 다르다**. `codex-plugin-cc`는 Codex bridge, `triflux`는 multi-model orchestration platform이다.
