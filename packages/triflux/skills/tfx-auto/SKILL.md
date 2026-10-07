---
name: tfx-auto
description: >
  통합 CLI 오케스트레이터이자 실행 스킬 front door. 단일/병렬 구현·수정 작업을 자동 분류해
  Codex 우선으로 dispatch 하고, 명시 플래그로 mode/parallel/consensus 등 동작을 오버라이드한다.
  '코드 짜줘', '구현해줘', '만들어줘', '수정해줘', '고쳐줘', 'implement', 'build', 'fix' 같은
  구현/수정 요청에 사용. 플래그 상세는 argument-hint, 라우팅 정책은 .claude/rules/tfx-routing.md 참조.
argument-hint: "<command|task> [args...] [--cli auto|codex|antigravity|claude] [--mode quick|deep|consensus|live] [--rounds <N>] [--shape consensus|debate|panel] [--cli-set triad|no-antigravity|custom] [--parallel 1|N] [--retry 0|1|ralph] [--skill <name>]"
---

# tfx-auto: 통합 CLI 오케스트레이터

> **ARGUMENTS 처리**: 이 스킬이 `ARGUMENTS: <값>`과 함께 호출되면, 해당 값을 사용자 입력으로 취급하여
> 워크플로우의 첫 단계 입력으로 사용한다. ARGUMENTS가 비어있거나 없으면 기존 절차대로 사용자에게 입력을 요청한다.

### 라우팅 판단

판단 기준 (우선순위 순):

0. **명시 플래그** (최우선, 추론 스킵): ARGUMENTS 에 `--cli`/`--mode`/`--shape`/`--cli-set`/`--parallel`/`--retry` 플래그가 있으면 분류/추론을 건너뛰고 플래그 값대로 즉시 dispatch. 자세한 플래그 동작은 아래 "플래그 오버라이드" 섹션 참조.
   - `--parallel N` → `tfx multi` 위임 (`auto`: mux가 있으면 interactive pane, 비TTY에서 mux가 없으면 headless)
   - `--cli codex|antigravity` → `TFX_CLI_MODE` 설정 + 단일 실행
   - `--mode deep` → `-t/--thorough` 동일 동작 (Plan → PRD → Exec → Verify)
   - `--mode consensus --shape debate|panel` → prompt ensemble fold 경로
   - `--mode live` → `tfx-live` 엔진 위임 (분해/트리아지 스킵)
   - `--retry ralph` → `retry-state-machine.mjs`의 ralph 모드

1. **사용자 명시 키워드** (플래그 없을 때):
   - "격리해서", "충돌 없이 돌려" → 작업별 worktree와 세션을 나누고 각 세션에서 `tfx-auto` 실행. Claude Agent는 `isolation: worktree`를 쓸 수 있다
   - "병렬", "동시에", "multi", "협업"(단순 동시 작업 의미) → `--parallel N --mode deep` (코드 변경이 없거나 작업별 worktree가 분리된 경우)
   - "팀"은 모호하다: 서로 메시지를 주고받는 영속 협업을 원하면 정답은 OMC 네이티브 `/team`이고(tfx-auto 관할 밖), 그냥 여러 작업을 동시에 처리해달라는 뜻이면 바로 위 `--parallel N` 행을 따른다. "팀"만 보고 바로 `--parallel N`으로 단정하지 말고 어느 쪽인지 애매하면 되묻는다
   - "꼼꼼히", "제대로", "deep" → `--mode deep`
   - "끝까지", "멈추지마", "ralph" → `--retry ralph`
   - "3관점 분석" → `--mode consensus --shape panel` (분석 roster는 보조 문서 참조)
   - "3자 합의 정리" → `--mode consensus` cleanup. 무수식 slop/deslop 은 host `ai-slop-cleaner` 소관이다
   - "codex로", "antigravity로" → `--cli codex` 또는 `--cli antigravity`
   - "원격으로", "다른 기기에서", "리모트로 돌려" → `tfx-remote`로 원격 세션 관리. 원격에서 코드 변경 병렬 실행 시 세션별 worktree 분리
   - "논쟁시켜", "서로 반박하게 해", "계속 대화하면서 풀게", "왕복으로 주고받게" → `--mode live` (`tfx-live peer` 고정). "협업"/"팀"과 겹쳐 보여도 이 쪽은 "논쟁/반박/대화를 계속 이어간다"는 뉘앙스가 명시적으로 있을 때만 해당

