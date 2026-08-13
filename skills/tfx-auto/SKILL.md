---
name: tfx-auto
description: >
  통합 CLI 오케스트레이터이자 실행 스킬 front door. 단일/병렬 구현·수정 작업을 자동 분류해
  Codex 우선으로 dispatch 하고, 명시 플래그로 mode/parallel/consensus 등 동작을 오버라이드한다.
  '코드 짜줘', '구현해줘', '만들어줘', '수정해줘', '고쳐줘', 'implement', 'build', 'fix' 같은
  구현/수정 요청에 사용. 플래그 상세는 argument-hint, 라우팅 정책은 .claude/rules/tfx-routing.md 참조.
argument-hint: "<command|task> [args...] [--cli auto|codex|antigravity|claude] [--mode quick|deep|consensus|live] [--rounds <N>] [--risk-tier auto|low|medium|high] [--shape consensus|debate|panel] [--cli-set triad|no-antigravity|custom] [--parallel 1|N|swarm] [--retry 0|1|ralph] [--isolation none|worktree] [--remote <host>|none] [--skill <name>]"
---

# tfx-auto — 통합 CLI 오케스트레이터

> **ARGUMENTS 처리**: 이 스킬이 `ARGUMENTS: <값>`과 함께 호출되면, 해당 값을 사용자 입력으로 취급하여
> 워크플로우의 첫 단계 입력으로 사용한다. ARGUMENTS가 비어있거나 없으면 기존 절차대로 사용자에게 입력을 요청한다.

### Step 0: 스마트 라우팅 (tfx-auto 진입 시 자동 실행)

preamble에서 routing-weights.json을 읽고, 사용자 입력을 분석하여 dispatch 결정.

```bash
SLUG=$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")
WEIGHTS_FILE="$HOME/.gstack/projects/$SLUG/routing-weights.json"
USER_MODE=""
if [ -f "$WEIGHTS_FILE" ]; then
  USER_MODE=$(node -e "
    const w=JSON.parse(require('fs').readFileSync('$WEIGHTS_FILE','utf8'));
    const m=w.weights?.mode_bias||{};
    const top=Object.entries(m).sort((a,b)=>b[1]-a[1])[0];
    if(top && top[1]>0.3) console.log(top[0]);
  " 2>/dev/null)
fi
echo "USER_PREFERRED_MODE: ${USER_MODE:-none}"
```

판단 기준 (우선순위 순):

0. **명시 플래그** (최우선, 추론 스킵): ARGUMENTS 에 `--cli`/`--mode`/`--risk-tier`/`--shape`/`--cli-set`/`--parallel`/`--retry`/`--isolation`/`--remote` 플래그가 있으면 분류/추론을 건너뛰고 플래그 값대로 즉시 dispatch. 자세한 플래그 동작은 아래 "플래그 오버라이드" 섹션 참조.
   - `--parallel swarm` → tfx-swarm 엔진 위임 (PRD 필요)
   - `--parallel N` → tfx-multi 엔진 위임 (`auto`: 리드 tmux면 interactive pane, 없으면 in-process)
   - `--cli codex|antigravity` → `TFX_CLI_MODE` 설정 + 단일 실행
   - `--mode deep` → `-t/--thorough` 동일 동작 (pipeline init)
   - `--risk-tier low|medium|high` → risk-tier 기준으로 verification 강도와 mode 결정
   - `--mode ...` 명시 시 `--risk-tier` 는 무시 (mode 우선)
   - `--mode consensus --shape debate|panel` → prompt ensemble fold 경로
   - `--mode live` → `tfx-live` 엔진 위임 (분해/트리아지 스킵)
   - `--retry ralph` → stderr 경고 후 bounded 3회 degrade (Phase 2 미구현)

1. **사용자 명시 키워드** (플래그 없을 때):
   - "swarm", "PRD 돌려", "격리해서", "충돌 없이 돌려" → `--parallel swarm --mode consensus --isolation worktree`
   - "병렬", "동시에", "multi", "협업"(단순 동시 작업 의미) → `--parallel N --mode deep` — 여기서 미리 swarm으로 단정하지 않는다. 실제 코드 변경이 여러 파일에 걸치면 "멀티 태스크 라우팅"의 자동 분류가 swarm으로 승격시킨다 ("병렬" 한 단어만으로 곧장 worktree 격리+3-CLI 합의까지 가는 건 과함)
   - "팀"은 모호하다: 서로 메시지를 주고받는 영속 협업을 원하면 정답은 OMC 네이티브 `/team`이고(tfx-auto 관할 밖), 그냥 여러 작업을 동시에 처리해달라는 뜻이면 바로 위 `--parallel N` 행을 따른다. "팀"만 보고 바로 `--parallel N`으로 단정하지 말고 어느 쪽인지 애매하면 되묻는다
   - "꼼꼼히", "제대로", "deep" → `--mode deep`
   - "끝까지", "멈추지마", "ralph" → `--retry ralph`
   - "codex로", "antigravity로" → `--cli codex` 또는 `--cli antigravity`
   - "원격으로", "다른 기기에서", "리모트로 돌려" → `--remote <host>` (`--parallel swarm` 자동 동반. host 미지정 시 `hosts.json` 목록에서 질의)
   - "논쟁시켜", "서로 반박하게 해", "계속 대화하면서 풀게", "왕복으로 주고받게" → `--mode live` (`tfx-live peer` 고정). "협업"/"팀"과 겹쳐 보여도 이 쪽은 "논쟁/반박/대화를 계속 이어간다"는 뉘앙스가 명시적으로 있을 때만 해당

2. **PRD 인자 분석**:
   - PRD 경로 2개 이상 → `--parallel swarm --mode consensus --isolation worktree`
   - PRD 1개 + XL 규모 → `--mode deep --parallel 1`

3. **선호도 가중치** (tiebreaker):
   - USER_PREFERRED_MODE가 있고 가중치 > 0.3이면 제안
   - "[tfx] 사용자 선호: {mode}. 이 모드로 실행할까요?" 1줄 표시
   - 응답 없으면 기본(auto) 진행

4. **기본**: 기존 tfx-auto 워크플로우 그대로 실행

정규화된 플래그를 현재 `tfx-auto` 실행 인자로 적용한다. legacy Skill 이름은 compatibility alias 문서에서만 다룬다.

라우팅 결정 후 1줄 표시:
```
[tfx] 규모: {S/M/L/XL}, 모드: {mode} ({profile}) — 오버라이드: /tfx-multi, /tfx-swarm 등
```

> **MANDATORY RULES**
>
> 1. **실행**: CLI 에이전트는 반드시 `Bash("bash ~/.claude/scripts/tfx-route.sh ...")`. Claude 네이티브(explore/verifier/test-engineer/qa-tester)만 `Agent()`.
> 2. **비용/편향 분리**: 실행 워커 비용은 Codex/Antigravity 우선으로 낮추되, consensus/debate/panel에서는 Claude/Opus를 최후수단이 아니라 counter-bias outvoice로 둔다. Claude가 실행을 맡는 경우는 명시적 `--cli claude`, Claude-native host role, 또는 fallback뿐이다.
> 2-a. **Anti-bias triad**: Triflux의 본가 목적은 Codex↔Claude 균형으로 단일 모델 편향을 줄이는 것이다. `triad`는 Claude/Opus(counter-bias outvoice) + Codex(implementation/reality check) + Antigravity(product/UX auxiliary)를 보존하고, disputed/minority view를 삭제하지 않는다.
> 2-b. **Claude effort**: Claude lane은 Claude Code CLI의 `--model`과 `--effort`를 사용한다. Triflux의 `CLI_EFFORT`/profile 값은 `low|medium|high|xhigh|max` Claude effort로 매핑한다(`ultracode`는 `claude --effort` 값이 아니라 하니스 모드이므로 기본 effort로 매핑된다). skill 문서가 모델 ID를 하드코딩하지 않는다.
> 3. **DAG**: SEQUENTIAL/DAG이면 레벨 기반 순차 실행. `.omc/context/{sid}/` 생성, context_output 저장, 실패 시 후속 SKIP.
> 4. **트리아지**: Codex `exec --full-auto` 분류 + Opus 인라인 분해. Agent 스폰 금지.
> 5. **thorough**: `-t`/`--thorough` 시 파이프라인 init 필수. 커맨드 숏컷은 항상 quick.
> 6. **직접 수정 금지**: implement/review/analyze 등 커맨드 숏컷 실행 시 절대로 Edit/Write 도구로 직접 코드를 수정하지 마라. 반드시 Bash(tfx-route.sh)를 통해 Codex/Antigravity에 위임하라. 작업이 아무리 사소해도 예외 없음.

