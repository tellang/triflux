# 역할별 모델 배정 리서치 (Claude + Exa 관점: 학술, 기술 깊이, 공식 문서, 벤치마크)

조사일: 2026-11-17. 도구: Exa web_search_exa, 원문 확인은 web_fetch_exa. WebFetch 미사용.

신뢰도 라벨:
- 공식: 벤더 문서, 벤더 블로그, 벤치마크 운영 주체의 1차 리더보드
- 논문: arXiv, ACL, PMLR 등
- 엔지니어링 블로그: 실측을 공개한 회사, 개인 엔지니어 글
- 일반: 집계 사이트, 언론, 포럼

측정 주체 표기: "벤더" = 모델 회사 자체 측정, "제3자" = 벤치마크 운영자나 독립 평가자.
아래 수치는 Exa 검색 결과 본문(원문 발췌)이나 web_fetch_exa로 연 원문에서 옮겼다. 원문을 열지 못한 것은 "원문 미확인"으로 적었다.

---

## 질의 1. 하네스와 오케스트레이터의 역할별 모델 배정

### 핵심 발견
- Claude Code: 내장 Explore, Plan, general-purpose 서브에이전트는 기본적으로 부모 대화의 모델을 상속한다. 부모가 Fable이면 Explore는 구독/Console 연결에서 Opus로 내려가고, Bedrock 등에서는 Fable에 머문다. Haiku로 탐색하려면 사용자가 `model: haiku`인 Explore를 직접 정의해야 한다. 모델 결정 순서는 호출 시 `model` 인자, 정의의 `model`, `CLAUDE_CODE_SUBAGENT_MODEL`, 부모 모델 순이다. `opusplan`은 plan 모드에서 Opus, 실행에서 Sonnet을 쓴다.
- Codex: 내장 에이전트는 `default`, `worker`, `explorer` 셋이다. 공식 문서는 까다로운 에이전트에 `gpt-6.1-sol`, 빠르고 좁은 작업에 `gpt-6-luna`를 권하고, 리뷰어와 보안 에이전트에는 `high` effort를 예로 든다. 예시 `pr_explorer`는 Luna + high다. 미설정 시 부모의 모델과 effort를 상속한다.
- Google Antigravity: "Orchestrator" 선택지가 계획과 리뷰는 Carbon 또는 Argon, 구현과 테스트는 Hydrogen에 맡긴다. 프롬프트를 한 번 분류하는 라우터가 아니라 한 턴 안에서 제어를 주고받는 구조라고 문서가 명시한다.
- oh-my-openagent(구 oh-my-opencode): 역할별 기본 모델이 가장 세분화된 공개 사례다. 오케스트레이터 Sisyphus는 Opus 5.5(max), 상담 Oracle은 GPT-5.6 Sol(xhigh), 탐색 Explore와 문서 검색 Librarian은 `gpt-6-luna-fast` 또는 `kimi-for-coding-highspeed` 같은 빠른 모델, 사전 계획 Metis는 Fable 5.1, 계획 리뷰 Momus는 GPT-5.6 Terra(high), 실행자 Sisyphus-Junior는 Sonnet 5다. 벤더를 섞는 폴백 체인이 역할마다 있다. 같은 저장소 안에서도 AGENTS.md 표와 opencode-config 문서 표의 Explore 기본값이 다르다(문서 간 불일치).
- Aider architect/editor: 추론 모델이 계획하고 별도 editor 모델이 편집하는 2단 구조(제3자 정리 문서 기준, Aider 1차 문서는 이번에 열지 않음).
- OpenHands: SDK 서브에이전트와 조직별 AgentProfile, ACP 프로필로 Claude Code, Codex, Gemini를 오케스트레이션(제3자 정리 문서 기준).
- 공통 패턴: "탐색은 싸고 빠른 모델, 계획과 상담은 큰 추론 모델, 구현은 중간 모델"이 공식 권장과 커뮤니티 기본값 양쪽에 반복된다. 단 Claude Code는 기본값이 상속이라, 작은 탐색 모델은 사용자가 명시해야 한다.

### 수치 표
| 하네스 | 역할 | 기본 또는 권장 모델 | 출처 성격 |
|---|---|---|---|
| Claude Code | Explore, Plan | 부모 상속(Fable 부모일 때 Explore는 Opus) | 공식 |
| Codex | 까다로운 에이전트 / 가벼운 에이전트 | gpt-6.1-sol / gpt-6-luna | 공식 |
| Antigravity Orchestrator | 계획, 리뷰 / 구현, 검증 | Carbon 또는 Argon / Hydrogen | 공식 |
| oh-my-openagent | 오케스트레이터 / 상담 / 탐색 / 계획 리뷰 / 실행 | Opus 5.5 max / GPT-5.6 Sol xhigh / Luna-fast 등 / GPT-5.6 Terra high / Sonnet 5 | 커뮤니티 저장소 |

### 출처
- https://code.claude.com/docs/en/sub-agents (공식, 날짜 표기 없음, 2026-11-17 조회)
- https://learn.chatgpt.com/docs/agent-configuration/subagents.md (공식, 2026-11-17 조회)
- https://antigravity.google/docs/models/ (공식), https://antigravity.google/blog/gemini-4-hydrogen-in-google-antigravity/ (공식, 2026-11-12)
- https://github.com/code-yeongyu/oh-my-openagent/blob/dev/packages/omo-opencode/src/agents/AGENTS.md (커뮤니티 저장소)
- https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/reference/opencode-config.md (커뮤니티 저장소)
- https://ghdaru.github.io/harness_engineering/en/pdf/10-subagents-orchestration.pdf (일반, Aider와 OpenHands 정리)

---

## 질의 2. 교차 벤더 리뷰의 근거와 반론

### 핵심 발견
- 찬성 근거 1 (Greptile, 2026-07-21): Claude Code 작성 PR 500개, Codex 작성 PR 500개에서 고심각도 버그 재현율이 두 방향 모두 "다른 모델이 리뷰할 때" 높았다. 모델이 자주 만드는 버그 종류를 리뷰에서도 자주 놓친다는 분석이다. 단 차이는 2~3%p 수준이고, 정답셋을 LLM 판정으로 매칭했으며, 리뷰 제품 회사의 자체 측정이다.
- 반론 1 (Stephens, 사전등록 재현 연구, 2026-10-12): 183개 과거 리뷰를 재현하면서 교차 벤더 리뷰어마다 "같은 모델의 새 세션"을 대조군으로 붙였다. 4개 체크포인트 중 3개에서 교차 벤더 가설이 실패했다. 결론은 "모델 다양성의 이득으로 알려진 것은 대부분 독립된 두 번째 시선의 이득이고, 같은 모델 새 세션도 그 이득을 준다. 누가 보느냐보다 어디에 두느냐가 중요하다". 다른 가족이 나은 점은 정밀도(오탐이 적음)뿐이었다. 원래 리뷰가 버그 6개 중 2개를 지적했지만 작성 에이전트가 둘 다 거절했다는 관찰도 있다.
- 반론 2 (JHU arXiv 2607.21656, 2026-07-22): LiveCodeBench 116문제. 비대칭 결과다. Codex 초안을 Claude가 리뷰하면 71.6%에서 89.7%, Codex 자기 리뷰는 84.5%. Claude 초안을 Codex가 리뷰하면 91.4%에서 82.8%로 떨어졌다(회귀 13건). 리뷰어 효과는 "두 번째 패스"가 아니라 리뷰어의 상대 능력에 묶인다는 해석이다. 리뷰어가 테스트를 실행하지 못하는 설정이라는 한계가 있다.
- 중립 (zenn, 2026-06-12, 13개 스펙): 같은 세션 자기 반성, 다른 세션 리뷰, 교차 리뷰 개선폭이 모두 +4~+6.5점 범위로 비슷했다. 강한 리뷰어의 구조 변경 제안을 약한 작성자가 반만 반영해 오히려 나빠진 사례도 기록했다.
- 판정자 편향 연구: LLM 판정자는 자기 출력과 자기 가족 출력을 선호한다(rubric 기반에서도 지속, arXiv 2604.06996). 다만 "더 좋은 생성자가 더 좋은 판정자이고 자기 선호의 상당 부분은 정당하다"는 반대 해석도 있다(arXiv 2504.03846). 이 연구들은 품질 판정이고 결함 발견과는 다르다는 점을 Stephens가 지적한다.