2. **PRD 인자 분석**:
   - PRD 경로 2개 이상 → 작업별 worktree와 세션을 나누고 각 세션에서 `tfx-auto` 실행
   - PRD 1개 + XL 규모 → `--mode deep --parallel 1`

3. **기본**: 기존 tfx-auto 워크플로우 그대로 실행

정규화된 플래그를 현재 `tfx-auto` 실행 인자로 적용한다.

라우팅 결정 후 1줄 표시:
```
[tfx] 규모: {S/M/L/XL}, 모드: {mode} ({profile})
```

> **MANDATORY RULES**
>
> 1. **실행**: CLI 에이전트는 반드시 `Bash("bash ~/.claude/scripts/tfx-route.sh ...")`. Claude 네이티브 역할과 명시적 verifier override만 `Agent()`.
> 2. **비용/편향 분리**: 실행 워커 비용은 Codex/Antigravity 우선으로 낮추되, consensus/debate/panel에서는 Claude를 최후수단이 아니라 counter-bias outvoice로 둔다. Claude가 실행을 맡는 경우는 명시적 `--cli claude`, Claude-native host role, 또는 fallback뿐이다.
> 2-a. **Anti-bias triad**: `triad`는 Claude(counter-bias outvoice) + Codex(implementation/reality check) + Antigravity(product/UX auxiliary)를 보존하고, disputed/minority view를 삭제하지 않는다.
> 2-b. **Claude effort**: Claude lane은 Claude Code CLI의 `--model`과 `--effort`를 사용한다. Triflux의 `CLI_EFFORT`/profile 값은 `low|medium|high|xhigh|max` Claude effort로 매핑한다. `ultracode`도 공식 `--effort` 값(v2.1.203+)이지만 프로필 매핑에서는 쓰지 않는다. skill 문서가 모델 ID를 하드코딩하지 않는다.
> 3. **DAG**: SEQUENTIAL/DAG이면 레벨 기반 순차 실행. `.omc/context/{sid}/` 생성, context_output 저장, 실패 시 후속 SKIP.
> 4. **트리아지**: 입력을 분류하고 의존 관계에 따라 작업을 나눈다.
> 5. **thorough**: `-t`/`--thorough` 시 Plan → PRD → Exec → Verify 순서를 따른다.
> 6. **CLI 실행**: Codex/Antigravity CLI 작업은 `tfx-route.sh`를 경유한다.

## 모드

| 입력 형식 | 모드 | 트리아지 |
|-----------|------|----------|
| `/tfx-auto "리팩터링 + UI"` | 자동 (quick) | Codex 분류 → Claude 분해 |
| `/tfx-auto -t "리팩터링 + UI"` | 자동 (thorough) | Codex 분류 → Claude 분해 → Pipeline |
| `/tfx-auto --thorough "리팩터링"` | 자동 (thorough) | `-t` 동일 |
| `/tfx-auto 3:codex "리뷰"` | 수동 (quick) | Claude 분해만 |

> **tfx-auto는 `--quick`이 기본.**

## 플래그 오버라이드

ARGUMENTS 에 아래 플래그가 있으면 라우팅 판단의 내부 추론을 건너뛰고 해당 값을 적용한다.

### 플래그 표