## 모드

| 입력 형식 | 모드 | 트리아지 |
|-----------|------|----------|
| `/implement JWT 추가` | 커맨드 숏컷 (quick) | 없음 (즉시 실행) |
| `/tfx-auto "리팩터링 + UI"` | 자동 (quick) | Codex 분류 → Opus 분해 |
| `/tfx-auto -t "리팩터링 + UI"` | 자동 (thorough) | Codex 분류 → Opus 분해 → Pipeline |
| `/tfx-auto --thorough "리팩터링"` | 자동 (thorough) | `-t` 동일 |
| `/tfx-auto 3:codex "리뷰"` | 수동 (quick) | Opus 분해만 |

> **tfx-auto는 `--quick`이 기본.** 커맨드 숏컷·단일 실행에서 plan/verify 오버헤드가 불필요하기 때문.
> 멀티 태스크 시 tfx-multi로 전환되면 tfx-multi의 기본값(`--thorough`)이 적용된다.

## 플래그 오버라이드 (명시 제어, Phase 2 v10.9.33+)

ARGUMENTS 에 아래 플래그가 있으면 Step 0 스마트 라우팅의 내부 추론을 건너뛰고 값대로 즉시 dispatch 한다. legacy tfx-codex/antigravity/multi/swarm 등을 이 플래그로 표현할 수 있게 되어, 기존 11개 실행 스킬의 front door 역할을 tfx-auto 가 맡는다.

### 플래그 표

| 플래그 | 값 | 효과 | 위임 엔진 |
|--------|-----|------|----------|
| `--cli` | `auto` (기본) | Codex 분류 후 최적 CLI 선택 | 기존 라우팅 |
| `--cli` | `codex` | Codex 전용 고정. `TFX_CLI_MODE=codex` | tfx-route.sh |
| `--cli` | `antigravity` | Antigravity CLI 고정. `TFX_CLI_MODE=antigravity` | tfx-route.sh |
| `--cli` | `claude` | Claude native 에이전트만 (CLI 호출 없음) | Agent() |
| `--mode` | `quick` (기본) | fire-and-forget, plan/verify 오버헤드 없음 | 직접 실행 |
| `--mode` | `deep` | pipeline init → plan → PRD → verify → fix loop | `-t/--thorough` 동일 |
| `--mode` | `consensus` | 3-CLI 합의 family 실행 | tfx-auto consensus root |
| `--mode` | `live` | 서브태스크 분해 불가한 왕복 대화형 작업을 직행 위임 | `tfx-live peer` (v1 단일 경로, 상세는 "Live 위임 계약" 절) |
| `--rounds` | `4` (기본) | live peer 왕복 횟수(총 hop 수는 `rounds * 2`) | `tfx-live peer --rounds` |
| `--risk-tier` | `auto` (기본) | changed files 기준 자동 분류 후 mode/verify 강도 결정 | risk matrix |
| `--risk-tier` | `low` | quick mode + verify skip | 기존 default 와 동일 |
| `--risk-tier` | `medium` | quick mode + verify (lint + test 만) | bounded verify |
| `--risk-tier` | `high` | deep mode + full verify/fix loop | pipeline + full verify |
| `--shape` | `consensus` (기본) | findings 합의/충돌 판정 | consensus renderer |
| `--shape` | `debate` | 옵션 비교 + 점수화 + 최종 추천 | debate renderer |
| `--shape` | `panel` | 전문가 roster 기반 시뮬레이션 | panel renderer |
| `--cli-set` | `triad` (기본) | Claude + Codex + Antigravity | consensus participants |
| `--cli-set` | `no-antigravity` | Claude/Opus outvoice + Codex partial degrade | consensus participants |
| `--cli-set` | `custom` | 기존 3 CLI 내부 subset/repetition 만 허용 | consensus participants |
| `--options` | `"A|B|C"` | debate 비교 대상 | debate normalizer |
| `--criteria` | `"latency|complexity|operability"` | debate 평가 기준 | debate normalizer |
| `--experts` | `"claude:...;codex:...;antigravity:..."` | panel roster override | panel normalizer |
| `--analysis-prompt-file` | `<path>` | consensus family 공통 분석 프롬프트 주입 | consensus normalizer |
| `--parallel` | `1` (기본) | 단일 워커 | tfx-route.sh |
| `--parallel` | `N` | 로컬 병렬 (mode 생략=`auto`; 리드 tmux면 interactive pane, 없으면 in-process) | `tfx multi` |
| `--parallel` | `swarm` | worktree 격리 + 다기기 | `tfx swarm` (PRD 필요) |
| `--no-native-bridge-ui` | true | 명시적 headless worker의 Claude agents UI 노출을 비활성화 | `tfx multi` |
| `--retry` | `0` | 자동 재시도 없음 | — |
| `--retry` | `1` (기본) | bounded verify → fix loop 3회 | — |
| `--retry` | `ralph` | **Phase 3** — true ralph state machine (unlimited, stuck detector 3회 중단) | retry-state-machine.mjs |
| `--retry` | `auto-escalate` | **Phase 3** — 프로필 기반 체인 승격 | retry-state-machine.mjs |
| `--isolation` | `none` (기본) | cwd 공유 | — |
| `--isolation` | `worktree` | shard별 `.codex-swarm/wt-*/` 격리 | `--parallel swarm` 자동 강제 |
| `--remote` | `none` (기본) | 로컬만 | — |
| `--remote` | `<host>` | hosts.json 의 host 로 shard 분배 | `--parallel swarm` 전용 |
| `--lead` | `claude` (기본) | 분류·메타판단을 Claude 가 담당 | tfx-auto 내장 |
| `--lead` | `codex` | 분류·메타판단을 Codex 에 위임 (tfx-auto-codex 의미 일부 흡수) | tfx-route.sh |
| `--no-claude-native` | false (기본) | Claude native sub-agent 경로 유지 | — |
| `--no-claude-native` | true | Claude native 경로 disable, CLI 기반 worker 강제 | tfx-route.sh |
| `--max-iterations` | `0` (기본, unlimited) | `--retry ralph`/`auto-escalate` 상한 | retry-state-machine.mjs |
| `--skill` | `<name>` | `skills/<name>/SKILL.md` 본문을 codex/agy 프롬프트 앞에 주입 (`TFX_INJECT_SKILL`). 미지정 시 no-op | tfx-route.sh |

### `--risk-tier` 계약

- 기본값은 `auto`.
- `--mode` 가 명시되면 `--risk-tier` 는 무시된다. mode 가 최종 우선순위다.
- `--risk-tier` 만 명시되면 tier 가 mode 를 자동 결정한다.
- `low` → quick mode + verify skip.
- `medium` → quick mode + verify (lint + test 만).
- `high` → deep mode + full verify/fix loop.
- `auto` → 아래 변경 분류 매트릭스로 tier 를 계산한다.
- auto 분류 입력은 **staged + unstaged 전체 변경 파일** 기준이다. untracked 파일도 relative path 집합에 포함해 판정한다.

### 자동 분류 매트릭스

`hub/lib/risk-tier.mjs` 의 `classifyRiskTier({ changedFiles })` 계약을 기준으로 적용한다. 판정 순서는 **high → medium → low → default** 이다.

