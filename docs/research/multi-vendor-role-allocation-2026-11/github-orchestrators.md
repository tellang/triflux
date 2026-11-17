# GitHub 멀티 에이전트 오케스트레이터의 역할별 모델 기본값과 폴백 규칙

기준일 2026-11-17. 모든 수치와 기본값은 `gh api`로 저장소 파일과 커밋 날짜를 직접 열어 확인했다. 열지 못했거나 확인 범위 밖이면 "원문 미확인"으로 적었다. 별 수와 마지막 push는 2026-11-17 조회값이다.

## 목적

멀티 에이전트 코딩 하네스가 역할(리드, 계획, 설계, 구현, 리뷰, 보안, 탐색, 테스트, 문서, 디자인, 소통)마다 어떤 모델을 기본값으로 두는지, 쿼터와 rate limit과 장애 때 모델이나 벤더를 어떻게 넘기는지를 1차 자료로 모은다. 결론을 미리 정하지 않고 서로 다른 설계를 그대로 적는다.

## 대상 선정

### 방법

- `gh search repos`는 키워드 검색 노이즈가 커서 상위 후보가 별 수가 한 자릿수인 저장소로 채워졌다. 그래서 알려진 저장소를 `gh api repos/OWNER/REPO`로 직접 조회해 별 수, push 날짜, 아카이브 여부를 확인했다.
- GitHub 트렌딩(일간, 주간, 월간)은 curl로 가져와 저장소 이름만 추렸다. 이 기간 상위에서 역할별 모델 설정이 있는 오케스트레이터는 `QwenLM/qwen-code`(주간)와 `pingdotgg/t3code`(월간) 정도였고, 둘은 열어 보지 않았다(원문 미확인).
- 다른 선택 기준: 최근 3개월 안에 push가 있고, 저장소에 역할별 모델이나 폴백 설정이 실제 파일로 있는 것.

### 대상 16개

| 저장소 | 별 | 마지막 push | 선택 이유 |
|---|---|---|---|
| code-yeongyu/oh-my-openagent | 70,952 | 11-17 | 역할, 카테고리, 프로필 3층 체인이 코드와 문서에 있다 |
| Yeachan-Heo/oh-my-claudecode | 40,877 | 11-17 | Claude Code 플러그인 최대 규모, 사용자의 기본 하네스 |
| Yeachan-Heo/oh-my-codex | 33,796 | 11-16 | Codex 쪽 최대 규모, 역할마다 effort를 명시 |
| alvinunreal/oh-my-opencode-slim | 10,250 | 11-16 | 프리셋 5종 공개, 폴백 설정 키가 상세 |
| anomalyco/opencode | 227,359 | 11-17 | 상위 하네스들의 호스트, 역할 기본값 부재가 대조점 |
| OpenHands/OpenHands + software-agent-sdk | 93,615 | 11-17 | 폴백 발동 조건이 가장 명확 |
| cline/cline | 71,696 | 11-17 | Plan/Act 모델 분리의 원조 |
| Kilo-Org/kilocode | 28,027 | 11-17 | 서버측 자동 모델 라우터를 상용 공개 |
| charmbracelet/crush | 29,103 | 11-17 | large/small 슬롯만 있는 단순 구조 |
| aaif-goose/goose | 56,691 | 11-17 | 리드/워커를 만들었다가 제거한 이력 |
| google-gemini/gemini-cli | 108,884 | 11-17 | 벤더 자체 CLI, 라우터와 폴백 코드가 정교 |
| openai/codex | 135,553 | 11-17 | 역할이 설정 레이어인 구조 |
| ruvnet/ruflo | 81,892 | 11-16 | 3단 비용 라우터와 서킷 브레이커 |
| wshobson/agents | 42,589 | 11-16 | 에이전트 약 200개를 모델 별칭으로 등급화 |
| bmad-code-org/BMAD-METHOD | 55,448 | 11-17 | 모델 지정이 없는 페르소나 중심 반대 사례 |
| smtg-ai/claude-squad | 8,821 | 11-13 | 세션 관리만 하는 최소 사례 |

제외한 후보:
- `RooCodeInc/Roo-Code`: 2026-05-15 아카이브됨.
- `Aider-AI/aider`: 별 50,150이지만 마지막 push가 2026-05-22로 3개월 기준 밖.
- `Kilo-Org/kilo`: 2026-02-24 아카이브됨.

## 저장소별 조사

### code-yeongyu/oh-my-openagent (구 oh-my-opencode)

- 별 70,952, 마지막 push 2026-11-17, 기본 브랜치 `dev`
- 근거 파일(2026-11-15 커밋 확인):
  - `docs/guide/agent-model-matching.md`
  - `packages/senpi-task/src/category/fallback-chains.ts`
  - `packages/senpi-task/src/agents/builtin/fallback-chains.ts`
  - `docs/reference/omo-json.md`
- 선택 이유: 별 수 1위급, 역할 및 카테고리별 모델 체인이 코드와 문서에 가장 상세하다.

**설계 단위**: 메인 에이전트의 "모델 프로필 4레인", 위임 단위의 "카테고리", 읽기 전용 "큐레이트 에이전트" 세 층이 서로 독립 체인을 가진다. 프로필은 메인 세션 모델만 정하고 위임 자식 모델에는 영향이 없다고 문서가 명시한다.

**메인 에이전트 프로필 4레인** (`model_profile`, 세션 시작 때 1회 해석)

| 레인 | 체인 |
|---|---|
| daily-normal (기본) | Claude Opus 5.5(medium), Claude Fable 5.2(medium), Kimi K3.1 Pro(max) |
| daily-heavy | Fable 5.2(high), Fable 5.1(xhigh) |
| geeky-normal | GPT-6 Astra(medium), GPT-6.1 Sol Fast, GPT-6.1 Sol, GPT-5.6 Sol |
| geeky-heavy | GPT-6 Astra(high) 단독 |