| 플래그 | 값 | 효과 | 위임 엔진 |
|--------|-----|------|----------|
| `--cli` | `auto` (기본) | Codex 분류 후 최적 CLI 선택 | 기존 라우팅 |
| `--cli` | `codex` | Codex 전용 고정. `TFX_CLI_MODE=codex` | tfx-route.sh |
| `--cli` | `antigravity` | Antigravity CLI 고정. `TFX_CLI_MODE=antigravity` | tfx-route.sh |
| `--cli` | `claude` | Claude native 에이전트만 (CLI 호출 없음) | Agent() |
| `--mode` | `quick` (기본) | plan/verify 단계 없음 | 직접 실행 |
| `--mode` | `deep` | Plan → PRD → Exec → Verify → Fix loop | `-t/--thorough` 동일 |
| `--mode` | `consensus` | 3-CLI 합의 family 실행 | tfx-auto consensus root |
| `--mode` | `live` | 서브태스크 분해 불가한 왕복 대화형 작업을 직행 위임 | `tfx-live peer` (v1 단일 경로, 상세는 "Live 위임 계약" 절) |
| `--rounds` | `4` (기본) | live peer 왕복 횟수(총 hop 수는 `rounds * 2`) | `tfx-live peer --rounds` |
| `--shape` | `consensus` (기본) | findings 합의/충돌 판정 | consensus renderer |
| `--shape` | `debate` | 옵션 비교 + 점수화 + 최종 추천 | debate renderer |
| `--shape` | `panel` | 전문가 roster 기반 시뮬레이션 | panel renderer |
| `--cli-set` | `triad` (기본) | Claude + Codex + Antigravity | consensus participants |
| `--cli-set` | `no-antigravity` | Claude outvoice + Codex partial degrade | consensus participants |
| `--cli-set` | `custom` | 기존 3 CLI 내부 subset/repetition 만 허용 | consensus participants |
| `--options` | `"A|B|C"` | debate 비교 대상 | debate normalizer |
| `--criteria` | `"latency|complexity|operability"` | debate 평가 기준 | debate normalizer |
| `--experts` | `"claude:...;codex:...;antigravity:..."` | panel roster override | panel normalizer |
| `--analysis-prompt-file` | `<path>` | consensus family 공통 분석 프롬프트 주입 | consensus normalizer |
| `--parallel` | `1` (기본) | 단일 워커 | tfx-route.sh |
| `--parallel` | `N` | 로컬 병렬 (mode 생략=`auto`; mux가 있으면 interactive pane, 비TTY에서 mux가 없으면 headless) | `tfx multi` |
| `--no-native-bridge-ui` | true | 명시적 headless worker의 Claude agents UI 노출을 비활성화 | `tfx multi` |
| `--retry` | `0` | 자동 재시도 없음 | 없음 |
| `--retry` | `1` (기본) | bounded verify → fix loop 3회 | 없음 |
| `--retry` | `ralph` | 무제한 재시도, 동일 실패 3회 중단 | retry-state-machine.mjs |
| `--retry` | `auto-escalate` | 양수 `--max-iterations` 소진 시 프로필 체인 승격 | retry-state-machine.mjs |
| `--lead` | `claude` (기본) | 분류·메타판단을 Claude 가 담당 | tfx-auto 내장 |
| `--lead` | `codex` | 분류·메타판단을 Codex 에 위임 (Codex lead) | tfx-route.sh |
| `--no-claude-native` | false (기본) | Claude native sub-agent 경로 유지 | 없음 |
| `--no-claude-native` | true | Claude native 경로 disable, CLI 기반 worker 강제 | tfx-route.sh |
| `--max-iterations` | `0` (기본, unlimited) | `--retry ralph`/`auto-escalate` 상한 | retry-state-machine.mjs |
| `--skill` | `<name>` | `skills/<name>/SKILL.md` 본문을 codex/agy 프롬프트 앞에 주입 (`TFX_INJECT_SKILL`). 미지정 시 no-op | tfx-route.sh |

### 플래그 검증

- `--shape` 미지정 + `--mode consensus` → `shape=consensus`
- `--shape` 지정 + `--mode != consensus` → warning 또는 error. shape 는 consensus family 에서만 유효
- `--cli-set custom` + 기존 3 CLI 외 participant 지정 → 즉시 error. silent fallback 금지
- `--retry ralph` → 재시도 상태 머신 (`retry-state-machine.mjs`)
- `--retry auto-escalate` → CLI 승격 체인 (양수 `--max-iterations` 필요)
- `--max-iterations N` (N>0) → ralph/auto-escalate 에 상한 부여
- `--skill <name>` → `TFX_INJECT_SKILL=<name>` 로 tfx-route.sh 에 전달. 스킬 파일 부재 시 warning 후 주입 생략 (fail-open, 작업은 계속)
- `--mode live` + `--parallel`/`--retry ralph` 동시 지정 → warning 후 무시. 라이브 세션은 배치 병렬·재시도 상태머신 모델과 호환되지 않는다
- `--rounds` 지정 + `--mode != live` → warning 후 무시

### 스킬 주입 (`--skill <name>`)

codex/agy 워커 프롬프트 앞에 등록된 스킬의 방법론을 주입하는 **opt-in** 프레임워크. 동작:

- **메커니즘**: `--skill <name>` → tfx-route.sh `TFX_INJECT_SKILL=<name>`. `skills/<name>/SKILL.md` 본문을 `--- SKILL: <name> (apply this methodology...) ---` delimited block 으로 프롬프트 앞에 prepend. codex·agy 레인 공통 (CLI-agnostic, `prepend_skill`).
- **기본 off**: 미지정이면 no-op → 현행 동작 그대로. 회귀 위험 없음.
- **파싱 안전**: prepend 는 `printf`/`cat` → temp file 만 사용. codex 는 argv `--` 뒤, agy 는 `--print <프롬프트>` 인자로 전달되므로 `$`(codex)·`₩`/백슬래시(agy) 같은 특수문자를 셸 재확장 없이 **리터럴 보존**. 스킬 본문을 그대로 넘겨도 깨지지 않음.
- **네이티브 스킬을 안 쓰는 이유**: codex `$skill-name`/`/name` 슬래시와 agy `/name` 은 둘 다 **인터랙티브 TUI 전용** → headless one-shot 에서 named-skill 강제 호출 불가 (미문서). 그래서 prose 주입을 채택 (레퍼런스 omc 도 role .md 를 raw prepend, 네이티브 회피).

#### 커맨드→스킬 매핑 (tfx-auto convention, opt-in)

tfx-auto 가 커맨드/agent 별로 주입할 스킬을 고를 때 쓰는 **권고 테이블**. 기본은 매핑 없음 (명시 `--skill` 만 작동): 부적절한 스킬이 모든 프롬프트에 새는 것을 막는다. 프로젝트가 명시적으로 활성화할 때만 아래를 적용해 `--skill` 을 자동 부여한다.

| 커맨드/agent | 권고 스킬 | 비고 |
|--------------|-----------|------|
| (기본) | 없음 | explicit `--skill` 우선 |
| 프로젝트 정의 | 프로젝트가 지정 | 활성화 시 tfx-auto 가 해당 `--skill` set |

> 매핑된 스킬 파일이 없으면 `prepend_skill` 이 warning 후 주입을 생략한다 (fail-open). 존재하지 않는 매핑을 "주입됨"으로 가정하지 않는다.

#### agy anti-overclaim (자동, agy 레인 전용)

agy 레인은 `TFX_AGY_ANTI_OVERCLAIM`(기본 on) 으로 완료/grounding 규율 블록을 프롬프트 **END** 에 자동 append (`append_agy_anti_overclaim`). 근거 없는 완료 주장을 줄이기 위한 설정이다:

- fresh 증거 없이 done/fixed/passing 주장 금지.
- 검증 불가 시 `No Info / 확인 불가` 후 중단 (날조 금지).
- 추론은 주어진 context 로, confident guessing 보다 accurate abstention 우선.

해당 지시 블록은 프롬프트 끝에 배치한다. opt-out: `TFX_AGY_ANTI_OVERCLAIM=0`.

### Retry state machine 계약

`--retry ralph` 와 `--retry auto-escalate` 는 모두 `hub/team/retry-state-machine.mjs` 를 사용한다.

- `--retry ralph`는 재시도 상태 머신으로 동작한다. 기본값 `--max-iterations 0`은 횟수 제한이 없다는 뜻이다.
- 스킬 경유 실행의 상태 파일은 `.omc/state/retry-<sessionId>.json` 이다. `retry-state-machine.mjs`는 전달받은 `stateFile`에 전이를 기록하며 파일 이름을 정하지 않는다.
- 동일 `failureReason` 이 3회 연속 반복되면 `stuckCounter` 가 올라가고 `STUCK` 으로 중단한다.
- `--retry auto-escalate` 는 `DEFAULT_ESCALATION_CHAIN` 을 기본으로 사용한다. 커스텀 체인이 필요하면 `.triflux/config/escalation-chain.json` 으로 override 한다.

`DEFAULT_ESCALATION_CHAIN`의 프로필 설정은 `.claude/rules/tfx-escalation-chain.md`와 CLI 프로필 설정을 따른다.

1. Codex: `gpt6_astra_max` 프로필
2. Claude: 최종 수단 프로필

체인 규칙:
- `auto-escalate`는 양수 `--max-iterations N`을 소진하면 다음 CLI 프로필로 전이한다. 기본값 `0`에서는 횟수에 따른 승격이 없으며 동일 실패 3회 중단 규칙이 적용된다.
- 체인 끝까지 소진하면 `BUDGET_EXCEEDED` 와 `reason: "escalation-chain-exhausted"` 를 기록한다.
- 체인 항목은 optional `profile` 필드를 지원한다. 값이 있으면 파싱/전달만 하고, 없으면 기존 CLI/config 기본 동작을 따른다.

### Codex lead 계약

`--cli codex --lead codex --no-claude-native` 조합은 Codex가 분류와 실행을 맡는다.

- `--cli codex` 는 CLI 워커를 Codex 로 고정한다.
- `--lead codex` 는 분류·메타판단도 Codex 가 담당하게 한다.
- `--no-claude-native` 는 Claude native sub-agent 경로를 끄고 CLI 기반 worker 만 허용한다.
- 하위 호환 env `TFX_NO_CLAUDE_NATIVE=1` 는 계속 읽되, 플래그가 우선한다.