| tier | 규칙 | 판정 기준 |
|------|------|----------|
| `high` | 아키텍처/배포/운영 핵심 경로 | `hub/`, `scripts/`, `.claude/rules/`, `bin/`, `.github/` prefix 중 하나라도 매칭 |
| `medium` | 빌드/설정/런타임 영향 | 다중 파일 변경, `package.json`, `.yml/.yaml`, `.toml`, `config/`, `hooks/` 매칭 |
| `low` | 문서/텍스트/테스트-only | 단일 파일 + non-config (`.md`/`.txt` 만) 또는 `.test` 파일만 |
| default | 안전 fallback | 어떤 low/high 패턴에도 안 맞으면 `medium` |

### 플래그 검증

- `--mode ...` + `--risk-tier ...` 동시 지정 → mode 우선. risk-tier 는 informational 로그만 남기고 실행 결정에는 사용하지 않음
- `--parallel swarm` + PRD 없음 → PRD 자동 생성 또는 사용자에게 경로 질의
- `--parallel 1` + `--isolation worktree` → warning, isolation=none 으로 강제
- `--remote <host>` + `--parallel != swarm` → warning, remote 무시
- `--shape` 미지정 + `--mode consensus` → `shape=consensus`
- `--shape` 지정 + `--mode != consensus` → warning 또는 error. shape 는 consensus family 에서만 유효
- `--cli-set custom` + 기존 3 CLI 외 participant 지정 → 즉시 error. silent fallback 금지
- `--retry ralph` → true ralph state machine (Phase 3, retry-state-machine.mjs)
- `--retry auto-escalate` → CLI 승격 체인 (Phase 3)
- `--max-iterations N` (N>0) → ralph/auto-escalate 에 상한 부여
- `--skill <name>` → `TFX_INJECT_SKILL=<name>` 로 tfx-route.sh 에 전달. 스킬 파일 부재 시 warning 후 주입 생략 (fail-open, 작업은 계속)
- `--mode live` + `--parallel`/`--isolation`/`--retry ralph`/`--remote` 동시 지정 → warning 후 무시. 라이브 세션은 배치 병렬·worktree 격리·재시도 상태머신 모델과 호환되지 않는다
- `--rounds` 지정 + `--mode != live` → warning 후 무시

### 스킬 주입 (`--skill <name>`)

codex/agy 워커 프롬프트 앞에 등록된 스킬의 방법론을 주입하는 **opt-in** 프레임워크. 설계 근거는 `decision-skill-passing` (omc 레퍼런스 + codex/agy 네이티브 스킬 조사):

- **메커니즘**: `--skill <name>` → tfx-route.sh `TFX_INJECT_SKILL=<name>`. `skills/<name>/SKILL.md` 본문을 `--- SKILL: <name> (apply this methodology...) ---` delimited block 으로 프롬프트 앞에 prepend. codex·agy 레인 공통 (CLI-agnostic, `prepend_skill`).
- **기본 off**: 미지정이면 no-op → 현행 동작 그대로. 회귀 위험 없음.
- **파싱 안전**: prepend 는 `printf`/`cat` → temp file 만 사용. codex 는 argv `--` 뒤, agy 는 stdin `printf %s` 로 전달되므로 `$`(codex)·`₩`/백슬래시(agy) 같은 특수문자를 셸 재확장 없이 **리터럴 보존**. 스킬 본문을 그대로 넘겨도 깨지지 않음.
- **네이티브 스킬을 안 쓰는 이유**: codex `$skill-name`/`/name` 슬래시와 agy `/name` 은 둘 다 **인터랙티브 TUI 전용** → headless one-shot 에서 named-skill 강제 호출 불가 (미문서). 그래서 prose 주입을 채택 (레퍼런스 omc 도 role .md 를 raw prepend, 네이티브 회피).

#### 커맨드→스킬 매핑 (tfx-auto convention, opt-in)

tfx-auto 가 커맨드/agent 별로 주입할 스킬을 고를 때 쓰는 **권고 테이블**. 기본은 매핑 없음 (명시 `--skill` 만 작동) — 부적절한 스킬이 모든 프롬프트에 새는 것을 막는다. 프로젝트가 명시적으로 활성화할 때만 아래를 적용해 `--skill` 을 자동 부여한다.

| 커맨드/agent | 권고 스킬 | 비고 |
|--------------|-----------|------|
| (기본) | 없음 | explicit `--skill` 우선 |
| 프로젝트 정의 | 프로젝트가 지정 | 활성화 시 tfx-auto 가 해당 `--skill` set |

> 매핑된 스킬 파일이 없으면 `prepend_skill` 이 warning 후 주입을 생략한다 (fail-open). 존재하지 않는 매핑을 "주입됨"으로 가정하지 않는다.

#### agy anti-overclaim (자동, agy 레인 전용)

agy 레인은 `TFX_AGY_ANTI_OVERCLAIM`(기본 on) 으로 완료/grounding 규율 블록을 프롬프트 **END** 에 자동 append (`append_agy_anti_overclaim`). Gemini 3.x 과신(AA-Omniscience 실측: 정확도 53-56% 대비 환각률 88-91%) 대응:

- fresh 증거 없이 done/fixed/passing 주장 금지.
- 검증 불가 시 `No Info / 확인 불가` 후 중단 (날조 금지).
- 추론은 주어진 context 로, confident guessing 보다 accurate abstention 우선.

부정 제약은 Gemini 3 공식 가이드대로 **END 배치**하고 blanket "do not guess" 는 역효과라 피한다. opt-out: `TFX_AGY_ANTI_OVERCLAIM=0`.

### Retry state machine 계약 (legacy autoroute / persist 이관)

`--retry ralph` 와 `--retry auto-escalate` 는 모두 `hub/team/retry-state-machine.mjs` 를 사용한다.

- `--retry ralph` 는 **true ralph state machine** 으로 동작한다. 기본값 `--max-iterations 0` 은 unlimited 의미다.
- 실행 상태는 `.omc/state/ralph-<sessionId>.json` 에 append 저장한다. `resumeFromStateFile()` 로 재개 가능해야 한다.
- 동일 `failureReason` 이 3회 연속 반복되면 `stuckCounter` 가 올라가고 `STUCK` 으로 중단한다.
- `--retry auto-escalate` 는 `DEFAULT_ESCALATION_CHAIN` 을 기본으로 사용한다. 커스텀 체인이 필요하면 `.triflux/config/escalation-chain.json` 으로 override 한다.

`DEFAULT_ESCALATION_CHAIN`
정확한 모델 ID는 `.claude/rules/tfx-escalation-chain.md`와 CLI 프로필 설정을 따른다.

1. codex : 표준 코드/추론 프로필 (profile optional; 미지정 시 config 기본값)
2. claude : 최종 수단 프로필

커스텀 체인은 `.triflux/config/escalation-chain.json` 으로 override 한다.

체인 규칙:
- 각 단계에서 `max-iterations` 를 모두 소진하면 다음 CLI/모델로 전이한다.
- 체인 끝까지 소진하면 `BUDGET_EXCEEDED` 와 `reason: "escalation-chain-exhausted"` 를 기록한다.
- 체인 항목은 optional `profile` 필드를 지원한다. 값이 있으면 파싱/전달만 하고, 없으면 기존 CLI/config 기본 동작을 따른다.

### Codex lead 계약 (legacy auto-codex 이관)

`--cli codex --lead codex --no-claude-native` 조합이 `tfx-auto-codex` 의 canonical 표현이다.

- `--cli codex` 는 CLI 워커를 Codex 로 고정한다.
- `--lead codex` 는 분류·메타판단도 Codex 가 담당하게 한다.
- `--no-claude-native` 는 Claude native sub-agent 경로를 끄고 CLI 기반 worker 만 허용한다.
- 하위 호환 env `TFX_NO_CLAUDE_NATIVE=1` 는 계속 읽되, 플래그가 우선한다.

### 사용 예시

