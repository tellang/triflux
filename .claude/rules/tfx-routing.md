# 자연어 → 스킬 라우팅

## 목차

- 기본 워크플로우 ladder
- 스킬 선택 결정트리 (SSOT)
- 행동 유형 → 스킬 매핑
- 깊이 수정자
- CLI 우선순위 정책: 역할군별 3사 후보 순서 (모델 배치 포함)
- CLI 라우팅 (원격 오프로드 기본 정책 포함)
- 충돌 해소

사용자가 스킬명을 모르더라도 자연어로 요청하면 아래 규칙에 따라 적절한 스킬을 호출한다.

이 문서는 **무엇을 어떤 순서로 밟는가**(워크플로 단계 + 자연어 트리거)를 정한다.
**어느 시스템이 그 기능을 소유하는가**(gstack / superpowers / triflux)는
`tfx-stack-coexistence.md` 의 책임 매트릭스가 SSOT다. 두 문서가 어긋나 보이면 층위를
먼저 구분한다. 실행 계획은 superpowers `writing-plans`, TFX 다중모델 계획·실행은
`tfx-auto --mode deep`이 맡는다. 같은 층위에서 실제로 갈릴 때만 coexistence를 따른다.

## 기본 워크플로우 ladder

넓은 운영 순서와 스택 간 책임 경계는 이 파일에 둔다. 개별 `SKILL.md`
description에는 해당 스킬을 고르는 데 필요한 좁은 activation phrase만 넣는다.

| 상황 | 기본 순서 | 비고 |
|------|-----------|------|
| 메타 라우팅/스킬 선택 | `/tfx-harness` | 어떤 스킬/순서가 맞는지 먼저 판정해야 할 때 쓰는 단일 진입점. |
| 신규 제품/아이디어 | `/gstack-office-hours` → `/gstack-autoplan` → `/superpowers:writing-plans` → `/tfx-auto` | 먼저 문제/범위를 잡고, 리뷰된 계획을 실행으로 넘긴다. |
| 기존 작업 계속 | `/gstack-context-restore` → `/tfx-auto` | 저장된 맥락을 복원한 뒤 실행한다. |
| 직접 구현/수정 | `/tfx-auto` (Codex 우선) | "이거 고쳐줘", "구현해줘". 기존 작업 연장이면 `/gstack-context-restore` 먼저. |
| 디버그 | Claude 기본 Explore 에이전트 → `/superpowers:systematic-debugging` → `/tfx-auto` | 코드 위치/사용처 확인과 원인 분석을 분리한다. |
| 리서치 | `/tfx-research` 또는 `/multilingual-parallel-research` | 외부/최신/도구 가능 여부 의문문은 `/tfx-research`; 언어권 병렬 조사는 multilingual 경로. |
| 검증 | `/tfx-review` + `/gstack-qa` + `/superpowers:verification-before-completion` | 코드 판정은 review, 브라우저/워크플로우 게이트는 qa, 완료 주장 전 evidence 수집은 verification. |
| 디자인 검토 | `/gstack-design-review` | 시각/UX 판정. 코드 판정과 분리. |
| TDD 시작 | `/superpowers:test-driven-development` | 테스트부터 짜는 흐름. 구현 전에 invoke. |
| 코드 변경 병렬 실행 | 작업별 worktree와 세션을 분리하고 각 세션에서 `/tfx-auto` 실행 | Claude Agent는 `isolation: worktree` 사용 가능. |
| 병렬 작업 (read-only) | `/tfx-auto --parallel N --mode deep` 또는 `/superpowers:dispatching-parallel-agents` | cwd 공유가 가능한 read-only 병렬. 코드 변경은 작업별 worktree를 분리. |
| plan 실행 (체크포인트 별도) | `/superpowers:executing-plans` | 다른 세션에서 plan 을 단계별 실행. |
| 머지 직전 정리 | `/superpowers:finishing-a-development-branch` → `/tfx-ship` 또는 `/gstack-ship` | merge/PR/cleanup 결정 후 ship. |
| 리뷰 응답 | `/superpowers:receiving-code-review` | 검토 의견에 기술적 rigor 로 응답. blind apply 금지. |
| triflux 릴리즈 | `/tfx-ship` | triflux 본체는 AI trailer 금지 정책이 있는 전용 ship 경로를 쓴다. |
| 일반 PR/배포 | `/gstack-ship` | 로컬 `/gstack-ship`도 AI attribution footer/trailer 없이 실행되어야 한다. |
| 저장/복원 | `/gstack-context-save` / `/gstack-context-restore` | 진행 상태는 gstack checkpoint 계열이 소유한다. |
| 회고/슬롭 정리 | `/gstack-retro` 또는 명시 `tfx-auto --mode consensus` | 세션 회고는 gstack, 무수식 AI slop/deslop은 host ai-slop-cleaner, TFX 3자 cleanup만 `tfx-auto --mode consensus`. |