### 사용 예시

```
/tfx-auto "리팩터링" --mode deep               # = 기존 -t/--thorough
/tfx-auto "구현" --cli codex
/tfx-auto "병렬" --parallel N --mode deep
/tfx-auto "끝까지 고쳐" --retry ralph
/tfx-auto "src/auth 구조 분석" --mode consensus --shape panel
/tfx-auto "src/ 슬롭 3자 합의 정리" --mode consensus
/tfx-auto "REST vs GraphQL" --mode consensus --shape debate
/tfx-auto "모놀리스 분해 전략" --mode consensus --shape panel --experts "claude:Fowler|Beck;codex:Newman|Hohpe;antigravity:Porter|Wiegers"
/tfx-auto "이벤트소싱 도입 여부 논쟁" --mode live --rounds 3       # = tfx-live peer 위임
```

### Consensus 출력 계약

`--mode consensus`의 shape별 입력과 결과를 작성할 때 [references/consensus-schema.md](references/consensus-schema.md)를 읽는다.

### Live 위임 계약 (`--mode live`)

`--mode live`는 Codex 분류/Claude 분해 트리아지를 건너뛰고 `tfx-live peer`(Claude↔Codex 실시간 세션 릴레이)로 직접 위임한다. **독립 엔진 위임**이며 `tfx-live`를 병합·재구현하지 않는다. `--parallel N`은 `tfx multi`를 위임한다.

v1은 `peer` 단일 경로만 지원한다. `--live-shape`, `--live-mode`, `tfx-auto`의 `orchestrate` 위임은 v2 예정이며 현재 파서·실행 계약에는 없다.

**적용 대상**: 서브태스크로 쪼갤 수 없는 왕복 대화형 작업(설계 논쟁, 경쟁 가설 조율, 두 모델이 서로 반박하며 수렴해야 하는 케이스). 독립적으로 병렬 처리 가능한 작업, 또는 가벼운 반박 1라운드면 `--mode consensus --shape debate`(배치형, 리드 중개, ≤2라운드, per-round 재시작 오버헤드 있음)가 더 저렴하다. `live`는 리드 중개 없이 세션이 직접 이어받으며 세션 상태를 유지해야 하는 경우에만 쓴다.

**tfx-auto의 배치 모델과 근본적으로 다른 지점**: 나머지 모든 모드(quick/deep/consensus)는 "분해 → dispatch → 결과 수집"의 stateless 배치 잡이다. `live`는 `tfx-live`가 관리하는 장수명 세션(daemon UDS attach 또는 지속 tmux 세션)에 얹혀가므로, verify/fix loop 같은 배치형 계약이 적용되지 않는다.

디스패치:

```bash
Bash("tfx-live peer --cli-a codex --cli-b claude \
  --session-a {sid}-a --session-b {sid}-b \
  --cwd {cwd} --mode freeform --seed '{task}' \
  --rounds {rounds} --timeout {timeout}", run_in_background=true)
```

**Closure**: `rounds * 2` hop 예산을 늘리지 않고 마지막 B(`--cli-b`) hop을 closure turn으로 대체한다. B는 `agreement_status`, `unresolved_questions`, `needs_more_rounds`를 포함한 구조화 선언을 반환해야 한다.

**상태 판정**: harness가 B의 자기선언과 독립적으로 판정한다. closure가 구조화되어 있고 `unresolved_questions=[]`, `needs_more_rounds=false`, `agreement_status=complete`일 때만 `status=complete`다. 검증·저장된 성공 hop이 1개 이상이면 그 외에는 `partial`, 0개면 `failed`다. timeout/transport 오류도 성공 hop이 있으면 `partial`이며 원인은 `exit_reason=timeout|transport_error`로 따로 남긴다.

**중단과 세션 정리**: SIGINT/SIGTERM은 transcript 수와 무관하게 `status=aborted`로 분리하고 `hops_completed`, `exit_reason=user_interrupt|terminated`를 남긴다. 첫 신호 뒤 3초 안에 transcript flush → status 기록 → session stop을 시도한다. stop이 3초를 넘기면 orphan tmux 세션은 허용하지만 transcript/status 파일은 보존한다. 두 번째 신호는 graceful 경로를 포기하고 즉시 종료한다.