```
/tfx-auto "리팩터링" --mode deep               # = 기존 -t/--thorough
/tfx-auto "구현" --cli codex                   # = legacy tfx-codex
/tfx-auto "문서만 수정" --risk-tier low        # = quick + verify skip
/tfx-auto "설정/빌드 손봄" --risk-tier medium  # = quick + lint/test verify
/tfx-auto "hub 라우팅 개편" --risk-tier high   # = deep + full verify/fix loop
/tfx-auto "병렬" --parallel N --mode deep      # = legacy tfx-multi 기본값
/tfx-auto "PRD 실행" --parallel swarm          # = legacy tfx-swarm
/tfx-auto "REST vs GraphQL" --mode consensus --shape debate
/tfx-auto "모놀리스 분해 전략" --mode consensus --shape panel --experts "claude:Fowler|Beck;codex:Newman|Hohpe;antigravity:Porter|Wiegers"
/tfx-auto "이벤트소싱 도입 여부 논쟁" --mode live --rounds 3       # = tfx-live peer 위임
```

### Consensus shape 계약 (Phase 4a — ensemble fold)

`--mode consensus` 는 orchestration family 를 뜻하고, `--shape` 는 그 family 내부의 출력/해석 surface 를 뜻한다.

- `--mode consensus --shape consensus` → 기존 `tfx-consensus`
- `--mode consensus --shape debate` → 기존 `tfx-debate`
- `--mode consensus --shape panel` → 기존 `tfx-panel`

canonical 호출:

```bash
tfx-auto \
  "<task or topic>" \
  --mode consensus \
  --shape consensus|debate|panel \
  --cli-set triad|no-antigravity|custom \
  [--experts "..."] \
  [--options "..."] \
  [--criteria "..."] \
  [--analysis-prompt-file <path>]
```

shape 의미:

| `--shape` | 의미 | orchestration 차이 |
|-----------|------|-------------------|
| `consensus` | 3-CLI findings 합의/충돌 판정 | 기존 `tfx-consensus` 의미 |
| `debate` | 옵션 비교 + ranking/recommendation | 옵션/criteria renderer |
| `panel` | 전문가 역할 시뮬레이션 | expert roster + panel renderer |

`--cli-set` 규약:

| 값 | 의미 | 비고 |
|----|------|------|
| `triad` | Claude/Opus outvoice + Codex + Antigravity | 기본값 |
| `no-antigravity` | Claude/Opus outvoice + Codex | Antigravity 미가용 degrade |
| `custom` | 기존 3 CLI 내부 subset/repetition 만 허용 | 신규 provider 추가 금지 |

shape 입력 정규화:

```json
{
  "mode": "consensus",
  "shape": "consensus|debate|panel",
  "topic": "...",
  "cli_set": "triad",
  "participants": ["claude", "codex", "antigravity"],
  "context": "...",
  "analysis_prompt": "...",
  "shape_input": {}
}
```

shape 별 `shape_input`:

```json
{
  "consensus": {
    "analysis_prompt_file": "optional-path",
    "resolution_threshold": 70
  },
  "debate": {
    "options": ["A", "B", "C"],
    "criteria": ["latency", "complexity", "operability"]
  },
  "panel": {
    "experts": {
      "claude": ["Martin Fowler", "Kent Beck"],
      "codex": ["Sam Newman", "Gregor Hohpe"],
      "antigravity": ["Michael Porter", "Karl Wiegers"]
    }
  }
}
```

공통 orchestration 루프:

1. ARGUMENTS + 플래그 파싱
2. `--mode consensus` 확인
3. `--shape` 기본값 보정 (`consensus`)
4. shape 별 payload 정규화
5. Claude/Opus outvoice + headless Codex/Antigravity 동시 dispatch
6. 결과 수집
7. 공통 `meta_judgment` 생성
8. shape renderer 로 markdown/json 출력
9. artifact 저장

공통 메타/렌더링 계약:

- 공통 유틸: `hub/team/consensus-meta.mjs`
- 공통 `meta_judgment` 스키마:

```json
{
  "severity_classification": { "p1": [], "p2": [], "p3": [] },
  "consensus_vs_dispute": { "agreements": [], "conflicts": [] },
  "recommended_action": "merge|FIX_FIRST|close|defer|split",
  "followup_issues": [],
  "mode_specific_meta": {}
}
```

- 공통 root 메타:

```json
{
  "mode": "consensus",
  "shape": "consensus|debate|panel",
  "topic": "...",
  "cli_set": "triad",
  "participants": [
    { "name": "claude", "status": "success" },
    { "name": "codex", "status": "success" },
    { "name": "antigravity", "status": "timeout" }
  ],
  "status": "complete|partial|needs_user_input"
}
```

- 필수 markdown 섹션:
  - `shape=consensus`: `합의 결과`, `Consensus Score`, `합의 항목`, `disputed items`, `resolved items`, `user decision needed`, `meta judgment`
  - `shape=debate`: `토론 결과`, `비교 대상`, `평가 기준`, `합의 사항`, `최종 추천`, `리스크 및 완화 방안`, `meta judgment`
  - `shape=panel`: `전문가 패널 보고서`, `패널 구성`, `패널 합의`, `소수 견해`, `핵심 추천`, `미해결 쟁점`, `다음 단계`, `meta judgment`

- artifact 경로:
- markdown: `.omc/artifacts/consensus/<session-id>/<shape>.md`
- json: `.omc/artifacts/consensus/<session-id>/<shape>.json`

shape 별 orchestration 정책:

#### `shape=consensus`

정책:

- 목적: 각 participant 의 findings 를 합의/충돌 항목으로 압축하고 `FIX_FIRST` / `merge` / `defer` 같은 실행 결정을 빠르게 내린다.
- 수집 단위: 옵션 비교가 아니라 finding/assertion 단위다. 동일 결론이라도 근거가 다르면 separate evidence 로 보존한다.
- 합의 판정: 3자 중 2자 이상이 같은 remediation 또는 risk assessment 를 지지하면 provisional agreement 로 분류하고, Claude/Opus outvoice가 반론을 제공하고 lead가 최종 `resolved_items` 승격 여부를 결정한다.
- 충돌 승격: P1/P2 급 충돌은 score 와 무관하게 `user_decision_needed` 또는 `FIX_FIRST` 로 승격한다. score 가 높아도 안전 이슈를 묻지 않는다.
- degrade: `no-antigravity` 또는 partial timeout 시 2자 합의를 허용하되 root meta 의 `status=partial` 과 누락 participant 이유를 반드시 남긴다.

출력 schema 예시:

```json
{
  "mode": "consensus",
  "shape": "consensus",
  "topic": "Phase 5 alias removal readiness",
  "cli_set": "triad",
  "participants": [
    { "name": "claude", "status": "success" },
    { "name": "codex", "status": "success" },
    { "name": "antigravity", "status": "success" }
  ],
  "status": "complete",
  "shape_output": {
    "consensus_score": 82,
    "consensus_items": [
      "15 legacy alias can be removed after usage reaches zero",
      "alias usage gate must be verified before physical deletion"
    ],
    "disputed_items": [
      {
        "item": "Delete tfx-psmux-rules in same PR as remote aliases",
        "positions": {
          "claude": "defer",
          "codex": "proceed",
          "antigravity": "defer"
        },
        "severity": "p2"
      }
    ],
    "resolved_items": [
      "Delete consensus/debate/panel aliases after routing docs are updated"
    ],
    "user_decision_needed": [],
    "meta_judgment": {
      "severity_classification": {
        "p1": [],
        "p2": [
          "Remote alias removal ordering still disputed"
        ],
        "p3": []
      },
      "consensus_vs_dispute": {
        "agreements": [
          "Phase 5 requires zero alias usage before deletion"
        ],
        "conflicts": [
          "Remote alias deletion bundling"
        ]
      },
      "recommended_action": "FIX_FIRST",
      "followup_issues": [
        "Confirm remote migration docs before deleting remote aliases"
      ],
      "mode_specific_meta": {
        "threshold_passed": true,
        "needs_resolution_round": false
      }
    }
  }
}
```

