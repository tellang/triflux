# 3사 모델 가족 1차 자료 검증

열어 본 날짜: 2026-11-17 (전 항목 동일, 별도 표기 없으면 이 날짜).
방법: 1차 도메인 원문을 curl 과 Exa web_fetch 로 직접 열었다. 2차 요약(llm.ing, benchleader, wikiprompt 등)은 수치 근거로 쓰지 않았고 대조용으로만 봤다. 열리지 않은 곳은 "원문 미확인"으로 적었다.

## 접근 결과 요약

| 출처 | 결과 |
|---|---|
| artificialanalysis.ai 리더보드, 모델 페이지 11개, 비교 페이지 6개 | 열림 |
| blog.google Hydrogen, Carbon(2건), Argon 발표 | 열림 |
| antigravity.google 블로그 3건, docs(models, swarm, subagents) | 열림 |
| ai.google.dev 가격 페이지 | 열림 |
| developers.openai.com model-selection, latest-model, 가격, Luna 모델 페이지 | 열림 |
| learn.chatgpt.com 모델, 서브에이전트 문서 | 열림 |
| openai.com Terra, Sol 발표 | curl 403, Exa 검색 하이라이트로만 확인 (본문 일부) |
| openai.com Astra, Sol and Luna 발표 | curl 미시도, Exa 검색 하이라이트로 확인 (본문 일부) |
| platform.claude.com 모델 개요, 모델 선택, 가격 | 열림 |
| anthropic.com Opus 5.5, Sonnet 5.5, Haiku 5.5 발표 | 열림 |
| anthropic.com Fable 5.2 발표 (claude-fable-and-mythos-5-2) | Exa 검색 하이라이트로 확인 (본문 일부) |
| code.claude.com sub-agents, model-config | 열림 |
| arena.ai text, webdev, creative-writing | curl 403, Exa fetch 로 표 확인 (text, webdev 는 fetch, creative-writing 은 검색 하이라이트) |
| tbench.ai 홈(4.1 보드) | 열림 (순위표는 Exa 하이라이트에서 15위까지 확인) |
| openai.com/api/pricing | 비즈니스 요금제 페이지라 API 가격 없음. API 가격은 developers.openai.com 에서 확인 |

## 1. Artificial Analysis

기준: Intelligence Index v5.0.1 (9개 평가: AA-Briefcase v1.1, AutomationBench-AA, Terminal-Bench 4.0, FrontierCode-AA 2.0, AA-Omniscience v1.1, GDP.pdf, HLE-Diamond, CritPt v2, Terminal-Bench-Science 0.1).
URL: https://artificialanalysis.ai/leaderboards/models, https://artificialanalysis.ai/models/{slug}, https://artificialanalysis.ai/models/comparisons/{a}-vs-{b}

주의 세 가지.
- 이 지수는 v5 로 바뀌면서 v4.3.2 점수와 비교할 수 없다. 리더보드 본문에도 "Time per Task"(분)와 "First Answer Token"(초)만 속도 열로 쓰고, tok/s 는 모델 페이지와 비교 페이지에만 있다.
- 작업당 비용(Cost per Task)은 Intelligence Index 작업 1건의 가중 평균 비용이다. 같은 지수 내 비교용이고 실제 코딩 세션 비용이 아니다.
- 같은 날 두 번 열었을 때 시간과 지연이 소폭 달랐다(예: Fable 5.2 max 40.9분, 207.86초에서 40.8분, 208.11초). 아래는 나중에 연 값이다.

### 1-1. 가족별 최고 설정과 기본 노출 설정

리더보드가 모델당 하나로 보여 주는 설정 기준. 단가는 입력/출력 USD per 1M tokens.

| 모델 | 설정 | 지수 | 작업당 비용 | 작업 시간(분) | 출력 속도(tok/s) | 첫 답변 토큰(초) | 단가 |
|---|---|---|---|---|---|---|---|
| Claude Fable 5.2 | max | 65 | $26.54 | 40.8 | 112 | 208.11 | 8 / 40 |
| Gemini 4 Carbon | high | 60 | $5.48 | 31.1 | 66 | 73.05 | 2 / 10 |
| Claude Opus 5.5 | max | 59 | $10.04 | 24.6 | 117 | 352.34 | 4 / 20 |
| GPT-6 Astra | max | 57 | $6.24 | 20.4 | 42 | 195.31 | 10 / 50 |
| GPT-6.1 Sol | max | 55 | $1.27 | 23.0 | 49 | 154.71 | 2 / 10 |
| Claude Sonnet 5.5 | max | 55 | $10.02 | 32.4 | 147 | 278.92 | 2 / 10 |
| Gemini 4 Hydrogen | xhigh | 54 | $3.16 | 14.7 | 175 | 44.10 | 1.50 / 7.50 |
| GPT-6.1 Terra | max | 51 | $0.96 | 14.0 | 71 | 146.11 | 1 / 5 |
| Gemini 4 Argon | high | 50 | $4.97 | 29.3 | 66 | 43.88 | 2 / 10 |
| Claude Haiku 5.5 | max | 36 | $0.41 | 14.7 | 257 | 182.34 | 0.10 / 0.50 (100K 이하) |
| GPT-6 Luna | max | 28 | $0.15 | 12.2 | 103 | 68.26 | 0.10 / 0.50 |

### 1-2. 설정(effort)별 수치

각 비교 페이지의 effort 표에서 그대로 옮겼다. 지수 | 작업당 비용 | 작업 시간(분) | tok/s | 첫 답변 토큰(초).