- 연결된 프로바이더가 서빙하는 첫 모델을 쓴다. 아무것도 안 맞으면 다른 레인으로 넘어간다(ChatGPT만 있으면 geeky-normal로 시작).
- 문서 문장: "A model outside the ladder isn't supported as the main agent." 오케스트레이션 프롬프트를 Opus 5.5, Fable 5.1, Kimi K3, GPT-6 Astra, GPT-6.1 Sol, GPT-6 Sol, GLM 5.3 순으로 맞춰 튜닝한다.
- 모델 계열별 프롬프트 프리셋이 따로 있다(Claude는 체크리스트형, GPT는 원칙형).
- 구독 로그인이 API 키보다 항상 앞선다(`anthropic-subscription`, `chatgpt-subscription`이 각 체인의 첫 프로바이더). 과금 API 경로로 새는 것을 막으려는 의도로 코드 주석에 이슈 번호(#8051, #8300)가 있다.

**큐레이트 에이전트(읽기 전용)**

| 에이전트 | 일 | 기본 | 체인 요약 |
|---|---|---|---|
| explore | 코드 검색 | kimi-for-coding-highspeed(off) | GPT-6 Luna Fast(low), Claude Haiku 5.5(medium), DeepSeek Flash, Qwen3.7 Plus, MiniMax M2.7 |
| librarian | 문서와 OSS 검색 | 위와 동일 | 위와 동일 |
| plan-consultant | 사전 계획 갭 분석 | Claude Fable 5.2(max) | Fable 5.1, Opus 5.5, Kimi K3.1 Pro, Kimi K3 |
| plan-reviewer | 계획 리뷰 | GPT-6 Astra(xhigh) | Copilot Astra(high), Opus 5.5(max), 낮은 단계 둘, GLM 5.2 |

- 리뷰어(`omo-native-code-reviewer`, `omo-native-gate-reviewer`, `omo-native-qa-executor`)는 손으로 쓴 체인이 없고 카테고리 이름을 나열한다. 예: gate-reviewer는 `deep-high` 다음 `unspecified-high`.

**카테고리(구현 위임)**

| 카테고리 | 용도 | 기본(effort) | 폴백 순서 요약 |
|---|---|---|---|
| architect | 시스템 설계, 광범위 디버깅 | Claude Fable 5.2(xhigh) | Fable 5.1(xhigh)만. 둘 다 없으면 카테고리 자체가 숨겨짐 |
| visual-engineering | 프론트, UI/UX | Gemini 4 Argon(low) | Fable 5.2(max), 5.1, Opus 5.5(max), Kimi K3.1 Pro |
| ultrabrain | 어려운 논리 작업 | GPT-6 Astra(max) | GPT-5.6 Sol(max) |
| deep-low | 기본 깊은 작업 | GPT-6.1 Sol(medium) | Sol Fast, GPT-5.6 Sol, 5.6 Sol Fast |
| deep-high | 증거로 못 정하는 핵심 결정 | GPT-6 Astra(high) | 폴백 없음 |
| artistry | 비정형 창의 문제 | Fable 5.2(max) | Fable 5.1, Opus 5.5, Kimi K3.1 Pro |
| quick | 한 파일, 오타 | GPT-6 Luna Fast(low) | Haiku 5.5, DeepSeek Flash(off), Qwen3.6 Flash, Grok 4.20 non-reasoning, GLM 5.3 Flash, MiMo V2.6 Flash |
| unspecified-low | 그 밖의 저강도 | Claude Sonnet 5.5(medium) | MiMo V2.6 Pro, Grok 4.7(xhigh), GLM 5.3, GPT-6.1 Sol, 5.6 Sol, Sonnet 5, Qwen3.8 Max, DeepSeek V4 Pro, MiMo V2.5 Pro |
| unspecified-high | 그 밖의 고강도 | Opus 5.5(medium) | GLM 5.3(max), Kimi K3.1 Pro |
| writing | 문서, 산문 | Gemini 4 Argon(low) | Opus 5.5(low), Opus 4.6(max). 다른 계열로 폴백하지 않음, 셋 다 없으면 카테고리 사라짐 |

**폴백 규칙**
- 위임 자식: 체인을 순서대로 보고 연결된 프로바이더가 서빙하는 첫 rung을 쓴다. 사용자 설정(`omo.json`의 `categories.<name>.model(s)`, `agents.<name>.model(s)`)이 항상 이긴다.
- 모델 게이트: `ultrabrain`, `deep-low`, `deep-high`, `architect`는 특정 모델이 없으면 메인 에이전트에게 목록으로 노출되지 않는다("선택해놓고 실패" 방지).
- 런타임: 자식마다 지정 체인이 세션 오버레이로 들어가 엔진이 오류 시 다음 rung으로 넘어간다. 메인 세션의 중도 실패는 프로필이 아니라 Senpi 엔진의 `retry.fallbackChains`를 따른다. 어떤 오류 종류(429, 쿼터)에서 발동하는지는 Senpi 저장소 내용이라 원문 미확인.
- `models_distribution: round_robin`: 병렬 스폰마다 `[A,B,C]`, `[B,C,A]`처럼 시작 모델을 돌려 쓴다. 쿼터를 나누려는 장치이고 프롬프트 캐시 보존을 위해 스폰 시 1회만 고른다. 프로바이더 계정 분산은 아니라고 문서가 적는다.
- `disabled_models`: 일치하는 모델을 프로바이더 로그인이 없는 것처럼 모든 체인에서 뺀다.
- 사용량 수치로 모델을 바꾸는 장치는 이 문서에서 확인하지 못했다.

**쿼터 운용 지침(문서 문장)**: 희소한 프리미엄 모델 하나를 아낄 때는 호출 빈도가 낮고 영향이 큰 역할(plan-consultant 계획당 1회)에 쓰고, 실행이 잦은 슬롯(카테고리 워커, explore, librarian)에는 쓰지 않는다. `explore`/`librarian`에 Opus나 Fable을 쓰는 것은 "Massive cost waste"라고 적어 놨다.

**라우터 / 리드 / 소통**: 메인 에이전트가 카테고리를 고르면 카테고리가 모델을 고른다(작업 단위 선택). 리드(메인) 전용 레인이 있고, 소통 전용 역할은 따로 없다. 문서는 Claude 계열을 "communicative roles"(메인, plan-consultant)에 맞춘다고 쓴다.

---

### Yeachan-Heo/oh-my-claudecode (OMC)

- 별 40,877, 마지막 push 2026-11-17
- 근거 파일: `agents/*.md` 프런트매터, `docs/shared/agent-tiers.md`(2026-10-13), `src/config/models.ts`(2026-06-30), `src/features/model-routing/{router,rules,types}.ts`(router 2026-08-13), `src/features/rate-limit-wait/`(2026-04-12), `src/features/jev-model-routing.ts`(2026-11-08), `docs/agents/model-compatibility.md`(2026-05-28)
- 선택 이유: Claude Code 플러그인 중 별 수 최상위, 사용자의 기본 하네스.

**역할별 기본 모델(`agents/*.md` 프런트매터 직접 확인)**

| 역할 | 모델 | 도구 제한 |
|---|---|---|
| analyst(사전 계획 컨설팅) | opus | 쓰기, 편집 금지 |
| architect(설계, 디버깅 자문) | opus | 쓰기, 편집 금지 |
| code-reviewer | opus | 쓰기, 편집 금지 |
| critic | opus | 쓰기, 편집 금지 |
| security-reviewer | opus | 쓰기, 편집 금지 |
| planner | opus | 없음 |
| code-simplifier | opus | 없음 |
| debugger, designer, executor, git-master, tracer | sonnet | 없음 |
| scientist, verifier | sonnet | 쓰기, 편집 금지 |
| explore | haiku | 쓰기, 편집 금지 |
| writer | haiku | 없음 |

- `docs/shared/agent-tiers.md`는 test-engineer, qa-tester, document-specialist, git-master를 sonnet으로 적는다(프런트매터는 직접 열지 않음).
- 문서와 프런트매터 불일치: 문서 표는 architect, security-reviewer, scientist를 "sonnet, opus"로 적지만 프런트매터는 architect와 security-reviewer가 opus 고정, scientist는 sonnet 고정이다. 문서 표는 "Typical Models"이고 호출 시 `model` 파라미터로 덮는 전제다.
- 모델 이름 기본값(`src/config/models.ts`, 커밋 2026-06-30): HAIKU `claude-haiku-4-5`, SONNET `claude-sonnet-5`, OPUS `claude-opus-4-8`, FABLE `claude-fable-5`. 사용자 환경에서 `OMC_MODEL_LOW/MEDIUM/HIGH` 환경 변수나 Bedrock, Anthropic 기본 모델 환경 변수로 덮는다. 외부 CLI 기본값은 Codex `gpt-5.3-codex`, Gemini `gemini-3.1-pro-preview`, Antigravity `Gemini 3.1 Pro (High)`로 코드에 하드코딩돼 있다(사용자 기준으로는 오래된 값이라 최근 갱신이 안 된 부분).

**라우터**
- 있다. `src/features/model-routing/router.ts`가 신호 추출, 복잡도 점수, 규칙 평가로 LOW(haiku), MEDIUM(sonnet), HIGH(opus) 티어를 고른다.
- 우선순위: `forceInherit`(부모 모델 상속) > 라우팅 비활성(기본 MEDIUM) > 명시 모델 > 에이전트별 오버라이드 > 규칙.
- 규칙 이름 예: `architect-complex-debugging`은 HIGH, `architect-simple-lookup`은 LOW, `security-domain`은 HIGH("Security-related tasks require careful reasoning"), `simple-search-query`는 LOW. 에이전트 범주 기본 티어는 exploration과 utility가 LOW, specialist와 orchestration이 MEDIUM, advisor, planner, reviewer가 HIGH.
- `escalationEnabled: false`(deprecated 주석, "orchestrator routes proactively"). 실패해서 올리는 자동 승격은 꺼져 있다.
- Jev 판단 지점 ④ `jev-model-routing.ts`: shadow 모드, 기록만 하고 기존 enforcer 판정을 덮지 않는다. API 키가 없으면 HTTP 호출 없이 꺼진다.

**폴백 / 쿼터**
- 다른 모델이나 벤더로 넘기는 폴백은 확인하지 못했다. 대신 `src/features/rate-limit-wait/`가 "Auto-resume Claude Code sessions when rate limits reset": 한도에 막힌 tmux pane을 감지해 리셋 시각에 재개하는 데몬(`omc wait daemon start`). 설계 철학은 넘기지 않고 기다린다.
- 호환성 문서(`docs/agents/model-compatibility.md`)는 OMO의 Prometheus, Sisyphus 등 에이전트 이름 기준의 비용 대비 품질 표로, 규칙 3개를 적는다: 계획과 리뷰는 비싸게, 구현은 싸게(토큰 무게 5~20배 차이 주장), 총 토큰을 지배하는 구현 슬롯이 가장 큰 비용 레버, DeepSeek V4 Pro를 비용 효율 기본값으로. 이 문서는 모델 이름이 Opus 4.8, GPT-5.5, Sonnet 4.6 등 5월 기준이라 현행 기본값 코드와 다르다.

**리드 / 소통**: 사용자 호출 에이전트가 오케스트레이터 역할을 하고 모델을 따로 고정한 리드 에이전트는 없다. 보고, 소통 전용 역할 없음(writer는 문서 작성용 haiku).

---

### Yeachan-Heo/oh-my-codex (OMX)

- 별 33,796, 마지막 push 2026-11-16
- 근거 파일: `src/config/models.ts`(2026-10-29), `src/agents/definitions.ts`(2026-09-06), `docs/shared/agent-tiers.md`, `src/team/model-contract.ts`
- 선택 이유: Codex 쪽 최상위 오케스트레이터, 역할마다 effort를 명시해 둠.

**구조**: 역할(role)과 깊이 티어(LOW/STANDARD/THOROUGH), 자세(posture), `exactModel` 핀을 분리한다. 에이전트마다 `modelClass`(frontier, standard, fast)와 `routingRole`(leader, specialist, executor)을 단다.

**역할별 기본(`definitions.ts` 직접 확인)**

| 역할 | reasoningEffort | modelClass | routingRole |
|---|---|---|---|
| explore | low | fast | specialist |
| style-reviewer | low | fast | specialist |
| qa-tester | low | standard | executor |
| executor | medium | standard | executor |
| team-executor | medium | frontier | executor |
| analyst, planner | medium | frontier | leader |
| architect | xhigh | frontier | leader |
| security-reviewer | medium | frontier | leader |
| code-reviewer | high | frontier | leader |
| quality-reviewer, api-reviewer, performance-reviewer, quality-strategist | medium | standard | leader |
| verifier | high | standard | leader |
| debugger, build-fixer | high | standard | executor |
| test-engineer | medium | frontier | executor |
| designer | high | standard | executor |
| writer | high | standard | specialist |
| git-master | high | standard | executor |
| code-simplifier | high | frontier | executor |
| researcher | high | (코드 줄 미확인) | specialist |
| dependency-expert | high | standard | specialist |

**모델**: `DEFAULT_FRONTIER_MODEL`, `DEFAULT_STANDARD_MODEL`, `DEFAULT_SPARK_MODEL` 셋 다 `gpt-6-astra`다. 즉 기본값에서는 클래스가 달라도 모델이 같고 effort만 다르다. `planner`, `architect`, `researcher` 세 역할만 `exactModel: 'gpt-6-astra'`로 핀(내장 프로바이더일 때).
- 해석 순서(코드 주석): 모드별 `models[mode]` > `models.default` > 메인 기본(셸 환경 변수 > `.omx-config.json`의 env > `config.toml` 루트 `model` > 내장 기본). 에이전트별은 `agentModels`, `agentReasoning`으로 덮는다. 네이티브 서브에이전트는 핀된 역할을 빼면 모델 필드를 안 쓰고 Codex `config.toml` 모델을 상속한다.
- 팀 워커 폴백 순서(주석): `agentModels` > `*-low` spark 경로 > exactModel 핀 > executor/main > modelClass 기본. 여기서 "폴백"은 설정 해석 순서이고 쿼터나 장애 때 벤더를 넘기는 규칙이 아니다.
- 저강도 역할(`explore`, `explorer`, `style-reviewer`)은 팀에서 spark 기본 모델로 간다.
- 쿼터, rate limit을 보고 모델을 바꾸는 코드는 확인하지 못했다(`notify-fallback-*`는 알림 전송 폴백이라 무관).
- 한 벤더(OpenAI)만 쓰고 effort로 비용을 조절하는 설계다.

---

### alvinunreal/oh-my-opencode-slim

- 별 10,250, 마지막 push 2026-11-16
- 근거 파일: `README.md`(2026-11-16), `docs/presets/*.md`(2026-10-25 ~ 11-14), `docs/configuration.md`, `.out-of-scope/smart-routing.md`, `.out-of-scope/preset-fallback.md`(2026-10-12)
- 선택 이유: opencode 플러그인 중 별 수 2위권. 역할 5개와 프리셋 구조가 단순하고 프리셋 5종이 실제 값으로 공개돼 있다.

**역할**: orchestrator(계획과 위임), oracle(아키텍처 리뷰, 단계 사이 검수), explorer(코드 탐색, librarian을 합침), designer(UI), fixer(범위가 정해진 구현), observer(시각 분석, 오케스트레이터가 멀티모달이 아닐 때만 켬), council/councillor(다중 의견 합의).

**프리셋별 기본 모델(문서에서 직접 확인)**

| 프리셋 | orchestrator | oracle | explorer | designer | fixer |
|---|---|---|---|---|---|
| openai (설치 시 기본 생성, 2026-11-01) | gpt-6.1-sol(medium) | gpt-6.1-sol(high) | gpt-6-luna(low) | gpt-6-luna(medium) | gpt-6.1-sol(low) |
| opencode-go (2026-11-14) | minimax-m3(thinking) | qwen3.8-max(xhigh) | deepseek-v4.1-flash(high) | kimi-k2.7-code | deepseek-v4.1-flash(high), observer는 mimo-v2.5 |
| $30 (Codex Plus + Copilot Pro) | gpt-6-sol(medium) | gpt-6-astra(high) | gpt-6-luna(low) | github-copilot/gemini-3.5-flash | gpt-6-luna(medium) |
| $40 (Claude Pro + ChatGPT Plus) | claude-opus-5-5 | gpt-6-astra | gpt-6-luna | claude-opus-5-5 | gpt-6.1-sol |
| 작성자 본인 | gpt-6-sol-fast | gpt-6-sol-fast | gpt-5.3-codex-spark | omniroute 경유 gemini-3-flash-agent | xai/grok-4.5 |

- 경향: 예산이 줄면 oracle 한 칸에 가장 센 모델(GPT-6 Astra)을 남기고 explorer와 fixer를 가장 싼 모델로 낮춘다. 작성자 본인 설정은 벤더 4곳을 섞는다.
- README 문장: "Model lineups change fast ... Use them for ideas, then build your own around the models you actually have." 프리셋은 권장이 아니라 출발점이라고 적는다.

**폴백**
- `model`에 배열을 쓰면 그 순서가 런타임 폴백 체인(`ForegroundFallbackManager`가 실패한 세션을 abort하고 다음 미시도 모델로 재프롬프트).
- `fallback.enabled` 기본 true, `fallback.maxRetries` 기본 3(호스트가 알린 재시도 이벤트를 몇 번 흡수한 뒤 다음 모델로), `retryDelayMs` 기본 500.
- 호스트가 알린 재시도 대기가 30분보다 길면 횟수 예산과 상관없이 즉시 폴백을 시작한다(쿼터 리셋 대기 성격의 오류를 겨냥한 규칙으로 보이나 문서에는 "quota"라는 말이 없음).
- 프로바이더 단위 실패로 세션을 옮기면 그 프로바이더를 30분간 제외한다. 체인의 처음부터 훑되 이미 시도한 모델을 건너뛴다. 남은 후보가 없으면 마지막 항목을 한 번만 더 시도하고 끝낸다.
- 복귀 정책 `continuationPolicy`: `retry-primary`(기본, 백그라운드 완료 후속 턴이 원래 모델을 다시 시도) 또는 `stick-to-fallback`.
- 프리셋에서 프리셋으로 넘어가는 폴백은 `.out-of-scope/preset-fallback.md`에서 wontfix(#638). 사용량을 보고 프로바이더를 고르는 "smart routing"도 PR #144를 "플러그인 범위 밖"으로 닫았다. 모델 선택 정책은 OpenCode 본체와 사용자 설정 몫이라는 입장이다.
- 사용량 수치로 바꾸는 장치는 없다. 라우터도 없고, 오케스트레이터 프롬프트가 역할 선택을 한다.

**리드 / 소통**: 오케스트레이터가 리드. 보고 전용 역할은 없다. `docs/project-local-customization.md`에 오케스트레이터 라우팅 지침을 덮어쓰는 방법이 있다.

---

### anomalyco/opencode (구 sst/opencode)

- 별 227,359, 마지막 push 2026-11-17
- 근거 파일: `services/site/src/docs/content/agents.mdx`(2026-11-11), `services/site/src/docs/content/models.mdx`(2026-11-10), `packages/core/src/plugin/agent.ts`(2026-10-21), `packages/core/src/model-retry.ts`(2026-11-05), `packages/core/src/session/runner/retry.ts`
- 선택 이유: 별 수가 가장 많고 oh-my-openagent, slim 같은 상위 하네스의 기반 호스트다.

**역할**: 기본 내장은 `build`(기본 코딩, primary), `plan`(편집 없는 계획, primary), `general`(연구와 다단계, subagent), `explore`(읽기 전용 검색, subagent), 숨은 유지보수 에이전트 `compaction`, `title`, `summary`.

**역할별 모델 기본값**: 없다. 문서 문장: "A subagent uses its configured model, or inherits the parent session's model when none is configured." 역할마다 모델을 고르려면 사용자가 `.opencode/agents/*.md` 프런트매터나 `opencode.jsonc`에 `model: provider/model#variant`로 직접 적는다(문서 예시는 `anthropic/claude-sonnet-5-5#high`). 루트 `model`이 없거나 불가하면 "newest available supported model"로 간다.

**폴백**: 같은 모델 재시도 정책만 코어에 있다(`model-retry.ts`): 지수 백오프 2초에서 시작해 간격 10초 상한, 최대 10회(주석상 약 84초). `RateLimit`과 `ProviderInternal` 오류의 `retry-after`는 존중하되 15분으로 상한("hostile or buggy retry-after" 방어). 네트워크 불통(ENOTFOUND 등)은 따로 최대 1시간 예산. 다른 모델이나 벤더로 넘기는 규칙은 코어에 없고, 세션 retry 훅(`PluginHooks session retry`)으로 플러그인이 맡는 구조다(oh-my-opencode-slim이 이 위에서 체인을 구현). 사용량을 보고 바꾸는 장치는 없다.

**라우터 / 리드 / 소통**: 라우터 없음. 리드는 사용자가 고른 primary 에이전트. 소통 전용 역할 없음.

---

### charmbracelet/crush

- 별 29,103, 마지막 push 2026-11-17
- 근거 파일: `internal/config/config.go`(`SetupAgents`), `docs/config/README.md`(2026-10-30), `internal/agent/coordinator.go`
- 선택 이유: Go 기반 인기 CLI 에이전트, 모델 슬롯 구조가 단순해서 대비용으로 가치가 있다.

**역할과 모델**: 모델 슬롯이 `large`와 `small` 둘이고(`SelectedModelTypeLarge/Small`), 내장 에이전트 `coder`, `task`(컨텍스트 탐색, MCP와 LSP 없음), `plan`(분석과 계획, 파일 수정 불가)이 모두 `Model: SelectedModelTypeLarge`다. 즉 에이전트 역할 사이에 모델 차이는 없다. `small` 슬롯의 용처는 `SetupAgents`에서는 확인하지 못했다(제목 생성 등으로 보이나 원문 미확인). 기본 모델은 사용자가 `model large provider/id --reasoning-effort low|medium|high`로 정한다. 공식 제공자 Hyper(Charm)를 첫 실행 권장 경로로 안내한다.

**폴백 / 라우터**: 확인한 범위에서 자동 폴백과 라우터는 없다. 모델 목록은 Catwalk 저장소에서 가져온다. 대신 `internal/agent/hyper_credits.go`가 있어 자사 제공자의 크레딧 잔량 표시 로직을 갖는 것으로 보이나 파일 내용은 열지 않았다(원문 미확인).

---

### cline/cline

- 별 71,696, 마지막 push 2026-11-17
- 근거 파일: `docs/core-workflows/plan-and-act.mdx`, `docs/features/subagents.mdx`(2026-10-08), `.agents/skills/cline-sdk/references/multi-agent/REFERENCE.md`(2026-05-14)
- 선택 이유: 별 수 상위, Plan/Act 모델 분리의 원조.

- Plan/Act 모드별 다른 모델을 쓸 수 있다. 문서: "useful when you want to use a stronger reasoning model for planning and a faster model for implementation." 설정에서 "Use different models for Plan and Act"를 켜야 하고 기본은 꺼짐(같은 모델 하나).
- 서브에이전트: SDK에서 `enableSpawnAgent: true`일 때 `start_subagent` 등 도구가 생기고 역할, 작업, "optionally a preset"을 넘긴다. 문서 예시는 부모 설정 하나(`claude-sonnet-4-6`)이고 서브에이전트 기본 모델 규칙은 문서에서 확인하지 못했다(원문 미확인).
- 폴백, 라우터, 사용량 기반 전환은 이 문서들에서 확인하지 못했다.

---

### Kilo-Org/kilocode

- 별 28,027, 마지막 push 2026-11-17
- 근거 파일: `packages/kilo-docs/pages/code-with-ai/agents/auto-model.md`(2026-11-02), `packages/kilo-docs/pages/gateway/models-and-providers.md`(2026-10-13), `packages/kilo-docs/pages/customize/custom-modes.md`(2026-10-01), `.../orchestrator-mode.md`(2026-09-15)
- 선택 이유: 서버측 모델 라우터를 상용으로 공개한 유일한 사례.

**에이전트별 고정**: 사용자 정의 에이전트에 `model: provider/model`을 고정할 수 있고, 같은 이름의 설정이 여러 층에 있으면 속성별로 병합된다. 모델 선택기는 에이전트와 세션별 수동 선택을 기억하며 수동 선택이 설정 고정보다 우선한다.

**Auto Model 라우터(`kilo-auto/*`)**: 모델을 직접 고르지 않고 티어를 고르면 서버가 모델을 정한다.
- `kilo-auto/frontier`(유료): 모드별 해석 표(문서 2026-10-13, 당시 모델명): `plan`, `general`, `architect`, `orchestrator`, `ask`, `debug`는 `anthropic/claude-opus-4.7`, `build`, `explore`, `code`와 모드 불명은 `anthropic/claude-sonnet-4.6`. medium reasoning effort와 medium verbosity로 전송. 추론 중심 작업과 구현 중심 작업을 다른 모델로 나눈다.
- `kilo-auto/efficient`(유료): 요청 난이도를 실시간 분류해 "cheapest model proven accurate enough"로 보낸다(Kilo가 상시 돌리는 벤치마크 기반). 확신 있는 판단이 안 서면 `z-ai/glm-5.3-flash`로 폴백한다. 조직이나 개인이 허용 모델 풀을 직접 지정할 수 있다.
- `kilo-auto/free`: OpenRouter 무료 모델 중 서버가 골라 트래픽을 나눈다. 프롬프트가 제공자 로그에 남을 수 있다는 경고가 붙는다.
- 문서 문장: 티어 뒤의 모델은 서버에서 바뀔 수 있다("The tier you select stays the same; the model it routes to may change over time").

**리드 / 오케스트레이터**: Orchestrator 모드는 deprecated, 풀툴 에이전트(Code, Plan, Debug)에 서브에이전트 위임이 내장됐다. Kilo Swarm이 기본으로 켜져 세션과 하위 작업이 공유 보드로 발견을 주고받는다. 폴백은 위의 efficient 기본값 외에 확인하지 못했다.

---

### OpenHands/OpenHands + OpenHands/software-agent-sdk

- OpenHands 별 93,615 (push 2026-11-17). 실제 로직은 `OpenHands/software-agent-sdk`(별 1,404, push 2026-11-17)에 있다.
- 근거 파일(2026-11-12 ~ 11-14): `openhands-sdk/openhands/sdk/llm/fallback_strategy.py`, `.agents/skills/verify-sdk/references/feature-map/S03-llm-routing-profiles.md`, `.../S11-subagents-delegation.md`, `openhands-tools/openhands/tools/preset/subagents/*.md`
- 선택 이유: 폴백 조건(무엇이 폴백을 일으키고 무엇이 안 일으키는지)이 코드와 기능 지도에 가장 구체적으로 적혀 있다.

**역할별 모델**: 역할별 기본 모델 배정은 없다. 내장 서브에이전트 4개(`general-purpose`, `code-explorer`, `bash-runner`, `web-researcher`)는 `model: inherit`(general-purpose는 필드 없음)로 부모 모델을 그대로 쓴다. 사용자가 서브에이전트 정의 파일에 `model: <프로필명>`을 쓰면 `LLMProfileStore`의 그 프로필을 불러온다.

**폴백(`FallbackStrategy`, 기능 지도의 문장을 요약)**
- `LLM(..., fallback_strategy=FallbackStrategy(fallback_llms=["p1","p2"]))`. 프로필 이름 목록이고 첫 폴백 때 지연 로딩한다.
- 발동 조건: 주 LLM이 재시도를 소진한 뒤에도 일시 오류(rate limit, 타임아웃, 연결, 서비스 불가, 일시 HTTP 상태, 무응답)일 때. 목록 순서대로 시도해 처음 성공한 응답을 반환한다.
- 발동 안 함: 일시적이지 않은 오류(잘못된 요청, 인증, 컨텍스트 창 초과)와 예산 거부는 폴백하지 않는다. "quota exhaustion fails over without retrying the primary": 쿼터 소진은 주 모델을 재시도하지 않고 바로 폴백한다.
- 호출 단위: 폴백은 호출마다 평가되고 다음 요청은 다시 주 모델로 시작한다. 폴백 호출의 비용과 토큰은 주 LLM의 사용 세션에 합산된다.

**라우터**: `MultimodalRouter`(이미지가 있는 턴은 primary, 텍스트만 있는 턴은 secondary, 토큰이 secondary 입력 상한을 넘으면 primary), `RandomRouter`. 모델 호출 도구도 있다: `SwitchLLMTool`(모델이 `switch_llm`을 호출)과 `route_task_to_model`(`enable_classify_and_switch_llm_tool=True`와 메타 프로필 설정 시 최근 대화를 분류기에 보내 프로필을 고름). 둘 다 선택 기능이고 기본은 꺼져 있다. 기능 지도는 `RandomRouter`, `MultimodalRouter` 텍스트 경로를 "Unit: none (untested)"로 적는다.

**기타**: 컨텍스트 압축기(condenser)는 에이전트 LLM과 별개 LLM 필드를 가질 수 있고(`S03.agent-llm-discovery`에서 "condenser" 언급) 사용량은 `usage_id`별로 집계한다. 구독 로그인(`LLM.subscription_login(vendor="openai", ...)`)을 지원한다. 리드나 소통 전용 역할은 없다.

---

### aaif-goose/goose (구 block/goose)

- 별 56,691, 마지막 push 2026-11-17
- 근거: `documentation/blog/2025-06-16-multi-model-in-goose/index.md`(2026-09-14 기준 "Outdated" 배너), PR #7989 "Remove lead/worker provider"(2026-03-18 머지), `documentation/docs/guides/context-engineering/subagents.mdx`
- 선택 이유: 리드/워커 모델 분리를 가장 먼저 구현했다가 코드에서 제거한 사례.

- 과거 설계: `GOOSE_LEAD_MODEL`이 처음 몇 턴(`GOOSE_LEAD_TURNS`)을 맡고 이후 `GOOSE_MODEL`(워커)로 넘어가며, 연속 실패 `GOOSE_LEAD_FAILURE_THRESHOLD`회면 리드로 폴백하고 안정되면 복귀했다. 블로그 문장: API 타임아웃만으로 모델을 바꾸지 않고 "real task failures"만 신호로 봤다.
- 현재: PR #7989가 `lead_worker.rs`(약 500줄)와 설정 UI를 삭제했고 블로그에 "Lead/Worker mode has been removed from goose, as has the Planning Mode that replaced it"가 붙었다. 대체 수단은 `/model`로 세션 중 수동 전환, 서브에이전트별 모델.
- 서브에이전트: 각자 다른 제공자와 모델을 쓸 수 있고 `GOOSE_SUBAGENT_MODEL`, `GOOSE_SUBAGENT_PROVIDER`가 기본값, 레시피 `settings`가 우선. 외부 에이전트(Codex)를 MCP 서버로 서브에이전트처럼 붙이는 예시가 문서에 있다.
- 쿼터 기반 전환, 라우터는 없다.

---

### google-gemini/gemini-cli

- 별 108,884, 마지막 push 2026-11-17
- 근거: `docs/cli/model-routing.md`(2026-04-29), `packages/core/src/availability/policyCatalog.ts`(2026-09-22), `packages/core/src/routing/strategies/{approvalModeStrategy,classifierStrategy}.ts`, `packages/core/src/agents/*.ts`, `docs/core/subagents.md`(2026-06-08)
- 선택 이유: 벤더 자체 CLI 중 라우팅과 폴백이 코드로 가장 정교하다.

**기본 모델**: 기본값은 `auto`. 우선순위는 `--model`, `GEMINI_MODEL`, `settings.json`의 `model.name`, 로컬 Gemma 라우터(실험), 기본 `auto`.

**라우터(`auto`일 때 전략 체인)**
- `approvalModeStrategy`: PLAN 승인 모드면 Pro로 계획, 계획이 승인된 뒤 다른 모드에서는 Flash로 구현("high-quality planning"과 "efficient implementation"). 계획 모드 라우팅이 켜져 있을 때만 적용.
- `classifierStrategy`: 요청을 SIMPLE이면 flash, COMPLEX면 pro로 분류하는 프롬프트(복잡도 루브릭: 전략 계획, 심층 디버깅, 대략 도구 호출 1~3번 이하면 simple).
- 그 밖에 `numericalClassifierStrategy`, `gemmaClassifierStrategy`(로컬 Gemma가 라우팅 판단, 호스팅 모델 비용 절감 목적), `overrideStrategy`, `fallbackStrategy`, `defaultStrategy`가 있다.

**내장 서브에이전트 모델(코드 확인)**: `codebase-investigator`는 `DEFAULT_GEMINI_MODEL`(thinking 설정 있음), `generalist-agent`는 `inherit`, `cli-help-agent`는 Flash 별칭, `skill-extraction-agent`는 preview Flash. 사용자 정의 에이전트(`.gemini/agents/*.md`)의 `model` 기본은 `inherit`. `agents.overrides`로 모델을 덮는다.

**폴백**
- `ModelAvailabilityService`가 모델 상태를 감시. 모델 실패(문서 예: 쿼터, 서버 오류) 시 폴백 절차 시작. 기본은 사용자에게 전환 여부를 묻는다(`terminal/transient/not_found/unknown` 모두 `prompt`).
- 자동 선택(`auto`)이면 일시 오류는 `silent` + `sticky_retry`, 최대 3회. 체인은 코드에서 Pro 우선, 마지막 수단(`isLastResort`)으로 Flash를 최대 10회 시도(미리보기 사용 시).
- 내부 유틸리티 호출(프롬프트 자동완성, 분류)은 `flash-lite`, `flash`, `pro` 순서의 조용한 폴백 체인을 쓴다(문서).
- 벤더 단위 이동(다른 회사 모델로 폴백)은 없다. 같은 Gemini 가족 안에서만 움직인다.

---

### openai/codex

- 별 135,553, 마지막 push 2026-11-17
- 근거: `codex-rs/agent-roles/src/agent_role_config.rs`(2026-08-24), `codex-rs/core/assets/agent/builtins/{explorer,awaiter}.toml`(2026-08-29)
- 선택 이유: Codex 본체. 역할 설정이 "설정 레이어" 구조라 다른 하네스와 대비된다.

- 역할은 `description`, `config_file`(역할 전용 config 레이어), `nickname_candidates`로 정의한다. 역할 파일은 `ConfigToml` 전체를 평탄하게 받으므로 역할마다 `model`, `model_reasoning_effort` 등을 자유롭게 지정할 수 있다.
- 내장 역할 2개: `explorer.toml`은 크기 0바이트(설정 없음, 부모 모델 상속), `awaiter.toml`은 `model_reasoning_effort = "low"`, 백그라운드 터미널 최대 타임아웃 3,600,000ms, "대기만 하고 작업을 수정하지 말 것" 지시.
- 역할별 기본 모델과 폴백은 코드에서 확인하지 못했다. 폴백, 쿼터 전환, 라우터 없음(확인 범위).

---

### ruvnet/ruflo (구 claude-flow)

- 별 81,892, 마지막 push 2026-11-16
- 근거: `v3/implementation/adrs/ADR-026-agent-booster-model-routing.md`(2026-06-09, Status: Implemented), `v3/@claude-flow/cli/src/ruvector/enhanced-model-router.ts`(2026-09-07), `v3/@claude-flow/integration/src/multi-model-router.ts`(2026-01-07)
- 선택 이유: 3단 비용 라우터와 서킷 브레이커를 갖춘 대형 오케스트레이터.

- 3단 라우팅(ADR-026): 1단 Agent Booster(WASM, 1ms 미만, 비용 0, `var-to-const` 같은 단순 변환), 2단 Haiku(복잡도 0.3 미만), 3단 Sonnet 또는 Opus(복잡도 0.3~0.6은 Sonnet, 0.6 초과는 Opus). 의도 신뢰도 0.8 미만이면 AST 복잡도 분석으로 넘어간다. 휴리스틱에 Thompson 샘플링을 결합했다고 ADR이 설명한다.
- 멀티 모델 라우터: 모드는 manual, cost-optimized(기본), performance-optimized, quality-optimized, rule-based. 제공자는 Anthropic, OpenAI, OpenRouter, Ollama, LiteLLM, ONNX, Gemini 등. 서킷 브레이커(실패 5회, 리셋 60초)로 비정상 제공자를 후보에서 빼고 비용 추적과 예산 경보를 둔다. 이 파일의 마지막 수정은 2026-01-07이라 현재 기본 경로와 연결돼 있는지는 확인하지 못했다.
- 역할(에이전트)별 고정 모델 표는 확인하지 못했다. README의 "Intelligent routing (89% accuracy)"는 자체 주장이고 검증하지 않았다.

---

### wshobson/agents

- 별 42,589, 마지막 push 2026-11-16
- 근거: `docs/agents.md`(2026-10-04), `README.md`(2026-11-05)
- 선택 이유: 에이전트 약 200개를 모델 별칭으로 등급화한 플러그인 모음.

- 원본 에이전트에 `opus`, `sonnet`, `haiku`, `fable`, `inherit` 별칭을 쓰고 어댑터가 하네스별 모델로 번역한다. 분포(문서 표): Fable 2, Opus 54, Sonnet 70, Haiku 24, Inherit 52.
- 선택 기준(문서): Haiku는 명세가 분명한 코드 생성, 테스트 생성, 문서, 인프라 작업. Fable은 다시간 자율 작업에만 쓰고 "Security-analysis agents"에는 피하라고 한다. 이유: Fable 5의 사이버, 바이오 안전 분류기가 그 내용에서 Opus 4.8로 폴백하기 때문이라고 적었다. 즉 벤더 쪽 안전장치가 모델을 바꾸는 사례다.
- 조합 패턴 문서: 설계는 Sonnet, 구현과 테스트 생성은 Haiku, 리뷰는 다시 Sonnet(계획, 실행, 리뷰 샌드위치).
- 문서 내부 불일치: 표는 Opus 54개를 "critical architecture, security, code review"로 적지만 기준 절은 아키텍처와 보안 감사를 Sonnet 항목에 넣는다(해당 절의 Opus 항목은 확인 범위에서 보이지 않음).
- 폴백, 쿼터 규칙은 없다.

---

### bmad-code-org/BMAD-METHOD

- 별 55,448, 마지막 push 2026-11-17
- 근거: `docs/reference/skills-and-agents.md`(2026-11-11), `docs/toolsmith/subagent-patterns.md`(2026-11-01)
- 선택 이유: 역할 페르소나 중심의 대표 방법론이라 모델 지정이 없는 반대 사례.

- 역할은 에이전트 정체성과 사용자 커스터마이즈 레이어(`customize.toml`)로 정의하고 모델은 지정하지 않는다. 확인한 파일 3개에 모델, 등급 설정이 없다(grep 결과 `bmad-review/customize.toml`의 "model"은 모델 일반 이야기). 서브에이전트가 없는 환경에서는 각 역할을 인라인으로 차례로 돌리라고 안내한다(`subagent-patterns.md`).

---

### smtg-ai/claude-squad

- 별 8,821, 마지막 push 2026-11-13
- 근거: `config/config.go`, `README.md`
- 선택 이유: 세션 관리 도구의 최소 사례.

- 역할도 모델 설정도 없다. `default_program`이 기본 `claude`이고 `profiles` 배열로 이름 붙인 실행 프로그램 문자열(`claude`, `codex`, `aider --model ...` 등)을 바꿔 쓴다. 즉 모델 선택은 각 CLI에 위임한다.

## 사용자 이슈와 토론 사례

링크는 모두 직접 열어 제목, 날짜, 반응 수를 확인했다.

- [opencode #7602](https://github.com/anomalyco/opencode/issues/7602) "Native Model Fallback / Failover Support": 2026-01-10 생성, 추천 121, 댓글 32, 2026-10-13에 `not_planned`로 닫힘. 요청 내용: 코어는 같은 모델 ID의 제공자 폴백만 하고 서로 다른 모델 사이 폴백이 없다. 후속 댓글: OpenCode Go 계정 여러 개를 쓰며 429가 나면 같은 제공자 안에서 키를 돌리는 로테이션이 필요하다는 요구, 외부 라우터(`swobu`)와 플러그인(`opencode-fallback`) 링크.
- [opencode #1267](https://github.com/anomalyco/opencode/issues/1267) 모드별 모델 목록으로 장애와 크레딧 소진 시 폴백(2025-07-24, 추천 10, 닫힘): 같은 요구가 1년 넘게 반복됐다.
- [oh-my-openagent #703](https://github.com/code-yeongyu/oh-my-openagent/issues/703) 에이전트 하나에 폴백 모델 여러 개(2026-01-12, 추천 22, 닫힘): 비싼 주 모델이 429나 크레딧 소진에 걸리면 에이전트가 멈추고 사용자가 설정 파일을 손으로 고쳐야 한다는 불만. 현재 체인 구조는 이 요구의 결과로 보이나 연결은 확인하지 못했다.
- [oh-my-openagent #839](https://github.com/code-yeongyu/oh-my-openagent/issues/839) 모델 문자열 하드코딩을 설정 상수로(2026-01-16, 열림, 댓글 11): 모델 ID가 20개 넘는 파일에 흩어져 어디에 어떤 모델이 쓰이는지 감사하기 어렵다는 지적. 지금은 체인이 전용 파일로 모였다.
- [oh-my-openagent #5435](https://github.com/code-yeongyu/oh-my-openagent/issues/5435) `runtime_fallback`이 "Model Fallback" 토스트만 띄우고 주 세션이 소진된 OpenAI 모델을 계속 재시도(2026-06-19, 닫힘): 폴백이 표시와 달리 실제로는 안 넘어간 버그.
- [oh-my-opencode-slim #595](https://github.com/alvinunreal/oh-my-opencode-slim/issues/595) 폴백이 백그라운드 작업 수명주기와 분리돼 실패가 사라지고 성공이 고아가 됨(2026-06-24, 닫힘), [#560](https://github.com/alvinunreal/oh-my-opencode-slim/issues/560), [#998](https://github.com/alvinunreal/oh-my-opencode-slim/issues/998)도 같은 계열. 폴백이 성공해도 오케스트레이터가 결과를 못 받는 문제가 반복해서 보고됐다.
- [oh-my-opencode-slim #638](https://github.com/alvinunreal/oh-my-opencode-slim/issues/638) 프리셋 단위 폴백 요청: wontfix(`.out-of-scope/preset-fallback.md`). PR #144의 provider smart routing도 "범위 밖"으로 닫혔다.
- [oh-my-claudecode #1135](https://github.com/Yeachan-Heo/oh-my-claudecode/issues/1135) 모델 라우팅을 끄고 모든 에이전트에 단일 모델을 쓰게 해 달라(2026-02-27, 닫힘): 사용자가 `settings.json`의 `model`과 `OMC_ROUTING_ENABLED=false`를 시도했는데도 라우터가 explore는 haiku, executor는 sonnet으로 덮는다는 불만. 지금 코드에는 `forceInherit` 옵션(이슈 #1135를 주석으로 인용)이 있다.
- [oh-my-openagent #2075](https://github.com/code-yeongyu/oh-my-openagent/issues/2075) 가벼운 카테고리(quick)에 gpt-5.3-codex-spark가 가능하면 자동 선택(2026-02-23, 닫힘): 계정이 접근 가능한 모델을 조회해 거기에 맞춰 쓰자는 요구. 현재 `quick`의 첫 rung은 GPT-6 Luna Fast로 바뀌어 있다.
- [Kilo #14338](https://github.com/Kilo-Org/kilocode/issues/14338) 수동 모델 선택이 에이전트별이 아니라 전역으로 기억됨(2026-09-20, 닫힘), [#11383](https://github.com/Kilo-Org/kilocode/issues/11383) 에이전트 매니저 작업별 모델 지정 요청. 현재 문서는 "에이전트와 세션별로 기억"이라고 적는다.
- [goose PR #7989](https://github.com/aaif-goose/goose/pull/7989) lead/worker 제거(2026-03-18 머지)에 달린 댓글([1](https://github.com/aaif-goose/goose/pull/7989#issuecomment-4173896846), [2](https://github.com/aaif-goose/goose/pull/7989#issuecomment-4315187880), [3](https://github.com/aaif-goose/goose/pull/7989#issuecomment-4583463648)): 제거 이유를 묻고("Are lead models ill supported, or why was this taken out?"), 비용을 낮추면서 품질을 유지하는 새 권장 방식이 있는지 묻는다. 웹사이트가 아직 기능을 광고한다는 지적도 있다. 내가 확인한 범위에서 유지보수자의 답변은 보이지 않았다.
- [gemini-cli #24937](https://github.com/google-gemini/gemini-cli/issues/24937) "Tracking: 429 / Capacity Issues"(2026-04-08, 열림, 댓글 131): 폴백 정책이 있어도 429가 대량으로 보고되는 추적 이슈. 본문은 열지 않았다(원문 미확인).

## 저장소 전체를 가로지르는 관찰

1. 비싼 모델은 호출 빈도가 낮은 판단 역할에, 싼 모델은 호출이 잦은 실행 역할에 둔다는 쪽이 다수다. oh-my-openagent는 문서에 직접 적었고("explore/librarian on Opus or Fable: Massive cost waste"), OMC의 호환성 문서는 "계획과 리뷰는 비싸게, 구현은 싸게"를 규칙 1로 둔다. gemini-cli는 코드로 구현해서 PLAN 모드면 Pro, 승인된 계획 뒤 구현은 Flash로 보낸다. Kilo frontier도 plan, architect, debug는 Opus, build, explore, code는 Sonnet으로 나눈다. wshobson/agents의 설계는 Sonnet, Haiku, Sonnet 순서로 계획, 실행, 리뷰를 끼운다.

2. 반대 진영이 크다. 역할마다 모델을 바꾸지 않고 상속하거나 effort만 바꾼다. opencode, OpenHands 내장 서브에이전트, codex 내장 역할, crush(`coder`, `task`, `plan` 모두 large 슬롯), claude-squad는 역할별 모델 기본값이 없다. oh-my-codex는 `gpt-6-astra` 하나로 frontier, standard, fast 세 클래스를 모두 채우고 역할 차이는 `reasoningEffort`(low부터 xhigh)로만 둔다. 같은 "역할 분화"를 모델이 아니라 effort 기준으로 하는 설계다.

3. 모델 계열을 역할 성격에 맞추는 설계가 있다. oh-my-openagent는 대화와 계획(메인, plan-consultant)에 Claude 계열, 자율 심층 작업(ultrabrain, deep, plan-reviewer)에 GPT 계열, UI와 문서(visual-engineering, writing)에 Gemini Argon을 1순위로 둔다. 그리고 `ultrabrain`, `deep-*`에 Claude나 Kimi를 쓰는 것을 "Risky"로 분류한다. 반면 OMX는 한 벤더만 쓰고, Kilo는 Claude 한 벤더 안에서 Opus와 Sonnet을 나눈다. 같은 OMC 저장소 안에서도 호환성 문서(2026-05-28)는 Hephaestus에 GPT를 쓰지 말라고 하는데 현행 omo 문서는 구현 성격 카테고리에 GPT를 1순위로 둔다. 문서 날짜와 모델 세대가 달라서 충돌처럼 보이는 부분이 있다.

4. 폴백 설계는 크게 네 가지로 나뉜다.
   - 순서 있는 체인을 설정하고 소진되면 다음으로: oh-my-openagent(역할, 카테고리별 체인), slim(`model` 배열), OpenHands(`fallback_llms` 프로필 목록).
   - 같은 가족 안에서만 내려가고 사용자에게 묻거나 조용히 넘김: gemini-cli(Pro에서 Flash, 기본은 `prompt`, `auto` 선택이면 `silent` + 최대 3회).
   - 폴백 없이 재시도 또는 대기: opencode 코어(같은 모델 지수 백오프, `retry-after` 15분 상한), OMC(`rate-limit-wait` 데몬이 리셋까지 기다렸다가 세션 재개). 모델을 바꾸지 않는다.
   - 제공했다가 제거하거나 범위 밖으로 선언: goose(lead/worker 삭제), slim(provider smart routing, 프리셋 폴백 wontfix), opencode(#7602 not_planned).

5. 폴백을 일으키는 조건은 저장소마다 다르다. 이것이 가장 큰 설계 차이다.
   - OpenHands: 재시도 소진 뒤의 일시 오류(rate limit, 타임아웃, 연결, 5xx)만. 잘못된 요청, 인증, 컨텍스트 초과, 예산 거부는 폴백하지 않는다. 쿼터 소진은 주 모델 재시도 없이 즉시 폴백한다.
   - slim: 호스트 재시도 이벤트 3회를 흡수한 뒤. 대기가 30분을 넘게 알려지면 횟수와 무관하게 즉시 폴백. 제공자 단위 실패면 그 제공자를 30분 제외한다.
   - goose(제거 전): API 타임아웃이 아니라 "실제 작업 실패"(연속 N회)만 신호로 삼았다.
   - gemini-cli: 모델 실패(쿼터, 서버 오류 예시)에 반응하고 정책이 `prompt`면 사용자 승인을 받는다.
   - oh-my-openagent: 위임 자식은 연결된 프로바이더가 서빙하는 첫 rung을 고르는 방식이고, 런타임 폴백이 어떤 오류에서 발동하는지는 엔진(Senpi) 쪽이라 원문 미확인.

6. 사용량 수치를 읽어 모델을 바꾸는 장치는 이번에 확인한 범위에서 찾지 못했다. 대신 세 가지 대체 수단이 있다. 시간 기반 제외(slim 30분), 호스트가 알려 준 대기 시간 임계(slim 30분 초과 시 즉시 폴백), 서킷 브레이커(ruflo, 실패 5회와 60초 리셋). 쿼터를 아끼는 방법은 설정 가이드로 사람에게 맡기거나(omo의 "희소한 모델은 빈도 낮은 역할에") `models_distribution: round_robin`처럼 병렬 스폰의 시작 모델을 돌리는 것이다(omo). OMC는 `rate-limit-wait`가 한도 시각을 읽는 쪽이지만 모델을 바꾸지 않는다.

7. 가용성에 맞춰 체인이 줄어드는 설계가 있다. oh-my-openagent는 카테고리의 어떤 rung도 서빙되지 않으면 그 카테고리를 메인 에이전트의 목록에서 뺀다("선택해 놓고 실패" 방지). `writing`은 Claude 둘과 Argon이 모두 없으면 다른 계열로 폴백하지 않고 사라진다. 구독 로그인이 API 키보다 항상 앞선다는 규칙(`anthropic-subscription`, `chatgpt-subscription` 선행)도 같은 의도로, 과금되는 경로로 새는 것을 코드 주석이 이슈 번호와 함께 막는다. Kilo는 반대로 모델 선택을 서버로 올려 티어 뒤 모델을 서버가 바꾼다.

8. 리드와 소통 역할에는 대부분 별도 모델이 없다. 리드는 사용자가 고른 메인 모델이거나(opencode, Kilo, slim의 orchestrator, OMC) 전용 프로필 레인이다(oh-my-openagent의 daily와 geeky 4레인). 소통, 보고 전용 역할을 따로 정의한 저장소는 확인하지 못했다. 가장 가까운 것은 oh-my-openagent 문서의 "Claude 계열은 communicative roles(메인, plan-consultant)에 맞다"는 서술과 OMC `writer`(haiku)다. 모델 선택 자체를 라우터가 자동으로 하는 곳은 OMC(복잡도 점수), gemini-cli(LLM 분류기와 승인 모드), Kilo(서버, 벤치마크 기반), ruflo(WASM, Haiku, Sonnet/Opus 3단)이고 OpenHands는 선택 기능이다. oh-my-openagent는 메인 에이전트가 모델이 아니라 카테고리를 고르고 카테고리가 체인으로 모델을 정한다.

## 설계끼리 충돌하는 지점

- 사용자 제어 대 자동 라우팅: OMC 이슈 #1135는 라우터가 사용자 모델 선택을 덮는다고 불만을 냈고 `forceInherit`가 생겼다. 반대로 slim과 opencode는 라우팅을 "플러그인이나 호스트 사용자 설정의 몫"으로 선언해 자동 라우터를 범위 밖에 둔다. Kilo는 서버 라우터를 기본 상품으로 낸다.
- 폴백을 코어에 둘지: opencode는 #7602(추천 121)를 not_planned로 닫고 플러그인에 맡겼다. oh-my-openagent, slim, OpenHands는 자체 폴백을 구현해 이슈의 실제 구현자가 됐다. 그 결과 slim과 omo에서 폴백 성공 결과가 고아가 되거나 토스트만 뜨고 안 넘어가는 버그(#595, #5435)가 나왔다. 호스트 밖 플러그인이 폴백을 얹을 때 작업 수명주기와 어긋나는 구조적 위험을 보여 준다.
- 쿼터 대응이 기다림 대 전환: OMC는 기다렸다가 같은 모델로 재개하고, omo, slim, OpenHands는 다른 모델로 넘긴다. 사용자 요구는 후자(#703, #7602, #1267)지만 전환이 결과 품질과 프롬프트 캐시에 주는 영향은 어느 저장소도 정량 자료를 내지 않았다(원문 미확인). omo는 프롬프트 캐시 보존을 이유로 모델 분산을 스폰 시 1회로 제한한다.
- 역할 분화의 기준: 모델을 나누는 쪽(omo, Kilo, gemini-cli, wshobson)과 effort만 나누는 쪽(OMX), 아예 나누지 않는 쪽(opencode, crush, codex, OpenHands 내장)이 공존한다. goose는 리드와 워커 분리를 만들어 쓰다가 코드에서 삭제했고 이유를 문서에 설명하지 않아 사용자가 질문하는 상태다.
- 벤더 경계: gemini-cli는 같은 가족 안에서만 내려가고, omo 체인은 Claude에서 Kimi, GPT에서 Claude로 벤더를 넘나든다. wshobson 문서는 Fable이 보안 분석 내용에서 벤더 안전장치로 Opus 4.8로 폴백된다고 적어 벤더 측 암묵적 폴백도 존재한다고 알려 준다. 이 폴백은 하네스 설정으로 제어할 수 없는 계층이다.
- 문서와 코드의 시차: OMC는 `docs/shared/agent-tiers.md`와 프런트매터가 architect, security-reviewer, scientist에서 다르고(문서는 "sonnet, opus", 프런트매터는 opus 또는 sonnet 단일), 코드 기본 모델은 Opus 4.8, Sonnet 5, Codex gpt-5.3-codex로 omo 문서의 Opus 5.5, Fable 5.2, GPT-6 계열보다 두세 세대 뒤다. Kilo 매핑 문서(2026-10-13)도 Opus 4.7 기준이다. 모델 이름과 기본값은 몇 주 단위로 낡으므로 표를 인용할 때 문서 커밋 날짜를 같이 봐야 한다.

## 한계

- 파일 전체를 끝까지 읽은 곳은 oh-my-openagent의 모델 매칭 가이드, OMC와 OMX의 에이전트 정의 일부, OpenHands 기능 지도, gemini-cli의 정책 카탈로그 일부다. 나머지는 grep과 발췌로 읽었으므로 "없음"이라고 쓴 항목은 "확인한 범위에서 없음"이다.
- oh-my-openagent의 메인 세션 런타임 폴백 트리거는 Senpi 엔진 저장소 소관이라 열지 않았다.
- 별 수와 push 날짜는 조회 시점 값이고 변동한다.
- 트렌딩 페이지에서 나온 `qwen-code`, `t3code`, `plannotator`, `agent-skills` 등은 열어 보지 않았다.