## 스킬 선택 결정트리 (SSOT)

우선순위는 **명시 스킬/플래그 > D0-D11 결정트리 > 위 quick reference > 개별 description**이다. 위 표는 파생 참조이며 충돌하면 이 결정트리가 이긴다.

- D0: 명시 `/skill`, `$skill`, `tfx-*`, `--mode/--cli`는 안전 위반이 없으면 유지한다.
- D1: “어떤 스킬/경로?”만 묻는 요청은 `tfx-harness`가 recommendation-only로 owner 하나를 반환한다.
- D2: 목표·non-goal·acceptance criteria가 불명확하면 host `deep-interview`; 자연어 목표의 `/goal` 변환은 Claude Code 기본 `/goal`을 쓴다.
- D3: 제품 수요·wedge 단계는 `office-hours`; D4 해법/UX 발산은 `brainstorming`.
- D5: 승인된 spec의 실행 계획은 superpowers `writing-plans`; 명시 TFX 다중모델 계획·실행은 `tfx-auto --mode deep`.
- D6: 실패/버그/test failure는 `systematic-debugging` 후 `tfx-auto`; 정상 구조 설명은 `tfx-auto --mode consensus --shape panel`.
- D7: 로컬 파일·심볼은 Claude 기본 Explore 에이전트(스킬 없음); 외부·최신·공식 문서는 `tfx-research`.
- D8: 무수식 AI slop/deslop/refactor는 host `ai-slop-cleaner`; 명시 TFX 3자 cleanup만 `tfx-auto --mode consensus`; 회고는 `retro`. “정리” 한 단어로 cleanup을 강제하지 않는다.
- D9: web/app flow는 `qa`, code verdict는 review backend, 완료 주장 전 근거 수집은 `verification-before-completion`.
- D10: 명확한 직접 구현은 TDD 필요 여부 뒤 `tfx-auto`; 2+ code-changing lane은 worktree와 세션을 각각 분리.
- D11: fresh verification 없이 ship 금지. triflux release는 `tfx-ship`, 일반 release는 `ship`, 중단/재개는 context save/restore.

owner availability를 실제로 검출한 경우에만 `owner unavailable → tfx-X fallback`을 명시해 fallback할 수 있다. availability가 unknown이면 추측 fallback하지 않는다.

## 행동 유형 → 스킬 매핑