Claude Fable 5.2 (비교: gpt-6-astra-vs-claude-fable-5-2)
- max: 65 | $26.54 | 40.8 | 112 | 208.11
- xhigh: 62 | $14.83 | 25.8 | 105 | 48.22
- high: 62 | $9.08 | 14.6 | 111 | 23.65
- medium: 56 | $3.80 | 6.8 | 105 | 9.20
- low: 54 | $3.10 | 5.4 | 111 | 7.22

GPT-6 Astra
- max: 57 | $6.24 | 20.4 | 42 | 195.31
- xhigh: 55 | $3.66 | 11.0 | 41 | 86.03
- high: 55 | $3.24 | 9.1 | 43 | 46.54
- medium: 52 | $2.73 | 6.6 | 46 | 6.10
- low: 43 | $1.42 | 3.4 | 45 | 3.70

Claude Opus 5.5 (비교: claude-sonnet-5-5-vs-claude-opus-5-5)
- max: 59 | $10.04 | 24.6 | 117 | 352.34
- xhigh: 57 | $6.05 | 15.8 | 109 | 65.52
- high: 52 | $3.46 | 9.3 | 108 | 21.64
- medium: 48 | $2.45 | 6.8 | 108 | 12.46
- low: 35 | $0.98 | 3.0 | 105 | 4.80

Claude Sonnet 5.5
- max: 55 | $10.02 | 32.4 | 147 | 278.92
- xhigh: 50 | $4.09 | 14.2 | 143 | 26.77
- high: 42 | $1.64 | 6.8 | 144 | 9.06
- medium: 31 | $0.78 | 4.0 | 129 | 4.71
- low: 26 | $0.51 | 2.6 | 134 | 2.50

Gemini 4 Carbon (비교: gpt-6-1-sol-vs-gemini-4-carbon)
- high: 60 | $5.48 | 31.1 | 66 | 73.05
- medium: 58 | $4.68 | 30.2 | 57 | 23.35
- low: 54 | $5.22 | 28.5 | 50 | 10.32

GPT-6.1 Sol
- max: 55 | $1.27 | 23.0 | 49 | 154.71
- xhigh: 52 | $0.76 | 9.7 | 52 | 65.21
- high: 50 | $0.59 | 7.5 | 50 | 31.29
- medium: 46 | $0.36 | 4.3 | 53 | 5.04
- low: 35 | $0.16 | 1.9 | 52 | 3.02

Gemini 4 Argon (비교: gpt-6-1-terra-vs-gemini-4-argon, gemini-4-hydrogen-vs-gemini-4-argon)
- high: 50 | $4.97 | 29.3 | 66 | 43.88
- medium: 48 | $4.31 | 28.6 | 58 | 12.02
- (low 와 xhigh 는 페이지에 행이 없다)

Gemini 4 Hydrogen
- xhigh: 54 | $3.16 | 14.7 | 175 | 44.10
- high: 51 | $1.87 | 7.8 | 181 | 14.89
- medium: 41 | $0.80 | 3.9 | 167 | 12.24
- low: 27 | $0.29 | 1.5 | 161 | 6.00

GPT-6.1 Terra
- max: 51 | $0.96 | 14.0 | 71 | 146.11
- xhigh: 45 | $0.40 | 6.3 | 69 | 27.58
- high: 42 | $0.26 | 4.1 | 68 | 10.15
- medium: 38 | $0.17 | 2.7 | 66 | 4.64
- non-reasoning: 31 | $0.23 | 2.4 | 65 | 2.42
- low: 29 | $0.0713 | 1.2 | 64 | 2.80

Claude Haiku 5.5 (비교: gpt-6-luna-vs-claude-haiku-5-5)
- max: 36 | $0.41 | 14.7 | 257 | 182.34
- xhigh: 35 | $0.25 | 9.8 | 231 | 47.19
- high: 30 | $0.16 | 6.5 | 225 | 17.83
- medium: 25 | $0.0918 | 4.0 | 224 | 9.55
- low: 19 | $0.0438 | 2.2 | 212 | 4.89

GPT-6 Luna
- max: 28 | $0.15 | 12.2 | 103 | 68.26
- xhigh: 23 | $0.10 | 7.3 | 100 | 16.03
- high: 21 | $0.0729 | 5.9 | 93 | 9.70
- medium: 18 | $0.0422 | 3.5 | 94 | 5.11
- low: 10 | $0.0051 | 0.6 | 89 | 2.67
- non-reasoning: 9 | $0.0714 | 1.9 | 90 | 1.55

### 1-3. 읽을 때 걸리는 점

- 지수 55 근처에 세 가족이 모인다: Sol max 55, Sonnet 5.5 max 55, Hydrogen xhigh 54. 비용은 $1.27, $10.02, $3.16 으로 크게 다르다.
- 지수 50 근처: Terra max 51, Hydrogen high 51, Argon high 50. 비용은 $0.96, $1.87, $4.97 이고 시간은 14.0분, 7.8분, 29.3분이다.
- Gemini 4 Carbon 과 Argon 은 effort 를 낮춰도 작업 시간이 거의 줄지 않는다(Carbon low 28.5분, Argon medium 28.6분). Hydrogen, Sol, Terra 는 effort 에 따라 시간이 크게 변한다.
- Fable 5.2 high(62)는 xhigh(62)와 지수가 같고 비용은 $9.08 대 $14.83 이다.
- Terra 의 Opus 5.5 대비 우위 주장(OpenAI 발표)은 아래 2-2 에 인용. AA 수치로는 Terra max 51($0.96)이 Opus 5.5 high 52($3.46)와 근접하다.