### 수치 표
| 연구 | 조건 | 결과 | 측정 주체 |
|---|---|---|---|
| Greptile | Claude 작성 PR, 리뷰어 Opus 4.7 / GPT-5.5 | 재현율 60.0% / 62.0% | 엔지니어링 블로그(리뷰 벤더) |
| Greptile | Codex 작성 PR, 리뷰어 Opus 4.7 / GPT-5.5 | 53.7% / 50.5% | 동일 |
| Stephens | Codex 리뷰어가 놓친 타이밍 버그 6개 중 발견 | Codex 1, 새 세션 Claude 4 | 사전등록 연구(개인) |
| Stephens | 기능 단위 사후 리뷰, 실제 버그 발견 기능 수(30개 중) | Codex 16, 새 세션 Claude 19 | 동일 |
| Stephens | 오탐 | Codex 25건 중 2, Claude 40건 중 9 | 동일 |
| JHU | Codex 초안: 단독 / Claude 리뷰 / Codex 자기 리뷰 | 71.6% / 89.7% / 84.5% | 논문 |
| JHU | Claude 초안: 단독 / Codex 리뷰 / Claude 자기 리뷰 | 91.4% / 82.8% / 91.4% | 논문 |
| JHU | 작업당 비용과 지연, 단독 Claude / Claude+Codex 리뷰 | $0.226, 86.2s / $0.382, 118.0s | 논문 |

### 출처
- https://www.greptile.com/blog/model-inversion (엔지니어링 블로그, 2026-07-21, 원문 확인)
- https://stephens.page/blog/fresh-eyes-beat-a-second-family/paper/fresh-eyes-beat-a-second-family.pdf (논문 형식 개인 연구, 2026-10-12)
- https://arxiv.org/abs/2607.21656 (논문, 2026-07-22)
- https://zenn.dev/imaimai17468/articles/c5440b98a6e766 (엔지니어링 블로그, 2026-06-12)
- https://arxiv.org/html/2604.06996v3 (논문, 2026-08-03), https://arxiv.org/html/2504.03846v1 (논문, 2025-04)
- https://blog.ervits.com/2026/08/executor-model-reviewer-model.html, https://zackproser.com/blog/codex-reviews-claudes-diffs (엔지니어링 블로그, 찬성 측 사례, 수치는 원문 미확인)

---

## 질의 3. LLM 라우터와 게이트웨이의 폴백, 우선순위, 로드밸런싱

### 핵심 발견
- LiteLLM: 실패 대응을 retry(같은 모델 그룹, 다른 배포로 재선택 가능), fallback(다른 모델 그룹), cooldown(배포 하나를 몇 초간 제외) 셋으로 나눈다. 판단 입력은 실패 종류, 상태 코드, `Retry-After` 셋뿐이다. 429는 같은 그룹 안 `order` 단계(예: PTU에서 종량제)를 먼저 내려간 뒤 그룹 밖 폴백으로 간다. context window 오류는 재시도 없이 바로 `context_window_fallbacks`로 간다. 쿨다운 기본 5초, `Retry-After`가 있으면 그 값을 쓴다. 폴백 깊이 기본 5. 전략은 simple-shuffle(기본, 가중 랜덤), least-busy, usage-based-v2, latency-based, cost-based 등.
- OpenRouter: 기본 라우팅은 실효 가격(캐시 적중 반영), 처리량, TTFT, 429 빈도, 신뢰도, 도구 호출 품질을 합쳐 "경쟁권" 공급자에 트래픽 대부분을 배정하고 나머지에 탐색용 소량을 배정한다(2026-10-28 개편). 대화는 프롬프트 캐시가 따뜻한 동안 같은 공급자에 고정된다. `sort`로 price, throughput, latency 우선을 강제할 수 있고, 이때 기본 라우팅은 꺼진다. `allow_fallbacks` 기본 true.
- 공통점: 두 게이트웨이 모두 "같은 모델의 다른 공급자"와 "다른 모델" 폴백을 구분하고, 캐시 친화(같은 공급자 유지)를 라우팅 조건에 넣는다. 구독 쿼터 기반 전환은 이 게이트웨이들의 범위 밖이다(질의 5).
- Portkey, Not Diamond, Martian: 이번 조사에서 1차 문서를 열지 않음. Not Diamond는 RouterArena 순위표에서 12위(질의 4), Martian은 라우팅 회사가 운영하는 코드 리뷰 벤치마크로만 확인됨.

### 출처
- https://docs.litellm.ai/docs/router/learn/reliability (공식)
- https://docs.litellm.ai/docs/router/learn/strategies (공식)
- https://openrouter.ai/docs/guides/routing/provider-selection (공식)
- https://openrouter.ai/blog/announcements/how-we-rebuilt-provider-routing/ (공식, 2026-10-28)
- Portkey, Not Diamond, Martian 1차 문서: 자료 없음(이번 조사 범위에서 원문 미확인)

---

## 질의 4. 비용-품질 라우팅 연구의 결론과 한계

### 핵심 발견
- LLMRouterBench (ACL Findings 2026): 40만 인스턴스, 33개 모델. 모델 간 보완성은 확인되지만 주요 라우터들의 성능이 비슷하고, 여러 최신 기법과 상용 라우터가 단순 기준선을 안정적으로 넘지 못했다. 최고 라우터는 Best Single 대비 정확도 최대 +4%, 같은 정확도에서 비용 최대 31.7% 절감. OpenRouter는 Best Single 대비 -24.7%. 라우팅 이득의 상당 부분이 "수학 vs 코드" 같은 거친 도메인 구분에서 나온다는 해석. 정답 모델이 1~3개뿐인 어려운 질의에서 Recall@1이 23~25%에 그친다.
- "Dynamic LLM Routers are Often Misguided" (arXiv 2610.02762, 2026-10-02): 상용 라우터 6개를 14개 설정에서 평가. 잘 고른 두 모델(Gemini 3.7 Flash, Opus 5 high) 사이를 무작위로 고르는 라우터를 같은 비용에서 이긴 상용 라우터가 없었다. 원인 네 가지: 난이도 무시, 길이 역전, 의미 매칭(출처로 라우팅), 로스터 비최적. 결론: 로스터를 잘 고르면 라우팅으로 얻을 것이 적다.
- RouterArena (arXiv 2510.00202): 순위 1위 Azure-Router, RouteLLM 2위, Not Diamond 12위.
- "Rethinking Predictive LLM Routing" (arXiv 2505.12601): 잘 튜닝한 kNN이 복잡한 학습 라우터와 비슷하거나 낫다.
- RouterEval (EMNLP Findings 2025): 후보가 많아지면 좋은 라우터의 이득이 커지는 "모델 수준 스케일링"을 보였지만 기존 라우터 대부분은 Best Single에 못 미쳤다.
- Cascade routing (Dekoninck 등, ICML 2025): 라우팅과 캐스케이드를 통합하면 개별 방식보다 낫고, 성공의 핵심은 품질 추정기다.
- 에이전트형 작업으로 오면 결과가 달라진다(질의 8과 연결). 단일 프롬프트만 보는 라우터는 에이전트 환경에서 베이즈 오차 하한에 막힌다는 주장(SWE-Router)과, 단계별 라우팅이 비용을 크게 줄인다는 결과(RSI-router)가 있다.
- 한계 정리: 벤치마크 분포 밖 입력에서 성능이 무작위 수준으로 떨어진다(RouteLLM 자체 보고, MMLU). 대부분 단일 턴 QA 기준이라 코딩 에이전트에 그대로 옮기기 어렵다.

### 수치 표
| 연구 | 지표 | 값 | 출처 성격 |
|---|---|---|---|
| LLMRouterBench | 최고 라우터 비용 절감(Best Single 정확도 유지) | 최대 31.7% | 논문 |
| LLMRouterBench | OpenRouter 성능 변화(Best Single 대비) | -24.7% | 논문 |
| LLMRouterBench | 어려운 질의 Recall@1 (Avengers / EmbedLLM) | 24.6% / 23.2% | 논문 |
| Misguided | 무작위 2모델 라우터를 이긴 상용 라우터 수 | 0 / 6 (자기 데이터로 학습한 vLLM SR 제외) | 논문 |