#### `shape=debate`

정책:

- 목적: 2개 이상 옵션을 criteria 기반으로 비교하고 최종 추천안 1개를 만든다.
- 수집 단위: option x criterion matrix 다. participant 자유서술을 그대로 합치지 말고 각 옵션의 장단점/score 를 정규화한다.
- 라운드 운영: 1차 독립 평가 후 상위 2개 옵션 간 반론 라운드 1회를 허용한다. `--max-rounds` 로 늘리더라도 기본은 2라운드 이하로 제한한다.
- 추천 규칙: 단순 다수결이 아니라 weighted ranking 을 사용하되, P1 risk 가 있는 옵션은 총점이 높아도 최종 추천에서 제외 가능하다.
- criteria 누락: 사용자가 criteria 를 주지 않으면 latency, implementation complexity, operability, migration risk 를 기본 축으로 채운다.

출력 schema 예시:

```json
{
  "mode": "consensus",
  "shape": "debate",
  "topic": "REST vs GraphQL for triflux remote control API",
  "cli_set": "triad",
  "participants": [
    { "name": "claude", "status": "success" },
    { "name": "codex", "status": "success" },
    { "name": "antigravity", "status": "success" }
  ],
  "status": "complete",
  "shape_output": {
    "options": [
      "REST",
      "GraphQL"
    ],
    "criteria": [
      "latency",
      "complexity",
      "operability",
      "migration_risk"
    ],
    "scorecard": [
      {
        "option": "REST",
        "total_score": 84,
        "criterion_scores": {
          "latency": 86,
          "complexity": 88,
          "operability": 83,
          "migration_risk": 79
        }
      },
      {
        "option": "GraphQL",
        "total_score": 68,
        "criterion_scores": {
          "latency": 64,
          "complexity": 55,
          "operability": 70,
          "migration_risk": 83
        }
      }
    ],
    "agreements": [
      "REST is simpler to roll out incrementally"
    ],
    "disputes": [
      "GraphQL may reduce future overfetching but adds current operational complexity"
    ],
    "recommendation": {
      "winner": "REST",
      "decision_type": "majority_with_risk_adjustment",
      "why": "REST wins on complexity and operability while avoiding a new query layer"
    },
    "meta_judgment": {
      "severity_classification": {
        "p1": [],
        "p2": [
          "GraphQL rollout would widen migration scope"
        ],
        "p3": []
      },
      "consensus_vs_dispute": {
        "agreements": [
          "REST is lower risk for the current phase"
        ],
        "conflicts": [
          "Long-term schema flexibility payoff"
        ]
      },
      "recommended_action": "merge",
      "followup_issues": [
        "Re-evaluate GraphQL after remote surface stabilizes"
      ],
      "mode_specific_meta": {
        "rounds_run": 2,
        "winning_margin": 16
      }
    }
  }
}
```

#### `shape=panel`

정책:

- 목적: 전문가 roster 기반으로 관점이 다른 조언을 구조화하고 majority/minority view 를 명시한다.
- roster 규칙: `--experts` 미지정 시 기본 roster 를 채우되 각 CLI 가 서로 다른 전문성을 대표하도록 배분한다. 동일 전문가를 중복 배정하지 않는다.
- 발언 구조: participant raw answer 를 그대로 이어붙이지 말고 `expert -> thesis -> supporting evidence -> concern -> recommendation` 구조로 정리한다.
- 합의 규칙: panel 은 unanimity 보다 "majority view + minority view + open questions" 보존이 중요하다. minority 가 P1/P2 를 제기하면 별도 `open_questions` 로 승격한다.
- moderator 역할: Claude/Opus outvoice 는 moderator 로서 panel synthesis 를 담당하지만, 자기 의견을 추가 participant 처럼 중복 집계하지 않는다.

출력 schema 예시:

```json
{
  "mode": "consensus",
  "shape": "panel",
  "topic": "How should triflux remove 15 legacy aliases in Phase 5?",
  "cli_set": "triad",
  "participants": [
    { "name": "claude", "status": "success" },
    { "name": "codex", "status": "success" },
    { "name": "antigravity", "status": "success" }
  ],
  "status": "complete",
  "shape_output": {
    "panelists": [
      { "cli": "claude", "experts": ["Martin Fowler", "Kent Beck"] },
      { "cli": "codex", "experts": ["Sam Newman", "Gregor Hohpe"] },
      { "cli": "antigravity", "experts": ["Michael Porter", "Karl Wiegers"] }
    ],
    "majority_view": "Delete routing aliases first, then consensus family, then remote aliases after usage and docs converge",
    "minority_views": [
      {
        "position": "Delete remote aliases together with consensus family in one release",
        "supporters": ["Sam Newman"],
        "severity": "p3"
      }
    ],
    "open_questions": [
      "Should tfx-psmux-rules be deleted in the same PR as tfx-remote-setup/spawn?"
    ],
    "action_items": [
      "Verify alias-usage.log aggregate is zero",
      "Update README and routing docs before physical deletion"
    ],
    "meta_judgment": {
      "severity_classification": {
        "p1": [],
        "p2": [
          "Docs drift would make remote alias deletion unsafe"
        ],
        "p3": []
      },
      "consensus_vs_dispute": {
        "agreements": [
          "Usage-zero gate is mandatory"
        ],
        "conflicts": [
          "Exact ordering of remote alias deletion"
        ]
      },
      "recommended_action": "split",
      "followup_issues": [
        "Run a repo-wide reference-zero audit before remote alias deletion"
      ],
      "mode_specific_meta": {
        "panel_size": 6,
        "moderator": "claude",
        "majority_strength": "5/6"
      }
    }
  }
}
```

### Live 위임 계약 (`--mode live`)

`--mode live`는 Codex 분류/Opus 분해 트리아지를 건너뛰고 `tfx-live peer`(Claude↔Codex 실시간 세션 릴레이)로 직접 위임한다. **독립 엔진 위임**이며 `tfx-live`를 병합·재구현하지 않는다 — `--parallel swarm`이 `tfx-swarm`을, `--parallel N`이 `tfx-multi`를 위임하는 것과 동일한 패턴이다.

v1은 `peer` 단일 경로만 지원한다. `--live-shape`, `--live-mode`, `tfx-auto`의 `orchestrate` 위임은 v2 예정이며 현재 파서·실행 계약에는 없다.

**적용 대상**: 서브태스크로 쪼갤 수 없는 왕복 대화형 작업(설계 논쟁, 경쟁 가설 조율, 두 모델이 서로 반박하며 수렴해야 하는 케이스). 독립적으로 병렬 처리 가능한 작업, 또는 가벼운 반박 1라운드면 `--mode consensus --shape debate`(배치형, 리드 중개, ≤2라운드, per-round 재시작 오버헤드 있음)가 더 저렴하다. `live`는 리드 중개 없이 세션이 직접 이어받으며 세션 상태를 유지해야 하는 경우에만 쓴다.

**tfx-auto의 배치 모델과 근본적으로 다른 지점**: 나머지 모든 모드(quick/deep/consensus)는 "분해 → dispatch → 결과 수집"의 stateless 배치 잡이다. `live`는 `tfx-live`가 관리하는 장수명 세션(daemon UDS attach 또는 지속 tmux 세션)에 얹혀가므로, verify/fix loop나 risk-tier 자동판정 같은 배치형 계약이 적용되지 않는다.

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

### Legacy 스킬 매핑

| legacy 스킬 | `tfx-auto` 등가 플래그 |
|------------|----------------------|
| `tfx-autopilot` | `(기본)` |
| `tfx-autoroute` | `--retry auto-escalate` (Phase 3) |
| `tfx-fullcycle` | `--mode deep --parallel 1` |
| `tfx-persist` | `--retry ralph` (Phase 3, unlimited) |
| `tfx-codex` | `--cli codex` |
| `tfx-antigravity` | `--cli antigravity` |
| `tfx-auto-codex` | `--cli codex --lead codex --no-claude-native` (Phase 3) |
| `tfx-consensus` | `--mode consensus` |
| `tfx-debate` | `--mode consensus --shape debate` |
| `tfx-panel` | `--mode consensus --shape panel` |
| `tfx-multi` | `--parallel N --mode deep` |
| `tfx-swarm` | `--parallel swarm --mode consensus --isolation worktree` |
| `tfx-codex-swarm` | `--parallel swarm --cli codex --isolation worktree` |