## 2. 벤더 공식 문서의 역할 권고

### 2-1. Google

**Hydrogen 발표** (https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-gemini-4-hydrogen/ , 2026-11-12, 최종 갱신 11-16)
- "While our frontier models, Gemini 4 Carbon and Gemini 4 Argon, excel at deep, long-horizon reasoning on your hardest problems, Hydrogen is built for rapid execution across diverse agentic workflows."
- "Hydrogen is built to stand on its own as a model for everyday work ... or to pair with Carbon and Argon as the high-efficiency execution engine in multi-model workflows." (원문 중간 기호는 생략 표시로 바꿨다)
- "For workflows that require parallel agents, Carbon can act as the coordinator while Hydrogen can power worker and verifier agents to build and test changes simultaneously across isolated workspaces"
- "Hydrogen surpasses Argon on the Artificial Analysis Intelligence Index at its default high thinking level (51 vs. 50, and reaching 54 at its highest xhigh thinking setting)". 이 수치는 위 AA 표와 일치한다.
- 가격: "$1.50 per million input tokens and $7.50 per million output tokens", 1M 컨텍스트 전 구간 동일.

**Carbon 발표 1** (https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-gemini-4-carbon/ , 2026-10-28)
- "Gemini 4 Carbon is our strongest model with state-of-the-art cybersecurity and long horizon capabilities."
- "Designed to take on much harder, long-horizon engineering problems, Carbon is built for sustained agentic workflows."
- 당시 AA 지수 "ranks #1 ... at 59". 지금은 60(AA 현재값).

**Carbon 발표 2, 일반 공개** (https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-4-carbon-now-available/ , 2026-11-10)
- "Argon remains the ideal choice for the majority of software engineering and knowledge work, while Carbon is built for tasks that test the limits of a model's intelligence like complex, multi-step coding and debugging and open-ended scientific research and discovery ... using more tokens than Argon to explore thoroughly, reason deeply, and run extended verification loops." (원문 중간 기호는 생략 표시로 바꿨다)
- "Developers can assign Carbon to roles that demand the deepest reasoning, like architectural design, coordination, and auditing, while pairing it with faster, lighter models across parallel isolated workspaces and adversarial verifiers that test every change."

**Argon 발표** (https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-gemini-4-argon/ , 2026-10-13)
- "Argon excels at deep work in complex, real-world tasks across domains including coding, finance, legal, cybersecurity, and science."
- AI Studio 문서(aistudio.google.com/docs/whats-new-gemini-4-argon, 검색 하이라이트): "Our efficient Gemini 4 frontier reasoning model, delivering faster responses and lower token spend per turn compared to Gemini 4 Carbon". 기본 thinking level 은 `medium`.