| 의도 | 자연어 신호 | 스킬 |
|------|-----------|------|
| 리드 운영 | 리드 맡아, 세션들 지휘, 워커 띄워서 조율, 승계·머지·릴리스 조율 | tfx-lead |
| 구현/수정 | 만들어, 고쳐, 구현해, 짜줘, 수정해, 바꿔 | tfx-auto |
| 리뷰 | 봐줘, 리뷰해, 검토해, 괜찮아? | tfx-review |
| 분석 | 분석해, 어떻게 돌아가?, 구조가 뭐야 | tfx-auto (`--mode consensus --shape panel`) |
| 계획 | 계획, 어떻게 하지, 설계해 | superpowers `writing-plans`; TFX 다중모델 계획·실행은 `tfx-auto --mode deep` |
| 요구사항 명확화 | 요구사항, 인터뷰, 목표 구체화 | host `deep-interview`; 목표 변환은 Claude Code 기본 `/goal` |
| Codex 프로필 관리 | 프로필, 모델, effort 변경 | `~/.config/triflux/models.json` 가족별 고정 또는 자동 해석 |
| 검색 | 찾아, 어디있어, 파일 찾아 | Claude 기본 Explore 에이전트 |
| 리서치 (빠른) | 검색해줘, 찾아봐, 공식문서, 이거 뭐야 | tfx-research |
| 리서치 (자율) | 자율 리서치, 검색하고 정리해, research and plan | tfx-research (Auto 모드) |
| 테스트 | 테스트, 검증, 돌려봐, QA | 코드 판정은 tfx-review, 테스트→수정 반복은 tfx-auto, 브라우저 흐름은 gstack `/gstack-qa` |
| 정리 | 대상 domain을 먼저 판정; 무수식 AI slop/deslop은 host ai-slop-cleaner | D8 참조 (명시 TFX 3자 cleanup만 `tfx-auto --mode consensus`) |
| 토론/비교 | 뭐가 나을까, 비교해, A vs B | tfx-auto (`--mode consensus --shape debate`) |
| 합의 | 합의로 분석해, 3자 합의, consensus | tfx-auto (`--mode consensus`) |
| 패널 | panel, 패널, 전문가 의견, expert panel | tfx-auto (`--mode consensus --shape panel`) |

위 표는 Claude가 요청을 읽고 스킬을 고를 때 쓰는 지도다. 자동 키워드 주입은 [ADR-0023](../../docs/adr/0023-remove-command-hooks-hub-and-adopt-mods.md)에 따라 제거한다. 명시적 스킬 호출은 해당 스킬의 설치 여부와 호출 문법을 확인한다.

## 깊이 수정자

| 수정자 | 신호 | 효과 |
|--------|------|------|
| 기본 | (없음), 빠르게, 간단히 | Light 스킬 |
| 깊이 | 제대로, 꼼꼼히, 철저히 | `tfx-auto --mode deep` |
| 합의 | 3자, 교차, 다각도 | `tfx-auto --mode consensus` |
| 반복 | 끝까지, 멈추지마, ralph | `--retry ralph` (Phase 3 true state machine, `.claude/rules/tfx-escalation-chain.md` 참조) |
| 승격 | 알아서 승격, 안 되면 더 강한 모델 | `--retry auto-escalate` (Phase 3 CLI 체인 승격) |
| 자율 | 알아서, 자동으로, autopilot | autopilot 모드 |
| 최대 effort | ultracode, 울트라코드 | Claude Code `--effort ultracode`(v2.1.203+). 멀티에이전트 Workflow 오케스트레이션, 토큰 비용 무관 철저성 우선. tfx CLI 플래그는 아니다 |

## CLI 우선순위 정책: 역할군별 3사 후보 순서

> 근거(why): [ADR-0054: 역할군별 3사 모델 우선순위 라우팅](../../docs/adr/0054-multi-vendor-priority-routing.md) (기존 [ADR-0004](../../docs/_archive/adr/0004-codex-as-default-cli.md), [ADR-0039](../../docs/_archive/adr/0039-review-by-author-vendor.md), [ADR-0053](../../docs/_archive/adr/0053-agy-carbon-explicit-family.md) 대체). 이 절이 SSOT(어떻게), ADR은 결정 이력(왜)이다.

단일 기본 벤더 대신 6개 역할군별로 3사(`codex`, `antigravity`, `claude`) 후보 순서와 등급을 정한다. 정본 구현은 `scripts/lib/vendor-priority-policy.mjs`와 `scripts/lib/quota-snapshot.mjs`다.