legacy 스킬은 thin alias 로 유지. 호출 시 stderr 에 `[deprecated] {legacy} -> use: tfx-auto --{flag} {value}` 1회 출력, stdout 머리부에 `[DEPRECATED]` 마커를 남기고 `.omc/state/alias-usage.log` 에 usage 를 append 한다. Phase 5 (v11) 에 물리 삭제.

Phase 5 삭제 게이트:
- 코드 검색에서 alias 파일 자체만 남아야 함
- integration + golden test 100% pass
- `.omc/state/alias-usage.log` 7일 집계 0

### 파싱 규칙

- 플래그는 ARGUMENTS 어느 위치에든 올 수 있다. 순서 자유.
- 플래그 값은 공백 뒤 다음 토큰 (예: `--cli codex`). `=` 문법 (`--cli=codex`) 도 허용.
- 알 수 없는 플래그는 무시 후 warning. 작업 설명으로 포함.
- 플래그 제외한 나머지 텍스트를 작업 설명 `<task>` 로 추출.

설계 근거: `.triflux/plans/phase2-tfx-run-design.md` (GitHub Issue `#112` umbrella Phase 2 산출물).

## 커맨드 숏컷

커맨드명 매칭 시 트리아지 없이 즉시 실행. 패턴: `Bash("bash ~/.claude/scripts/tfx-route.sh {에이전트} '{PROMPT}' {MCP}")`.

### Codex 직행

| 커맨드 | 에이전트 | MCP |
|--------|---------|-----|
| `implement` | executor | implement |
| `build` | build-fixer | implement |
| `research` | document-specialist | analyze |
| `brainstorm` | analyst | analyze |
| `design` | architect | analyze |
| `troubleshoot` | debugger | implement |
| `cleanup` | executor | implement |
| `pm` | planner | analyze |

### 2단계: `improve`

1단계 `code-reviewer '{PROMPT}' review` → 사용자 승인 → 2단계 `executor '리뷰 반영: {요약}' implement`

### 병렬

| 커맨드 | 에이전트들 (병렬, run_in_background=true) | MCP |
|--------|------------------------------------------|-----|
| `analyze` | quality-reviewer + security-reviewer | review |
| `spec-panel` | architect + analyst + critic | analyze |
| `business-panel` | analyst + architect | analyze |

### Antigravity 직행

| 커맨드 | 에이전트 | MCP |
|--------|---------|-----|
| `explain` | writer | docs |
| `document` | writer | docs |

### Claude 네이티브

| 커맨드 | 실행 |
|--------|------|
| `test` | `Agent(subagent_type="oh-my-claudecode:test-engineer", model="sonnet")` |
| `reflect` | `Bash(tfx-route.sh verifier '{PROMPT}' review)` (기본) / `Agent(subagent_type="oh-my-claudecode:verifier", model="sonnet")` (TFX_VERIFIER_OVERRIDE=claude 시) |

### 복합

| 커맨드 | 흐름 |
|--------|------|
| `estimate` | explore(haiku) → analyst(codex): 영향범위, 복잡도(S/M/L/XL), 리스크 |
| `index-repo` | explore(haiku) × 2 → Write(PROJECT_INDEX.md). mode=quick/update/full |

## 트리아지

**자동 모드:**
1. Codex 분류: `codex exec --full-auto --skip-git-repo-check` → JSON `{parts: [{description, agent: "codex|antigravity|claude"}]}`
2. Opus 인라인 분해: `{graph_type: "INDEPENDENT|SEQUENTIAL|DAG", subtasks: [{id, description, scope, agent, mcp_profile, depends_on, context_output, context_input}]}`
3. 실패 시 Opus가 직접 분류+분해

**수동 모드 (`N:agent_type`):** Codex 분류 건너뜀 → Opus가 N개 서브태스크 분해. N > 10 거부.

## --thorough 모드

`-t` 또는 `--thorough` 플래그 시 파이프라인 기반 실행. 커맨드 숏컷에서는 무시된다.

```
분기점은 "실행 전략"이지 "계획"이 아님:

TRIAGE
  │
  ├─ [thorough] → PIPELINE INIT(plan) → PLAN → PRD → [APPROVAL]
  │                                                      │
  │                                      ┌───────────────┤
  │                                      │               │
  │                                  [1 task]        [2+ tasks]
  │                                      │               │
  │                                  AUTO 직접 실행   TEAM EXEC (multi Phase 3)
  │                                      │               │
  │                                      └───────┬───────┘
  │                                              │
  │                                          VERIFY → FIX loop → COMPLETE
  │
  └─ [quick] → [1 task] → fire-and-forget
               [2+ tasks] → TEAM EXEC → COLLECT → CLEANUP
```

### 단일 태스크 thorough

1. `Bash("node hub/bridge.mjs pipeline-init --team ${sid}")` — 파이프라인 초기화 (phase: plan)
2. Plan: Codex architect → 결과를 `pipeline.writePlanFile()` 저장
3. PRD: Codex analyst → acceptance criteria 확정
4. `pipeline_advance_gated` → [Approval Gate] → 사용자 승인 대기
5. Exec: tfx-auto 직접 실행 (아래 "실행" 섹션)
6. Verify: Codex verifier → 검증
7. 실패 시 Fix loop (최대 3회) → Exec 재실행
8. Complete

### 멀티 태스크 thorough

Plan/PRD/Approval은 tfx-auto에서 실행, 그 후 tfx-multi Phase 3로 전환.
서브태스크 배열 + `thorough: true` 신호를 함께 전달하여 multi 측에서 verify/fix를 수행.

## PRE-CONTEXT GATE

legacy `tfx-fullcycle` 가 맡던 deep/fullcycle 계약은 `tfx-auto --mode deep --parallel 1` 로 이관되었다. Phase 1 시작 전 아래 intake 를 먼저 수행한다.

1. task slug 를 생성한다.
2. 최근 관련 컨텍스트와 산출물을 탐색한다.
3. 현재 작업용 `context-snapshot.md` 를 생성한다.
4. ambiguity 가 높으면 `.tfx/plans/interview-*` 산출물을 우선 재사용한다.

권장 저장 경로:
- `.tfx/fullcycle/{run-id}/context-snapshot.md`

## STATE & ARTIFACT CONTRACT

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

## CLEANUP & CANCEL RULES

- 성공 시 `state.json` 을 `complete` 상태로 기록하고 orphan state 가 남지 않도록 정리한다.
- 취소/비정상 종료 시에도 마지막 phase, `failure_reason`, 재개 힌트를 남겨 다음 실행에서 resume 가능해야 한다.
- cleanup 은 상태를 무조건 삭제하는 것이 아니라, 성공/취소 여부가 판별되도록 메타데이터를 남긴 뒤 정리한다.

## 멀티 태스크 라우팅 (트리아지 후)

> **트리아지 결과에 따라 실행 경로 결정.**
> v6.0.0부터 CLI 워커는 **Lead-Direct `auto`** 가 기본이다. Agent 래퍼는 불필요하며, 리드가 tmux/psmux 안이면 interactive pane으로 보인다.
> OS별 primary multiplexer는 macOS/Linux = tmux, Windows = psmux다. macOS에서 psmux 미설치는 fallback 사유가 아니다.

| 조건 | 실행 경로 | 엔진 |
|------|----------|------|
| 1개 + quick | tfx-auto 직접 실행 (fire-and-forget) | tfx-route.sh |
| 1개 + thorough | tfx-auto 직접 실행 + verify/fix loop | tfx-route.sh |
| 2개+ + quick | `tfx multi` auto 실행 (리드 tmux/psmux면 interactive pane) | team runtime |
| 2개+ + thorough | Plan/PRD/Approval 후 → auto 실행 + verify/fix | team runtime |
| primary multiplexer 없음 | Native/in-process fallback | native.mjs |