**보고**: 배치 모드의 `=== OUTPUT ===` 대신 `tfx-live peer` JSON의 `status`, `exit_reason`, `hops_completed`, `transcript_path`, `status_path`를 위 규칙대로 해석하고 transcript를 요약한다.

### 파싱 규칙

- 플래그는 ARGUMENTS 어느 위치에든 올 수 있다. 순서 자유.
- 플래그 값은 공백 뒤 다음 토큰 (예: `--cli codex`). `=` 문법 (`--cli=codex`) 도 허용.
- 알 수 없는 플래그는 무시 후 warning. 작업 설명으로 포함.
- 플래그 제외한 나머지 텍스트를 작업 설명 `<task>` 로 추출.

## 트리아지

**자동 모드:**
1. 입력의 작업 범위와 CLI 레인을 분류한다.
2. Claude가 작업을 분해: `{graph_type: "INDEPENDENT|SEQUENTIAL|DAG", subtasks: [{id, description, scope, agent, mcp_profile, depends_on, context_output, context_input}]}`
3. 분류 결과가 없으면 Claude가 분류와 분해를 수행한다

**수동 모드 (`N:agent_type`):** Claude가 N개 서브태스크를 분해한다. N > 10 거부.

## --thorough 모드

`-t` 또는 `--thorough` 플래그 시 파이프라인 기반 실행.

```
분기점은 "실행 전략"이지 "계획"이 아님:

TRIAGE
  │
  ├─ [thorough] → PLAN → PRD
  │                       │
  │                       ├─ [1 task] → AUTO 직접 실행
  │                       └─ [2+ tasks] → 병렬 실행 (tfx multi)
  │                           │
  │                           └─ VERIFY → FIX loop → COMPLETE
  │
  └─ [quick] → [1 task] → fire-and-forget
               [2+ tasks] → TEAM EXEC → COLLECT → CLEANUP
```

### 단일 태스크 thorough

1. Plan: Codex architect → 결과를 `pipeline.writePlanFile()` 저장
2. PRD: Codex analyst → acceptance criteria 확정
3. Exec: tfx-auto 직접 실행 (아래 "실행" 섹션)
4. Verify: Codex verifier → 검증
5. 실패 시 Fix loop (최대 3회) → Exec 재실행
6. Complete

### 멀티 태스크 thorough

Plan/PRD는 tfx-auto에서 실행하고, 여러 작업의 실행은 `tfx multi`에 위임한다.
서브태스크 배열 + `thorough: true` 신호를 함께 전달하여 multi 측에서 verify/fix를 수행.

## 실행 전 컨텍스트

`tfx-auto --mode deep --parallel 1` 실행은 시작 전에 아래 입력을 확인한다.

1. task slug 를 생성한다.
2. 최근 관련 컨텍스트와 산출물을 탐색한다.
3. 현재 작업용 `context-snapshot.md` 를 생성한다.
4. ambiguity 가 높으면 `.tfx/plans/interview-*` 산출물을 우선 재사용한다.

권장 저장 경로:
- `.tfx/fullcycle/{run-id}/context-snapshot.md`

## 상태와 산출물 계약

deep/fullcycle 경로는 phase 별 산출물과 상태를 남긴다.

- 기본 아티팩트 디렉토리: `.tfx/fullcycle/{run-id}/`
- 최소 산출물: `context-snapshot.md`, `expanded-spec.md`, `implementation-plan.md`, `execution-summary.md`, `qa-findings.md`, `validation-decision.md`, `state.json`
- `state.json` 최소 필드: current phase, started_at, last_successful_phase, retry_count, failure_reason
- 재실행 시 전체를 처음부터 다시 돌리지 않는다. `state.json` 을 읽고 마지막 미완료 phase 부터 resume 한다.
- QA / Validation 재시도는 해당 phase 만 다시 실행한다.

deep/fullcycle 추가 규칙:
- `task slug` 와 `context-snapshot.md` 는 항상 같이 생성한다.
- `/deep-interview` 또는 기존 `.tfx/plans/interview-{timestamp}.md` 산출물이 있으면 raw prompt 대신 재사용한다.
- 동일한 실패 / 동일한 에러가 3회 반복되면 무한 루프를 중단하고 근본 이슈 보고서를 남긴다.

## 정리와 취소 규칙

- 성공 시 `state.json` 을 `complete` 상태로 기록하고 orphan state 가 남지 않도록 정리한다.
- 취소/비정상 종료 시에도 마지막 phase, `failure_reason`, 재개 힌트를 남겨 다음 실행에서 resume 가능해야 한다.
- cleanup 은 상태를 무조건 삭제하는 것이 아니라, 성공/취소 여부가 판별되도록 메타데이터를 남긴 뒤 정리한다.