| 역할군 | 대표 역할 | 1순위 | 2순위 | 3순위 |
|---|---|---|---|---|
| 탐색 (exploration) | `explore`, `spark`, `summarizer`, `classifier`, `triage`, `translator`, `formatter` | `claude haiku low` | `codex luna low` | `antigravity hydrogen low` |
| 판단 및 설계 (judgment) | `architect`, `planner`, `critic`, `analyst`, `debugger`, `deep-executor`, `scientist-deep` | `claude opus high` | `codex astra xhigh` (단독 `ultraEligible`은 `ultra` 허용) | `antigravity carbon high` |
| 실행 (execution) | `executor`, `test-engineer`, `verifier`, `qa-tester`, `scientist`, `build-fixer`, `cleanup`, `deslop` | `codex` (`sol high` / `sol medium`) | `antigravity` (`hydrogen medium` / `hydrogen high` / `hydrogen low`) | `claude` (`sonnet medium` / `sonnet high` / `sonnet low`) |
| 검증 및 교차 리뷰 (verification) | `code-reviewer`, `quality-reviewer`, `security-reviewer` | 일반 리뷰: 작성자 제외(`codex sol high` / `claude opus`), `security-reviewer`: `claude fable high` | 일반 리뷰: 타 벤더 2순위(`claude opus` / `antigravity hydrogen high`), `security-reviewer`: `codex astra xhigh` | 일반 리뷰: 타 벤더 전멸 시 동일 벤더 새 세션(`freshSessionRequired`), `security-reviewer`: `antigravity carbon high` |
| 문서 및 시각 설계 (writing_design) | `designer`, `writer`, `researcher`, `document-specialist` | `designer`: `claude opus high`, 문서군: `antigravity argon medium` | `designer`: `antigravity hydrogen high`, 문서군: `claude opus medium/high` | `designer`: `codex sol high`, 문서군: `codex terra high` |
| 리드 및 소통 (lead_communication) | `lead`, `communication`(상주 소통 세션, `tfx lead <역할> --role communication`), `communication-report`(단발 보고 워커), `communication-relay` | `lead`: `claude opus high`, `communication`/`report`: `claude opus medium`, `relay`: `claude haiku low` | `lead`: `codex astra xhigh`, `communication`/`report`: `antigravity argon medium`, `relay`: `codex luna low` | `lead`: `antigravity carbon high`, `communication`: `codex terra high`, `relay`: `antigravity hydrogen low` (`report`는 명시 `--cli codex` 시 `terra high`) |

`tfx-auto`, `tfx-review`, `tfx-research`, `tfx lead` 등 multi-CLI 래퍼는 이 정책을 따른다. 명시 플래그(`--cli claude`, `--cli codex`, `--cli antigravity`)가 있으면 해당 벤더를 최우선으로 선택하며, `TFX_DISABLE_*` 등으로 하드 차단되었거나 소진된 경우에만 다음 가용 후보로 폴백한다. `--retry auto-escalate` 체인(`.claude/rules/tfx-escalation-chain.md`)은 `codex astra_max` -> `antigravity carbon_high` -> `claude fable` 3단계로 승격한다.

### 모델 배치와 쿼터·Jev 조정

> 근거: [ADR-0037](../../docs/adr/0037-model-family-aliases.md), [ADR-0038](../../docs/_archive/adr/0038-agy-default-argon-family.md), [ADR-0048](../../docs/adr/0048-codex-terra-family-for-writing-lanes.md), [ADR-0054](../../docs/adr/0054-multi-vendor-priority-routing.md). 모델 목록의 같은 가족에서 사용할 수 있는 최신 버전을 실행 때 해석한다.

역할별 후보 순서, 가족, effort의 SSOT는 `scripts/lib/vendor-priority-policy.mjs`와 `scripts/lib/agent-route-policy.mjs`다.

