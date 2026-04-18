# PRD: Phase 2 Step B — 9개 legacy skill 을 tfx-auto thin alias 로 변환

## 목표

triflux Phase 2 (Issue #112 umbrella) 의 Step B. 9개 legacy 실행 스킬의 SKILL.md 본문을 tfx-auto thin alias 로 교체한다. 각 스킬은 stderr deprecation 경고 후 `/tfx-auto` 를 해당 플래그 조합으로 호출한다.

tfx-auto 는 Phase 2 Step A 에서 플래그 오버라이드 (`--cli`, `--mode`, `--parallel`, `--retry`, `--isolation`, `--remote`) 가 이미 구현되어 있다.

## 대상 파일 (9개)

각 shard 당 1개 파일. `skills/tfx-{legacy}/SKILL.md` 를 전체 교체.

## 공통 제약 (모든 shard)

- 기존 frontmatter 의 `triggers` 배열 **보존** (키워드 자동 매칭 유지 목적)
- 기존 `name` 필드 그대로
- `description` 을 "DEPRECATED — tfx-auto ..." 로 교체
- `deprecated: true`, `superseded-by: tfx-auto` 추가
- 본문 전체를 thin alias 구조로 교체

## Codex 실행 제약 (자동 삽입됨)

- stdin redirect 금지: `codex < file` → "stdin is not a terminal" 에러
- `codex exec "$(cat prompt.md)" --dangerously-bypass-approvals-and-sandbox` 사용
- `codex exec` 는 `--profile` 미지원. config.toml 기본 모델 사용
- `--full-auto` CLI 플래그 금지 (config.toml sandbox 와 충돌)

## 완료 조건 (모든 shard 공통)

1. `skills/tfx-{legacy}/SKILL.md` 전체 교체
2. triggers 배열 원본 보존
3. `git add skills/tfx-{legacy}/SKILL.md && git commit -m "refactor(skills): convert tfx-{legacy} to thin alias for tfx-auto (#112)"`
4. packages/ 는 건드리지 말 것 (pack.mjs 별도 실행 예정)

---

## Shard: tfx-autopilot-alias

- files: skills/tfx-autopilot/SKILL.md
- critical: false
- prompt: |
    Convert skills/tfx-autopilot/SKILL.md to a thin alias for tfx-auto.

    STEP 1 - Read existing skills/tfx-autopilot/SKILL.md and extract the triggers array from frontmatter. You MUST preserve those triggers verbatim in the new file.

    STEP 2 - Replace the ENTIRE contents of skills/tfx-autopilot/SKILL.md with this exact content (substitute {{PRESERVED_TRIGGERS}} with the trigger lines you extracted in step 1, maintaining the YAML indentation with `  - `):

    ---
    name: tfx-autopilot
    description: >
      DEPRECATED — tfx-auto 로 통합됨. `/tfx-auto` 로 리다이렉트 (플래그 없음, 기본 동작 동일).
      Phase 5 (v11) 에 물리 삭제 예정. tfx-autopilot 은 tfx-auto 복제본이었으므로 플래그 없이 그대로 리다이렉트.
    deprecated: true
    superseded-by: tfx-auto
    triggers:
    {{PRESERVED_TRIGGERS}}
    argument-hint: "<작업 설명 — tfx-auto 로 passthrough>"
    ---

    # tfx-autopilot (DEPRECATED → tfx-auto alias)

    > DEPRECATED. 이 스킬은 `/tfx-auto` 로 리다이렉트된다. 실제 워크플로우는 tfx-auto 가 수행한다.
    > Phase 5 (v11) 에 물리 삭제 예정.

    ## 동작

    1. stderr 에 1회 deprecation 경고 출력:
       ```
       [deprecated] tfx-autopilot -> use: tfx-auto
       ```
    2. ARGUMENTS 를 그대로 `Skill("tfx-auto")` 에 전달한다 (추가 플래그 없음).
    3. tfx-auto 의 Step 0 스마트 라우팅과 플래그 오버라이드 로직이 나머지를 처리한다.

    ## 등가 플래그

    `(기본)` — 추가 플래그 없음.

    상세 동작은 `~/.claude/skills/tfx-auto/SKILL.md` 의 "플래그 오버라이드" 섹션 참조.

    ## 이 alias 의 의미

    tfx-autopilot 은 구현상 tfx-auto 의 복제본이었다. 별도 이름을 유지할 명분이 없어 tfx-auto 로 흡수. muscle memory 유지 목적으로 alias 만 남긴다.

    ## 마이그레이션 가이드

    | 기존 호출 | 새 호출 |
    |----------|---------|
    | `/tfx-autopilot "작업"` | `/tfx-auto "작업"` |

    muscle memory 는 그대로 동작. 새 작업부터는 `/tfx-auto` 를 직접 사용 권장.

    STEP 3 - Verify the file starts with `---` and has all required frontmatter fields.

    STEP 4 - `git add skills/tfx-autopilot/SKILL.md && git commit -m "refactor(skills): convert tfx-autopilot to thin alias for tfx-auto (#112)"`

    DO NOT modify any other files. DO NOT run pack.mjs (that happens after all shards complete).

---

## Shard: tfx-autoroute-alias

- files: skills/tfx-autoroute/SKILL.md
- critical: false
- prompt: |
    Convert skills/tfx-autoroute/SKILL.md to a thin alias for tfx-auto.

    STEP 1 - Read existing skills/tfx-autoroute/SKILL.md and extract the triggers array from frontmatter. Preserve verbatim.

    STEP 2 - Replace the entire file with (substitute {{PRESERVED_TRIGGERS}}):

    ---
    name: tfx-autoroute
    description: >
      DEPRECATED — tfx-auto 로 통합됨. `/tfx-auto --cli auto --retry 1` 로 리다이렉트.
      자동 승격 escalation 의미는 --retry 1 로 근사 표현. 완전한 escalation policy 는 Phase 3+ 에 --retry auto-escalate 로 도입 예정.
    deprecated: true
    superseded-by: tfx-auto
    triggers:
    {{PRESERVED_TRIGGERS}}
    argument-hint: "<작업 설명 — tfx-auto 로 passthrough>"
    ---

    # tfx-autoroute (DEPRECATED → tfx-auto alias)

    > DEPRECATED. `/tfx-auto --cli auto --retry 1` 로 리다이렉트. Phase 5 (v11) 에 물리 삭제.

    ## 동작

    1. stderr 에 1회 경고 출력:
       ```
       [deprecated] tfx-autoroute -> use: tfx-auto --cli auto --retry 1
       ```
    2. ARGUMENTS 전체 앞에 `--cli auto --retry 1` 를 prepend 하여 `Skill("tfx-auto")` 호출.
    3. tfx-auto 의 플래그 오버라이드 로직이 나머지 처리.

    ## 등가 플래그

    `--cli auto --retry 1`

    ## 이 alias 의 의미

    tfx-autoroute 의 "자동 승격 + 실패 시 더 강한 모델" 의미는 --cli auto + --retry 1 로 근사 표현된다. 완전한 IntentGate escalation chain (Haiku → Sonnet → Opus, Codex normal → xhigh) 은 Phase 3+ 에 별도 플래그로 노출 예정.

    ## 마이그레이션 가이드

    | 기존 호출 | 새 호출 |
    |----------|---------|
    | `/tfx-autoroute "작업"` | `/tfx-auto "작업" --cli auto --retry 1` |

    STEP 3 - `git add skills/tfx-autoroute/SKILL.md && git commit -m "refactor(skills): convert tfx-autoroute to thin alias for tfx-auto (#112)"`

    DO NOT modify any other files.

---

## Shard: tfx-fullcycle-alias

- files: skills/tfx-fullcycle/SKILL.md
- critical: false
- prompt: |
    Convert skills/tfx-fullcycle/SKILL.md to a thin alias for tfx-auto.

    STEP 1 - Read existing skills/tfx-fullcycle/SKILL.md and extract the triggers array. Preserve verbatim.

    STEP 2 - Replace entire file with (substitute {{PRESERVED_TRIGGERS}}):

    ---
    name: tfx-fullcycle
    description: >
      DEPRECATED — tfx-auto 로 통합됨. `/tfx-auto --mode deep --parallel 1` 로 리다이렉트.
      Phase 5 (v11) 에 물리 삭제 예정. "pipeline-thorough 단일 실행" 의미는 플래그로 동일 표현.
    deprecated: true
    superseded-by: tfx-auto
    triggers:
    {{PRESERVED_TRIGGERS}}
    argument-hint: "<작업 설명 — tfx-auto 로 passthrough>"
    ---

    # tfx-fullcycle (DEPRECATED → tfx-auto alias)

    > DEPRECATED. `/tfx-auto --mode deep --parallel 1` 로 리다이렉트. Phase 5 (v11) 에 물리 삭제.

    ## 동작

    1. stderr 에 1회 경고 출력:
       ```
       [deprecated] tfx-fullcycle -> use: tfx-auto --mode deep --parallel 1
       ```
    2. ARGUMENTS 전체 앞에 `--mode deep --parallel 1` 를 prepend 하여 `Skill("tfx-auto")` 호출.
    3. tfx-auto 의 플래그 오버라이드 로직이 나머지 처리.

    ## 등가 플래그

    `--mode deep --parallel 1`

    ## 이 alias 의 의미

    tfx-fullcycle 의 "pipeline-thorough 단일 실행" (plan → PRD → exec → verify → fix loop) 은 --mode deep --parallel 1 과 동일하다.

    ## 마이그레이션 가이드

    | 기존 호출 | 새 호출 |
    |----------|---------|
    | `/tfx-fullcycle "작업"` | `/tfx-auto "작업" --mode deep --parallel 1` |

    STEP 3 - `git add skills/tfx-fullcycle/SKILL.md && git commit -m "refactor(skills): convert tfx-fullcycle to thin alias for tfx-auto (#112)"`

    DO NOT modify any other files.

---

## Shard: tfx-persist-alias

- files: skills/tfx-persist/SKILL.md
- critical: false
- prompt: |
    Convert skills/tfx-persist/SKILL.md to a thin alias for tfx-auto.

    STEP 1 - Read existing skills/tfx-persist/SKILL.md and extract the triggers array. Preserve verbatim.

    STEP 2 - Replace entire file with (substitute {{PRESERVED_TRIGGERS}}):

    ---
    name: tfx-persist
    description: >
      DEPRECATED — tfx-auto 로 통합됨. `/tfx-auto --mode deep --retry ralph` 로 리다이렉트.
      ⚠ --retry ralph 는 Phase 2 현 구현에서 bounded retry 3회로 degrade 된다 (완전한 ralph state machine 은 Phase 3+).
      Phase 5 (v11) 에 물리 삭제 예정.
    deprecated: true
    superseded-by: tfx-auto
    triggers:
    {{PRESERVED_TRIGGERS}}
    argument-hint: "<작업 설명 — tfx-auto 로 passthrough>"
    ---

    # tfx-persist (DEPRECATED → tfx-auto alias)

    > DEPRECATED. `/tfx-auto --mode deep --retry ralph` 로 리다이렉트.
    > ⚠ --retry ralph 는 현재 bounded 3회로 degrade. 완전한 ralph state machine 은 Phase 3+.

    ## 동작

    1. stderr 에 1회 경고 출력:
       ```
       [deprecated] tfx-persist -> use: tfx-auto --mode deep --retry ralph
       ```
    2. ARGUMENTS 전체 앞에 `--mode deep --retry ralph` 를 prepend 하여 `Skill("tfx-auto")` 호출.
    3. tfx-auto 의 플래그 오버라이드 로직이 나머지 처리 (ralph 는 bounded degrade + stderr 경고).

    ## 등가 플래그

    `--mode deep --retry ralph`

    ## 이 alias 의 의미

    tfx-persist 는 이름상 ralph/persist 이지만 실제 구현은 bounded verify/fix 3회 루프였다. --retry ralph 로 **의도** 를 표현하되, Phase 2 단계에서는 여전히 bounded 로 동작하고 stderr 에 degrade 경고가 나간다. 진짜 ralph state machine (종료 조건, 상태 저장, 중단/재개) 은 Phase 3+ 에 별도 구현.

    ## 마이그레이션 가이드

    | 기존 호출 | 새 호출 |
    |----------|---------|
    | `/tfx-persist "작업"` | `/tfx-auto "작업" --mode deep --retry ralph` |

    STEP 3 - `git add skills/tfx-persist/SKILL.md && git commit -m "refactor(skills): convert tfx-persist to thin alias for tfx-auto (#112)"`

    DO NOT modify any other files.

---

## Shard: tfx-codex-alias

- files: skills/tfx-codex/SKILL.md
- critical: false
- prompt: |
    Convert skills/tfx-codex/SKILL.md to a thin alias for tfx-auto.

    STEP 1 - Read existing skills/tfx-codex/SKILL.md and extract the triggers array. Preserve verbatim.

    STEP 2 - Replace entire file with (substitute {{PRESERVED_TRIGGERS}}):

    ---
    name: tfx-codex
    description: >
      DEPRECATED — tfx-auto 로 통합됨. `/tfx-auto --cli codex` 로 리다이렉트.
      Phase 5 (v11) 에 물리 삭제 예정.
    deprecated: true
    superseded-by: tfx-auto
    triggers:
    {{PRESERVED_TRIGGERS}}
    argument-hint: "<작업 설명 — tfx-auto 로 passthrough>"
    ---

    # tfx-codex (DEPRECATED → tfx-auto alias)

    > DEPRECATED. `/tfx-auto --cli codex` 로 리다이렉트. Phase 5 (v11) 에 물리 삭제.

    ## 동작

    1. stderr 에 1회 경고 출력:
       ```
       [deprecated] tfx-codex -> use: tfx-auto --cli codex
       ```
    2. ARGUMENTS 전체 앞에 `--cli codex` 를 prepend 하여 `Skill("tfx-auto")` 호출.
    3. tfx-auto 의 플래그 오버라이드 로직이 나머지 처리 (TFX_CLI_MODE=codex).

    ## 등가 플래그

    `--cli codex`

    ## 이 alias 의 의미

    Codex CLI 전용 라우팅 고정. tfx-auto 의 --cli codex 플래그로 동일 의미 표현.

    ## 마이그레이션 가이드

    | 기존 호출 | 새 호출 |
    |----------|---------|
    | `/tfx-codex "작업"` | `/tfx-auto "작업" --cli codex` |

    STEP 3 - `git add skills/tfx-codex/SKILL.md && git commit -m "refactor(skills): convert tfx-codex to thin alias for tfx-auto (#112)"`

    DO NOT modify any other files.

---

## Shard: tfx-gemini-alias

- files: skills/tfx-gemini/SKILL.md
- critical: false
- prompt: |
    Convert skills/tfx-gemini/SKILL.md to a thin alias for tfx-auto.

    STEP 1 - Read existing skills/tfx-gemini/SKILL.md and extract the triggers array. Preserve verbatim.

    STEP 2 - Replace entire file with (substitute {{PRESERVED_TRIGGERS}}):

    ---
    name: tfx-gemini
    description: >
      DEPRECATED — tfx-auto 로 통합됨. `/tfx-auto --cli gemini` 로 리다이렉트.
      Phase 5 (v11) 에 물리 삭제 예정.
    deprecated: true
    superseded-by: tfx-auto
    triggers:
    {{PRESERVED_TRIGGERS}}
    argument-hint: "<작업 설명 — tfx-auto 로 passthrough>"
    ---

    # tfx-gemini (DEPRECATED → tfx-auto alias)

    > DEPRECATED. `/tfx-auto --cli gemini` 로 리다이렉트. Phase 5 (v11) 에 물리 삭제.

    ## 동작

    1. stderr 에 1회 경고 출력:
       ```
       [deprecated] tfx-gemini -> use: tfx-auto --cli gemini
       ```
    2. ARGUMENTS 전체 앞에 `--cli gemini` 를 prepend 하여 `Skill("tfx-auto")` 호출.
    3. tfx-auto 의 플래그 오버라이드 로직이 나머지 처리 (TFX_CLI_MODE=gemini).

    ## 등가 플래그

    `--cli gemini`

    ## 이 alias 의 의미

    Gemini CLI 전용 라우팅 고정. tfx-auto 의 --cli gemini 플래그로 동일 의미 표현.

    ## 마이그레이션 가이드

    | 기존 호출 | 새 호출 |
    |----------|---------|
    | `/tfx-gemini "작업"` | `/tfx-auto "작업" --cli gemini` |

    STEP 3 - `git add skills/tfx-gemini/SKILL.md && git commit -m "refactor(skills): convert tfx-gemini to thin alias for tfx-auto (#112)"`

    DO NOT modify any other files.

---

## Shard: tfx-auto-codex-alias

- files: skills/tfx-auto-codex/SKILL.md
- critical: false
- prompt: |
    Convert skills/tfx-auto-codex/SKILL.md to a thin alias for tfx-auto.

    STEP 1 - Read existing skills/tfx-auto-codex/SKILL.md and extract the triggers array. Preserve verbatim.

    STEP 2 - Replace entire file with (substitute {{PRESERVED_TRIGGERS}}):

    ---
    name: tfx-auto-codex
    description: >
      DEPRECATED — tfx-auto 로 통합됨. `/tfx-auto --cli codex` (+ TFX_NO_CLAUDE_NATIVE=1) 로 리다이렉트.
      Phase 5 (v11) 에 물리 삭제 예정. 완전한 "Codex lead + Gemini 유지 + Claude native 제거" 의미는 Phase 3+ 의 --lead codex + --no-claude-native 플래그로 표현.
    deprecated: true
    superseded-by: tfx-auto
    triggers:
    {{PRESERVED_TRIGGERS}}
    argument-hint: "<작업 설명 — tfx-auto 로 passthrough>"
    ---

    # tfx-auto-codex (DEPRECATED → tfx-auto alias)

    > DEPRECATED. `/tfx-auto --cli codex` + `TFX_NO_CLAUDE_NATIVE=1` 로 리다이렉트.
    > 완전한 의미는 Phase 3+ 에 --lead/--no-claude-native 플래그로 도입 예정.

    ## 동작

    1. stderr 에 1회 경고 출력:
       ```
       [deprecated] tfx-auto-codex -> use: tfx-auto --cli codex (+ TFX_NO_CLAUDE_NATIVE=1)
       ```
    2. 세션 env 에 `TFX_NO_CLAUDE_NATIVE=1` 를 설정한다 (tfx-auto 가 이 env 를 감지하여 Claude native 에이전트를 스킵).
    3. ARGUMENTS 전체 앞에 `--cli codex` 를 prepend 하여 `Skill("tfx-auto")` 호출.
    4. tfx-auto 의 플래그 오버라이드 로직이 나머지 처리.

    ## 등가 플래그

    `--cli codex` + env `TFX_NO_CLAUDE_NATIVE=1`

    ## 이 alias 의 의미

    tfx-auto-codex 는 "Codex lead + Gemini 유지 + Claude native 제거" 조합이었다. 현 플래그 축으로 완전 표현 어려워서, --cli codex (Codex 부분) + env TFX_NO_CLAUDE_NATIVE=1 (Claude native 제거) 로 근사. Phase 3+ 에 --lead codex + --no-claude-native 로 명시 도입 예정.

    ## 마이그레이션 가이드

    | 기존 호출 | 새 호출 |
    |----------|---------|
    | `/tfx-auto-codex "작업"` | `/tfx-auto "작업" --cli codex` (Claude native 유지 허용 시) |
    | `/tfx-auto-codex "작업"` | `TFX_NO_CLAUDE_NATIVE=1 /tfx-auto "작업" --cli codex` (엄격 Codex-only) |

    STEP 3 - `git add skills/tfx-auto-codex/SKILL.md && git commit -m "refactor(skills): convert tfx-auto-codex to thin alias for tfx-auto (#112)"`

    DO NOT modify any other files.

---

## Shard: tfx-multi-alias

- files: skills/tfx-multi/SKILL.md
- critical: false
- prompt: |
    Convert skills/tfx-multi/SKILL.md to a thin alias for tfx-auto.

    STEP 1 - Read existing skills/tfx-multi/SKILL.md and extract the triggers array. Preserve verbatim.

    STEP 2 - Replace entire file with (substitute {{PRESERVED_TRIGGERS}}):

    ---
    name: tfx-multi
    description: >
      DEPRECATED — tfx-auto 로 통합됨. `/tfx-auto --parallel N --mode deep` 로 리다이렉트.
      tfx-auto 가 이 플래그 조합을 받으면 내부적으로 `tfx multi --teammate-mode headless` 를 호출한다.
      Phase 5 (v11) 에 물리 삭제 예정.
    deprecated: true
    superseded-by: tfx-auto
    triggers:
    {{PRESERVED_TRIGGERS}}
    argument-hint: "<작업 설명 — tfx-auto 로 passthrough>"
    ---

    # tfx-multi (DEPRECATED → tfx-auto alias)

    > DEPRECATED. `/tfx-auto --parallel N --mode deep` 로 리다이렉트. Phase 5 (v11) 에 물리 삭제.

    ## 동작

    1. stderr 에 1회 경고 출력:
       ```
       [deprecated] tfx-multi -> use: tfx-auto --parallel N --mode deep
       ```
    2. ARGUMENTS 전체 앞에 `--parallel N --mode deep` 를 prepend 하여 `Skill("tfx-auto")` 호출.
    3. tfx-auto 의 플래그 오버라이드 로직이 내부적으로 `tfx multi --teammate-mode headless` 를 호출한다.

    ## 등가 플래그

    `--parallel N --mode deep`

    ## 이 alias 의 의미

    tfx-multi 의 "로컬 headless 병렬 + thorough 기본" 은 --parallel N --mode deep 과 동일. N 은 ARGUMENTS 에 구체 숫자가 있으면 그대로 전달, 없으면 tfx-auto 가 subtask 수 기반으로 판단한다.

    ## 마이그레이션 가이드

    | 기존 호출 | 새 호출 |
    |----------|---------|
    | `/tfx-multi "작업"` | `/tfx-auto "작업" --parallel N --mode deep` |

    STEP 3 - `git add skills/tfx-multi/SKILL.md && git commit -m "refactor(skills): convert tfx-multi to thin alias for tfx-auto (#112)"`

    DO NOT modify any other files.

---

## Shard: tfx-swarm-alias

- files: skills/tfx-swarm/SKILL.md
- critical: false
- prompt: |
    Convert skills/tfx-swarm/SKILL.md to a thin alias for tfx-auto.

    STEP 1 - Read existing skills/tfx-swarm/SKILL.md and extract the triggers array. Preserve verbatim — especially the "swarm", "스웜", "병렬 실행", "codex-swarm" keywords. These are load-bearing for Step 0 routing.

    STEP 2 - Replace entire file with (substitute {{PRESERVED_TRIGGERS}}):

    ---
    name: tfx-swarm
    description: >
      DEPRECATED — tfx-auto 로 통합됨. `/tfx-auto --parallel swarm --mode consensus --isolation worktree` 로 리다이렉트.
      실제 swarm 엔진 (PRD 파싱, shard 스케줄링, reconcile) 은 `tfx swarm` CLI 에 그대로 유지된다.
      Phase 5 (v11) 에 물리 삭제 예정.
    deprecated: true
    superseded-by: tfx-auto
    triggers:
    {{PRESERVED_TRIGGERS}}
    argument-hint: "<PRD 경로 — tfx-auto 로 passthrough>"
    ---

    # tfx-swarm (DEPRECATED → tfx-auto alias)

    > DEPRECATED. `/tfx-auto --parallel swarm --mode consensus --isolation worktree` 로 리다이렉트.
    > Phase 5 (v11) 에 물리 삭제 예정.

    ## 동작

    1. stderr 에 1회 경고 출력:
       ```
       [deprecated] tfx-swarm -> use: tfx-auto --parallel swarm --mode consensus --isolation worktree
       ```
    2. ARGUMENTS 전체 앞에 `--parallel swarm --mode consensus --isolation worktree` 를 prepend 하여 `Skill("tfx-auto")` 호출.
    3. tfx-auto 의 플래그 오버라이드 로직이 `tfx swarm <prd>` CLI 를 호출한다 (실제 swarm 엔진은 변경 없음).

    ## 등가 플래그

    `--parallel swarm --mode consensus --isolation worktree`

    ## 이 alias 의 의미

    tfx-swarm 의 "worktree 격리 + 다중 모델 + PRD 기반 오케스트레이션" 은 플래그 조합으로 entry semantics 를 표현한다. 실제 swarm 엔진 (swarm-planner, swarm-hypervisor, file-lease, reconcile) 은 `hub/team/` 과 `tfx swarm` CLI 에 그대로 유지되고 tfx-auto 가 이 경로를 호출한다. PRD 포맷 예시는 `docs/prd/_template.md` 참조.

    ## 마이그레이션 가이드

    | 기존 호출 | 새 호출 |
    |----------|---------|
    | `/tfx-swarm <PRD>` | `/tfx-auto <PRD> --parallel swarm --mode consensus --isolation worktree` |

    STEP 3 - `git add skills/tfx-swarm/SKILL.md && git commit -m "refactor(skills): convert tfx-swarm to thin alias for tfx-auto (#112)"`

    DO NOT modify any other files. DO NOT touch hub/team/swarm-*.mjs (실제 엔진).

---

## 테스트 명령

```bash
# 각 alias 가 frontmatter 에 deprecated: true 를 가지는지 확인
for skill in autopilot autoroute fullcycle persist codex gemini auto-codex multi swarm; do
  head -10 skills/tfx-$skill/SKILL.md | grep -q "deprecated: true" && echo "✓ $skill" || echo "✗ $skill"
done
```

## 완료 조건 (전체)

1. 9개 파일 모두 thin alias 로 교체됨
2. 각 파일 frontmatter 에 `deprecated: true`, `superseded-by: tfx-auto` 있음
3. 각 파일 triggers 배열 원본 보존
4. 9개 커밋 각각 `refactor(skills): convert tfx-{legacy} to thin alias for tfx-auto (#112)`