**Antigravity 블로그, Carbon 과 /swarm** (https://antigravity.google/blog/gemini-4-carbon-in-google-antigravity/ , 2026-11-10)
- "While Gemini 4 Argon remains an ideal choice for most advanced engineering and knowledge work tasks, Carbon is built to explore thoroughly, reason deeply, and run extended verification loops using more tokens (ranking #1 on CursorBench 4.0 and Perplexity's WANDR). That makes Carbon ideal for high-leverage coordinator, architecture, cybersecurity auditing, and adversarial verification roles while lighter, faster models handle the parallel file edits and routine implementation tasks."
- "even with zero-token idle waits and dynamic model hot-swapping, parallel multi-agent systems consume quota much faster than a standard chat."
- 제공 범위: Carbon 은 Google AI Ultra 구독자 대상.

**Antigravity 블로그, Hydrogen 과 Orchestrator** (https://antigravity.google/blog/gemini-4-hydrogen-in-google-antigravity/ , 2026-11-12)
- "Carbon can start in a read-only phase to explore dependencies, resolve ambiguities, and build a concrete plan with explicit re-planning triggers. Hydrogen could then take over to write edits, update packages, and run tests. If Hydrogen hits friction, it would hand back to Carbon to inspect the state, repair the plan, and resume execution."
- "On Terminal-Bench 4.1, Orchestrator reached near-Carbon task success rates while, on average, consuming 24% less quota and completing 19% faster." (같은 날 Google 블로그는 이 문장을 "Terminal-Bench 4.0"으로 적었다. 두 원문이 서로 다르다.)
- Hydrogen 단독: "57% on Terminal-Bench 4.1" 이라고 적었으나 tbench.ai 순위표는 Hydrogen(high) 56.4% 다(4항 참조).
- Orchestrator (Carbon)는 Ultra 만, Orchestrator (Argon)은 Ultra 와 Pro.

**Antigravity 문서, 모델 선택** (https://antigravity.google/docs/models/)
- "Orchestrator (recommended default): Most day-to-day development, such as feature work, bug fixes, refactoring, and multi-file debugging, where you want Gemini 4 Carbon or Gemini 4 Argon to plan and review the work and Gemini 4 Hydrogen to carry out the implementation faster and with fewer tokens used."
- "Gemini 4 Carbon or Gemini 4 Argon: Work where every intermediate step needs maximum reasoning depth, such as designing complex distributed systems from scratch, untangling subtle concurrency race conditions, or running multi-repository migrations."
- "Gemini 4 Hydrogen: Fast, everyday coding and maintenance tasks where you don't need a separate planning phase, such as package upgrades, code deduplication, scaffolding boilerplate, writing unit tests for well-defined functions, updating documentation, or generating quick scripts."
- Orchestrator 구성: planner(Carbon 또는 Argon)가 계획과 검토, Hydrogen 이 구현. 고정 구성이라 thinking level 선택 불가. `agy --model "Orchestrator (Carbon)"` 로 지정.
- Antigravity 에서 Claude Sonnet 5.5 (thinking), Claude Opus 5.5 (thinking) 도 선택 가능. Gemini 4 Hydrogen 은 `xhigh` 를 `--model gemini-4-hydrogen-xhigh` 또는 `--effort xhigh` 로 지정.

**Antigravity 문서, Swarm 과 서브에이전트** (https://antigravity.google/docs/swarm/ , https://antigravity.google/docs/subagents/)
- "Workers run on the same model as your conversation. To use a different model for one worker or for all of them, say so in your prompt, for example, "run the verifier on a different model than the workers.""
- 서브에이전트 frontmatter `model`: 기본 `inherit`, 선택지 `flash` 또는 `pro` 등급. 기본 제공 서브에이전트는 `research`, `browser`, `self`.
- Swarm 은 "broad and divides cleanly across independent files, packages, or investigation tracks", Boost 는 "the problem is hard rather than broad", Teamwork 는 "long-horizon, multi-milestone projects".
- 문서에 Hydrogen, Argon, Carbon 을 역할별로 못박은 표는 없다. 역할 권고는 위 블로그와 모델 선택 문서가 전부다.

### 2-2. OpenAI

**모델 선택 가이드** (https://developers.openai.com/api/docs/guides/model-selection)
- "Luna is the most cost-efficient model, while Astra is our state-of-the-art, most powerful model. If cost and latency aren't a concern, you can default to Astra."
- 7단계 순서(원문): "Luna · Low: Fine-grained edits, well-scoped problem-solving, and simple data extraction." / "Luna · Extra high: Finding current context across multiple apps, prioritizing work, and solving problems with clear constraints." / "GPT-6.1 Sol · Medium: Complex technical work and coordinated deliverables you expect to revise." / "GPT-6.1 Sol · Extra high: Polished deliverables, connected visual systems, and decisions built from conflicting evidence." / "Astra · Low: Concise writing and content adaptation that preserve facts and nuance." / "Astra · Medium: Ambitious projects that need broad context, reliable interactions, and complete results." / "Astra · Extra high: Demanding analysis and complex deliverables with exacting requirements."
- Terra: "Try GPT-6.1 Terra for concise writing based on supplied material, computer-use tasks with a defined outcome, and scoped code fixes."
- Sol: "Consider GPT-6.1 Sol for complex projects where cost matters ... Compare it with Astra on the same task to assess the tradeoff between quality and cost."
- 이 순서에 Terra 는 들어 있지 않다.

**Using GPT-6** (https://developers.openai.com/api/docs/guides/latest-model)
- "Use GPT-6 Astra for the most demanding work, GPT-6.1 Sol for complex work at lower cost, GPT-6.1 Terra for visual reasoning and writing, or GPT-6 Luna for focused, high-volume tasks."
- "GPT-6 Astra is trained to be able to divide and delegate work to subagents that work in parallel."

**Codex 모델 문서** (https://learn.chatgpt.com/docs/models)
- "Astra suits the most demanding workflows. GPT-6.1 Sol offers near-Astra performance at a lower cost than Astra. GPT-6.1 Terra is a fast, efficient choice for writing, visual understanding, and computer use. Luna suits focused, repeatable tasks."
- "GPT-6.1 Sol, for repeated, long-running work. Consider GPT-6.1 Sol for work across code, apps, and documents when cost matters. Keep Astra for your most demanding work."
- "GPT-6.1 Terra, for everyday writing and visual work."
- "Luna, for clear, repeatable tasks. Choose Luna for specific, high-volume tasks when you know what a good result looks like, such as extraction, classification, transformation, and structured summaries."
- GPT-6.1 Sol 기본 컨텍스트 500,000 토큰(Codex 와 ChatGPT Work). Terra 는 Codex CLI 0.159.0 이상 필요.

**Codex 서브에이전트 문서** (https://learn.chatgpt.com/docs/agent-configuration/subagents)
- "For most tasks in Codex, start with `gpt-6.1-sol` when your signed-in account or workspace has access. ... Use `gpt-6-luna` when you want a faster, lower-cost option for lighter subagent work."
- "`gpt-6.1-sol`: Start here for demanding agents. Use it for ambiguous, multi-step work that needs planning, tool use, validation, and follow-through across a larger context."
- "`gpt-6-luna`: Use for fast, narrowly scoped agents handling clear, repeatable, or high-volume work."
- "For explicit model settings, start with `high` for GPT-6 Luna or `low` for GPT-6 Astra."
- 서브에이전트 모델 미설정 시 부모 모델과 effort 를 상속. 내장 에이전트 `default`, `worker`, `explorer`. 설정 키 `agents.default_subagent_model`, `agents.default_subagent_reasoning_effort`.
- 이 문서의 모델 권고에 Terra 와 Astra 는 서브에이전트 역할로 나오지 않는다(Astra 는 effort 시작점만 언급).

**Terra 발표** (https://openai.com/index/introducing-gpt-6-1-terra/ , 본문은 Exa 하이라이트로 확인, curl 403)
- "a fast, efficient model that combines detailed visual reasoning and precise computer use alongside clearer, more natural writing."
- "For the most complex coding tasks, GPT-6.1 Sol and GPT-6 Astra remain the better choice."
- "At maximum reasoning effort, GPT‑6.1 Terra solves 50.3% of tasks [Terminal-Bench 4.0], more than double GPT‑5.6 Terra's published score of 21.5%." (tbench.ai 4.1 순위표의 Terra max 는 53.3%. 발표 시점과 다른 값이므로 같은 값이 아니다.)
- 가격: "Standard API pricing is $1 per million input tokens, $0.05 per million cached input tokens, and $5 per million output tokens."

**Sol 6.1 발표** (https://openai.com/index/introducing-gpt-6-1-sol/ , Exa 하이라이트)
- "a fifth of Astra's standard input and output token prices", 부제 "Near-Astra intelligence for a fifth of the price."

**Astra 발표** (https://openai.com/index/gpt-6-astra/ , Exa 하이라이트)
- "GPT‑6 Astra, the world's most intelligent and aligned model." 가격 $10 / $50, Fast 모드 2배 속도 2배 가격.

**Sol 과 Luna 발표** (https://openai.com/index/introducing-gpt-6-sol-and-luna/ , Exa 하이라이트)
- "While the most demanding and important projects still call for Astra's full depth, work happens at different scales, rhythms, and budgets."

**Luna 모델 페이지** (https://developers.openai.com/api/docs/models/gpt-6-luna)
- "GPT-6 Luna is our most efficient model for focused, high-volume tasks." 컨텍스트 1,050,000.

### 2-3. Anthropic

**모델 개요** (https://platform.claude.com/docs/en/models/overview)
- "If you're unsure which model to use, start with Claude Opus 5.5 for most workloads. Use Claude Fable 5.2 for demanding reasoning and long-horizon agentic work, or when your evals on Claude Opus 5.5 at higher effort still fall short."
- 설명 열: Fable 5.2 "For demanding reasoning and long-horizon agentic work", Opus 5.5 "For long-running agentic coding and knowledge work", Sonnet 5.5 "The best combination of speed and intelligence", Haiku 5.5 "For high-volume, latency-sensitive tasks such as classification, extraction, and routing".
- 기본 effort: Fable 5.2 `high`, Opus 5.5 `medium`, Sonnet 5.5 `high`, Haiku 5.5 `medium`. 상대 지연: Haiku 가장 빠름, Sonnet 빠름, Opus 와 Fable 보통.

**모델 선택 문서** (https://platform.claude.com/docs/en/about-claude/models/choosing-a-model)
- "Most workloads start with Claude Opus 5.5."
- 선택 표: 최고 성능은 Fable 5.2("Agent sessions that run for hours, multistep deep research ..."), Opus 5.5 는 "Multihour autonomous coding agents, large-scale refactoring, complex systems engineering, vision-heavy workflows, computer use", Sonnet 5.5 는 "Code generation, data analysis, content creation, visual understanding, agentic tool use", Haiku 5.5 는 "Real-time applications, high-volume intelligent processing, cost-sensitive deployments needing strong reasoning, subagent tasks".
- "If your evals at `xhigh` or `max` effort still fall short on demanding reasoning or long-horizon agentic work, move to Claude Fable 5.2."

**Fable 5.2 발표** (https://www.anthropic.com/claude-fable-and-mythos-5-2 , 2026-11-09, Exa 하이라이트)
- "Fable and Mythos are best for the most ambitious, open-ended technical work. For most coding and knowledge tasks, we recommend that users start with Claude Opus 5.5, our strongest daily driver, and then switch to a different model as required, depending on the scope and complexity of their work ... upward to Fable or Mythos, or downward to Claude Sonnet 5.5 or Claude Haiku 5.5." (원문 중간 기호는 생략 표시로 바꿨다)
- "Fable 5.2 can also play the role of Advisor (where Haiku, Sonnet, or Opus models consult it to help solve harder problems) or Orchestrator (where it delegates simpler tasks to smaller models)."
- 가격 "$8 per million input tokens and $40 per million output tokens", fast mode "$16 per million input tokens and $80 per million output tokens", 출력 속도 Fable 5.1 대비 최대 30% 빠름.

**Opus 5.5 발표** (https://www.anthropic.com/claude-opus-5-5 , 2026-09-22)
- "It performs at the level of Claude Fable 5.1 on most work and costs 40% less to run than Opus 5."
- "Opus 5.5 is particularly good at long and sprawling jobs like codebase-wide migrations and audits."

**Sonnet 5.5 발표** (https://www.anthropic.com/claude-sonnet-5-5 , 2026-09-28)
- "Sonnet 5.5 is a faster, lower-cost complement to Claude Opus 5.5. Where Opus 5.5 is built for complex work requiring careful judgment, Sonnet 5.5 is strongest at well-scoped everyday tasks, fixing bugs, and creating polished documents, slides, and spreadsheets."
- "in our own testing, and in that of external testers, Opus 5.5 remains clearly stronger at complex, open-ended work requiring sustained judgment."

**Haiku 5.5 발표** (https://www.anthropic.com/claude-haiku-5-5 , 2026-10-07)
- "Claude Haiku 5.5 is designed for high-volume, cost-sensitive tasks. It reliably handles quick and repetitive workloads (like summaries, compactions, database queries, and classification requests). It pairs well with Opus 5.5 and Sonnet 5.5 as a subagent on coding work."
- "it works especially well for speed-sensitive tasks like live customer support and browser use."

**Claude Code 서브에이전트 문서** (https://code.claude.com/docs/en/sub-agents)
- `model` 필드: `sonnet`, `opus`, `haiku`, `fable`, 전체 ID, `inherit`. 생략 시 부모 모델 상속. 우선순위: 호출별 `model` 파라미터, 정의의 `model`, `CLAUDE_CODE_SUBAGENT_MODEL`, 메인 대화 모델.
- Explore: "the parent conversation's model. When the parent conversation runs Fable, Explore runs on Opus or stays on Fable, based on how you connect." 그리고 "define one with `model: haiku` to run exploration on a lower-cost model."
- 이 문서는 역할별 모델을 권하는 표가 없고, 예시 frontmatter 만 `model: sonnet` 을 쓴다.
- 모든 서브에이전트를 한 모델로 강제: `CLAUDE_CODE_SUBAGENT_MODEL` 과 `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` (v2.1.257 이상).

**모델 별칭** (https://code.claude.com/docs/en/model-config)
- Anthropic API 기준 `opus`는 Opus 5.5, `sonnet`은 Sonnet 5.5, `haiku`는 Haiku 5.5, `fable`은 Fable 5.2(게이트웨이 세션 제외).
- 별칭 설명: `fable` "for your hardest and longest-running tasks", `sonnet` "for daily coding tasks", `opus` "for complex reasoning tasks", `haiku` "for simple tasks".

**Anthropic 블로그 모델 선택 글** (https://claude.dev/blog/which-claude-model-should-you-build-with/ , 2026-11-09, Addy Osmani 저, anthropic 도메인이 아니라 claude.dev 게시물)
- "Subagents that search files, read logs, or summarize: Haiku 5.5 or Sonnet 5.5 ... Wrong answers are cheap to spot, and the main model has the judgment calls anyway."
- "Major refactors and migrations, architecture planning, and leading many subagents: Fable 5.2."
- "Everyday engineering and debugging. Multi-PR feature work: Opus 5.5, medium (default), then high."
- 이 글의 작성 주체가 Anthropic 공식 채널인지는 확인하지 못했다. 공식 문서가 아니라는 전제로 참고만 한다.

## 3. 가격 페이지 세 곳

### 3-1. Google (https://ai.google.dev/gemini-api/docs/pricing , 원문 열어 확인)
USD per 1M tokens, Standard, 유료 티어.

| 모델 | 입력 | 출력(thinking 포함) | 캐시 읽기 | 비고 |
|---|---|---|---|---|
| Gemini 4 Hydrogen | $1.50 | $7.50 | $0.075 | 무료 티어 있음. 페이지에 가격 변경 날짜 없음 |
| Gemini 4 Carbon | $2.00 (11-30까지), $4.00 (12-01부터) | $10.00, $20.00 | $0.10, $0.20 | 무료 티어 없음 |
| Gemini 4 Argon | $2.00 (11-30까지), $4.00 (12-01부터) | $10.00, $20.00 | $0.10, $0.20 | 무료 티어 없음 |

- 인용: "$2.00 through November 30, 2026. $4.00 starting December 1, 2026." (Carbon, Argon 입력). 출력은 "$10.00 through November 30, 2026. $20.00 starting December 1, 2026."
- 발표 쪽 표현은 introductory price. Carbon 일반 공개 글: "at the same introductory price as Gemini 4 Argon ($2 per million input tokens and $10 per million output tokens)".
- 12월 1일 인상이 Antigravity 구독 한도(Google AI Pro, Ultra)에 어떻게 반영되는지는 원문 미확인. API 토큰 단가만 확인했다.
- 모든 시간대와 시각 표기는 원문에 날짜만 있고 시각이 없다.
- Gemini 3.8 Flash 의 2027-01-01 인상은 2차 자료(s5labs.io)에서만 봤다. 원문 미확인.

### 3-2. OpenAI (https://developers.openai.com/api/docs/pricing , 원문 열어 확인)
USD per 1M tokens.

| 모델 | Standard 입력 / 출력 | 캐시 입력 | Batch 입력 / 출력 | Fast 입력 / 출력 |
|---|---|---|---|---|
| gpt-6-astra | $10.00 / $50.00 | $1.00 | $5.00 / $25.00 | $20.00 / $100.00 |
| gpt-6.1-sol | $2.00 / $10.00 | $0.10 | $1.00 / $5.00 | $4.00 / $20.00 |
| gpt-6.1-terra | $1.00 / $5.00 | $0.05 | $0.50 / $2.50 | $2.00 / $10.00 |
| gpt-6-luna | $0.10 / $0.50 | $0.01 | $0.05 / $0.25 | $0.20 / (잘림) |

- 예정된 가격 변경 문구는 이 페이지에서 찾지 못했다(검색어: price change, introductory, promotional). 눈에 띈 프로모션은 "GPT-6 Astra for Law promotional pricing is available at least through December 31, 2026." 한 건이고 우리 대상 모델과 무관하다.
- "Regional processing (data residency) endpoints are charged a 10% uplift for models released on or after March 5, 2026."
- openai.com/api/pricing 은 비즈니스 요금제 페이지다. 12월부터 ChatGPT 와 Codex 플랜 사용량이 한도 하나를 공유한다는 문구가 있다: "Starting in December, plan usage will have a shared limit across all of ChatGPT and Codex." (Business 플랜 한정 문구, 적용 범위는 원문 미확인)
- Codex 구독 한도 소모 비율은 Terra 발표가 "the same usage allowance covers more tasks than with GPT‑5.6 Terra and substantially more than with GPT‑6.1 Sol or GPT‑6 Astra"라고만 적었다. 수치 원문 미확인.

### 3-3. Anthropic (https://platform.claude.com/docs/en/about-claude/pricing , 원문 열어 확인)
USD per MTok.

| 모델 | 입력 | 출력 | 캐시 5m 쓰기 | 캐시 1h 쓰기 | 캐시 읽기 | Batch 입력 / 출력 |
|---|---|---|---|---|---|---|
| Fable 5.2 | $8 | $40 | $10 | $16 | $0.20 | $4 / $20 |
| Opus 5.5 | $4 | $20 | $5 | $8 | $0.20 | $2 / $10 |
| Sonnet 5.5 | $2 | $10 | $2.50 | $4 | $0.10 | $1 / $5 |
| Haiku 5.5 (프롬프트 100K 이하) | $0.10 | $0.50 | $0.125 | $0.20 | $0.01 | $0.05 / $0.25 |
| Haiku 5.5 (100K 초과) | $0.50 | $2.50 | - | - | - | $0.25 / $1.25 |

- Haiku 5.5 만 프롬프트 길이로 가격이 달라진다: "a request whose prompt is over 100,000 tokens pays higher prices." 나머지는 1M 컨텍스트 전 구간 동일 가격.
- Fast 모드: 출력 최대 2.5배 속도, 프리미엄 가격. Fable 5.2 는 $16 입력, $80 출력(발표문). Fast 는 Fable 5.2, Opus 5.5 에서 사용 가능. Haiku 와 Sonnet 은 미지원(모델 개요 표).
- US 전용 추론은 1.1배.
- 예정된 가격 변경은 가격 페이지에서 찾지 못했다. Haiku 5.5 발표문은 Sonnet 5.5 캐시 읽기를 절반으로 내렸다고 적었다(이미 반영됨).

## 4. 리더보드 위치

### 4-1. LMArena
출처는 arena.ai (구 lmarena.ai). "Preliminary" 표시는 표본이 적어 잠정이라는 뜻이다.

**Text Arena 종합** (https://arena.ai/leaderboard/text , 보드 날짜 2026-11-11, 421개 모델)
- 1위 Gemini 4 Carbon (High) 1526±10 Preliminary
- 2위 Gemini 4 Argon (High) 1522±5
- 4위 Claude Opus 5.5 (High) 1507±6
- 15위 Gemini 4 Hydrogen (High) 1490±9 Preliminary
- 30위 GPT-6.1 Sol (Max) 1481±6
- 42위 GPT-6 Astra (Max) 1474±6 (검색 하이라이트 표에서 확인한 순위)
- Claude Fable 5.2, Sonnet 5.5, GPT-6.1 Terra, GPT-6 Luna, Claude Haiku 5.5 는 열어 본 상위 36행 안에 없다. Fable 5.2 는 이 보드에 아직 안 올라온 것으로 보인다(2차 자료 wikiprompt 도 같은 관찰. 원문 미확인).
- 2차 자료 whatisthelatest.ai 는 같은 보드를 Carbon 1538, Argon 1529 로 적었다. 보드 갱신 차이로 보이나 확인하지 못했다. 1차 원문 값을 우선했다.

**WebDev Arena** (https://arena.ai/leaderboard/webdev , 보드 날짜 2026-11-13, 159개 모델)
- 1위 Claude Fable 5.2 (xHigh) 1826
- 2위 Claude Opus 5.5 (Max) 1816
- 3위 Claude Sonnet 5.5 (xHigh) 1772
- 4위 Gemini 4 Carbon (High) 1768 Preliminary
- 5위 GPT-6 Astra (Max) 1763
- 8위 GPT-6.1 Sol (Max) 1742
- 10위 Claude Sonnet 5.5 (High) 1716
- 11위 Gemini 4 Hydrogen (High) 1704 Preliminary
- 14위 GPT-6.1 Terra (Max) 1681
- 15위 Gemini 4 Argon (High) 1679
- GPT-6 Luna 와 Claude Haiku 5.5 는 열어 본 상위 33행 안에 없다.
- Carbon 발표문은 "+89 elo points to land at #4 (1768) on WebDev Arena"라고 적었고 위 값과 같다.

**Creative Writing** (https://arena.ai/leaderboard/chat/text/creative-writing , 보드 날짜 2026-11-11, 419개 모델, 검색 하이라이트에서 확인)
- 1위 Gemini 4 Argon (High) 1523±10
- 2위 Claude Opus 5.5 (High) 1517±11
- 3위 Gemini 4 Carbon (High) 1516±20 Preliminary
- 6위 Gemini 4 Hydrogen (High) 1492±20 Preliminary
- 40위 GPT-6 Astra (Max) 1451±10
- 43위 GPT-6.1 Sol (Max) 1449±12
- Fable 5.2, Sonnet 5.5, Terra, Luna, Haiku 5.5 는 열어 본 행 안에 없다.
- 글쓰기 보드는 OpenAI 모델이 Google, Anthropic 보다 크게 아래다. OpenAI 가 Terra 를 "clearer, more natural writing" 용으로 내세운 주장은 이 보드에서 확인되지 않는다(Terra 가 보이지 않음).

### 4-2. Terminal-Bench 4.1
출처: https://www.tbench.ai/ (4.1 보드. 4.0 제출물을 4.1 검증기로 재채점. 66개 작업, 모든 항목이 기존 95% 신뢰구간 안). 4.0 표는 같은 사이트에 병기. 수치는 "해결률 ± 95% 신뢰구간, 모델(effort), 에이전트, 전체 66개 작업 총 토큰, 총 비용".

| 순위 | 모델(effort) | 에이전트 | 해결률 | 토큰 | 비용 |
|---|---|---|---|---|---|
| 1 | Opus 5.5 (max) | Claude Code | 65.8% ± 3.1 | 8.0B | $4.7k |
| 1 | Fable 5.2 (max) | Claude Code | 65.8% ± 2.8 | 15.7B | $16.5k |
| 3 | Gemini 4 Carbon (high) | Antigravity CLI | 64.5% ± 3.2 | 3.8B | $1.4k |
| 4 | Sonnet 5.5 (max) | Claude Code | 63.9% ± 3.0 | 19.4B | $7.3k |
| 5 | GPT-6.1 Sol (max) | Codex | 60.9% ± 3.0 | 1.5B | $0.6k |
| 6 | GPT-6 Astra (max) | Codex | 60.3% ± 2.8 | 1.5B | $3.3k |
| 9 | Gemini 4 Hydrogen (high) | Antigravity CLI | 56.4% ± 3.0 | 3.6B | $0.8k |
| 10 | Gemini 4 Argon (high) | Antigravity CLI | 55.5% ± 2.8 | 2.8B | $1.1k |
| 11 | GPT-6.1 Terra (max) | Codex | 53.3% ± 3.1 | 8.5B | $0.9k |

- GPT-6 Luna 와 Claude Haiku 5.5 는 열어 본 상위 15위(44.8%까지)에 없다.
- 해석 주의: 에이전트가 모델마다 다르다(Claude Code, Antigravity CLI, Codex). 모델 비교가 아니라 모델 더하기 에이전트 비교다. 사이트 설명도 "Effort ... is the harness's own reasoning or agent effort setting"이고 비용은 "not normalized for effort setting"이라고 적었다.
- 상위 3개(Opus 5.5, Fable 5.2, Carbon)의 신뢰구간이 모두 겹친다. 순위 차이는 통계적으로 구분되지 않는다.
- Sonnet 5.5 발표문은 자체 측정으로 Terminal-Bench 4.0 70.6% 라고 적었다. tbench.ai 값(63.9%)과 다르다. 하네스와 조건이 다른 자체 값이므로 리더보드 값을 기준으로 한다.
- 최상위 두 모델 사이의 비용 차이가 크다: Fable 5.2 총 $16.5k 대 Opus 5.5 $4.7k 로 해결률은 같다. Carbon 은 $1.4k.

## 5. 대응 관계 가설 점검

[[project_vendor_tier_equivalence_2026_11_17]] 의 가설은 fable=astra=carbon, opus=sol=argon, sonnet=terra=hydrogen, haiku=luna 다. 아래는 1차 자료가 말하는 것만 적은 점검이다. 판단은 리드 몫이다.

- fable=astra=carbon: 벤더 문장은 셋 다 최상위(Fable "most ambitious, open-ended technical work", Astra "most intelligent", Carbon "strongest model")로 일치. AA 지수는 Fable 5.2 max 65, Carbon high 60, Astra max 57. 단가는 $8/$40, $2/$10(12월부터 $4/$20), $10/$50. 가격 등급은 Carbon 이 한 단계 아래다.
- opus=sol=argon: Anthropic 은 Opus 5.5 를 "daily driver"로, OpenAI 는 Sol 을 "complex work at lower cost"로, Google 은 Argon 을 "ideal choice for the majority of software engineering and knowledge work"로 부른다. 역할 문장은 일치. AA 지수는 Opus 5.5 max 59, Sol max 55, Argon high 50이라 Argon 이 한 단계 아래다. 단가는 $4/$20, $2/$10, $2/$10(12월부터 $4/$20).
- sonnet=terra=hydrogen: 역할 문장이 서로 다른 방향이다. Sonnet 은 "well-scoped everyday tasks", Terra 는 "writing, visual understanding, and computer use", Hydrogen 은 "execution engine" 이다. 점수는 Sonnet max 55, Hydrogen xhigh 54, Terra max 51 로 근접하지만 effort 가 다르다. Hydrogen 은 속도(175 tok/s, 14.7분)가 눈에 띄고 Terra 는 가격($1/$5)이 눈에 띈다.
- haiku=luna: 역할 문장 일치(고빈도, 저비용, 서브에이전트, 추출과 분류). AA 지수는 Haiku max 36, Luna max 28 이고 속도는 Haiku 257 tok/s 대 Luna 103 tok/s. Haiku 는 100K 초과 프롬프트에서 단가가 5배다.
- 가설에서 빠진 점: Google 은 Orchestrator 를 "recommended default"로 두어 Carbon 또는 Argon 이 계획, Hydrogen 이 구현하는 조합을 기본으로 권한다. Anthropic 도 Fable 5.2 를 "Advisor" 또는 "Orchestrator"로 쓰는 구성을 적었다. OpenAI 서브에이전트 문서는 Sol 로 시작하고 가벼운 일은 Luna 를 권한다. 1:1 대응표보다 "계획 모델 + 실행 모델" 쌍으로 보는 것이 벤더 문서와 맞다.

## 6. 원문 미확인 목록

- openai.com Terra, Sol 6.1, Astra, Sol and Luna 발표 전문(curl 403). 인용은 Exa 하이라이트에서만 옴.
- anthropic.com Fable 5.2 발표 전문. 인용은 Exa 하이라이트에서만 옴.
- arena.ai creative-writing 전체 표(상위 일부만 확인).
- arena.ai text 와 creative-writing 보드에서 Terra, Luna, Haiku 5.5, Sonnet 5.5 위치(열어 본 행 밖).
- tbench.ai 4.1 보드에서 Luna, Haiku 5.5 위치(15위 밖, 정확한 순위 미확인).
- Google AI Pro, Ultra 구독 한도에 대한 12월 1일 가격 인상 영향.
- OpenAI, Anthropic 가격 페이지의 예정된 변경(찾지 못함이지 없다는 보증은 아님).
- Google Gemini 3.8 Flash 2027-01-01 인상(2차 자료만).