- **쿼터 스냅샷 규칙 (`scripts/lib/quota-snapshot.mjs`):** 사용률 `>=100%`이거나 런타임 쿨다운 마커(`$TFX_TMP/tfx-quota-reset-<cli>`, `$TFX_TMP/tfx-agy-quota-reset`)가 만료되지 않은 벤더는 후보에서 제외한다. 사용률 `>95%`인 벤더 후보는 배열 우측부터 역순으로 정확히 1칸만 후순위로 내린다(95% 이하는 순서 유지, 기존 80% 전환 규칙은 폐기).
- **Jev 최대 1칸 조정 (`reconcileCandidatesWithJev`):** Jev를 켜고 신뢰도가 `0.85` 이상일 때만 후보 배열의 인접 1칸 교환(`visual_frontend`, `long_context`, `deep_architecture`, `fast_parallel_slice`) 또는 등급 1단계 조정을 적용한다. `decomposable === false`이면 등급 하향(`lower`)을 차단하고, `security-reviewer`는 내리지 않는다. 명시 프로필이 항상 우선한다.
- **교차 리뷰 작성자 분리:** `code-reviewer`와 `quality-reviewer`는 `TFX_REVIEW_AUTHOR=codex|claude|antigravity`로 작성 벤더를 받아 후보에서 제외한다(미지정이면 `codex`, 잘못된 값은 오류). `TFX_REVIEW_AUTHOR_TIER=top`이면 남은 후보를 상위 등급(`opus`, `astra xhigh`, `carbon high`)으로 승격한다. 다른 두 벤더가 모두 비가용일 때만 동일 벤더 후보를 새 세션 격리(`freshSessionRequired: true`) 조건으로 허용하며, 세 벤더 모두 비가용이면 `exit 78`로 실패한다.

| 가족 + effort / Claude 별칭 | triflux 배정 |
|---------|--------------|
| `astra` + `xhigh` | scientist-deep(단독 실행은 ultra 허용), deep-executor, debugger, architect/planner/critic/analyst(2순위), designer(2순위), security-reviewer(2순위) |
| `astra` + `max` / `astra` + `ultra` | `TFX_CODEX_PROFILE=max/ultra`, `--retry auto-escalate` 1단계(`astra_max`) |
| `sol` + `high` | executor, codex, verifier, test-engineer, qa-tester, scientist, code-reviewer/quality-reviewer(Claude·agy 작성 코드) |
| `sol` + `medium` | cleanup, deslop |
| `terra` + `high` | writer(2순위), document-specialist(2순위), communication(3순위), communication-report(명시 `--cli codex` 시) |
| `luna` + `high` / `luna` + `low` | build-fixer(`high`), spark(`low`), explore/communication-relay 보조(`low`) |
| `hydrogen` + `low` / `medium` / `high` | Antigravity 기본 실무 가족: document-specialist, explore 보조(`low`), writer/executor 보조(`medium`), designer, code-reviewer/quality-reviewer, verifier/test-engineer/qa-tester 보조(`high`). 목록에 없으면 같은 effort의 Argon으로 폴백 |
| `argon` + `low` / `medium` / `high` | Antigravity 호환 및 폴백 가족, communication/communication-report 2순위(`medium`) (`TFX_GEMINI_PROFILE=argon*` 명시 또는 Hydrogen/Carbon 미보유 시 자동 폴백) |
| `carbon` + `low` / `medium` / `high` | Antigravity 상위 추론 가족: security-reviewer 1순위(`high`), 판단군 상위 보조(`high`), `--retry auto-escalate` 2단계(`carbon_high`). 목록에 없으면 같은 effort의 Argon으로 폴백 |
| `fable` | `--retry auto-escalate` 3단계 최종 수단 (리드 자동 선택은 `opus` 상한으로 제한) |
| `opus` | architect, planner, critic, analyst, lead 1순위, communication/communication-report 1순위(`medium`), Codex·agy 작성 코드의 code-reviewer/quality-reviewer 1순위 |
| `sonnet` | writer, executor/test-engineer/qa-tester/verifier 보조 |
| `haiku` | explore, communication-relay 1순위, spark/cleanup/deslop 보조 |