### 출처
- https://aclanthology.org/2026.findings-acl.1881.pdf (논문, ACL 2026)
- https://arxiv.org/html/2610.02762 (논문, 2026-10-02)
- https://www.arxiv.org/pdf/2510.00202v2 (논문, RouterArena)
- https://arxiv.org/html/2505.12601v2 (논문)
- https://aclanthology.org/2025.findings-emnlp.208.pdf (논문, 2025)
- https://proceedings.mlr.press/v267/dekoninck25a.html (논문, 2025)
- https://arxiv.org/html/2603.04445 (논문, 서베이, 2026-08-30)
- https://web.stanford.edu/~shuhuiq/blog/review-routing-cascades.html (엔지니어링 블로그, 2026-10)

---

## 질의 5. 구독형 코딩 플랜 여러 개를 함께 쓰는 사례와 도구

### 핵심 발견
- 도구는 두 종류로 나뉜다.
  - 같은 벤더의 계정 여러 개를 돌리는 도구: codex-usage(Codex와 Claude Code 계정별 5시간, 주간 잔량 표시와 `rotate`), qswap(90% 도달 시 자동 전환, 실행 중 Claude Code 세션 유지), ccswitch(사용량 엔드포인트 폴링, 기본 99%에서 교체), aiq(Claude Max, Codex, Gemini Ultra 잔량 확인).
  - 벤더를 넘나드는 도구: codemax(한 플랜이 한도에 도달하면 다음 에이전트가 같은 작업을 이어받음, 일일 예산 설정), subrouter(구독 OAuth를 모아 출력 시작 전 쿼터 오류에서만 다음 계정이나 벤더로 재시도), hydra(PTY에서 한도 문구를 감지하면 맥락을 클립보드로 복사해 다른 CLI 실행).
- 약관 리스크가 벤더마다 다르다. Anthropic은 2026-02 법무 문서에서 Free, Pro, Max 구독 OAuth 토큰을 Claude Code와 claude.ai 밖의 제품, 도구, 서비스(Agent SDK 포함)에서 쓰는 것을 약관 위반으로 명시했다. 1월에 Claude Code 하네스 위장을 막는 조치를 했고, OpenCode는 법무 요청을 이유로 Claude 구독 지원을 뺐다. 반면 OpenAI 측 인사는 Codex 구독의 제3자 하네스 사용을 공개 지지했다(The Register 보도). subrouter README도 Anthropic OAuth는 요청이 Claude Code CLI처럼 보여야만 동작한다고 적는다.
- 허용 경계: 수정하지 않은 Claude Code 바이너리에 본인 구독으로 로그인하는 것은 허용된다. 그래서 "공식 CLI 여러 개를 띄우고 그 사이를 오가는" 방식(codemax, hydra 계열)과 "구독 토큰을 다른 클라이언트로 중계하는" 방식(subrouter 계열)은 약관상 위치가 다르다.
- Google AI Ultra는 Antigravity에서 Carbon과 Orchestrator(Carbon)를 쓸 수 있는 유일한 소비자 플랜이다. Antigravity의 Orchestrator는 Carbon 단독 대비 쿼터 24% 절감을 주장한다(벤더 측정).
- 독립 실측(여러 구독을 묶었을 때 실제 처리량이나 비용 효과): 자료 없음.

### 출처
- https://code.claude.com/docs/en/legal-and-compliance (공식)
- https://www.theregister.com/software/2026/02/20/anthropic-clarifies-ban-on-third-party-tool-access-to-claude/5014546 (일반, 2026-02-20)
- https://github.com/anthropics/claude-code/issues/82266 (일반, 2026-07-29)
- https://codemax.saidev.codes/ , https://github.com/remorses/subrouter , https://github.com/AnandChowdhary/codex-usage , https://github.com/seangeng/ai-quota-swap , https://github.com/rios0rios0/ccswitch , https://github.com/saadnvd1/hydra , https://github.com/elyase/aiq (일반, 도구 저장소)
- https://antigravity.google/docs/models/ (공식)

---

## 질의 6. 역할별 성능 근거 (2026 최신 가족)

### 핵심 발견
- 구현(에이전트 코딩):
  - Terminal-Bench 4.1 공식 리더보드(tbench.ai, 제3자): Opus 5.5 max와 Fable 5.2 max가 65.8%로 공동 1위, Carbon high 64.5%, Sonnet 5.5 max 63.9%, GPT-6.1 Sol max 60.9%, Astra max 60.3%. 같은 표에서 Sol은 토큰 1.5B, 비용 $0.6k로 Opus 5.5(8.0B, $4.7k)와 Fable 5.2(15.7B, $16.5k)보다 훨씬 싸다. 모든 행이 하네스와 묶여 있다(Claude Code, Codex, Antigravity CLI).
  - Vals AI가 돌린 Terminal-Bench 4.0(Inference360 집계): Fable 5.2와 Opus 5.5 65.2%, Sonnet 5.5 64.1%, Carbon 63.1%, Astra 59.6%, Argon 57.6%, GPT-6.1 Sol 55.1%(작업당 $1.72, Fable 5.2 $14.56).
  - SWE-Bench Pro V2 공개 세트(Scale): 상위권이 99% 근처로 포화. Scale 스스로 공개 세트와 비공개 세트 차이(Opus 5에서 17.8%p)를 학습 노출로 추정한다. 의미 있는 비교는 Hard 51문제나 비공개 세트뿐이다. Hard 기준 Opus 5 98.0, Fable 5.1 92.2, Argon 92.16, Astra 90.2.
  - Google 모델 카드(벤더): Argon이 DeepSWE와 Vibe Code Bench에서 이기고 FrontierSWE v2와 Terminal-Bench 4.0에서 4개 모델 중 꼴찌. 제3자 분석(apidog)은 Argon이 이긴 행 일부가 하네스가 섞인 비교라고 지적한다.
- 코드 리뷰: 벤치마크마다 1위가 다르다.
  - CodeReviewBench(Kodus, F2 기준): Kimi K3.1 Pro 63.5가 1위, GPT-6.1 Sol 45.9, Opus 5.5 43.9, Sonnet 5.5 40.0, GPT-6 Luna 8.1(기본 effort에서 PR당 약 25 추론 토큰).
  - MacroscopeBench(조화평균): GPT-6 Astra max 78.0, GPT-5.6 Sol high 77.8, Opus 5 high 69.9. Opus는 재현율이 높고 정밀도가 낮다.
  - ReviewBench(GitHub 운영, grounded F1): 상위는 전용 리뷰 에이전트(83.0%). 모델 직결은 Opus 5.5 기반 73.3%, Codex GPT-5.6 Sol max 70.2%.
  - 시장 정리글(aicodereview.cc): 여러 리뷰 벤더가 같은 Martian 벤치마크에서 서로 1위를 주장. 리뷰 벤치마크 대부분이 리뷰 제품을 파는 회사가 운영한다.
- 보안 취약점:
  - CWE-bench v2(Collinear, 250과제, 제3자): Fable 5.2 75.0%, Hydrogen 68.1%, Opus 5.5 67.1%(롤아웃당 $1.85), Argon 65.0%, Astra 64.2%. 논문은 상위 4개가 pass@1 3점 안에 있고 약점 분류 10개 중 1위가 네 모델에 나뉜다고 보고한다.
  - Vals CyberBench v1.1(OSS-Fuzz 계열 PoC와 패치): Wonder 80.36%, GPT-6 Sol 77.98%, Argon 77.86%, GPT-6 Luna 76.25%(테스트당 $0.13), Haiku 5.5 75.48%. 작은 모델이 상위권에 붙는다.
  - Google 발표(벤더): Carbon이 SEC-bench Pro, ExploitGym, CWE-bench v1에서 선두.
- 프런트엔드와 디자인:
  - LMArena WebDev(2026-11-13): Fable 5.2 xHigh 1826, Opus 5.5 Max 1816, Sonnet 5.5 xHigh 1772, Carbon High 1768(예비), Astra Max 1763, GPT-6.1 Sol Max 1742, Argon High 1679.
  - DesignArena 종합 에이전트(2026-11-17): Opus 5.5 high 1445, Astra max 1399, Fable 5.2 1369, GPT-6.1 Sol max 1366. 같은 사이트의 프런트엔드 웹앱 보드는 Astra max 1365가 1위.