## 멀티 태스크 라우팅 (트리아지 후)

> **트리아지 결과에 따라 실행 경로 결정.**
> v6.0.0부터 CLI 워커는 **Lead-Direct `auto`** 가 기본이다. Agent 래퍼는 불필요하며, 리드가 tmux/psmux 안이면 interactive pane으로 보인다.
> OS별 primary multiplexer는 macOS/Linux = tmux, Windows = psmux다. macOS에서 psmux 미설치는 fallback 사유가 아니다.

| 조건 | 실행 경로 | 엔진 |
|------|----------|------|
| 1개 + quick | tfx-auto 직접 실행 | tfx-route.sh |
| 1개 + thorough | tfx-auto 직접 실행 + verify/fix loop | tfx-route.sh |
| 2개+ + 코드 변경 없음 | `tfx multi` auto 실행 (리드 tmux/psmux면 interactive pane) | team runtime |
| 2개+ + 코드 변경 있음 | 태스크별 worktree에서 세션 하나씩 실행 | 개별 세션 또는 `Agent(isolation: worktree)` |
| 대화형 + primary multiplexer 없음 | tmux(macOS/Linux) 또는 psmux(Windows) 설치 안내 오류 | team runtime |
| 비TTY + primary multiplexer 없음 | headless | headless.mjs |

> **2개 이상 태스크에 코드 변경이 있으면 worktree를 나눠 세션마다 하나씩 실행한다.**
> `Agent()`를 사용하면 `isolation: worktree`를 지정한다. 코드 변경이 없는 병렬 작업은 `tfx multi`를 사용할 수 있다.
> `auto`가 interactive(tmux/psmux)로 결정되면 pane이 관찰 표면이고 native bridge는 off다. 명시적 headless만 native bridge default on이며, 필요 시 `--no-native-bridge-ui`로 opt-out 한다.

**전환 방법:**

```
thorough = args에 -t 또는 --thorough 포함

if subtasks.length >= 2 and code_change:
  → 태스크별 worktree 생성 또는 Agent(isolation: worktree)
  → 세션마다 태스크 하나씩 실행
else if subtasks.length >= 2:
  → Bash("tfx multi --assign 'cli:prompt:role' ...")
  → mux가 있으면 interactive pane, 비TTY에서 mux가 없으면 headless, 대화형에서 mux가 없으면 설치 오류
  → if thorough: verify → fix loop
else:
  if thorough:
    → Plan → PRD → 직접 실행 → Verify → Fix loop
  else:
    → tfx-auto 직접 실행 (아래)
```

### teammate mode 정책

기본 명령에서는 `--teammate-mode`를 **생략**한다. 이때 엔진의 `auto`가 리드 환경을 따라
결정한다. tmux/psmux가 있으면 interactive pane을 사용한다. 대화형 환경에서 mux가 없으면
설치 안내 오류로 끝낸다. 비TTY에서 mux가 없으면 headless로 실행한다.

`headless`는 다음처럼 명시적으로 선택할 수 있다.

```bash
Bash("tfx multi --teammate-mode headless --assign 'cli:prompt:role' ...", run_in_background=true)
```

- 사용자가 "조용히" 또는 "백그라운드로만"을 명시한 경우
- 원격/CI/non-TTY처럼 pane 관찰이 불가능하거나 가치가 없는 실행

워커 수만으로 headless로 자동 전환하는 임계값은 두지 않는다. pane 가독성은 화면·작업 성격에
따라 달라지므로, 많은 워커도 `auto`와 대시보드를 유지하고 필요하면 호출자가 위 플래그로
opt-in 한다. 명시적 `--teammate-mode headless`에서는 native bridge UI가 default on이고,
interactive(tmux/psmux)에서는 off다.

## 실행

### CLI 에이전트 (Codex/Antigravity)

```bash
# Level 0 / INDEPENDENT
Bash("bash ~/.claude/scripts/tfx-route.sh {agent} '{prompt}' {mcp_profile}", run_in_background=true)

# Level 1+ (컨텍스트 의존): 4번째=timeout(빈값), 5번째=context_file
Bash("bash ~/.claude/scripts/tfx-route.sh {agent} '{prompt}' {mcp_profile} '' .omc/context/{sid}/combined-{tid}.md", run_in_background=true)
```

### tmux 라이브 관전