Codex는 `models_cache.json`의 공개 모델에서 같은 가족의 최신 버전을 선택하고 캐시가 없으면 `codex debug models`를 읽는다. Antigravity는 `agy models`의 Hydrogen, Argon, Carbon 목록을 하루 동안 캐시(`agy-models-v2.json`)하며, 요청한 Hydrogen이나 Carbon이 목록에 없으면 같은 effort의 Argon으로 폴백하고 stderr에 `agy 가족 폴백`을 남긴다. 최신 모델이 요청 effort를 지원하지 않으면 지원하는 가장 가까운 아래 단계로 제한한다. 옛 `flash*` 프로필 이름은 `argon` + `low`로 해석한다.

`~/.config/triflux/models.json`(Windows는 `%APPDATA%\triflux\models.json`)에 가족별 모델명을 적으면 해당 가족을 고정한다. 목록 조회 실패 시 마지막 성공 결과, 그다음 내장 기본값을 사용한다. 리드별 verifier와 explore 배치는 `skills/tfx-lead/SKILL.md`를 따른다.

## CLI 라우팅

`codex exec`와 `agy --print`를 직접 호출하지 않고 tfx 스킬을 거친다. headless-guard 훅은 제거되었으므로 호출자가 지킨다.

**Layer 1: Light** (tfx-route.sh → 단일 CLI)

| 경로 | CLI | 용도 |
|------|-----|------|
| `tfx-auto` | 자동 | 통합 진입점 |
| `tfx-auto --cli codex` | Codex | Codex 전용 lane |
| `tfx-auto --cli antigravity` | Antigravity | Antigravity 전용 lane |
| `tfx-auto --mode quick` | Codex→검증 | 단일 파일, 5분 이내 |
| `tfx-auto --retry auto-escalate` | 자동 승격 | 실패→더 강한 모델 |

**Layer 2: Deep** (headless 3-CLI 합의)

`tfx-auto --mode deep`, `tfx-auto --mode consensus --shape consensus|debate|panel`,
`tfx-auto --retry ralph`

**Layer 3: Remote/병렬**

| 스킬 | 용도 |
|------|------|
| `tfx multi` CLI | 2+개 태스크 headless 병렬 |
| tfx-remote | Claude Code 원격 세션 (SSH, user-state hosts.json setup 필수) |

**Claude 네이티브** (CLI 불필요): tfx-setup, tfx-doctor

**Headless UI default** : `tfx-auto`, `tfx multi`의 headless 워커는 default 로 `claude agents` 패널에 노출 (`--native-bridge-ui agents`). opt-out: `--no-native-bridge-ui`. interactive (tmux/wt) 경로는 default-off. 행에서 Enter 를 누르면 워커가 도는 tmux pane 이 열린다. 상세 행동표는 `CLAUDE.md` 의 `<native-bridge>` 섹션. 근거(why): [ADR-0008 : headless 워커 native-bridge 기본 노출](../../docs/adr/0008-native-bridge-ui-default-on.md), [ADR-0026 : agents 행을 워커 tmux 방의 attach client 로](../../docs/adr/0026-agents-row-tmux-attach.md).

자원 우선순위: remote-spawn > multi > Light > 로컬 단독

**원격 오프로드 기본 정책** : 로컬 기기의 램이 빠듯해지면 무거운 작업을 `hosts.json` 에 등록한 원격 호스트로 넘긴다. 판단 시점은 병렬 dispatch 직전이다.