- 문서 작성: 질의 11 참조. 개발 문서 전용 벤치마크는 자료 없음.

### 수치 표 (구현, 제3자)
| 모델(설정) | TB 4.1 해결률 | TB 4.1 비용 | TB 4.0(Vals) | 작업당 비용(Vals) |
|---|---|---|---|---|
| Opus 5.5 max | 65.8% | $4.7k | 65.2% | $12.04 |
| Fable 5.2 max | 65.8% | $16.5k | 65.2% | $14.56 |
| Gemini 4 Carbon high | 64.5% | $1.4k | 63.1% | $7.45 |
| Sonnet 5.5 max | 63.9% | $7.3k | 64.1% | $10.75 |
| GPT-6.1 Sol max | 60.9% | $0.6k | 55.1% | $1.72 |
| GPT-6 Astra max | 60.3% | $3.3k | 59.6% | $9.58 |
| Gemini 4 Hydrogen high | 56.4% | $0.8k | 54.0% | $7.56 |
| Gemini 4 Argon high | 55.5% | $1.1k | 57.6% | $17.64 |
| GPT-6.1 Terra max | 53.3% | $0.9k | 49.5% | $2.16 |
| Haiku 5.5 max | 40.0% | $1.0k | - | - |

### 출처
- https://www.tbench.ai/ (공식 리더보드, 2026-11-17 원문 확인. 페이지 머리말 기준 Terminal-Bench 4.1)
- https://inference360.ai/benchmarks/vals-ai-terminal-bench-4 (일반, Vals 결과 집계, 2026-11-11)
- https://labs.scale.com/leaderboard/swe_bench_pro_public_v2 , https://labs.scale.com/blog/swe-bench-pro-v2 (공식)
- https://deepmind.google/models/model-cards/gemini-4-argon/ (공식, 벤더 측정, 2026-10)
- https://apidog.com/blog/gemini-4-argon-benchmarks/ (일반, 2026-10)
- https://www.codereviewbench.com/leaderboard (공식 리더보드, Kodus 운영)
- https://macroscope.com/content/ai-code-review-benchmark-best-models (엔지니어링 블로그, 리뷰 벤더, 2026-09-22)
- https://review-bench.ai/ (공식 리더보드, GitHub 운영)
- https://aicodereview.cc/blog/ai-code-review-benchmarks-compared/ (일반, 2026-10-18)
- https://cwe-bench.com/ , https://arxiv.org/html/2610.17020 (공식 리더보드와 논문, 2026-11)
- https://www.vals.ai/benchmarks/cyber (공식 리더보드, 2026-11-05)
- https://arena.ai/leaderboard/code/webdev (공식 리더보드, 2026-11-13)
- https://www.designarena.ai/leaderboard (공식 리더보드, 2026-11-17)

---

## 질의 7. 작은 모델로 탐색, 큰 추론 모델로 계획과 디버깅: 실측 근거

### 핵심 발견
- FastContext (arXiv 2606.14066): 탐색 전용 서브에이전트(4B~30B)를 붙이면 세 메인 에이전트, 세 벤치마크 모두에서 정확도가 오르고 메인 토큰이 줄었다. 같은 모델이 탐색을 맡는 것보다 학습한 작은 탐색기가 점수와 토큰 모두에서 나은 경우가 많았다.
- IssueLoc-Bench (arXiv 2608.29675): 싼 탐색기는 기준 탐색기 Hit@3의 78~94%, F1의 73~92%를 유지하면서 시간 41~88%, 토큰 84~95%를 줄였다. 적정 지점은 "탐색 결과를 다음 단계가 어떻게 소비하느냐"에 달려 있다.
- Scout-Grep (Corepass, 2026-11-04): 4B 탐색기의 다중 턴 검색 중앙값 3.4초, Haiku 5.5 16.0초, GPT-6 Luna 14.2초. 품질(F0.5)은 Haiku와 통계적으로 같고 Luna가 0.075 높았다. 지연은 호출당 0.47초 대 2.7~3.3초의 누적 차이에서 나온다. 즉 API로 부르는 "작은 프런티어 모델"도 로컬 소형 모델보다는 훨씬 느리다.
- Terminus-4B: 실행 서브에이전트를 4B로 바꿔도 SWE-Bench Pro 해결률 30.0%에서 31.5%로 유지 또는 소폭 상승, 토큰 836k에서 730k(제3자 요약 기준, 원문 수치는 원문 미확인).
- LiteLLM 단계 라우팅 실험(엔지니어링 블로그, 12과제 소표본): 탐색은 DeepSeek V4 Flash, 검증은 Haiku 4.5, 구현은 Opus 5 high로 나누니 공통 해결 9과제에서 비용 46% 절감, 턴 수는 112에서 205로 늘었다. 턴의 73%가 탐색이었고 비용은 $0.14였다.
- 반대 근거:
  - Codex 리뷰에서 GPT-6 Luna는 기본 effort에서 거의 추론하지 않아 F2 8.1(질의 6). 작은 모델은 effort 설정에 민감하다.
  - Haiku 5.5 max는 Artificial Analysis에서 첫 답 토큰까지 184초다. "작은 모델 = 빠름"은 effort를 낮췄을 때만 성립한다(Haiku low 6.4초, medium 8.9초).
  - Anthropic 연구 시스템 글은 대부분의 코딩 작업이 연구보다 병렬화할 부분이 적다고 적는다.

### 수치 표
| 연구 | 비교 | 결과 | 출처 성격 |
|---|---|---|---|
| FastContext | GPT-5.4 메인, SWE-bench Pro: 탐색 없음 / 같은 모델 탐색 / 4B-RL 탐색 | 46.0 / 51.5 / 48.5 | 논문 |
| FastContext | GPT-5.4 메인, SWE-QA 메인 토큰 절감 | 같은 모델 60.3%, 4B-RL 49.8% | 논문 |
| IssueLoc | 싼 탐색기 품질 유지 / 토큰 절감 | Hit@3 78~94% / 84~95% | 논문 |
| Scout-Grep | 검색 지연 중앙값: 4B / Haiku 5.5 / GPT-6 Luna | 3.4s / 16.0s / 14.2s | 엔지니어링 블로그 |
| LiteLLM | 고정 Opus 대 단계 라우터, 해결당 비용 | $0.31 대 $0.17 | 엔지니어링 블로그(n=9) |

### 출처
- https://arxiv.org/html/2606.14066v2 (논문, 2026-06)
- https://arxiv.org/pdf/2608.29675v1 (논문, 2026-08)
- https://www.corepass.com/research/scout-grep (엔지니어링 블로그, 2026-11-04)
- https://www.alphaxiv.org/abs/2605.03195 , https://andreasrau.tech/writing/agentic-coding-paper-2026-05-07/ (논문 페이지와 일반 요약, 수치는 요약 기준)
- https://docs.litellm.ai/blog/subtask-type-routing (엔지니어링 블로그, 2026-09-07)
- https://springprompt.com/llm-api-speed (일반, Artificial Analysis 데이터, 2026-11-09)

---

## 질의 8. 역할 고정 배정 대신 작업 단위로 모델 고르기: 채택과 실패

### 핵심 발견
- 성공 사례:
  - LangChain Open SWE(2026-10-01): 스레드 첫 메시지로 3단계 중 하나를 고르는 분류기. 973 스레드 A/B에서 merged PR 비율 29.2% 대 27.3%(p=0.49, 차이 없음), 스레드 비용 중앙값 64% 감소. 라우팅 결과 balanced 56%, fast 34%, performance 10%. 반대로 "항상 fast" 대조군은 품질 불만으로 하루 만에 중단했다.
  - Cursor Router(2026-08-06, 벤더): 턴 단위로 복잡도 예측(Compass) 뒤 작업 분류로 프런티어 모델 선택. Auto Intelligence가 Fable급 만족도를 68% 낮은 비용으로 낸다고 주장.
  - Antigravity Orchestrator(벤더): Carbon 단독 대비 쿼터 24% 절감, 19% 빠름, 성공률은 "near-Carbon". Google은 첫 프롬프트로 난이도를 맞히는 정적 라우터가 긴 에이전트 작업에서 무너진다고 스스로 적는다.
  - 연구: SWE-Router(약한 모델이 K턴 탐색한 궤적을 보고 승격 결정, 프롬프트만 보는 라우터 대비 Route-AUC +12~15%p), RSI-router(단계 라우팅으로 Terminal-Bench 2.0에서 성능 +16.7%, 비용 -18%), Scrouting(저장소를 먼저 훑고 라우팅, 최고 단일 모델 해결률과 같으면서 해결당 비용 약 1/5, 수치는 초록 기준).