> **MANDATORY: 2개+ 서브태스크 시 `tfx multi` 엔진 필수 (teammate mode 생략 = `auto`)**
> `Agent()` 백그라운드나 `Bash(tfx-route.sh)` 개별 호출로 대체 금지.
> 반드시 아래 `Bash("tfx multi ...")` 명령으로 team runtime에 위임한다.
> `auto`가 interactive(tmux/psmux)로 결정되면 pane이 관찰 표면이고 native bridge는 off다. 명시적 headless만 native bridge default on이며, 필요 시 `--no-native-bridge-ui`로 opt-out 한다.

**전환 방법:**

```
thorough = args에 -t 또는 --thorough 포함

if subtasks.length >= 2:
  → Bash("tfx multi --auto-attach --dashboard --assign 'cli:prompt:role' ...")
  → 리드가 tmux/psmux이면 interactive pane, 없으면 Native/in-process fallback
  → if thorough: verify → fix loop
else:
  if thorough:
    → Pipeline init → Plan → PRD → Approval → 직접 실행 → Verify → Fix loop
  else:
    → tfx-auto 직접 실행 (아래)
```

### teammate mode 정책 — interactive 기본, headless opt-in

기본 명령에서는 `--teammate-mode`를 **생략**한다. 이때 엔진의 `auto`가 리드 환경을 따라
결정한다: 리드가 tmux/psmux 안이면 interactive pane, mux가 없으면 `in-process` fallback이다.
`in-process`는 워커 실행 위치를 바꾸는 fallback일 뿐 비대화형 background 실행을 뜻하는
`headless`와 같은 모드가 아니다.

`headless`는 다음처럼 **명시적으로** 선택할 때만 쓴다.

```bash
Bash("tfx multi --teammate-mode headless --assign 'cli:prompt:role' ...", run_in_background=true)
```

- 사용자가 "조용히" 또는 "백그라운드로만"을 명시한 경우
- 원격/CI/non-TTY처럼 pane 관찰이 불가능하거나 가치가 없는 실행

워커 수만으로 headless로 자동 전환하는 임계값은 두지 않는다. pane 가독성은 화면·작업 성격에
따라 달라지므로, 많은 워커도 `auto`와 대시보드를 유지하고 필요하면 호출자가 위 플래그로
opt-in 한다. 명시적 `--teammate-mode headless`에서는 native bridge UI가 default on이고,
interactive(tmux/psmux) 및 `in-process`에서는 off다.

## 실행

### CLI 에이전트 (Codex/Antigravity)

```bash
# Level 0 / INDEPENDENT
Bash("bash ~/.claude/scripts/tfx-route.sh {agent} '{prompt}' {mcp_profile}", run_in_background=true)

# Level 1+ (컨텍스트 의존) — 4번째=timeout(빈값), 5번째=context_file
Bash("bash ~/.claude/scripts/tfx-route.sh {agent} '{prompt}' {mcp_profile} '' .omc/context/{sid}/combined-{tid}.md", run_in_background=true)
```

### tmux 라이브 관전 (default)

**정책 SSOT**: `.claude/rules/tfx-execution-skill-map.md`의 `CLI tmux 관전 기본값`이 개별 CLI 디스패치를 언제 tmux로 관전할지 정한다.
이 절은 그 정책을 구현하는 세션 생성·attach·정리·폭 배치 절차만 소유한다. 명시적 headless
선택은 rules의 예외대로 유지한다.

순서:

1. `createPsmuxSession` + `sendKeysToPane`(`hub/team/psmux.mjs`)으로 독립 세션을 만들고
   tfx-route.sh 커맨드를 흘려보낸다.
2. `tmux capture-pane`으로 폴링해 `[tfx-route] Codex 버전:` 같은 시작 배너를 확인한다.
3. 사용자가 attach해 있는 현재 tmux 창에 `tmux split-window` + `env -u TMUX`(nested-attach
   보호 해제)로 대상 세션에 attach한다.

정리는 반드시 `killPsmuxSession()`으로 한다 (raw `tmux kill-session` 금지 — detach →
pipe capture 해제 → pane 프로세스 트리 종료 → 세션 종료 → orphan 정리 5단계를 대신
해준다).

**분할 비율** (triflux 자체 관례 — OMC `main-vertical`의 고정 50:50과 다름):

| 상황 | 리더(기존 화면) : 워커전체 |
|------|---------------------------|
| 인터랙티브 워커 1개 이상 포함 | 5 : 5 |
| 전부 헤드리스 | 7 : 3 |

**워커 영역 배치 — 폭 우선**: 워커가 2개 이상이면 각 워커에 배정되는 폭이 **최소 100 cols**인지
먼저 계산한다. 현재 전체 폭을 `W`, 워커 수를 `N`이라고 할 때 pane border 전의 근사치는
`5:5`에서 `W × 0.5 ÷ N`, `7:3`에서 `W × 0.3 ÷ N`이다. tmux border는 실제 폭을 더 줄이므로
경계값에서는 세로 스택을 택한다.

| 조건 | 배치 |
|------|------|
| 워커당 확보 폭이 100 cols 이상 | 워커 영역을 가로로(좌우) 균등분할 |
| 워커당 확보 폭이 100 cols 미만 또는 측정 불가 | `tmux select-layout even-vertical` 세로 스택 |

`100 cols`는 `scripts/tfx-route.sh`가 출력하는 시작 배너를 실제 캡처 로그로 측정한
`executor` 116 cols, `deep-executor` 120 cols, `document-specialist` 127 cols와 실측 가독성
경계(54 cols 불가, 108 cols 가능) 사이에서 정했다. 따라서 한 줄 무개행을 보장하는 값이
아니라, 시작 배너가 한 번만 접힐 수 있는 최소 가독 폭이다.

예를 들어 `W=361`, 워커 2개이면 `5:5`는 워커당 약 90 cols, `7:3`은 약 54 cols라서 둘 다
세로 스택이다. 워커 3개면 각각 약 60/36 cols이며, 100 cols를 내려면 전체 폭이 `5:5`에서
최소 600 cols, `7:3`에서 최소 1000 cols가 필요하다. 따라서 3개 이상은 이 계산을 통과하는
드문 초광폭 화면이 아니면 세로 스택을 기본으로 한다.

**인터랙티브(진짜 TUI) 워커**: headless `codex exec`가 아니라 사람이 직접 타이핑
가능한 인터랙티브 세션이 필요하면 `tfx-live`를 쓴다 (raw `codex`/`agy` 직접 호출은
headless-guard가 차단하는 경로이므로 시도하지 않는다).

1. `tfx-live start --cli codex --session <name> --cwd <dir>` — 세션 생성.
2. 스킬 주입이 필요하면 `tfx-route.sh`의 `prepend_skill()` 포맷을 그대로 재현해
   프롬프트 앞에 붙인다 (tfx-live 자체엔 `--skill` 플래그가 없음):
   ```
   --- SKILL: <name> (workspace: <cwd>; apply this methodology to the task below) ---
   <skills/<name>/SKILL.md 본문>
   <실제 프롬프트>
   ```
3. `tfx-live ask --cli codex --session <name> --prompt "<스킬+프롬프트 합친 텍스트>" --timeout <n>`
   로 실행 지시. 이 호출이 실제로 처리 중인 걸 확인한 뒤에만 tmux attach한다 (위
   "순서" 절과 동일 원칙 — 빈 세션을 먼저 보여주지 않는다).
4. 종료는 `tfx-live stop --session <name> --cli codex` (내부적으로
   `tmux kill-session`을 호출하지만 tfx-live라는 sanctioned CLI 경유라 안전가드에
   안 걸린다 — 우리가 만든 psmux 세션에 쓰는 raw `tmux kill-session` 금지 규칙과는
   다른 케이스). 세션의 마지막 프로세스가 죽으면(사람이 직접 codex를 종료해도)
   tmux 세션 자체가 같이 사라진다 — `stop` 없이도 사람이 직접 끌 수 있다.