개별 CLI 세션을 관전하거나 정리할 때 [references/tmux-observation.md](references/tmux-observation.md)를 읽는다.

### Claude 네이티브

```
Agent(subagent_type="oh-my-claudecode:{agent}", model="{model}", prompt="{prompt}", run_in_background=true)
# 컨텍스트 있으면 prompt에 <prior_context>...</prior_context> 추가
```

### 에이전트 매핑

| 입력 | CLI | MCP |
|------|-----|-----|
| codex / executor | Codex (기본 구현 프로필; 복잡 구현은 deep-executor 프로필) | implement |
| debugger / deep-executor | Codex (deep-executor 프로필) | implement |
| build-fixer | Codex (build-fixer 프로필) | implement |
| spark | Codex (spark 프로필) | implement |
| architect / planner / critic / analyst | Codex (deep-executor 프로필) | analyze |
| scientist / document-specialist | Codex | analyze |
| code-reviewer / security-reviewer / quality-reviewer | Codex (review) | review |
| antigravity / designer / writer | Antigravity | docs |
| explore / claude | Claude native | 없음 |
| test-engineer | Codex | implement |
| qa-tester | Codex review | review |
| verifier | Codex review (기본) / Claude native (TFX_VERIFIER_OVERRIDE=claude 시) | review / 없음 |

### MCP 프로필 자동 결정

| 에이전트 | MCP |
|----------|-----|
| executor, build-fixer, spark, debugger, deep-executor, test-engineer | implement |
| architect, planner, critic, analyst, scientist, document-specialist | analyze |
| code-reviewer, security-reviewer, quality-reviewer, qa-tester | review |
| designer, writer | docs |

### 결과 파싱

여기서 `failed`는 `tfx-route.sh`/CLI 종료 결과를 뜻한다. Claude Code `TaskUpdate` 상태값이 아니다.

| exit_code + status | 사용할 출력 |
|--------------------|-----------|
| 0 + success | `=== OUTPUT ===` 섹션 |
| 124 + timeout | `=== PARTIAL OUTPUT ===` |
| ≠0 + failed | STDERR → Claude fallback |

OUTPUT 추출: `echo "$result" | sed -n '/^=== OUTPUT ===/,/^=== /{/^=== OUTPUT ===/d;/^=== /d;p}'`

### 실패 처리

1차 → `Agent(subagent_type="oh-my-claudecode:executor", model="프로필 설정값")` fallback.
2차 연속 실패 → 실패 보고 + 성공 결과만 종합.

### 보고 형식

```markdown
## tfx-auto 완료
**모드**: {auto|manual} | **그래프**: {type} | **레벨**: {N}
| # | 서브태스크 | Agent | CLI | MCP | 레벨 | 상태 | 시간 |
### 워커 {n}: {제목}
(출력 요약)
```

## 필수 조건

- `~/.claude/scripts/tfx-route.sh` (필수)
- codex: `npm install -g @openai/codex` | antigravity: `curl -fsSL https://antigravity.google/cli/install.sh | bash`
- `--mode live` 전용: `tfx-live` CLI (triflux 번들, `bin/tfx-live.mjs`). UDS transport를 쓰면 살아있는 Claude daemon이 필요하며 데몬 미가용 시 tmux fallback 또는 `transport_error`로 판정한다

## 오류 참고

| 에러 | 처리 |
|------|------|
| `tfx-route.sh: not found` | tfx-route.sh 생성 |
| `codex/antigravity: not found` | npm install -g |
| timeout / failed (`tfx-route.sh` 결과) | stderr → Claude fallback |
| N > 10 | 10 이하로 조정 |
| 순환 의존 | 분해 재시도 |
| 컨텍스트 > 32KB | 비례 절삭 |
| `tfx-live: not found` | triflux 재설치/업데이트 안내, `--mode live` 중단 |
| UDS probe/attach 실패 | `tfx-live probe`로 재확인 후 tmux fallback 안내 (bug-report는 `tfx-live` 자체가 기록) |

> Claude Code `TaskUpdate`를 사용할 때는 `status: "failed"`를 쓰지 않는다.
> 실패 보고는 `status: "completed"` + `metadata.result: "failed"`로 표현한다.

## 문제 해결

`/tfx-doctor` 진단 | `/tfx-doctor --fix` 자동 수정 | `/tfx-doctor --reset` 캐시 초기화

## 상세 레퍼런스

DAG 알고리즘, 컨텍스트 머지 규칙, 보고서 상세는 `scripts/tfx-route.sh` 내부 주석 및 `hub/` 모듈 참조.