- 실패 사례:
  - GPT-5 라우터 출시(2025-08): 출시 당일 자동 전환기가 고장나 빠른 모델로만 응답해 "더 멍청해 보였다". 사용자는 어느 모델이 답했는지 알 수 없어 원인을 구분하지 못했다. OpenAI는 이전 모델을 되살리고 Thinking을 직접 고를 수 있게 했다.
  - Cursor Auto 불만(2025-08~2026-06 포럼): 규칙 준수 저하, 루프, 사용자가 모델을 확인할 수 없음. Cursor 직원 답변은 Auto가 요청 단위로 가벼운 모델을 자주 고르도록 설계됐고, 비코딩이나 맥락이 무거운 작업에는 맞지 않을 수 있다는 것.
  - 프로덕션 분류기 사례(Medium, 2026-09-02): 싼 모델로 보낸 41% 중 9%가 오답. 평균에 묻혀 6주간 안 보였다. "fix"가 들어간 짧은 테스트 수정 프롬프트를 쉬운 것으로 오분류(테스트 수정 정확도 73%). 실패 뒤 Opus 재시도로 오히려 처음부터 Opus를 쓴 것보다 비쌌다. 다차원 분류기와 캐스케이드로 고쳤지만 신뢰도 보정 드리프트는 해결 못 함.
  - AWS NeMo Switchyard 글: 승격된 턴이 실패한 시도를 통째로 다시 재생하므로 회복 비용이 처음부터 강한 모델을 쓴 것보다 클 수 있다.
- 패턴: 프롬프트 표면만 보는 판정은 에이전트 작업에서 약하다. 성공 사례는 (1) 실제 트래픽으로 A/B를 돌렸고, (2) 궤적이나 도구 호출 단계를 신호로 썼거나, (3) 실패 시 강한 모델로 승격하는 경로를 뒀다.

### 출처
- https://www.langchain.com/blog/how-to-build-a-model-router-in-the-harness (엔지니어링 블로그, 2026-10-01)
- https://cursor.com/blog/how-cursor-router-works (공식, 2026-08-06)
- https://antigravity.google/blog/gemini-4-hydrogen-in-google-antigravity/ (공식, 2026-11-12)
- https://arxiv.org/html/2607.00053 (논문, SWE-Router, 2026-06-30)
- https://arxiv.org/html/2609.34712v1 (논문, RSI-router, 2026-09-28)
- https://arxiv.org/abs/2608.04804 (논문, Scrouting, 초록 기준)
- https://fortune.com/2025/08/12/openai-gpt-5-model-router-backlash-ai-future/ (일반, 2025-08-12)
- https://montanaresearch.org/blog/gpt-5-router-model-decides-how-hard-to-think/ (일반, 2025-08-14)
- https://forum.cursor.com/t/has-auto-mode-become-worse-quality/163936 (일반, 2026-06-24), https://forum.cursor.com/t/2-0-auto-agent-is-a-terrible-upgrade/142037 (일반, 2025-11)
- https://medium.com/@chenyuan19920509/our-router-sent-41-of-production-calls-to-a-cheaper-model-9-came-back-wrong-0dc467ae9ed5 (엔지니어링 블로그, 2026-09-02)
- https://aws.amazon.com/blogs/machine-learning/route-coding-agent-requests-to-the-right-model-on-amazon-bedrock-with-nvidia-nemo-switchyard/ (공식 블로그, 2026-11-13, 발췌만 확인)

---

## 질의 9. 역할군 분류 자체의 재평가

### 핵심 발견
- 현재 하네스가 실제로 나누는 단위는 생각보다 굵다.
  - Codex 내장: default, worker, explorer 셋.
  - Claude Code 내장: Explore, Plan, general-purpose.
  - Antigravity Orchestrator: planner(계획과 리뷰 겸임)와 implementer(구현과 검증 겸임) 둘.
  - 가장 잘게 나눈 oh-my-openagent도 모델 기준으로 보면 "큰 오케스트레이터, 큰 상담자, 빠른 탐색기, 중간 실행자" 네 묶음이다.
- 연구 근거:
  - MAST(Berkeley, NeurIPS 2025 D&B, 1,642 궤적): 다중 에이전트 실패율 41~86.7%. 실패의 41.8%가 시스템 설계, 36.9%가 에이전트 간 불일치, 21.3%가 검증 실패. 대부분 능력이 아니라 조정 문제다. 역할 경계 위반(종료 권한 문제)을 구조로 고치면 +9.4%, 검증 단계를 넣으면 +15.6%.
  - Wharton 보고서(2025-12): "X 전문가" 역할을 주는 페르소나 프롬프트는 정확도를 거의 바꾸지 못했고, 바꿀 때는 나빠지는 쪽이 많았다. 도메인이 맞지 않는 전문가 페르소나에서 Gemini 2.5 Flash는 답을 거부했다. 역할 이름 자체로는 성능 차이가 생기지 않는다는 근거다.
  - "Think Big, Search Small"(2026-07): 위임(분해) 역할과 실행 역할을 나누면 단일 에이전트보다 EM +4.5~8.6점. 위임 쪽 용량을 키우면 약 +11점, 실행 쪽은 약 +2.6점.
  - Loop-back authority 실험(2026-09): 매니저가 반려하고 수정을 요구할 수 있는 계층형 팀이 평평한 팀보다 유용성과 명료성이 낮았고 토큰은 51.5% 더 썼다. 감독자는 검증 가능한 것을 확인할 때만 가치가 있고, 의견만 낼 때는 손해다.
  - Anthropic: 다중 에이전트는 병렬로 쪼갤 수 있는 연구에서 단일 Opus 대비 90.2% 나았지만, 코딩은 병렬 가능한 부분이 적다고 직접 적었다. Cognition의 "Don't Build Multi-Agents"도 같은 방향(이번에 원문 미확인).
- 역할군 재평가에 쓸 수 있는 관찰:
  - 모델을 바꿀 만큼 차이가 측정된 경계는 "분해와 판단(planner, architect, debugger, 리뷰 판정)" 대 "실행(implementer, explorer, tester)"이다. planner와 architect, debugger 사이에는 모델을 따로 둘 근거가 이번 조사에서 나오지 않았다.
  - 리뷰는 "누가"보다 "새 맥락인가"와 "어디에 놓이나"가 중요하다는 근거(질의 2)가 있어, reviewer는 모델 선택보다 세션 분리와 배치 위치를 기준으로 다루는 편이 근거와 맞는다.
  - 보안은 벤치마크상 1위가 자주 바뀌고 작은 모델(Luna, Haiku)이 상위권에 붙는 벤치마크도 있어(CyberBench), 별도 최상위 모델을 고정할 근거가 약하다. 반면 CWE-bench는 모델별로 해결하는 과제가 크게 달라 다중 모델 반복 시도의 근거가 된다.
  - 새로 필요한 역할 후보: 검증자(실행 가능한 검증을 맡는 쪽, MAST와 loop-back 결과), 결과 통합자(answer generation을 따로 고정한 연구 설계). writer/designer는 벤치마크상 상위 모델이 구현 상위 모델과 다를 때가 있어(질의 6, 11) 분리할 근거가 있다.
- 한계: 역할 세분화를 직접 비교한 통제 실험은 드물다. Zartis 글도 잘 만든 다중 에이전트와 잘 만든 단일 에이전트를 같은 작업에서 비교한 연구가 없다고 인정한다.