#### 운영 시나리오 (실측 검증됨)

**바쁜 상태 식별**: `ask`는 세션이 바쁜지 스스로 확인하지 않는다 — 바쁠 때 호출하면
그냥 텍스트를 그대로 밀어넣는다. 새 프롬프트 보내기 전에 먼저 확인:
```bash
tmux capture-pane -t <session> -p | grep -q "esc to interrupt" && echo BUSY
```
(`tfx-live`가 codex/claude 공통으로 이 문자열로 busy를 판정하는 것과 동일 로직.)

**인터럽트 후 즉시 새 프롬프트**: `tfx-live interrupt --session <name> --cli codex`
(Escape 전송) → 응답이 `aborted:true, reason:"user_interrupt"`이면 성공 → busy 해제
확인 후 곧바로 `ask` 호출 가능. 이 흐름은 실측 검증 완료.

**스킬 주입 실패 식별**: 두 가지 실패 모드가 있다.
- 기계적 실패(스킬 파일 없음): 프롬프트에 합치기 전에 `skills/<name>/SKILL.md` 존재를
  먼저 확인한다. 없으면 `tfx-route.sh`의 `prepend_skill()`과 동일하게 fail-open —
  경고만 하고 스킬 없이 원래 프롬프트로 진행한다.
- 정성적 실패(주입은 됐는데 codex가 방법론을 안 따름): 기계적으로 탐지할 수 없다.
  `response`에 스킬이 명시한 워크플로우 단계를 실제로 따른 흔적(예: tfx-find라면
  "Explored" 단계, Grep 사용 언급)이 있는지 사람이/Claude가 확인하는 수밖에 없다.

**이미 종료된 세션 resume**: `tfx-live start`의 `--resume <id>` / `--resume-last 1`로
codex 자체의 대화 이력을 새 tmux 세션에 이어붙인다. ID는 codex의 rollout 파일명에서
가져온다: `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl`
(또는 `~/.codex/session_index.jsonl`의 `id` 필드). 실측: 세션에 "42를 기억해"
시킨 뒤 `stop`으로 완전히 끄고, `--resume <id>`로 새 이름의 세션을 띄워 "아까 그
숫자가 뭐였지"라고 물으니 정확히 "42"라고 답함 — 컨텍스트가 진짜 이어짐을 확인.

**모델/effort — 새로 켤 때**: `tfx-live start --model <codex 모델 문자열> --effort <tier> ...`
가 codex의 `-c model=... -c model_reasoning_effort=...`로 직접 매핑된다. `tfx-route.sh`의
프로필 추상화(`gpt56_sol_xhigh` 등)와 달리 codex 고유 모델 ID/effort 값을 그대로 써야
한다 (프로필 이름 그대로 넣으면 안 됨).

**모델/effort 변경**: 현행 `tfx-live`는 시작 시 launch config로 모델과 effort를 전달한다.
실행 중인 세션의 `/model` 메뉴를 자동 조작하는 경로는 사용하지 않는다. 값을 바꿔야 하면
원하는 launch config로 새 세션을 시작하거나 기존 세션을 재시작한다. 모델 ID의 선택은
프로필/launch config의 책임이며 이 스킬 문서에 하드코딩하지 않는다.

**완료 판정/수집**: `ask`는 자체적으로 폴링한다 — done-marker 방식(제출한 프롬프트
이후 새 응답이 나타나는지) 또는 fallback(화면이 조용해지고 composer가 준비 상태고
busy가 아닌 상태가 일정 횟수 지속). 결과는 `response`(정제된 텍스트), `done`,
`matchedCompletion` 필드로 온다. `response`가 실제 답변인지와 셸 프롬프트 잔재가
섞이지 않았는지를 확인한다.

**Claude의 크로스세션 메시징과는 무관**: Claude Code 자체의 `SendMessage`(cross-session
messaging, 2.1.224+)는 여러 머신의 여러 Claude Code 세션끼리 통신하는 **클라이언트
레벨** 기능이다. `tfx-live`는 (지금 이 세션의) Claude가 별도 프로세스인 codex CLI와
통신하는 **triflux 레이어** 기능 — 완전히 다른 두 시스템이고 서로 의존하지 않는다.
이름에 "세션"이 같이 들어가서 헷갈릴 뿐이다.

**codex와의 통신이 진짜 메시지큐 수준인가**: 지금 쓰는 `start`/`ask` 경로는 tmux
paste-buffer로 텍스트를 밀어넣고 화면을 스크래핑해서 응답을 추출하는 방식 — 구조화된
메시지큐가 아니라 "터미널을 대신 조작"하는 수준이다. 진짜 구조화 채널은
`tfx-live orchestrate --codex-transport app-server-uds`(experimental)가 제공한다 —
`codex app-server`를 WebSocket-over-UDS로 띄워 JSON-RPC(RFC 6455)로 통신한다. 다만
이건 `orchestrate` 커맨드 전용 실험 경로이고, 지금 문서의 `start`/`ask` 흐름과는
별개다 — 기본값도 아니다.

### Claude 네이티브

```
Agent(subagent_type="oh-my-claudecode:{agent}", model="{model}", prompt="{prompt}", run_in_background=true)
# 컨텍스트 있으면 prompt에 <prior_context>...</prior_context> 추가
```

### 에이전트 매핑

| 입력 | CLI | MCP |
|------|-----|-----|
| codex / executor / spark | Codex (high; 복잡 구현은 deep-executor/xhigh) | implement |
| debugger / deep-executor | Codex (xhigh) | implement |
| build-fixer | Codex (low) | implement |
| architect / planner / critic / analyst | Codex (xhigh) | analyze |
| scientist / document-specialist | Codex | analyze |
| code-reviewer / security-reviewer / quality-reviewer | Codex (review) | review |
| antigravity / designer / writer | Antigravity | docs |
| explore / test-engineer / qa-tester | Claude native | — |
| verifier | Codex review (기본) / Claude native (TFX_VERIFIER_OVERRIDE=claude 시) | review / — |

### MCP 프로필 자동 결정

| 에이전트 | MCP |
|----------|-----|
| executor, build-fixer, spark, debugger, deep-executor | implement |
| architect, planner, critic, analyst, scientist, document-specialist | analyze |
| code-reviewer, security-reviewer, quality-reviewer | review |
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

1차 → `Agent(subagent_type="oh-my-claudecode:executor", model="sonnet")` fallback.
2차 연속 실패 → 실패 보고 + 성공 결과만 종합.

### 보고 형식

```markdown
## tfx-auto 완료
**모드**: {auto|manual} | **그래프**: {type} | **레벨**: {N}
| # | 서브태스크 | Agent | CLI | MCP | 레벨 | 상태 | 시간 |
### 워커 {n}: {제목}
(출력 요약)
### Token Savings Report
(node ~/.claude/scripts/token-snapshot.mjs report {session-id})
```

## 필수 조건

- `~/.claude/scripts/tfx-route.sh` (필수)
- codex: `npm install -g @openai/codex` | antigravity: `curl -fsSL https://antigravity.google/cli/install.sh | bash`
- `--mode live` 전용: `tfx-live` CLI (triflux 번들, `bin/tfx-live.mjs`). UDS transport를 쓰면 살아있는 Claude daemon이 필요하며 데몬 미가용 시 tmux fallback 또는 `transport_error`로 판정한다

## 에러 레퍼런스

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

## Troubleshooting

`/tfx-doctor` 진단 | `/tfx-doctor --fix` 자동 수정 | `/tfx-doctor --reset` 캐시 초기화

## 상세 레퍼런스

DAG 알고리즘, 컨텍스트 머지 규칙, 토큰 스냅샷, 보고서 상세는 `scripts/tfx-route.sh` 내부 주석 및 `hub/` 모듈 참조.
