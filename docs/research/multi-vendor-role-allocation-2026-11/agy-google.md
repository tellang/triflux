11개 하위 질의를 검색해 정리했습니다. 모든 결과는 2025년 하반기부터 2026년 11월 사이의 자료를 우선으로 추렸습니다.

## 1. 멀티 에이전트 코딩 하네스와 오케스트레이터의 역할별 모델 배정

### 상위 5개 검색 결과

1. [Harness Engineering: Anatomy, Architecture, and Evolution of Coding Agents](https://arxiv.org/abs/2609.00006)
   - **URL:** `https://arxiv.org/abs/2609.00006`
   - **날짜:** 2026-09 (제3자 측정)
   - **핵심 주장:** `Claude Code`, `Aider`, `OpenHands`, `OpenCode`(`oh-my-opencode`), `Codex CLI` 등 코딩 하네스 11종의 소스 코드를 분석했습니다. 계획과 오케스트레이션에는 고성능 추론 모델을 두고 탐색, 파일 편집, 히스토리 요약에는 경량 모델을 두는 구조가 표준으로 굳어졌습니다.
   - **수치:** 코딩 에이전트 시스템 11종 비교 분석, `OpenHands`는 `LiteLLM` 기반으로 공급자 100곳 이상 연결 지원.

2. [Harness-Bench: Measuring Harness Effects across Models in Realistic Agent Workflows](https://arxiv.org/abs/2605.27922)
   - **URL:** `https://arxiv.org/abs/2605.27922`
   - **날짜:** 2026-10 개정 (제3자 측정)
   - **핵심 주장:** 동일한 모델이라도 서브에이전트 분리 방식, 권한 제어, 상태 관리 같은 하네스 구조에 따라 실제 코딩 성공률이 크게 달라집니다. 역할별로 컨텍스트를 격리하면 장기 작업에서 성능 저하가 줄어듭니다.
   - **수치:** 프런티어 모델 다수를 대상으로 현실 에이전트 워크플로 성공률 편차 측정.

3. [Claude Code Subagents Documentation](https://code.claude.ai/docs/subagents)
   - **URL:** `https://code.claude.ai/docs/subagents`
   - **날짜:** 2026년 기준 공식 문서 (벤더 자체 측정)
   - **핵심 주장:** 메인 오케스트레이터와 설계(`Plan`)에는 `Claude Opus`나 `Claude Sonnet`을 쓰고, 읽기 전용 탐색(`Explore`)에는 빠른 `Claude Haiku`를 배정합니다. 커뮤니티에서도 아키텍처와 리뷰에 `Opus`, 일반 구현에 `Sonnet`, 검색과 로그 파싱에 `Haiku`를 두어 토큰 비용을 줄입니다.
   - **수치:** 역할 분리 구성을 적용할 때 단일 `Opus` 실행 대비 토큰 비용 `11%~90%` 절감(커뮤니티 및 플레이북 집계 기준).

4. [Aider Leaderboards and Architect/Editor Mode](https://aider.chat/docs/leaderboards/)
   - **URL:** `https://aider.chat/docs/leaderboards/`
   - **날짜:** 2025~2026년 상시 갱신 (벤더 자체 측정)
   - **핵심 주장:** 문제를 분석하고 해결책을 설계하는 `Architect` 역할과 실제 파일 diff를 생성하는 `Editor` 역할을 분리합니다. 커밋 메시지 작성과 대화 요약은 가장 저렴한 `Weak Model`에 맡깁니다.
   - **수치:** `Aider Polyglot` 벤치마크에서 `Architect`와 `Editor` 분리 구성이 단일 모델 실행보다 높은 `79.1%~85%` 이상 통과율 기록.

5. [Cursor Subagents & OpenAI Codex Multi-Agent Guides](https://cursor.com/docs/agent/subagents)
   - **URL:** `https://cursor.com/docs/agent/subagents`
   - **날짜:** 2026년 기준 공식 문서 (벤더 자체 측정)
   - **핵심 주장:** `Cursor`, `Codex CLI`, `Gemini CLI` 모두 읽기 전용 `Explorer`, 설계 문서 작성 `Planner`, 코드 수정 `Implementer`(`Worker`), 검증 `Reviewer`의 4단계 구성을 지원합니다. `Gemini CLI`와 `Antigravity`는 대규모 컨텍스트 탐색과 빠른 실행에 `Hydrogen`(`Flash` 계열)을 쓰고, 복잡한 설계와 검증에 `Carbon`이나 `Argon`을 배치합니다.
   - **수치:** `Gemini 4` 계열은 `1,048,576` 토큰 통합 컨텍스트 풀 지원.

### 반대 사례와 반론
- 파일 1~2개를 고치는 작은 작업에서는 `Explorer`, `Planner`, `Implementer`, `Reviewer`를 모두 거치면 모델 호출 횟수와 대기 시간만 늘어납니다.
- `Aider`에서도 프런티어 모델이 diff 포맷 출력까지 완벽히 처리할 때는 `Architect`와 `Editor`를 나누는 것보다 단일 모델로 한 번에 처리하는 편이 지연과 입력 토큰 중복을 줄입니다.

### 결론
- 공식 기본값과 커뮤니티 권장 설정 모두 계획, 설계, 리뷰에는 상위 추론 모델(`Claude Opus`, `GPT-6 Astra/Sol`, `Gemini 4 Carbon/Argon`)을 배정합니다.
- 구현에는 중상위 코딩 모델(`Claude Sonnet`, `GPT-6 Sol`, `Gemini 4 Argon/Hydrogen`)을 쓰고, 탐색과 단순 요약에는 경량 고속 모델(`Claude Haiku`, `GPT-6 Luna`, `Gemini 4 Hydrogen`)을 배정합니다.

## 2. 작성 모델과 다른 벤더 모델로 리뷰하기(Cross-Vendor Review)

### 상위 5개 검색 결과

1. [Self-Preference Bias in Rubric-Based Evaluation of Large Language Models](https://arxiv.org/abs/2604.06996)
   - **URL:** `https://arxiv.org/abs/2604.06996`
   - **날짜:** 2026-07 v2, COLM 2026 (제3자 측정)
   - **핵심 주장:** 객관적인 루브릭을 주더라도 LLM 판정기는 자기 가족 모델이 작성한 잘못된 코드를 통과시키는 자기 선호 편향(`Self-Preference Bias`)을 보입니다. 따라서 작성 모델과 다른 벤더의 모델로 교차 리뷰해야 오류 통과율을 낮출 수 있습니다.
   - **수치:** `LiveCodeBench`와 `IFEval` 기반 실험에서 같은 가족 모델이 작성한 결함 코드를 잘못 승인할 확률이 타 모델 대비 `50%` 이상 높음.

2. [SWR-Bench: Assessing LLM Performance in Real-World Code Review Comment Generation](https://arxiv.org/abs/2509.01494)
   - **URL:** `https://arxiv.org/abs/2509.01494`
   - **날짜:** 2025-09 공개, 2026-07 FSE 채택 (제3자 측정)
   - **핵심 주장:** 실제 GitHub Pull Request를 기반으로 자동 코드 리뷰(`ACR`) 성능을 평가한 결과, 단일 모델 리뷰보다 서로 다른 모델 가족의 리뷰 결과를 결합할 때 결함 탐지 성능이 크게 올라갑니다.
   - **수치:** 수동 검증된 실제 GitHub PR `1,000개` 벤치마크에서 다중 모델 가족 결합 시 단일 모델 대비 이슈 탐지 `F1` 점수 유의미 상승.

3. [CodeJudgeBench: Benchmarking LLM-as-a-Judge for Coding Tasks](https://arxiv.org/abs/2507.10535)
   - **URL:** `https://arxiv.org/abs/2507.10535`
   - **날짜:** 2025-08 v2 (제3자 측정)
   - **핵심 주장:** 코드 생성, 코드 수정, 단위 테스트 생성에서 LLM 판정기의 신뢰도를 측정했습니다. 모델마다 선호하는 코드 스타일과 위치 편향이 달라 교차 모델 평가와 사고 사슬(`CoT`) 강제가 필요합니다.
   - **수치:** 코딩 태스크 판정 쌍 `5,352개`를 대상으로 프롬프트 변형 및 모델 순서 변경 시 판정 일관성 측정.

4. [Do LLM Evaluators Prefer Themselves for a Reason?](https://arxiv.org/abs/2504.03846)
   - **URL:** `https://arxiv.org/abs/2504.03846`
   - **날짜:** 2025-04 공개, 2025년 하반기 후속 인용 (제3자 측정)
   - **핵심 주장:** 실제 코드 품질 차이와 순수 자기 선호 편향을 분리하는 `DBG` 점수를 제안했습니다. 모델 가족마다 고유한 토큰 확률 분포와 문체 선호가 있어 같은 계열 모델끼리는 보안 취약점이나 논리 오류를 놓치기 쉽습니다.
   - **수치:** 판정 모델의 과대평가율과 실제 정답 간 괴리를 `DBG` 지표로 정량화.

5. [StackEval: Benchmarking LLMs in Coding Assistance](https://arxiv.org/abs/2412.05288)
   - **URL:** `https://arxiv.org/abs/2412.05288`
   - **날짜:** 2024-12 공개, 2025~2026년 기준선 활용 (제3자 측정)
   - **핵심 주장:** 정답 코드나 단위 테스트 실행 결과 없이 LLM이 코드 리뷰를 수행하면 자기 선호 편향이 강하게 나타납니다. 반면 객관적 참조 답안이나 테스트 결과를 함께 주면 편향이 크게 줄어듭니다.
   - **수치:** 다중 언어 코딩 지원 및 코드 리뷰 벤치마크에서 참조 답안 유무에 따른 판정 편향 감소 확인.

### 반대 사례와 반론
- 단위 테스트 실행 결과, 정적 분석기 출력, 참조 구현 같은 객관적 기준(`Ground Truth`)이 프롬프트에 포함되면 같은 모델을 판정기로 써도 자기 선호 편향이 통계적으로 미미해집니다.
- 서로 다른 벤더 모델을 섞어 쓰면 프롬프트 캐시(`KV cache`)를 공유할 수 없어 지연 시간과 API 비용이 늘어나며, 약한 타 벤더 모델을 리뷰어로 두면 오히려 거짓 양성(`False Positive`) 경고가 많아져 개발 속도가 떨어집니다.

### 결론
- 실행 테스트만으로 잡기 어려운 설계 결함, 보안 취약점, 코드 품질 리뷰에서는 작성 모델과 같은 가족 모델이 결함 코드를 승인할 확률이 `50%` 이상 높으므로 다른 벤더 모델로 교차 리뷰하는 방식이 유효합니다.
- 다만 객관적 테스트 스위트가 완비된 작업에서는 교차 벤더 리뷰보다 실행 기반 검증과 정적 분석을 결합하는 편이 비용 대비 효율이 높습니다.

## 3. LLM 라우터와 게이트웨이의 폴백, 우선순위, 로드밸런싱

### 상위 5개 검색 결과

1. [LiteLLM Proxy Reliability & Routing Documentation](https://docs.litellm.ai/docs/routing)
   - **URL:** `https://docs.litellm.ai/docs/routing`
   - **날짜:** 2026년 기준 공식 문서 (벤더 자체 측정)
   - **핵심 주장:** 오픈소스 셀프호스팅 게이트웨이로, YAML 설정에서 일반 폴백, 컨텍스트 초과 폴백, 콘텐츠 정책 폴백 배열을 분리해 지정합니다. Redis를 이용해 배포 키별 분당 요청 수(`RPM`)와 분당 토큰 수(`TPM`)를 추적하고 지연 시간이나 비용 기준으로 로드밸런싱합니다.
   - **수치:** LLM 공급자 `100곳` 이상 통합 지원, `HTTP 429` 발생 시 쿨다운 및 타 배포 키 즉시 우회.

2. [OpenRouter Provider Routing & Model Selection Documentation](https://openrouter.ai/docs/guides/routing/provider-selection)
   - **URL:** `https://openrouter.ai/docs/guides/routing/provider-selection`
   - **날짜:** 2026년 기준 공식 문서 (벤더 자체 측정)
   - **핵심 주장:** 관리형 멀티모델 게이트웨이로, 가격의 역제곱 가중치를 활용한 자동 로드밸런싱과 가동률 기반 폴백을 기본 제공합니다. `Not Diamond` 기반의 `Auto Router` 슬라이더로 비용과 품질 비중을 조절할 수 있습니다.
   - **수치:** 단일 엔드포인트로 모델 `300~500개` 이상 연결, 크레딧 충전 수수료 약 `5.5%`(`BYOK` 일정 한도 무료).

3. [Portkey AI Gateway Fallbacks & Configs Documentation](https://portkey.ai/docs/product/ai-gateway/configs)
   - **URL:** `https://portkey.ai/docs/product/ai-gateway/configs`
   - **날짜:** 2026년 기준 공식 문서 (벤더 자체 측정)
   - **핵심 주장:** 조건부 라우팅, 자동 재시도, 서킷 브레이커, 시맨틱 캐싱, 개인정보(`PII`) 마스킹 가드레일을 결합한 엔터프라이즈 게이트웨이입니다. 특정 공급자에서 지연이나 상태 코드 오류가 누적되면 서킷 브레이커가 경로를 차단하고 백업 공급자로 트래픽을 돌립니다.
   - **수치:** 통합 모델 `1,600개` 이상 지원, 유료 플랜 월 `$49`부터 시작.

4. [Not Diamond Routing Documentation](https://docs.notdiamond.ai)
   - **URL:** `https://docs.notdiamond.ai`
   - **날짜:** 2026년 기준 공식 문서 (벤더 자체 측정)
   - **핵심 주장:** 정적 규칙 대신 머신러닝 분류기를 사용해 입력 프롬프트마다 가장 높은 정확도나 최저 비용을 낼 모델을 예측합니다. 게이트웨이 앞단에서 라우팅 결정만 내리거나 지연과 비용 한도를 함께 조건으로 걸 수 있습니다.
   - **수치:** 프롬프트별 실시간 모델 매칭으로 프런티어 단일 모델 대비 비용 절감 및 정확도 유지.

5. [Martian Model Router Platform](https://www.withmartian.com)
   - **URL:** `https://www.withmartian.com`
   - **날짜:** 2026년 기준 공식 문서 (벤더 자체 측정)
   - **핵심 주장:** 모델 매핑 기술을 사용해 각 요청의 의미적 난이도와 실시간 가격 대비 성능 곡선을 계산하고 최적 모델로 연결합니다.
   - **수치:** 요청별 최대 허용 비용과 품질 임계값을 동시 지정 가능.

### 반대 사례와 반론
- 게이트웨이가 `HTTP 429`나 장애 때문에 다중 턴 에이전트 세션 도중 다른 벤더 모델로 폴백하면 기존 공급자에 쌓인 프롬프트 캐시(`KV cache`)가 무효화되어 첫 토큰 지연(`TTFT`)과 입력 토큰 과금이 급증합니다.
- 모델마다 도구 호출(`Tool Calling`) JSON 스키마 해석과 시스템 프롬프트 준수 방식이 미묘하게 달라, 폴백 직후 에이전트 파서가 깨지는 사고가 실무에서 자주 보고됩니다.

### 결론
- 인프라 통제권과 데이터 레지던시가 중요하면 `LiteLLM`, 빠른 다중 공급자 연결이 필요하면 `OpenRouter`, 엔터프라이즈 감사와 서킷 브레이커가 필요하면 `Portkey`, 프롬프트 난이도 기반 동적 선택이 필요하면 `Not Diamond`나 `Martian`을 씁니다.
- 에이전트 워크플로에서는 무작정 다른 벤더로 폴백하기보다 같은 모델을 호스팅하는 다른 리전이나 엔드포인트(예: Anthropic 직접 API에서 AWS Bedrock이나 Google Vertex AI로 전환)로 우선 폴백해야 포맷 깨짐을 막을 수 있습니다.

## 4. 비용-품질 라우팅 연구(2025~2026 논문)의 결론과 한계

### 상위 5개 검색 결과

1. [RouterWorld: Scaling Conversational AI with Latency-Aware LLM Routing](https://arxiv.org/abs/2610.26511)
   - **URL:** `https://arxiv.org/abs/2610.26511`
   - **날짜:** 2026-10-18 (제3자 측정)
   - **핵심 주장:** 기존 라우터들이 토큰 단가만 정적으로 계산하고 실제 하드웨어 대기열이나 스트리밍 지연은 무시했다는 점을 지적합니다. 지연을 반영한 `L-DCG` 지표를 도입해 실시간 트래픽 변화 속에서도 품질과 지연을 함께 최적화해야 한다고 결론짓습니다.
   - **수치:** 단일 턴 응답 `371,000건`, 다중 턴 에이전트 궤적 `76,000건`, 데이터셋 `12~17개`, 모델 풀 최대 `7개` 규모로 검증.

2. [LLMRouterBench: A Massive Benchmark and Unified Framework for LLM Routing](https://arxiv.org/abs/2601.07206)
   - **URL:** `https://arxiv.org/abs/2601.07206`
   - **날짜:** 2026-01-12 (제3자 측정)
   - **핵심 주장:** `RouteLLM`, `FrugalGPT`,Contextual Bandit 계열 등 다양한 라우팅 알고리즘을 동일한 기준에서 비교했습니다. 일반 대화 데이터로 학습된 라우터는 수학, 코딩, 도메인 특화 작업으로 넘어가면 난이도 예측력이 급격히 떨어지는 일반화 한계를 보입니다.
   - **수치:** 인스턴스 `400,000건` 이상, 데이터셋 `21개`, 모델 `33개` 통합 비교.

3. [A Unified Approach to Routing and Cascading for LLMs](https://arxiv.org/abs/2410.10347)
   - **URL:** `https://arxiv.org/abs/2410.10347`
   - **날짜:** 2025-05 개정, ICML 2025 발표 (제3자 측정)
   - **핵심 주장:** 한 번에 모델 하나만 고르는 라우팅(`RouteLLM` 방식)과 순차적으로 호출하는 캐스케이드(`FrugalGPT` 방식)를 수학적으로 통합한 `Cascade Routing`이 단독 방식보다 항상 파레토 우위에 있음을 증명했습니다.
   - **수치:** 고정 예산 조건에서 단독 라우팅 및 단독 캐스케이드 대비 모든 구간에서 정확도 우위 달성.

4. [CARROT: A Learned Cost-Constrained Retrieval Optimization System for RAG](https://arxiv.org/abs/2411.00744)
   - **URL:** `https://arxiv.org/abs/2411.00744`
   - **날짜:** 2026-03-12 v2 (제3자 측정)
   - **핵심 주장:** 모델 선택뿐 아니라 검색 증강 생성(`RAG`)에서 가져올 청크 수와 토큰 예산을 질의별로 동적 할당해야 비용 대비 품질이 극대화됩니다.
   - **수치:** `WikiPassageQA`, `MARCO`, `HotpotQA`에서 토큰 예산 제약 내 `ROUGE` 및 `F1` 점수 향상과 검색 지연 단축 확인.

5. [RouteLLM: Learning to Route LLMs with Preference Data](https://arxiv.org/abs/2406.18665)
   - **URL:** `https://arxiv.org/abs/2406.18665`
   - **날짜:** 2025-02 v4, ICLR 2025 발표 (제3자 측정)
   - **핵심 주장:** `Chatbot Arena` 선호도 데이터로 가벼운 라우터를 학습시키면 프런티어 모델 호출 비중을 크게 줄이면서도 전체 응답 품질을 유지할 수 있습니다.
   - **수치:** 응답 품질 손실 없이 API 비용 `2배` 이상(최대 `50%~85%`) 절감.

### 반대 사례와 반론
- **정적 비용 가정의 붕괴:** 실제 운영 환경에서는 GPU 큐 길이, `KV cache` 적중 여부, 시퀀스 길이에 따라 작은 모델이 몰릴 때 오히려 지연이 길어지고 캐시 미스로 비용이 역전됩니다.
- **오분류의 비대칭성:** 쉬운 질의를 비싼 모델로 보내면 돈만 조금 더 들지만, 보안이나 안전이 걸린 복잡한 질의를 작은 모델로 잘못 보내면 치명적인 환각이나 보안 사고가 납니다.
- **캐스케이드 지연 누적:** `FrugalGPT`처럼 작은 모델을 먼저 실행하고 실패할 때 큰 모델을 다시 호출하면, 실패한 단계의 대기 시간과 토큰 비용이 고스란히 누적됩니다.

### 결론
- 2025~2026년 연구는 단순 선호도 학습 라우터(`RouteLLM`)나 순차 캐스케이드(`FrugalGPT`) 단독 방식에서 벗어나, 하드웨어 상태와 지연, 캐시 적중률, 도메인 특성을 함께 반영하는 동적 라우팅으로 넘어가고 있습니다.

## 5. 구독형 코딩 플랜 여러 개의 사용량 한도를 함께 쓰는 실무 사례와 도구

### 상위 5개 검색 결과

1. [9Router: Open Source AI Router & Token Saver](https://github.com/decolua/9router)
   - **URL:** `https://github.com/decolua/9router`
   - **날짜:** 2026년 공개 오픈소스 (제3자 측정)
   - **핵심 주장:** 로컬 엔드포인트(`http://localhost:20128/v1`)를 띄워 `Claude Code`, `Codex CLI`, `Cursor`, `Cline`의 요청을 받아냅니다. 1순위 구독형 플랜(`Claude Max`, `ChatGPT Pro`, `Copilot`)의 5시간 또는 주간 한도가 차면 2순위 저가 종량제 API, 3순위 무료 티어로 자동 폴백하며, 도구 출력을 압축해 쿼터 소모를 줄입니다.
   - **수치:** 내장 `RTK Token Saver`로 `git diff`, `grep` 등 도구 결과 입력 토큰 `20%~40%` 절감.

2. [ccusage: CLI Usage Tracker for Claude Code and Codex](https://github.com/ryoppippi/ccusage)
   - **URL:** `https://github.com/ryoppippi/ccusage`
   - **날짜:** 2025~2026년 상시 갱신 (제3자 측정)
   - **핵심 주장:** `Claude Code`와 `Codex` 등이 로컬에 남기는 JSONL 세션 로그를 파싱해 일별, 주별, 월별, 5시간 블록별 토큰 사용량과 API 환산 금액을 실시간으로 집계합니다.
   - **수치:** 구독 플랜 한도 대비 실사용 API 환산 가치를 달러 단위로 계산.

3. [CodexBar & ClaudeMeter: macOS Menu Bar Rate-Limit Trackers](https://agentastic.dev)
   - **URL:** `https://agentastic.dev`
   - **날짜:** 2026년 기준 도구 생태계 요약 (제3자 측정)
   - **핵심 주장:** `CodexBar`, `ClaudeMeter`, `Usage for Claude`, `TokenMeter` 같은 macOS 메뉴바 앱이 여러 구독 계정(`Claude Max`, `ChatGPT Pro`)의 5시간 롤링 윈도와 주간 쿼터 소진 속도(`Burn Rate`)를 나란히 보여주고 한도 도달 전에 알림을 보냅니다.
   - **수치:** 5시간 세션 윈도 및 주간 한도 잔여율(`%`)과 초기화 카운트다운 실시간 표시.

4. [Claude Max vs. ChatGPT Pro vs. Google AI Ultra Pricing & Quota Analysis](https://aipricing.guru)
   - **URL:** `https://aipricing.guru`
   - **날짜:** 2026년 기준 (제3자 측정)
   - **핵심 주장:** 실무 개발자들은 단일 플랜의 주간 속도 제한에 막히지 않으려고 `Claude Max`(월 `$100~$200`), `ChatGPT Pro`(월 `$200`), `Google AI Ultra`(월 `$99.99~$249.99`)를 병행 구독합니다. 아키텍처와 다중 파일 구현은 `Claude Code`(`Claude Max`), 터미널 작업과 심층 리서치는 `Codex`(`ChatGPT Pro`), 대규모 컨텍스트 분석은 `Antigravity`(`Google AI Ultra`)로 역할을 나누어 쿼터를 분산합니다.
   - **수치:** `Claude Max`는 기본 Pro 대비 `5배~20배` 한도 제공, 3대 플래그십 구독 병행 시 월 고정비 약 `$400~$650`.

5. [Claude Monitor: Terminal Burn-Rate Predictor](https://pypi.org/project/claude-monitor/)
   - **URL:** `https://pypi.org/project/claude-monitor/`
   - **날짜:** 2025~2026년 (제3자 측정)
   - **핵심 주장:** 터미널에서 에이전트 루프의 분당 토큰 소진 속도를 추적해 현재 세션을 언제 다른 구독 도구나 API 키로 넘겨야 하는지 예측합니다.
   - **수치:** 실시간 토큰 소진율 기반으로 세션 잠김 예상 시각을 분 단위로 예측.

### 반대 사례와 반론
- 구독 계정의 웹/CLI OAuth 토큰을 비공식 프록시로 가로채 자동 회전시키거나 다중 계정을 묶어 쓰는 방식은 벤더 서비스 약관(`ToS`) 위반으로 계정 정지 위험이 있습니다.
- 도구 출력 압축기(`RTK` 등)가 스택 트레이스나 `git diff`의 핵심 줄을 잘라내면 에이전트가 잘못된 수정을 반복해 오히려 쿼터를 더 빨리 소모하기도 합니다.

### 결론
- 실무에서는 `ccusage`, `CodexBar`, `Usage for Claude` 등으로 5시간 및 주간 한도를 모니터링하면서, 작업 성격이나 잔여 쿼터에 따라 `Claude Code`, `Codex CLI`, `Antigravity` 세션을 전환하거나 `9Router` 같은 로컬 라우터로 종량제 API 폴백을 연결해 작업 끊김을 막습니다.

## 6. 역할별 성능 근거와 2026년 최신 모델 가족 비교

### 상위 5개 검색 결과

1. [SWE-bench Pro Leaderboard](https://benchlm.ai)
   - **URL:** `https://benchlm.ai`
   - **날짜:** 2026-11 집계 기준 (제3자 측정 및 벤더 보고 병기)
   - **핵심 주장:** 기존 `SWE-bench Verified`가 `95%` 이상으로 포화되어 아카이브된 뒤, 다중 파일과 다중 언어를 다루는 `SWE-bench Pro`(`Scale AI` 제작)가 구현 능력의 표준 지표가 되었습니다. 다중 파일 구현에서는 `Claude 5.5` 계열이 가장 앞섭니다.
   - **수치:** `Claude Opus 5.5` `89.9%`(벤더 최적화 스택 기준), `Claude Sonnet 5.5` `81.3%`, `Claude Fable 5.1` `81.2%`.

2. [Terminal-Bench 4.0 Official Leaderboard](https://harborframework.com)
   - **URL:** `https://harborframework.com`
   - **날짜:** 2026-10 기준 (제3자 측정)
   - **핵심 주장:** 실제 리눅스 터미널에서 빌드, 디버깅, 시스템 관리, 보안 작업을 수행하는 벤치마크입니다. `Claude Code` 하네스 위에서 도는 `Opus 5.5`와 `Sonnet 5.5`가 선두이며, `GPT-6.1 Sol`이 그 뒤를 추격합니다.
   - **수치:** `Claude Code (Opus 5.5 Max)` `64.8% ± 3.1%`, `Claude Code (Sonnet 5.5 Max)` `61.8% ± 2.9%`, `GPT-6.1 Sol (Max)` `58.2%~59.6%`(벤더 자체 설정 시 `Sonnet 5.5`는 `70.6%` 보고).

3. [FrontierSWE v1 & v2 Leaderboard](https://frontierswe.com)
   - **URL:** `https://frontierswe.com`
   - **날짜:** 2026-10 기준 (제3자 측정)
   - **핵심 주장:** 프로젝트당 최대 20시간이 걸리는 초장기 소프트웨어 엔지니어링 및 연구 벤치마크입니다. `Claude Fable` 계열과 `GPT-6 Astra`, `Gemini 4 Carbon`이 상위권을 형성합니다.
   - **수치:** 34개 과제로 구성된 `FrontierSWE v2`에서 `Claude Fable 5.2` 약 `69.9%`(mean@5), `GPT-6 Astra` `65.5%`, `Gemini 4 Carbon` `61.2%`, 오픈 모델 `GLM-5.3` `30.2%`.

4. [WebDev Arena (LMArena Code Arena)](https://arena.ai/leaderboard/code/webdev)
   - **URL:** `https://arena.ai/leaderboard/code/webdev`
   - **날짜:** 2026-11 기준 (제3자 측정, 블라인드 인간 평가)
   - **핵심 주장:** 프런트엔드와 풀스택 웹앱 생성 능력을 블라인드 쌍대 비교(`Elo`)로 평가합니다. `Claude Fable 5.2`, `Claude Opus 5.5`, `Gemini 4 Carbon`, `GPT-6 Astra`가 HTML 단일 문서와 React 다중 컴포넌트 트랙에서 최상위권을 다툽니다.
   - **수치:** `Claude Fable 5.2 (xHigh)` Elo 약 `1838`, `Claude Opus 5.5 (Max)` 약 `1815`, `Claude Sonnet 5.5 (xHigh)` 약 `1772`, `Gemini 4 Carbon`은 단일 웹앱 및 레이아웃 트랙 최상위권 기록.

5. [SEC-bench Pro, ExploitGym, CWE-bench & SecureVibeBench Security Evaluations](https://aclanthology.org/2026.acl-long.1107/)
   - **URL:** `https://aclanthology.org/2026.acl-long.1107/`
   - **날짜:** 2026-07 ACL 2026 및 2026년 하반기 보안 리포트 (벤더 자체 측정 및 제3자 측정 혼합)
   - **핵심 주장:** 보안 취약점 탐지(`SEC-bench Pro`), 취약점 검증(`ExploitGym`), 보안 패치(`CWE-bench`)에서는 가드레일을 해제한 `Gemini 4 Carbon`과 `GPT-6 Astra`가 가장 높은 점수를 기록했습니다. 한편 제3자 벤치마크인 `SecureVibeBench`는 에이전트가 기능 테스트는 통과하지만 보안 취약점을 남기거나 새로 만드는 현상을 지적합니다.
   - **수치:** 벤더 보고 기준 `SEC-bench Pro`에서 `Gemini 4 Carbon` `88.2%`, `GPT-6 Astra` `85.4%`, `Gemini 4 Argon` `83.4%`. `ExploitGym`에서 `Gemini 4 Carbon` `54.8%`, `GPT-6 Astra` `42.4%`, `Claude Opus 5.5` `34.5%`. `CWE-bench` 패치 성공률은 `Gemini 4 Carbon` `71.0%`, `Gemini 4 Argon` `68.0%`, `GPT-6 Astra` `68.0%`, `Claude Opus 5.5` `67.0%`.

### 반대 사례와 반론
- `SlopCodeBench`(`https://arxiv.org/abs/2603.24755`, 2026-03, 제3자 측정)에 따르면 단발성 벤치마크 점수가 높은 프런티어 모델들도 다중 턴에 걸쳐 기능을 반복 수정하면 코드 중복과 거대 함수(`God Function`)가 늘어나는 구조적 침식을 겪으며, 체크포인트 완주율이 `14.8%~17.2%`에 그칩니다.
- 보안 취약점 스캔(`RealVuln` 등)에서 프런티어 모델들은 탐지 건수는 많으나 거짓 양성(`False Positive`) 비율이 높아 전용 정적/동적 분석 도구 없이 단독으로 쓰기 어렵습니다.
- 벤더가 자체 최적화된 하네스로 발표한 점수(예: `Terminal-Bench` 벤더 보고치 `70.6%`)와 제3자 표준 하네스 점수(`61.8%~64.8%`) 사이에 약 `6~9%p` 격차가 존재합니다.

### 결론
- 다중 파일 구현과 터미널 작업은 `Claude Opus 5.5`와 `Sonnet 5.5`, 초장기 엔지니어링과 프런트엔드는 `Claude Fable 5.2`, `GPT-6 Astra`, `Gemini 4 Carbon`, 보안 취약점 탐지와 패치는 `Gemini 4 Carbon`과 `GPT-6 Astra`가 강점을 보입니다.
- 코드 리뷰는 질의 2의 `SWR-Bench`와 `CodeJudgeBench`가 기준 역할을 하며, 2026년 최신 3대 모델 가족을 동일 조건에서 비교한 공인 문서 작성(`Documentation Writing`) 전용 벤치마크는 `자료 없음`입니다.

## 7. 빠른 탐색에 작은 모델, 계획과 디버깅에 큰 추론 모델을 쓰는 방식의 실측 근거

### 상위 5개 검색 결과

1. [Ares: Adaptive Reasoning Effort Selection for Efficient LLM Agents](https://arxiv.org/abs/2603.07915)
   - **URL:** `https://arxiv.org/abs/2603.07915`
   - **날짜:** 2026-03-09 (제3자 측정)
   - **핵심 주장:** 모든 단계에 최대 추론을 쓰면 단순 탐색에서도 토큰과 시간이 낭비됩니다. `Qwen3-1.7B` 기반 경량 라우터로 단순 탐색과 조회에는 낮은 추론 수준을 배정하고 계획과 복잡한 디버깅에만 높은 추론 수준을 배정해 비용과 지연을 크게 줄였습니다.
   - **수치:** `TAU-Bench` 등 에이전트 벤치마크에서 정확도 손실 없이 누적 토큰 비용 `50%` 이상 절감.

2. [FastCode: Fast and Cost-Efficient Code Understanding and Reasoning](https://arxiv.org/abs/2603.01012)
   - **URL:** `https://arxiv.org/abs/2603.01012`
   - **날짜:** 2026-03 (제3자 측정)
   - **핵심 주장:** 저장소 전체를 대형 추론 모델에 바로 넣지 않고, 가벼운 스카우팅(`Scouting-first`) 단계로 관련 파일과 심볼을 먼저 추린 뒤 심층 추론과 디버깅만 수행하는 구조가 지연과 비용 모두에서 압도적입니다.
   - **수치:** `SWE-QA`, `LongCodeQA`, `LocBench`, `GitTaskBench`에서 전체 토큰 소모와 응답 지연을 대폭 절감하면서 정밀도 유지.

3. [Agentic Reinforced Policy Optimization (ARPO)](https://arxiv.org/abs/2507.19849)
   - **URL:** `https://arxiv.org/abs/2507.19849`
   - **날짜:** 2025-07-26 (제3자 측정)
   - **핵심 주장:** 에이전트가 외부 검색이나 도구를 호출한 직후에 토큰 엔트로피(불확실성)가 급증합니다. 불확실성이 높은 계획 및 분기 시점에만 탐색 연산을 집중하고 단순 단계는 빠르게 넘어가야 도구 호출 예산을 아낄 수 있습니다.
   - **수치:** 벤치마크 `13개`에서 기존 궤적 단위 강화학습 대비 절반(`50%`)의 도구 사용 예산으로 더 높은 성공률 달성.

4. [AgentSM: Semantic Memory-Augmented Agentic Text-to-SQL with Composite Tools](https://arxiv.org/abs/2601.15709)
   - **URL:** `https://arxiv.org/abs/2601.15709`
   - **날짜:** 2026-01 (제3자 측정)
   - **핵심 주장:** 반복적인 스키마 탐색과 데이터 조회를 복합 도구와 시맨틱 메모리로 단축하고, 핵심 쿼리 계획과 오류 수정에만 추론을 집중해 평균 궤적 길이와 지연을 줄였습니다.
   - **수치:** `Spider 2.0` 벤치마크에서 탐색 턴 수, 토큰 소모량, 전체 응답 지연 시간 유의미 단축.

5. [Artificial Analysis Model Latency & Throughput Benchmarks](https://artificialanalysis.ai)
   - **URL:** `https://artificialanalysis.ai`
   - **날짜:** 2026-11 기준 (제3자 측정)
   - **핵심 주장:** 대형 추론 모델은 첫 토큰이 나오기까지 내부 사고 토큰을 생성하느라 수십~백수십 초가 걸리므로, 빠른 파일 검색과 탐색 루프에 쓰면 전체 작업 시간이 폭증합니다.
   - **수치:** 경량 모델 `GPT-6 Luna`는 첫 토큰 지연(`TTFT`) `0.81~1.11초`, 생성 속도 `109~154 tokens/s`인 반면, 대형 추론 모델 `GPT-6 Astra (High/Max)`는 `TTFT` `100~173초`, 생성 속도 `58~64 tokens/s`.

### 반대 사례와 반론
- 작은 탐색 모델이 핵심 의존성 파일이나 버그 원인이 있는 모듈을 놓치면(`False Negative`), 뒤따르는 대형 추론 모델이 아무리 뛰어나도 잘못된 파일 위에서 계획을 세우게 되어 전체 작업이 실패합니다.
- 소형 모델이 탐색에 실패해 재시도 루프를 여러 번 돌면 아낀 토큰보다 재시도 누적 비용이 더 커지므로, 단순 토큰 단가가 아니라 성공한 작업당 비용(`Cost per Successful Task`)으로 평가해야 합니다.

### 결론
- 대형 추론 모델과 경량 모델의 초기 지연 차이가 최대 `100배` 이상(`0.8초` 대 `100초` 이상) 나기 때문에, 읽기 전용 스카우팅과 검색에는 경량 모델이나 낮은 추론 모드를 쓰고 분기 계획과 디버깅에만 고추론 모델을 쓰는 방식이 지연과 토큰 비용을 `50%` 이상 줄입니다.

## 8. 역할 기반 고정 배정 대신 작업 단위로 모델을 고르는 방식의 채택과 실패 사례

### 상위 5개 검색 결과

1. [Ares: Adaptive Reasoning Effort Selection for Efficient LLM Agents](https://arxiv.org/abs/2603.07915)
   - **URL:** `https://arxiv.org/abs/2603.07915`
   - **날짜:** 2026-03-09 (제3자 측정)
   - **핵심 주장:** 작업 단계마다 이기종 모델로 바꾸면 프롬프트 캐시(`KV cache`)가 깨져 재인코딩 지연과 비용이 발생합니다. 대신 같은 모델 가중치 안에서 단계별로 추론 강도(`low`, `medium`, `high`)만 동적으로 바꾸는 라우터가 캐시를 보존하면서 비용을 아낍니다.
   - **수치:** `KV cache` 재사용을 유지하며 추론 토큰 비용 `50%` 이상 절감.

2. [KVCMAS: Efficient KV cache Correction for Shared Context in Multi-Agent Systems](https://arxiv.org/abs/2609.34060)
   - **URL:** `https://arxiv.org/abs/2609.34060`
   - **날짜:** 2026-09-28 (제3자 측정)
   - **핵심 주장:** 다중 에이전트나 동적 라우팅 환경에서 문맥과 프롬프트가 바뀔 때마다 `KV cache`를 다시 채우는 프리필(`Prefill`) 오버헤드가 심각한 병목임을 실측하고, 저랭크 상태 보정으로 이를 완화했습니다.
   - **수치:** 캐시 미공유 기준선 대비 첫 토큰 지연(`TTFT`) `2.0배` 단축, 피크 GPU 메모리(`VRAM`) 최대 `3.7배` 절감.

3. [Not Diamond & GMI Cloud Cache-Aware Routing Analyses](https://docs.notdiamond.ai)
   - **URL:** `https://docs.notdiamond.ai`
   - **날짜:** 2026년 기준 (벤더 자체 측정)
   - **핵심 주장:** 작업 단위 동적 분류기가 수만 토큰이 쌓인 에이전트 세션 중간에 모델을 더 싼 모델로 바꾸면, 캐시 할인(보통 `75%~95%` 할인)을 잃고 전체 문맥을 정가로 다시 프리필하게 되어 오히려 요청당 유효 비용(`Effective Cost`)이 비싸지는 실패 사례가 나타납니다.
   - **수치:** `유효 비용 = (캐시 적중률 × 캐시 입력 단가) + ((1 - 적중률) × 일반 입력 단가) + 출력 단가` 공식으로 캐시 미스 손실 입증.

4. [RouterWorld: Scaling Conversational AI with Latency-Aware LLM Routing](https://arxiv.org/abs/2610.26511)
   - **URL:** `https://arxiv.org/abs/2610.26511`
   - **날짜:** 2026-10-18 (제3자 측정)
   - **핵심 주장:** 단일 턴 프롬프트 텍스트만 보고 난이도를 판정하는 사전 분류기는 다중 턴 에이전트 작업에서 직전 도구 실행 실패나 깊은 스택 트레이스 문맥을 읽지 못해(`Multi-Turn Blindness`) 잘못된 모델을 고릅니다.
   - **수치:** 다중 턴 에이전트 궤적 `76,000건`에서 정적 로그 학습 분류기와 연속 스트림 환경 간 성능 괴리 확인.

5. [OpenHands RouterLLM & MultimodalRouter](https://arxiv.org/abs/2407.16741)
   - **URL:** `https://arxiv.org/abs/2407.16741`
   - **날짜:** 2025~2026년 SDK v1+ 기준 (벤더 자체 측정)
   - **핵심 주장:** 복잡한 ML 분류기 대신 이미지 포함 여부(`MultimodalRouter`), 컨텍스트 길이, 이전 턴 오류 코드 같은 결정론적 상태 규칙으로 모델을 고르는 방식이 실무 코딩 에이전트에서 더 안정적으로 동작합니다.
   - **수치:** `LiteLLM` 연동 `100개` 이상 공급자 대상 규칙 기반 라우팅 기본 탑재.

### 반대 사례와 반론
- 역할 기반 고정 배정은 `Implementer`가 한 줄짜리 import 추가를 할 때도 비싼 모델을 쓰고, 반대로 `Verifier`에 고정된 작은 모델이 복잡한 에지 케이스를 만나 무한 재시도 루프에 빠지는 비효율을 낳습니다.
- 반면 작업 단위 외부 분류기 라우터는 분류기 자체의 추론 지연, 트래픽 분포 변화에 따른 분류기 드리프트, 그리고 이기종 모델 전환 시 `KV cache` 소멸이라는 치명적 단점이 있습니다.

### 결론
- 2026년 실무에서는 턴마다 다른 벤더 모델로 갈아타는 동적 라우팅이 `KV cache` 손실 때문에 실패하는 사례가 많아, 역할별(격리된 서브에이전트 단위)로 모델을 나누되 같은 세션 안에서는 동일 모델의 추론 강도(`low`/`medium`/`high`/`xhigh`)만 작업 난이도에 맞춰 조절하는 방식이 주류로 정착했습니다.

## 9. 역할군 분류 자체의 재평가와 세분화 오버헤드

### 상위 5개 검색 결과

1. [Rethinking Multi-Agent Collaboration: When More Is Less (SAIGE)](https://arxiv.org/abs/2609.19759)
   - **URL:** `https://arxiv.org/abs/2609.19759`
   - **날짜:** 2026-09 (제3자 측정)
   - **핵심 주장:** 에이전트 역할을 너무 잘게 쪼개면 단계 간 의존성이 강한 코딩 작업에서 맥락이 끊기고 조율 오버헤드가 커져 단일 에이전트(`Claude Code`, `Codex CLI` 단독 실행)보다 성능이 떨어집니다. 멀티 에이전트 분리는 의존성이 희소하고 호흡이 긴 작업에서만 이득이 있습니다.
   - **수치:** 저장소 수준 코드 생성(`NL2Repo Bench` 등)에서 밀결합 순차 작업은 단일 에이전트가 고정 다중 역할 MAS보다 높은 통과율과 낮은 토큰 비용 기록.

2. [Why Do Multi-Agent LLM Systems Fail? (MAST)](https://arxiv.org/abs/2503.13657)
   - **URL:** `https://arxiv.org/abs/2503.13657`
   - **날짜:** 2025-10 v3 개정 (제3자 측정)
   - **핵심 주장:** 멀티 에이전트 시스템의 실패 원인을 분석한 결과, 역할 정의 불명확, 에이전트 간 대화 비효율, 검증 및 종료 실패 등 조율 과정에서 발생하는 실패가 전체의 큰 비중을 차지합니다.
   - **수치:** 7개 주요 멀티 에이전트 프레임워크의 실행 궤적 `1,600건` 이상을 분석해 실패 유형 `14가지`(주석자 간 일치도 `κ = 0.88`) 도출.

3. [Agentic AI in the Software Development Lifecycle: Architecture, Empirical Evidence, and the Reshaping of Software Engineering](https://arxiv.org/abs/2604.26275)
   - **URL:** `https://arxiv.org/abs/2604.26275`
   - **날짜:** 2026-04 (제3자 측정)
   - **핵심 주장:** 실무 코딩 하네스의 역할군은 읽기 전용 `Explorer`, 설계 `Planner`(`Architect`), 실행 `Implementer`(`Worker`), 검증 `Reviewer`(`Tester`/`Security`)의 4대 핵심 축으로 수렴하고 있습니다.
   - **수치:** SDLC 전 단계 에이전트 아키텍처 실증 비교.

4. [AgentMesh: A Cooperative Multi-Agent Generative AI Framework for Software Development Automation](https://arxiv.org/abs/2507.19902)
   - **URL:** `https://arxiv.org/abs/2507.19902`
   - **날짜:** 2025-07 (제3자 측정)
   - **핵심 주장:** `Planner`, `Coder`, `Debugger`, `Reviewer` 역할을 나눌 때 에이전트 사이의 핸드오프는 자유 대화 대신 엄격한 아티팩트 계약(명세서, 패치, 테스트 결과)으로 전달해야 문맥 오염을 막을 수 있습니다.
   - **수치:** 구조화된 역할 파이프라인으로 복합 소프트웨어 개발 자동화 검증.

5. [Harness Engineering: Anatomy, Architecture, and Evolution of Coding Agents](https://arxiv.org/abs/2609.00006)
   - **URL:** `https://arxiv.org/abs/2609.00006`
   - **날짜:** 2026-09 (제3자 측정)
   - **핵심 주장:** 프로덕션 코딩 도구들은 `writer`, `designer`, `debugger`, `tester`, `implementer`를 모두 별도 모델로 고정하기보다, 도구 권한(읽기 전용 대 쓰기/실행 허용)과 문맥 격리 필요성에 따라 3~4개 기본 워커 타입으로 통합해 운영합니다.
   - **수치:** 상용 및 오픈소스 하네스 `11종`의 에이전트 역할 구조 비교.

### 반대 사례와 반론
- 대규모 레거시 마이그레이션이나 보안 감사처럼 수십 개 모듈을 동시에 고쳐야 할 때는 단일 에이전트 컨텍스트가 금방 오염되므로, 파일 단위로 격리된 다수의 `Worker`와 독립 `Security`/`Reviewer` 에이전트를 띄우는 편이 성공률이 높습니다.

### 결론
- `planner`와 `architect`, `implementer`와 `debugger`/`tester`는 실행 루프가 긴밀하게 맞물려 있어 너무 잘게 나누면 토큰 비용이 `2~4배` 늘고 맥락 손실이 발생합니다.
- 실제로 다른 모델을 배정할 만큼 차이가 나는 역할 단위는 읽기 전용 고속 탐색(`Explorer`), 고추론 설계(`Planner`/`Architect`), 쓰기 권한 실행(`Implementer`/`Debugger`/`Tester`), 교차 벤더 검증(`Reviewer`/`Security`), 그리고 문맥 압축/소통(`Compactor`/`Communicator`)의 5가지입니다. 프런트엔드 시각 설계가 필요할 때만 `Designer` 역할을 별도로 분리합니다.

## 10. 모델 가족별 성능 이점 재평가(OpenAI, Anthropic, Google)

### 상위 5개 검색 결과

1. [Artificial Analysis Intelligence Index, Latency & Pricing Leaderboards](https://artificialanalysis.ai)
   - **URL:** `https://artificialanalysis.ai`
   - **날짜:** 2026-11 기준 (제3자 측정)
   - **핵심 주장:** `OpenAI GPT-6`(`Astra`, `Sol`, `Terra`, `Luna`), `Anthropic Claude 5.5`(`Opus`, `Sonnet`, `Haiku`, `Fable`), `Google Gemini 4`(`Carbon`, `Argon`, `Hydrogen`)의 정확도, 첫 토큰 지연(`TTFT`), 초당 출력 토큰(`TPS`), 가격을 독립 측정했습니다.
   - **수치:**
     - `GPT-6 Astra`: 입력 `$10~$14.04`/1M, 출력 `$50~$70.20`/1M, `TTFT` `100~173초`(고추론), 속도 `58~64 TPS`.
     - `GPT-6.1 Sol`: 입력 `$2~$2.81`/1M, 출력 `$10~$14.04`/1M, `TTFT` `1.74초`(Low effort), 속도 `133 TPS`.
     - `GPT-6.1 Terra`: 입력 `$1.42`/1M, 출력 `$7.11`/1M.
     - `GPT-6 Luna`: 입력 `$0.10~$0.14`/1M, 출력 `$0.50~$0.70`/1M, `TTFT` `0.81~1.11초`, 속도 `109~154 TPS`.
     - `Gemini 4 Intelligence Index`: `Carbon (High)` `60점`, `Hydrogen (Xhigh)` `54점`, `Hydrogen (High)` `51점`, `Argon` `50점`, `Hydrogen (Low)` `27점`, `Gemini 3.8 Flash` `31점`.

2. [Anthropic Claude 5.5 & Fable Pricing and Performance Documentation](https://claude.com)
   - **URL:** `https://claude.com`
   - **날짜:** 2026-09 출시 및 2026-11 기준 (벤더 자체 측정 및 Toloka/BenchLM 제3자 측정)
   - **핵심 주장:** `Claude Opus 5.5`는 상시 작동하는 적응형 사고(`Adaptive Thinking`)를 탑재해 `SWE-bench Pro`와 `Toloka Arena` 1위를 기록하면서 이전 `Fable 5.1`보다 저렴합니다. `Sonnet 5.5`는 주력 코딩 모델이고, `Haiku 5.5`는 초고속 경량 모델이며, `Fable 5.1/5.2`는 수 시간 이상 걸리는 초장기 과제용입니다.
   - **수치:**
     - `Claude Fable 5.1`: 입력 `$10`/1M, 출력 `$50`/1M, `FrontierSWE v1` `88.2%`, `v2`(`Fable 5.2`) `69.9%`.
     - `Claude Opus 5.5`: 입력 `$4`/1M, 출력 `$20`/1M(캐시 읽기 `$0.20`/1M), `SWE-bench Pro` `89.9%`, `Toloka pass^5` `77.3%`.
     - `Claude Sonnet 5.5`: 입력 `$2`/1M, 출력 `$10`/1M, 속도 약 `127.5 TPS`, `SWE-bench Pro` `81.3%`.
     - `Claude Haiku 5.5`: 입력 `$0.10`/1M, 출력 `$0.50`/1M, 속도 최대 `237 TPS`.
     - 전 모델 `1,000,000` 토큰 컨텍스트 및 최대 `128,000` 출력 토큰 지원.

3. [Google Gemini 4 Lineup (Hydrogen, Argon, Carbon) Documentation & Pricing](https://blog.google)
   - **URL:** `https://blog.google`
   - **날짜:** 2026-11 기준 (벤더 자체 측정)
   - **핵심 주장:** `Gemini 4`는 입력, 파일, 사고 토큰, 출력을 하나의 `1,048,576` 토큰 풀로 통합했습니다. `Hydrogen`은 `Flash`를 대체하는 고속 일일 주력 모델이고, `Argon`은 장기 워크플로 추론 모델이며, `Carbon`은 가설 검증과 심층 보안/아키텍처용 최상위 모델입니다.
   - **수치:**
     - `Gemini 4 Hydrogen`: 입력 `$1.50`/1M, 출력 `$7.50`/1M.
     - `Gemini 4 Argon`: 입력 `$2.00`/1M(2026년 11월 프로모션, 12월부터 `$4.00`/1M), 출력 `$10.00`/1M(12월부터 `$20.00`/1M).
     - `Gemini 4 Carbon`: 입력 `$2.00`/1M(12월부터 `$4.00`/1M), 출력 `$10.00`/1M(12월부터 `$20.00`/1M), `SEC-bench Pro` `88.2%`, `FrontierSWE v2` `61.2%`.
     - `Gemini 3.8 Flash`: 입력 `$0.75`/1M, 출력 `$3.75`/1M(2027년 1월부터 `$1.50`/`$7.50` 인상 예정). `Gemini 3.5 Flash-Lite`: 입력 `$0.30`/1M, 출력 `$2.50`/1M.

4. [FrontierSWE & Terminal-Bench Cross-Family Benchmarks](https://frontierswe.com)
   - **URL:** `https://frontierswe.com`
   - **날짜:** 2026-10 기준 (제3자 측정)
   - **핵심 주장:** 장기 구현 과제와 터미널 에이전트 과제에서 3대 벤더 모델의 강점 영역이 뚜렷하게 구분됩니다.
   - **수치:** `Terminal-Bench 4.0`에서 `Claude Opus 5.5` `64.8%`, `Claude Sonnet 5.5` `61.8%`, `GPT-6.1 Sol` `58.2%~59.6%`.

5. [SlopCodeBench & Hallucination/Structural Erosion Analysis](https://arxiv.org/abs/2603.24755)
   - **URL:** `https://arxiv.org/abs/2603.24755`
   - **날짜:** 2026-03-25 (제3자 측정)
   - **핵심 주장:** 반복적인 장기 수정 작업에서는 모든 프런티어 모델에서 코드 복잡도 집중과 불필요한 중복 코드가 누적되며, 추론 강도를 무조건 높인다고 해결되지 않습니다.
   - **수치:** 장기 반복 과제의 체크포인트 해결률 최고치 `14.8%~17.2%`.

### 반대 사례와 반론
- `GPT-6 Astra`나 `Claude Fable 5.1`은 최고 성능을 내지만 입력 `$10`/출력 `$50` 이상으로 중급 모델보다 `5배` 비싸고, `Astra`의 고추론 모드는 첫 토큰 지연이 `100초`를 넘겨 대화형 코딩에는 부적합합니다.
- `Gemini 4 Hydrogen (High/Xhigh)`은 지능 지수(`51~54점`)에서 상위 티어인 `Argon`(`50점`)을 앞지르면서도 가격은 절반 이하라, 무조건 상위 티어 모델을 고르는 것이 능사가 아님을 보여줍니다.

### 결론
- **OpenAI (`Luna`, `Terra`, `Sol`, `Astra`):** `Astra`는 초장기 추론과 보안/인프라에서 최상위권이나 지연(`100~173초`)과 비용(`$10/$50`)이 크고, `Sol`은 빠른 코딩/터미널 주력(`$2/$10`), `Terra`는 가성비 중간 티어(`$1.42/$7.11`), `Luna`는 초저지연 탐색/분류용(`$0.10/$0.50`, `TTFT` `0.81초`)입니다.
- **Anthropic (`Haiku`, `Sonnet`, `Opus`, `Fable`):** `Opus 5.5`(`$4/$20`)는 다중 파일 구현(`SWE-bench Pro` `89.9%`)과 오케스트레이션 최강자이고, `Sonnet 5.5`(`$2/$10`, `127.5 TPS`)는 구현 가성비 주력, `Haiku 5.5`(`$0.10/$0.50`, `237 TPS`)는 초고속 탐색용, `Fable 5.1/5.2`(`$10/$50`)는 수 시간 단위 연구/아키텍처용입니다.
- **Google (`Gemini 4 Hydrogen`, `Argon`, `Carbon`, `Flash`):** `Carbon`은 보안 감사(`SEC-bench Pro` `88.2%`), 웹앱, 심층 추론에 강하고, `Argon`은 장문 문맥 및 엔터프라이즈 에이전트용이며, `Hydrogen`(`$1.50/$7.50`)은 추론 단계 조절(`low`~`xhigh`)로 속도와 지능을 겸비한 주력 모델입니다.
- 모든 모델을 동일 조건에서 비교한 단일 "작업당 평균 토큰 소모량" 절대 표준 수치는 벤치마크와 추론 설정(`low`~`max`)에 따라 달라져 단일 통합 표로는 `자료 없음`입니다(단, `Ares` 연구에서 적응형 추론 조절 시 고정 고추론 대비 작업당 토큰 `50%` 이상 절감 확인).

## 11. 오케스트레이터/리드 역할과 소통 역할의 모델 배정 및 다중 계층 비용 구조

### 상위 5개 검색 결과

1. [Decentralized Multi-Agent Systems with Shared Context (DeLM)](https://arxiv.org/abs/2606.10662)
   - **URL:** `https://arxiv.org/abs/2606.10662`
   - **날짜:** 2026-10 개정 (제3자 측정)
   - **핵심 주장:** 중앙 리드 에이전트가 모든 워커의 긴 로그를 직접 받아 조율하면 문맥 부패(`Context Rot`)와 병목이 생기고, 반대로 피어투피어(`P2P`)로 에이전트끼리 직접 메시지를 주고받으면 통신량이 제곱(`n(n-1)`)으로 늘어나 비용이 폭증합니다. 공유 작업 큐와 압축된 검증 문맥만 주고받아야 비용과 문맥 부패를 막을 수 있습니다.
   - **수치:** 단순 다중 에이전트 확장은 단일 에이전트 대비 비용을 `2배~4배` 늘리면서 문맥 부패로 성능을 떨어뜨림. 서브워커 활성 문맥을 `5,000~10,000` 토큰 미만으로 유지할 때 최적 효율 달성.

2. [AgentIF-OneDay: A Task-level Instruction-Following Benchmark for General AI Agents in Daily Scenarios](https://arxiv.org/abs/2601.20613)
   - **URL:** `https://arxiv.org/abs/2601.20613`
   - **날짜:** 2026-01-30 v2 (제3자 측정)
   - **핵심 주장:** 하루 이상 이어지는 장기 세션과 다단계 작업에서는 하위 워커로 지시가 전달될수록 초기 제약 조건이 변질되거나 누락됩니다. 리드 에이전트와 최종 감사 계층에는 지시 준수율과 장문 맥락 유지력이 검증된 상위 모델을 두어야 합니다.
   - **수치:** 장기 일상 및 업무 시나리오에서 텍스트 응답과 생성 파일의 지시 준수율을 이진 루브릭과 감점 체계로 측정.

3. [Selective and Hybrid-State Communication for Latent Multi-Agent Systems (SelectKV / HyLaMAS)](https://arxiv.org/abs/2610.37779)
   - **URL:** `https://arxiv.org/abs/2610.37779`
   - **날짜:** 2026-10, NeurIPS 2026 Workshop (제3자 측정)
   - **핵심 주장:** 다중 계층 오케스트레이션에서 에이전트 간 보고와 상태 전달을 장황한 자연어 대화로 처리하면 출력 토큰 비용과 지연이 급증합니다. 선택적 상태 전달과 요약 계층을 두어 디코딩 토큰 수를 크게 줄였습니다.
   - **수치:** 다중 에이전트 협업 계획 과제에서 자연어 전체 전달 대비 디코딩 토큰 수 대폭 절감.

4. [Why Do Multi-Agent LLM Systems Fail? (MAST)](https://arxiv.org/abs/2503.13657)
   - **URL:** `https://arxiv.org/abs/2503.13657`
   - **날짜:** 2025-10 v3 (제3자 측정)
   - **핵심 주장:** 리드 에이전트가 워커의 완료 여부를 잘못 판정하거나 워커끼리 불필요한 대화 루프에 빠지는 현상이 대표적 실패 원인입니다. 소통과 라우팅은 구조화된 상태 전이로 제한하고, 작업 분해와 최종 검증만 고성능 리드 모델이 맡아야 합니다.
   - **수치:** `1,600개` 이상 실행 궤적에서 에이전트 간 정렬 실패 및 종료 판정 실패 비중 규명.

5. [Multi-Agent Heterogeneous Model Selection Hierarchy Guides](https://cloud.google.com)
   - **URL:** `https://cloud.google.com`
   - **날짜:** 2025~2026년 엔터프라이즈 아키텍처 가이드 (벤더 자체 측정 및 산업 사례)
   - **핵심 주장:** 3계층 모델 배정 구조가 산업 표준입니다. 1계층 리드 오케스트레이터(작업 분해, 충돌 해결, 최종 통합)에는 프런티어 모델(`Claude Opus 5.5`, `GPT-6 Sol/Astra`, `Gemini 4 Argon/Carbon`)을 쓰고, 2계층 도메인 워커에는 중급 모델을 쓰며, 3계층 소통 및 알림 워커(진행 요약, 채팅 보고, 포맷 변환, 질문 중계)에는 초저지연 경량 모델(`Claude Haiku 5.5`, `GPT-6 Luna`, `Gemini 4 Hydrogen Low`)을 배정합니다.
   - **수치:** 1계층 프런티어 모델과 3계층 소통용 경량 모델 간 토큰당 단가 격차 `50배~200배`(`$0.10`/1M 대 `$10~$20`/1M), 소통 워커 응답 지연 `200ms~1초` 미만 유지.

### 반대 사례와 반론
- **리드에 저렴한 모델을 두어야 한다는 반론:** 작업 분해가 이미 정형화된 템플릿이나 결정론적 상태 머신(`LangGraph` 고정 노드 등)으로 짜여 있다면, 리드에 비싼 프런티어 모델을 두는 것은 "관리자 세금(`Manager Tax`)"만 늘리는 낭비입니다. 이 경우 리드 라우터는 `1.7B~8B` 경량 모델이나 코드로 처리하고 실제 구현 워커에만 강한 모델을 둡니다.
- **소통 워커에 너무 작은 모델을 둘 때의 실패:** 사용자나 팀 채팅에 보고하는 소통 워커에 초소형 모델을 아무 제약 없이 두면 프로젝트 고유 용어를 틀리거나 어색한 번역투 문체를 생성해 신뢰를 떨어뜨립니다.

### 결론
- 불확실한 요구사항을 분해하고 워커 결과를 통합하는 리드에는 지시 준수력과 추론력이 높은 모델(`Opus 5.5`, `GPT-6 Sol`, `Gemini 4 Argon`)을 두되, 워커의 날것 로그 대신 압축된 요약만 받게 해 관리자 토큰 비용을 통제합니다.
- 단순 상태 중계와 알림은 `1초` 미만의 경량 모델(`Haiku 5.5`, `Luna`, `Hydrogen Low`)에 맡기고, 사용자 대면 최종 보고서는 문체 규칙을 잘 지키는 중상위 모델이나 엄격한 문체 검사기(`Linter`)를 결합해 품질을 확보합니다.
- 리드 위의 리드가 있거나 여러 세션이 피어 메시지를 주고받는 다중 오케스트레이션에서는 전체 대화록 전달을 금지하고, 비동기 작업 큐와 `5,000~10,000` 토큰 이내의 압축 아티팩트만 교환해야 `O(N^2)` 비용 폭발과 문맥 부패를 막을 수 있습니다.

--- HANDOFF ---
status: ok
lead_action: accept
verdict: 2025년 하반기부터 2026년 11월까지의 최신 논문과 벤치마크 및 공식 문서를 Google Search로 검색하여 11개 하위 질의별 상위 5개 결과, 수치, 측정 주체, 반론, 결론을 모두 구조화해 정리했습니다.
files_changed: none
confidence: high