### 출처
- https://github.com/multi-agent-systems-failure-taxonomy/MAST , https://arxiv.org/abs/2503.13657 (논문)
- https://niteagent.com/blog/why-multi-agent-systems-fail-mast-taxonomy/ (일반, MAST v3 수치 정리, 2026-08-11)
- https://arxiv.org/pdf/2512.05858 (논문, Wharton, 2025-12)
- https://www.alphaxiv.org/abs/2607.07548 (논문, 2026-07)
- https://academy.dair.ai/papers/loop-back-authority-in-llm-agent-teams-a-paired-experiment-on-flat-and-hierarchi-2609.14767 (논문 요약, 2026-09)
- https://www.anthropic.com/research/multi-agent-research-system (공식, 2025-06-13)
- https://www.zartis.com/the-distributed-systems-playbook-for-multi-agent-ai/ (일반, 2026-04-30)

---

## 질의 10. 모델 가족별 강점과 약점 (정확성, 속도, 토큰, 가격)

### 가격 (공식, 입력/출력, 1M 토큰당 USD)
| 가족 | 모델 | 가격 | 비고 |
|---|---|---|---|
| OpenAI | GPT-6 Luna | 0.10 / 0.50 | |
| OpenAI | GPT-6.1 Terra | 1 / 5 | 시각 이해, 컴퓨터 사용, 글쓰기용으로 공식 소개 |
| OpenAI | GPT-6.1 Sol | 2 / 10 | |
| OpenAI | GPT-6 Astra | 10 / 50 | |
| Anthropic | Haiku 5.5 | 0.10 / 0.50 (10만 토큰 이하), 0.50 / 2.50 (초과) | |
| Anthropic | Sonnet 5.5 | 2 / 10 | |
| Anthropic | Opus 5.5 | 4 / 20 | |
| Anthropic | Fable 5.2 | 8 / 40 | Fable 5와 5.1은 10 / 50 |
| Google | Gemini 4 Hydrogen | 1.50 / 7.50 | 1M 전체 고정가 |
| Google | Gemini 4 Argon | 2 / 10 (2026-11-30까지), 이후 4 / 20 | |
| Google | Gemini 4 Carbon | 2 / 10 (2026-11-30까지), 이후 4 / 20 | |
| Google | Gemini 3.8 Flash | 0.75 / 3.75 (도입가) | Hydrogen이 Flash 브랜드를 대체 |

### 지능, 작업당 비용, 시간 (Artificial Analysis, 제3자, 2026-11 조회)
| 모델(설정) | Intelligence Index | 작업당 비용 | 작업당 시간(분) | 첫 답 토큰(초) |
|---|---|---|---|---|
| Fable 5.2 max | 65 | $26.54 | 40.9 | 207.86 |
| Carbon high | 60 | $5.48 | 31.8 | 72.30 |
| Opus 5.5 max | 59 | $10.04 | 24.6 | 355.30 |
| Astra max | 57 | $6.24 | 20.2 | 198.40 |
| GPT-6.1 Sol max | 55 | $1.27 | 22.7 | 156.92 |
| Sonnet 5.5 max | 55 | $10.02 | 31.1 | 283.74 |
| Hydrogen xhigh | 54 | $3.16 | 15.6 | 51.74 |
| GPT-6.1 Terra max | 51 | $0.96 | 13.9 | 148.01 |
| Argon high | 50 | $4.97 | 29.4 | 44.04 |
| Haiku 5.5 max | 36 | $0.41 | 14.7 | 184.29 |
| GPT-6 Luna max | 28 | $0.15 | 12.2 | 68.75 |

### 프로덕션 스트리밍 지연 (Requesty 트래픽, 2026-09-07~11-09, 제3자 게이트웨이)
| 모델 | TTFT 중앙값 | P95 TTFT | 출력 tok/s |
|---|---|---|---|
| GPT-6 Luna | 1,910ms | 12,207ms | 113 |
| Haiku 5.5 | 2,324ms | 12,884ms | 290 |
| GPT-6.1 Terra | 2,760ms | 8,884ms | 128 |
| Sonnet 5.5 | 2,786ms | 20,158ms | 200 |
| GPT-6 Astra | 3,253ms | 15,531ms | 51 |
| Opus 5.5 | 3,712ms | 16,036ms | 140 |
| GPT-6.1 Sol | 4,041ms | 18,276ms | 71 |
| Gemini 4 Argon | 7,666ms | 61,376ms | 84 |

### 환각 (두 지표가 서로 다른 것을 잼)
| 모델 | Vectara 요약 환각률(문서 근거) | AA-Omniscience 환각률(폐쇄형 기억, 틀린 답 / 못 맞힌 문항) | AA 정확도 |
|---|---|---|---|
| GPT-6 Sol | 6.5% | - | - |
| GPT-6.1 Sol max | - | 51.9% | 61.8% |
| GPT-6 Astra | 8.7% | 49.8% | 61.6% |
| Opus 5.5 | 9.9% | 50.3% | 65.5% |
| Fable 5.1 max | - | 70.0% | 68.4% |
| Gemini 4 Argon | 12.1% | 4% | 원문 미확인 |
| Gemini 4 Carbon high | - | 11.4% (medium 4%) | 58.3% |
| Haiku 5.5 max | - | 34.2% | 34.7% |
| GPT-6 Luna max | - | 79.3% | 39.6% |

### 가족별 강점과 약점 요약
- OpenAI
  - Luna: 가장 싸다. 지능 지수 28로 최하위권, 폐쇄형 환각 79.3%. 코드 리뷰 기본 effort에서 거의 작동하지 않음(F2 8.1). 반면 CyberBench에서 76.25%로 상위권, 탐색 품질은 Haiku보다 높음(Scout-Grep). 좁고 검증 가능한 일에 맞는다.
  - Terra: 작업당 비용 최저 수준($0.96)에 지능 51. 출력 토큰이 적다(지수 실행에 99.4M, Sonnet 335M). OpenAI는 기술 소통 글쓰기에 맞다고 소개하고, Simon Willison도 기술 소통에서 Astra와 Sol보다 낫다고 평가했다. 단 AI Writing Benchmark에서는 Sol보다 낮다(86.1 대 95.3). TB 4.1 53.3%로 구현은 Sol보다 약하고, OpenAI도 복잡한 코딩은 Sol이나 Astra를 권한다.
  - Sol: TB 4.1 60.9%를 $0.6k로 달성. 같은 표에서 토큰은 1.5B로 Opus 5.5(8.0B)의 약 1/5, 비용은 약 1/8이다. 코드 리뷰 정밀도가 높다(CodeReviewBench 62.6%, Stephens 연구에서도 오탐이 적음). 약점: 첫 토큰이 느리고(4.0초 중앙값, max에서 157초) 출력 71 tok/s.
  - Astra: 프런트엔드 DesignArena 1위권, MacroscopeBench 1위. 가격이 Sol의 5배.
- Anthropic
  - Haiku 5.5: 출력 290 tok/s로 가장 빠른 편. 지능 36. TB 4.1 40.0%. 10만 토큰 넘는 프롬프트에서 가격 5배.
  - Sonnet 5.5: TB 4.1 63.9%로 Opus와 근접. WebDev 3위. 단 작업당 비용($10.02)은 Opus와 같은 수준이고 토큰을 많이 쓴다(TB 4.1에서 19.4B, 표 최대).
  - Opus 5.5: 구현, WebDev, 보안(CWE-bench 롤아웃당 $1.85로 상위 중 저렴), 창작 글쓰기 상위. 첫 답 토큰이 느리다(max 355초).
  - Fable 5.2: 지능 지수 1위, CWE-bench 1위, AA-Omniscience 정확도 1위. 작업당 비용 $26.54, TB 4.1 비용 $16.5k로 최고가. TB에서는 Opus 5.5와 동률이라 구현에서 가격 대비 이점이 측정되지 않았다. Fable 5.1은 폐쇄형 환각 70.0%.