- 실시간 전이는 `/tfx-lead <역할>`(수동은 `/tfx-pressure on`)로 압박 감시를 켠 리드 세션의 triflux mod 가 2초마다 sysctl 을 읽어 두 표본 연속으로 확정한다. 4 로 오르는 전이만 리드 자기 세션에 피어 메시지로 넣고(실패하면 턴이 끝난 뒤 들어가는 prompt 로 폴백), 나머지 전이는 턴 없이 리드의 다음 요청에 한 줄로 붙인다. 상주 프로세스는 없다. 전이별 행동은 `skills/tfx-lead/SKILL.md` "압박 변화 대응" 절([ADR-0043](../../docs/adr/0043-pressure-transition-as-self-peer-message.md), [ADR-0047](../../docs/adr/0047-pressure-notice-without-turn.md))
- 판단 주체는 리드다. 워커와 피어 세션은 압박을 보고만 하고 실행 위치를 스스로 바꾸지 않는다. 리드가 있으면 압박 지침을 워커에 직접 뿌리지 않고 리드에게 넘긴다. 리드가 없는 단독 세션만 아래 기준으로 스스로 정한다. 절차는 `skills/tfx-lead/SKILL.md`의 "실행 위치 결정" 절
- 판정 명령: `sysctl -n kern.memorystatus_vm_pressure_level` (1=normal, 2=warn, 4=critical; Stats 앱·활성 상태 보기의 메모리 색과 같은 커널 신호, 노랑=2 빨강=4)
- 4(critical): 무조건 오프로드
- 2(warn): 무거운 shard(빌드·전체 테스트 스위트·대규모 리팩터)를 띄우거나 워커 3+개를 새로 만들 때만 오프로드
- 1(normal): 로컬 유지
- sysctl 실패 시 대체 신호: `vm_stat` 5초 간격 2회 측정에서 swapouts 증가
- 원격으로 넘기기 전에 `node scripts/remote-spawn.mjs --probe <host>`로 호스트 상태를 먼저 확인한다
- 호스트 선택은 작업 성격으로 나눈다. 무거운 계산(전체 테스트 스위트, 빌드, 대규모 리팩터)과 Claude 워커는 ryzen(31.6GB, 여유 약 20GB) 우선. git push 나 PR, Codex 스킬이 필요한 작업은 m2 로 보내되 m2 는 16GB 라 probe 압박이 1 일 때만 보낸다. 둘 다 안 되면 전체 테스트 스위트는 원격 격리 호스트가 준비될 때까지 미루고(tfx-lead 안전 절), 그 밖의 작업만 로컬에서 순차로 돌린다
- ryzen 은 Windows(PowerShell 7) 라 원격 세션을 psmux 로 감싼다. `remote-spawn` 은 로컬 멀티플렉서와 원격 psmux 3.4.0 이상이 있으면 Windows 원격 Claude를 원격 psmux로 감싼다. 원격 psmux가 없거나 지원 버전 미만이면 연결 종료 시 Claude도 종료되는 기존 경로로 실행한다. `remote-spawn`을 쓸 수 없을 때의 수동 대안은 설치본에 함께 배포되는 `skills/tfx-remote/SKILL.md`의 "Windows 원격 수동 실행 대안", 셸 규약 전문은 clone 의 `.claude/rules/tfx-psmux.md`. ryzen 은 Codex 스킬과 필요한 GitHub 계정의 gh 인증이 아직 준비되지 않아 그 작업은 보내지 않는다. agy 는 ryzen 에도 m5 와 같은 버전이 있다
- 행동: 원격 코드 변경은 별도 worktree와 세션에서 실행한다. 탐색·대화형은 tfx-remote로 원격 세션을 띄운다
- 로컬 여유가 충분하면 로컬 유지. 사용자가 로컬/원격을 명시하면 그에 따른다
- 원격 호스트 부재 시(ssh 불응) 조용히 로컬로 강등하지 말고 한 줄 알린 뒤 로컬 진행

원격 hosts 설정은 user-state 경로만 참조한다: macOS/Linux `~/.config/triflux/hosts.json`, Windows `%APPDATA%\triflux\hosts.json`. 기존 source-tree `references/hosts.json` 은 라우팅 입력으로 사용하지 않으며 첫 실행 lazy auto-migration 대상이다.

## 충돌 해소

- "auto" 단독 → tfx-auto. "알아서 해" → autopilot 모드 (위 깊이 수정자)
- "코드에서 찾아" → Claude 기본 Explore 에이전트. "알아봐" → tfx-research
- 복합 의도: "구현하고 리뷰까지" → tfx-auto 실행 후 리뷰 결과 확인
- "합의해서 비교해" 류 요청은 기본적으로 `tfx-auto --mode consensus --shape debate` 로 fold 한다
- `ralph` 표기는 항상 `--retry ralph` mode를 지칭한다. `--retry auto-escalate`와 동시에 쓸 수 없다(escalation-chain.md 규약).