- Google
  - Hydrogen(Flash 후속): 지능 54(xhigh), 작업당 시간 15.6분으로 짧고 첫 답 토큰 52초. CWE-bench 2위. Google은 실행과 검증 워커용으로 포지셔닝. 출력 속도 측정치가 출처마다 크게 다르다(충돌 목록 참조).
  - Argon: 1M 문맥 GraphWalks 256k~1M에서 84.2%로 경쟁 모델보다 크게 높음(벤더 측정). 폐쇄형 환각 4%로 최저이나 Vectara 문서 요약 환각은 12.1%로 4개 중 최고. P95 TTFT 61초로 꼬리 지연이 길다. 작업당 비용 $4.97~$17.64로 출처마다 다름. Google 스스로 대부분의 소프트웨어 작업에 Argon을 권한다.
  - Carbon: TB 4.1 64.5%를 $1.4k로 달성(Opus 5.5의 약 30%). 지능 60. 보안 공격 측 벤치마크 선두(벤더). 2026-11-10 일반 공개라 독립 측정이 아직 적다.
  - Flash(3.8): Hydrogen 발표 기준 TB 4.1 18.2%로 Hydrogen의 1/3. 리뷰 F2 18.2.
- 자료 없음: Hydrogen과 Carbon의 Vectara 환각률, Terra와 Hydrogen의 코드 리뷰 벤치마크, Fable 5.2의 코드 리뷰 벤치마크.

### 출처
- https://developers.openai.com/api/docs/pricing , https://openai.com/index/introducing-gpt-6-1-terra/ , https://openai.com/index/introducing-gpt-6-sol-and-luna/ (공식)
- https://platform.claude.com/docs/en/about-claude/pricing , https://platform.claude.com/docs/en/models/overview (공식)
- https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-gemini-4-hydrogen/ (공식, 2026-11-12), https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-4-carbon-now-available/ (공식, 2026-11-10), https://aistudio.google.com/docs/whats-new-gemini-4-hydrogen (공식)
- https://artificialanalysis.ai/leaderboards/models (제3자 공식 리더보드)
- https://www.requesty.ai/blog/gpt-vs-claude-vs-gemini-api-price-latency (엔지니어링 블로그, 게이트웨이 실측, 2026-11-11)
- https://github.com/vectara/hallucination-leaderboard (공식 리더보드, 2026-10-22)
- https://artificialanalysis.ai/evaluations/omniscience , https://lotook.com/articles/ai-hallucination-rates/ (제3자, 2026-11-01 스냅샷)
- https://www.widelai.com/blog/gemini-4-hydrogen-vs-claude-sonnet-5-5-gpt-6-1-terra-gemini-4-argon (일반, 2026-11-13)
- https://simonwillison.net/2026/oct/26/gpt-61-terra/ (엔지니어링 블로그, 2026-10-26)

---

## 질의 11. 오케스트레이터와 리드, 소통 역할의 모델 선택

### 핵심 발견
- 리드에 강한 모델을 두는 근거가 측정으로 반복된다.
  - "Think Big, Search Small"(2026-07): 위임 쪽 용량 확대 이득이 실행 쪽의 약 4.4배. 1.7B 실행자가 프런티어 실행자와 같은 정확도에 토큰 37% 절감.
  - "Can Small Agents Collaborate…"(2026-04): 시스템 성능은 오케스트레이터 용량이 좌우하고, 오케스트레이터에 추론을 켜는 것이 가장 효과가 컸다. 서브에이전트 추론은 이득이 없거나 손해였고 지연을 77% 늘렸다(오케스트레이터 추론은 8%).
  - Anthropic 연구 시스템: Opus 리드 + Sonnet 서브에이전트가 단일 Opus 대비 90.2% 우수. 성능 분산의 80%를 토큰 사용량이 설명. 다중 에이전트는 채팅 대비 약 15배 토큰.
  - 벤더 설계도 같다. Antigravity는 Carbon을 coordinator, Hydrogen을 worker와 verifier로 권하고, `/swarm`도 같은 배치다. oh-my-openagent도 오케스트레이터에 Opus max.
- 반대 또는 단서:
  - 감독 계층이 검증 불가능한 의견만 낼 때는 품질이 떨어지고 토큰이 51.5% 늘었다(loop-back 실험). 리드의 가치는 "검증 가능한 판단"에서 나온다.
  - MAST: 실패 대부분이 조정 문제라 모델을 키워도 사라지지 않는 실패가 있다.
  - Cognition의 반대 입장(맥락 공유가 불충분해 다중 에이전트가 깨지기 쉽다)은 이번에 원문 미확인.
- 긴 세션 유지와 지시 준수:
  - HANDBOOK.md(2026-07, 20~124쪽 규정 문서를 따르는 65과제): 최고 Fable 5 adaptive/max 36.2%, 대부분 프런티어 25% 미만. 실패 유형은 그럴듯한 요청에 상시 규정이 밀림, 확인 후 결과와 반대로 행동, 긴 지평에서 규칙 세부 상실, 하지 않은 준수를 보고. 이 표에서 Anthropic 상위 모델이 OpenAI보다 높았다(GPT-5.6 Sol max 23.5%).
  - SEQUOR(2026-05): 대화가 길어질수록 지시 준수 하락. 단일 제약 26%, 제약 누적 시 40% 이상 하락.
  - WDCD(2026-06): 세 차례 압박 후 준수율 95.8%에서 68.3%로. GPT-5.5 1위(구세대 모델 기준).
  - 장기 지평 퇴화(arXiv 2609.01660): 의존 단계가 많아지면 모든 모델이 무너진다. 맥락을 압축하면 퇴화가 오히려 빨라졌다(구세대 소형 모델 위주).
  - Argon의 1M 문맥 GraphWalks 84.2%(벤더)는 긴 문맥 검색에는 강하다는 근거지만 지시 준수와는 다른 능력이다.
- 소통 워커(보고, 요약, 알림):
  - 문체 품질은 측정마다 1위가 다르다. LMArena 글쓰기는 Carbon 1542, Argon 1532, Opus 5.5 1528(사람 선호). AI Writing Benchmark(AI 판정)는 GPT-6.1 Sol 95.3, Opus 5.5 92.8, Terra 86.1, Argon 63.2. EQ-Bench 장문은 Opus 5 86.3. 판정 방식(사람 대 AI)과 장르에 따라 Argon 순위가 크게 뒤집힌다.
  - 응답 속도: 첫 토큰과 출력 속도는 Haiku 5.5(2.3초, 290 tok/s), Sonnet 5.5(2.8초, 200 tok/s), Terra(2.8초, 128 tok/s, P95 8.9초로 꼬리가 가장 짧음)가 빠르다. Argon은 P95 61초로 대화형 소통에 불리하다.
  - 요약의 문서 충실도는 Vectara 기준 GPT-6 Sol 6.5%가 가장 낮은 환각률이고 Argon 12.1%가 가장 높다(4개 중).
  - 소통 워커 전용 벤치마크나 리드 위의 리드, 피어 메시지 구조에서 계층별 모델 배정과 비용을 잰 자료: 자료 없음.
- 비용 구조 사례: Swarms의 공개 구현은 리드 gpt-5.5, 서브에이전트 gpt-5.4-mini로 1회 실행 $0.30~0.60, 비용 대부분이 리드의 긴 호출 두 번에서 나온다. 리드를 Sonnet 5.5로 바꾸면 약 절반(벤더 문서).

### 출처
- https://www.alphaxiv.org/abs/2607.07548 (논문, 2026-07)
- https://arxiv.org/html/2601.11327v2 (논문, 2026-04)
- https://www.anthropic.com/research/multi-agent-research-system (공식, 2025-06)
- https://academy.dair.ai/papers/loop-back-authority-in-llm-agent-teams-a-paired-experiment-on-flat-and-hierarchi-2609.14767 (논문 요약, 2026-09)
- https://arxiv.org/html/2607.25398 (논문, HANDBOOK.md, 2026-07)
- https://arxiv.org/html/2605.06353v2 (논문, SEQUOR, 2026-05)
- https://www.winzheng.com/en/lab/reports/instruction-decay-95-to-68-percent-11-frontier-llms-wdcd (엔지니어링 블로그, 2026-06-12)
- https://arxiv.org/pdf/2609.01660 (논문)
- https://llmbenchmark.ai/benchmarks/lmarena-text-writing (일반, LMArena 집계, 2026-11-16)
- https://aiwritingbenchmark.com/leaderboard/ (일반, 2026-11-16)
- https://www.benchmarkalmanac.com/benchmarks/eqbench-longform-writing/ (일반, 2026-11-16)
- https://www.swarms.ai/blog/advanced-research-anthropic-multi-agent-research-system (엔지니어링 블로그)
- https://antigravity.google/docs/models/ (공식)

---

## 질의 전체를 가로지르는 결론

1. 모델을 따로 둘 근거가 측정으로 나온 경계는 "분해와 판단"과 "실행"의 둘이다. 위임 쪽 용량 확대가 실행 쪽보다 약 4배 효과가 있었고, 실행과 탐색은 작은 모델로 내려도 정확도가 유지되거나 오르며 토큰이 크게 준다. planner, architect, debugger를 서로 다른 모델로 나눌 근거는 찾지 못했다. 역할 페르소나 자체도 정확도를 바꾸지 않는다.
2. 교차 벤더 리뷰의 이득은 대부분 "새 맥락의 두 번째 시선"에서 온다. 같은 모델의 새 세션 대조군을 둔 사전등록 연구에서 교차 벤더 가설은 4개 중 3개 체크포인트에서 실패했다. 리뷰어가 작성자보다 약하면 오히려 정답을 깨뜨린다(JHU, -8.6%p). 교차 벤더가 확실히 주는 것은 오탐이 적다는 점 정도다. 리뷰 배치(기능 단위 사후 리뷰)와 지적을 실제로 반영하게 만드는 절차가 리뷰어 선택만큼 크다.
3. 역할별 "최강 모델"은 벤치마크마다 바뀐다. 구현(TB 4.1)은 Opus 5.5와 Fable 5.2 동률, 리뷰는 벤치마크별로 Kimi, Astra, 전용 에이전트가 1위, 보안은 Fable 5.2(CWE-bench)와 Wonder(CyberBench), 프런트엔드는 Fable 5.2와 Opus 5.5(WebDev) 또는 Astra(DesignArena), 글쓰기는 Carbon(사람 선호)과 Sol(AI 판정)이 1위다. 상위권 격차가 신뢰구간 안인 경우가 많아, 고정 배정은 성능보다 비용과 지연으로 고르는 편이 근거와 맞는다.
4. 비용 효율 차이는 정확도 차이보다 훨씬 크다. TB 4.1에서 GPT-6.1 Sol은 1위보다 4.9%p 낮지만 비용은 Opus 5.5의 약 1/8, Fable 5.2의 약 1/27이다. Carbon은 1.3%p 낮은데 Opus의 약 30% 비용이다. Fable 5.2는 구현에서 Opus 5.5를 넘지 못했는데 비용은 3.5배다.
5. 프롬프트만 보고 고르는 라우터는 연구와 실무 모두에서 약하다. 2026 연구는 상용 라우터가 잘 고른 두 모델 무작위 선택도 못 이긴다고 보고했고, 프로덕션 사례는 짧은 "fix" 프롬프트 오분류와 재시도 비용 역전을 기록했다. 효과가 난 방식은 궤적이나 도구 호출 단계를 신호로 쓰는 단계 라우팅, 계획자와 실행자가 제어를 주고받는 구조, 실제 트래픽 A/B다.
6. "작은 모델 = 빠름"은 effort를 낮췄을 때만 성립한다. Haiku 5.5 max의 첫 답 토큰은 184초, GPT-6 Luna는 기본 effort에서 리뷰를 거의 못 한다. 탐색 서브에이전트의 지연은 API 왕복 누적이 좌우해서, 프런티어 소형 모델도 로컬 4B 탐색기보다 4~5배 느렸다.
7. 리드와 오케스트레이터에는 강한 모델을 두는 근거가 일관되지만, 그 가치는 검증 가능한 판단에서 나온다. 의견만 내는 감독 계층은 토큰을 51.5% 더 쓰고 품질을 떨어뜨렸다. 긴 세션의 규정 준수는 모든 모델이 약해서(HANDBOOK.md 최고 36.2%), 모델 선택보다 규칙을 외부 검증으로 강제하는 장치가 더 중요하다.
8. 구독 묶음 운용은 약관 경계가 벤더마다 다르다. Anthropic은 구독 OAuth를 Claude Code와 claude.ai 밖에서 쓰는 것을 명시적으로 금지했고, OpenAI는 Codex 구독의 제3자 하네스 사용을 공개 지지했다. 공식 CLI를 여러 개 띄워 오가는 방식과 구독 토큰을 중계하는 방식은 약관상 위치가 다르다.

## 서로 충돌하는 근거

- 교차 벤더 리뷰: Greptile(다른 벤더가 재현율 2~3%p 높음)과 Stephens 사전등록 연구(새 세션 같은 모델이 같거나 더 많이 잡음), JHU 논문(방향에 따라 +18.1%p와 -8.6%p)이 서로 다른 결론을 낸다. Greptile은 리뷰 벤더의 자체 측정이고 새 세션 대조군이 없다.
- 환각률: Argon은 AA-Omniscience 4%(최저)인데 Vectara 12.1%(4개 중 최고). Fable 5.1은 AA 정확도가 높지만 환각률 70.0%. 지표가 다른 능력(문서 충실도 대 모르면 답하지 않기)을 잰다.
- 출력 속도: Artificial Analysis 수치를 인용한 집계 사이트들이 서로 다르다. models.fru.dev는 Opus 5.5 25 tok/s, Hydrogen 15 tok/s(둘 다 "Unverified" 표기), 17nas는 Opus 98/s, Hydrogen 249/s, WidelAI는 Hydrogen 198 tok/s, Requesty 프로덕션은 Opus 140 tok/s. 1차 출처(Artificial Analysis 모델 페이지)를 직접 열어야 확정된다.
- Terminal-Bench 2.x: 집계 사이트들이 90%대 점수를 싣지만 aicost.tools는 모든 행이 벤더 자체 보고이고 독립 행이 0이라고 적는다. benchgap의 Claude 5.5와 GPT-6.1 수치는 모델 기반 추정치다. Vals는 포화로 TB 2.0 측정을 중단했다.
- Gemini 4 Argon 구현 성능: Google 모델 카드는 DeepSWE 77.9%로 1위를 주장하지만 같은 표에서 FrontierSWE v2와 TB 4.0은 꼴찌이고, 제3자 분석은 DeepSWE 비교의 하네스가 섞였다고 지적한다. SWE-Bench Pro V2 공개 세트에서는 99.2%로 2위지만 이 세트는 학습 노출로 포화됐다고 Scale이 밝혔다.
- Argon 작업당 비용: Artificial Analysis 리더보드 $4.97, WidelAI 인용 $9.95(표준가 기준), Vals TB 4.0 $17.64. 가격 기준(도입가 대 표준가)과 벤치마크가 다르다.
- 글쓰기 품질: LMArena(사람 선호)에서 Argon 2위, AI Writing Benchmark(AI 판정)에서 Argon 42위. Terra는 OpenAI와 Simon Willison이 소통 글쓰기에 강하다고 평가하지만 AI 판정 벤치마크에서는 Sol보다 낮다.
- 작업 단위 라우팅의 효과: LangChain A/B(품질 동일, 비용 -64%), Cursor(만족도 유지, 비용 -68%)와 LLMRouterBench, "Misguided" 논문(상용 라우터가 단순 기준선을 못 넘음)이 충돌한다. 앞의 둘은 자기 트래픽에 맞춰 튜닝한 하네스 내부 라우터이고, 뒤의 둘은 범용 라우터를 고정 벤치마크로 쟀다는 차이가 있다.
- 다중 에이전트의 가치: Anthropic(단일 대비 90.2% 우수), "Think Big, Search Small"(단일 대비 EM +4.5~8.6)과 MAST(실패율 41~86.7%), loop-back 실험(계층형이 평평한 팀보다 나쁨)이 충돌한다. 앞의 둘은 병렬로 쪼개지는 검색과 연구 작업이고, 코딩은 병렬 가능한 부분이 적다고 Anthropic 스스로 적었다.
- 리뷰 벤치마크 1위: CodeReviewBench(Kimi K3.1 Pro), MacroscopeBench(GPT-6 Astra), ReviewBench(전용 에이전트, 모델 직결로는 Opus 5.5)가 모두 다르고, 운영 주체 대부분이 리뷰 제품을 판다.
