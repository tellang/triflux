# 범용 에이전트 프레임워크, LLM 게이트웨이, 트렌딩 하네스의 모델 배정과 폴백 (확장 조사)

기준일 2026-11-17. 기존 보고서 `github-orchestrators.md`(코딩 오케스트레이터와 하네스 16개)에 이어, 범위를 넓혀 추가로 조사한 결과다. 수치와 기본값은 `gh api`로 저장소 파일과 커밋 날짜를 직접 열어 확인했다. 못 열었거나 확인 범위 밖이면 "원문 미확인"으로 적었다. 별 수와 마지막 push는 2026-11-17 조회값이다.

## 목적

세 가지를 추가로 본다.
- 범용 에이전트 프레임워크 중 에이전트마다 모델을 지정하는 설정이 있는 것
- LLM 게이트웨이와 라우터의 폴백, 우선순위, 쿨다운 설정
- 최근 한 달 GitHub 트렌드에서 기존 16개에 없던 관련 저장소

특히 "사용량이나 쿼터 수치를 읽어 모델을 바꾸는 장치"가 게이트웨이 쪽에 있는지 집중해서 확인했다. 기존 보고서의 관찰 4번("사용량 수치를 읽어 바꾸는 장치 없음")은 이 확장 조사로 정정한다. 아래 "기존 관찰 4번 정정"에 있다.

## 방법

- 후보는 두 경로로 모았다. 알려진 프레임워크와 게이트웨이는 `gh api repos/OWNER/REPO`로 직접 조회했고, 트렌딩은 `https://github.com/trending`(일간, 주간, 월간)과 python, typescript, go, rust 월간 페이지를 curl로 받아 저장소 이름 132개를 추렸다.
- 서브에이전트 4개가 묶음별로 파일을 읽고 섹션을 썼다. 사용량 기반 전환을 주장한 핵심 항목(t3code, OmniRoute, open-swe 일일 토큰 상한)은 제가 다시 파일을 열어 확인했다. 리드가 지목한 세 저장소(Hydra, agent-orchestrator, harnessctl)는 처음부터 직접 읽었다.
- 판정 기준: 최근 3개월 안에 push가 있고 역할별 모델이나 폴백 설정이 실제 파일로 있는 것. 기준을 넘는 정지 저장소(MetaGPT, RouteLLM, Portkey, Hydra, harnessctl, Not Diamond)는 낡았다고 표시하고 간단히만 다뤘다.

## 대상

### 프레임워크와 SDK (15개)

| 저장소 | 별 | 마지막 push | 비고 |
|---|---|---|---|
| langchain-ai/open-swe | 11,227 | 11-17 | 라우터, 벤더 간 폴백, 토큰 예산이 모두 코드에 있는 유일한 프레임워크 |
| crewAIInc/crewAI | 61,002 | 11-16 | |
| huggingface/smolagents | 30,400 | 11-15 | |
| microsoft/autogen | 61,877 | 11-12 | README가 유지보수 종료를 밝히나 API의 archived 값은 false |
| ag2ai/ag2 | 5,073 | 11-16 | |
| langchain-ai/langgraph | 45,044 | 11-16 | |
| OpenBMB/ChatDev | 34,762 | 11-06 | |
| FoundationAgents/MetaGPT | 71,316 | 2026-01-21 | 낡음 |
| openai/openai-agents-python | 30,727 | 11-17 | |
| pydantic/pydantic-ai | 21,248 | 11-17 | |
| mastra-ai/mastra | 29,556 | 11-17 | |
| google/adk-python | 22,245 | 11-17 | |
| TauricResearch/TradingAgents | 122,872 | 11-17 | 역할별 LLM 분리 사례 |
| The-PR-Agent/pr-agent | 16,305 | 11-16 | `fallback_models` 키 |
| langroid/langroid | 4,152 | 11-14 | |

### 게이트웨이와 라우터 (14개)

| 저장소 | 별 | 마지막 push | 비고 |
|---|---|---|---|
| BerriAI/litellm | 63,373 | 11-17 | |
| musistudio/claude-code-router | 38,192 | 11-16 | |
| router-for-me/CLIProxyAPI | 58,756 | 11-17 | |
| cheaper-inference/OmniRoute | 88,149 | 11-17 | 옛 이름 `diegosouzapw/OmniRoute`, 리다이렉트 확인 |
| maximhq/bifrost | 9,642 | 11-17 | |
| katanemo/plano | 7,119 | 10-24 | |
| vllm-project/semantic-router | 6,489 | 11-17 | |
| agentgateway/agentgateway | 6,233 | 11-16 | |
| tashfeenahmed/freellmapi | 53,577 | 11-16 | |
| Mesh-LLM/mesh-llm | 4,140 | 11-17 | |
| QuantumNous/new-api | 52,038 | 11-16 | |
| Wei-Shaw/claude-relay-service | 12,812 | 11-16 | |
| lm-sys/RouteLLM | 5,712 | 2024-08-10 | 낡음 |
| Portkey-AI/gateway | 13,391 | 2026-05-25 | 3개월 이상 정지 |

Not Diamond 조직은 최근 3개월 안 push가 있는 저장소가 `not-diamond-python`(별 3) 하나뿐이라 간단히 다뤘다.

### 트렌딩에서 추가한 코딩 하네스 계열 (17개)

QwenLM/qwen-code, pingdotgg/t3code, multica-ai/multica, stablyai/orca, max-sixty/worktrunk(해당 없음), kagent-dev/kagent(해당 없음), block/buzz, davila7/claude-code-templates, luongnv89/claude-howto, anthropics/claude-quickstarts, alibaba/open-code-review, openai/codex-security, garrytan/gbrain, lobehub/lobehub, JetBrains/thinkrail, superplanehq/superplane, CopilotKit/OpenBot(해당 없음). 트렌딩에서 제외한 것: plannotator(계획 리뷰 UI), claude-mem(메모리), AstrBot(챗봇), agent-beacon(메모리 계층), mesh-llm 외의 분산 추론류.

### 사용량 기반 전환을 주장한다고 지목된 세 저장소

| 저장소 | 별 | 마지막 push | 비고 |
|---|---|---|---|
| mikecubed/Hydra | 4 | 2026-03-30 | 3개월 기준 밖(약 7.5개월 정지), 코드에 구현 있음 |
| willynikes2/agent-orchestrator | 67 | 2026-10-14 | 단일 파일 도구 |
| mnvsk97/harnessctl | 8 | 2026-05-14 | 3개월 기준 밖(약 6개월 정지) |

## 저장소별 조사

### langchain-ai/open-swe
- 별 11227, 마지막 push 2026-11-17
- 근거 파일(커밋 날짜): `openswe/dashboard/workspace_settings.py`(2026-11-12 이후 파일 기준, 기본값 줄 확인), `openswe/model_routing.py`(2026-11-13), `openswe/middleware/model_selection.py`(2026-11-12), `mda/rt/routing.py`(2026-11-12), `mda/rt/model_retries.py`(2026-11-02), `packages/runtime-api/src/runtime_api/catalog.py`(2026-11-16), `packages/runtime-api/src/runtime_api/models.py`, `openswe/config.py`(2026-11-16), `docs/INSTALLATION.md`
- 선택 이유: 이 묶음에서 유일하게 역할별 기본 모델, 작업 단위 라우터, 벤더 간 폴백, 토큰 예산이 모두 코드에 있는 저장소다.

**역할과 모델**: `workspace_settings.py`의 기본값 딕셔너리에서 직접 확인한 값이다.

| 역할 | 기본 모델 | effort |
|---|---|---|
| 메인 에이전트, 서브에이전트, 리뷰어, 리뷰어 서브에이전트 | `fallback_model`, `fallback_effort` 변수(환경 기본값에서 오는 값) | 같은 변수 |
| 라우팅 fast | `openai:gpt-6.1-sol` | medium |
| 라우팅 balanced | `openai:gpt-6.1-sol` | medium |
| 라우팅 performance | `anthropic:claude-opus-5-5` | high |
| 스레드 제목 | `openai:gpt-6-luna`(`DEFAULT_THREAD_TITLE_MODEL`) | 별도 상수 |
| 리뷰 스카우트 폴백 | `openai:gpt-6.1-sol` | medium(`REVIEW_SCOUT_FALLBACK_MODEL`) |

- 배포 기본 모델은 `docs/INSTALLATION.md`가 "`openai:gpt-6.1-sol`, medium"이라고 적는다. `LLM_MODEL_ID`와 `LLM_REASONING_EFFORT`로 바꾼다. 허용 effort는 low, medium, high, max이다.
- 지원 모델 레지스트리(`runtime_api/models.py`)에는 `anthropic:claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-fable-5-1`, `openai:gpt-6-astra`, `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-luna`, `google_genai:gemini-4-carbon`, `gemini-3.8-flash`, fireworks의 kimi 두 개가 있다.
- 설정 우선순위는 스레드 요청, 프로필(메인 쌍과 서브에이전트 쌍), 워크스페이스/팀 기본값, 배포 기본값 순이다(`openwiki/concepts/models-profiles-instructions.md`, 생성일 2026-09-08이라 코드보다 오래됐다).
- 사용자가 스레드에서 "performance 모델로 바꿔 달라"고 요청하면 그 스레드만 바뀐다(`INSTALLATION.md`).

**폴백 / 쿼터**:
- 코드 기준 현재 `main`은 벤더 간 폴백을 가진다. `fallback_model_id_for`는 anthropic 기본 모델이면 `openai:gpt-6.1-sol`, openai 기본 모델이면 `anthropic:claude-opus-5-5`를 반환하고, google 등 그 밖의 provider는 None이다(주석: 조용히 외부 호스트로 보내고 싶지 않은 provider). `LLM_FALLBACK_MODEL_ID`로 배포자가 지정할 수 있다.
- `ModelSpec.fallback` 주석은 "다른 provider의 모델을, 호출이 일시적으로 실패하는 동안 번갈아 쓴다"이다. 모델 전환은 일시 실패 때만이고, 모델 재시도와는 층이 다르다.
- 재시도(`mda/rt/model_retries.py`): 최대 5회, 대기 상한 60초, 상태코드 408, 409, 429와 5xx를 일시 오류로 본다. `Retry-After` 헤더를 읽고, 이미 스트리밍된 출력이 있으면 그 시도를 취소 표시(`open_swe_superseded`)한다.
- 쿼터: 구성원의 자동화 스레드는 UTC 하루 토큰 예산 `AUTOMATION_DAILY_TOKENS = 30_000_000`(캐시 입력 포함, best-effort)에 도달하면 멈추고, 그 스레드는 모델을 고정(`pinned_model`)해 폴백도 끈다. 게이트웨이 호출에는 `X-Gateway-Service` 헤더가 붙어 지출 한도와 rate limit을 서비스 단위로 건다고 주석에 적혀 있다(게이트웨이 쪽 설정은 원문 미확인).
- 열린 PR의 설계 이견: PR #5096(2026-11-05, 미머지)은 1차 호출에 첫 토큰 120초 데드라인을 따로 두어 폴백까지 600초 기다리던 것을 줄이고, 전체 예산은 900초로 묶는다. PR #4449(2026-10-23 열고 11-14 미머지로 닫음)는 반대로 "자동 폴백을 없애고 같은 모델이 회복하길 기다린 뒤 공급자 이름을 담아 실패시키며 사람이 모델을 바꾸게 한다"는 안이었다. 즉 현재 코드는 자동 폴백 쪽이고, 반대 설계가 제안됐다가 채택되지 않았다.

**라우터 / 리드 / 소통**:
- 작업 단위 라우터가 있다. 첫 요청을 `TaskRoute.classify`(Jev 분류기)가 fast, balanced, performance 중 하나로 분류하고, 불확실하면 그 실행 한 번만 `default`를 쓰고 다음 턴에 다시 분류한다(`persist=False`). 사용자가 모델을 명시하면 분류를 건너뛴다. `model_selection_enabled`의 기본값은 False이다.
- 경로 선택 대신 A/B 실험도 있다. `RoutingArm`은 스레드 id의 sha256으로 50%를 performance, 나머지를 balanced에 배정한다. 사람이 시작하지 않은 실행(schedule, api, 봇)은 실험 대상에서 뺀다.
- 서브에이전트 모델은 메인과 별도 키(`default_agent_subagent_model`)로 설정한다. 조율 전용 리드 역할은 이번에 읽은 파일에서는 원문 미확인이다(`catalog.py` 주석에 "coordinator's first worker"가 언급된다).

**이슈 사례**: 이 저장소는 모델 배정 불만 이슈보다 PR로 논의가 진행됐다.
- PR #4449, 2026-10-23, 반응 +1: 자동 폴백 제거와 "복구 대기 후 명시 실패" 제안(미머지).
- PR #5096, 2026-11-05: 폴백 전환 지연(600초)을 줄이는 수정(열림).
- PR #5113, 2026-11-10: 스트리밍된 OpenAI 서버 오류를 폴백으로 재시도(미머지).

### crewAIInc/crewAI
- 별 61002, 마지막 push 2026-11-16
- 근거 파일(커밋 날짜): `lib/crewai/src/crewai/constants.py`(2026-11-08), `lib/crewai/src/crewai/utilities/llm_utils.py`(2026-09-30), `lib/crewai/src/crewai/llms/retry.py`(2026-09-25), `lib/crewai/src/crewai/agent/core.py`(2026-11-16), `lib/crewai/src/crewai/crew.py`(2026-11-08), `lib/cli/src/crewai_cli/templates/agent_config/agent.yaml`(2026-11-08), `docs/edge/en/concepts/llms.mdx`(2026-11-05), `docs/edge/en/concepts/agents.mdx`
- 선택 이유: 에이전트와 크루 단위로 LLM 슬롯이 가장 많이 나뉜 프레임워크이고, 폴백이 없는 대신 rate limit 재시도와 RPM 제한이 있다.

**역할과 모델**:
- 전역 기본 모델은 `DEFAULT_LLM_MODEL = "gpt-6-luna"`이다. `llm_utils.py`는 환경변수 `MODEL`, `MODEL_NAME`, `OPENAI_MODEL_NAME` 순으로 읽고 없으면 이 상수를 쓴다.
- 에이전트 템플릿 `agent_config/agent.yaml`에는 `llm: {model: openai/gpt-6-luna, api: responses}`가 들어 있다. 크루 템플릿 `crew/config/agents.yaml`의 researcher, reporting_analyst에는 llm 키가 없어 위 기본값을 따른다.
- 역할별 모델 슬롯: 에이전트 `llm`, `function_calling_llm`(문서와 코드에서 deprecated 표시), 크루 `manager_llm`(hierarchical 프로세스에서 `manager_llm`이나 `manager_agent`가 없으면 검증 오류), `planning_llm`, `chat_llm`. 에이전트 필드 문서가 `llm`을 YAML에서도 지정할 수 있다고 적는다.
- `planning=True`만 켜면 `PlanningConfig(reasoning_effort="low", max_attempts=1)`이 기본이다(`agent/core.py`).

**폴백 / 쿼터**:
- 모델 폴백: 원문 미확인이 아니라 확인된 부재다. 파일 목록에서 `fallback`이 이름에 든 설정이나 모듈을 찾지 못했고, 이슈 #3032("Support Fallback LLMs for Agent Execution", 2025-06-19)는 기능 요청 상태로 닫혔다. litellm 쪽 "fallback"은 토큰 계산이나 context window 대체 값을 가리키는 별개 용례다.
- 재시도: `llms/retry.py`는 rate limit만 재시도한다. 최대 3회, 초기 1초에서 상한 8초, 지터 20%, 제공자의 retry-after가 있으면 그것을 우선한다. `servicequotaexceededexception`은 재시도하지 않는 오류로 분류한다. 별도로 `Agent.max_retry_limit`(실행 오류 재시도)과 `guardrail_max_retries=3`이 있다.
- 쿼터: `max_rpm`을 에이전트와 크루에 줄 수 있고 `RPMController`가 분당 요청을 제한한다. 모델별 토큰 사용량은 `llm.get_token_usage_summary()`로 조회한다. 사용량을 보고 모델을 바꾸는 코드는 원문 미확인이다.

**라우터 / 리드 / 소통**:
- 작업 단위 모델 라우터는 원문 미확인이다. 리드에 해당하는 것은 hierarchical 프로세스의 manager agent이고, 그 모델은 `manager_llm`으로 따로 정한다.

**이슈 사례**:
- #3032, 2025-06-19, 반응 +1, 댓글 13개, 닫힘: 에이전트 단위 폴백 LLM 요청. 본문이 "각 에이전트가 단일 LLM에 묶여 있다"고 서술한다.
- #7580(2026-09-18, 닫힘)과 #8333(2026-10-20, 열림): rate limit을 에이전트 경계에서 재시도하는 수정과 SDK 재시도가 겹쳐 중복되는 문제.
- #2841, 2025-05-15, 닫힘: TPM(분당 토큰) 제어기 추가 요청.

### huggingface/smolagents
- 별 30400, 마지막 push 2026-11-15
- 근거 파일(커밋 날짜): `src/smolagents/models.py`(2026-05-14), `src/smolagents/agents.py`(2026-05-29)
- 선택 이유: 기본 모델이 하드코딩된 최소 프레임워크이고, 폴백 대신 LiteLLM 라우터 래퍼를 제공한다는 점이 다른 설계다.

**역할과 모델**:
- 기본 모델은 `InferenceClientModel(model_id="Qwen/Qwen3-Next-80B-A3B-Thinking")`이다. 독스트링이 "향후 바뀔 수 있다"고 적는다.
- 에이전트마다 `model: Model` 인자를 받고, `managed_agents`로 하위 에이전트를 붙인다. 하위 에이전트도 각자 모델 객체를 가지므로 역할별 모델은 사용자가 코드로 지정한다. `planning_interval`로 계획 단계를 돌리는 주기를 정한다.

**폴백 / 쿼터**:
- `ApiModel`은 `requests_per_minute`(RateLimiter)와 `retry=True`를 가진다. 재시도는 `is_rate_limit_error`(문자열에 "429", "rate limit", "too many requests", "rate_limit" 포함)일 때만 하고, `RETRY_WAIT=60`, `RETRY_MAX_ATTEMPTS=3`, 지수 2, 지터 있음이다.
- 모델 전환 폴백은 `Model` 계층에 없다. 대신 `LiteLLMRouterModel`이 LiteLLM SDK Router에 model_list를 넘겨 여러 배포 사이에 요청을 분산한다(독스트링은 load balancer 예시). 그 안의 폴백 규칙은 LiteLLM 쪽 설정에 속해서 원문 미확인이다.

**라우터 / 리드 / 소통**: 작업 단위 라우터와 별도 리드 역할은 원문 미확인이다. 상위 에이전트가 managed agent를 도구처럼 호출하는 구조다.

**이슈 사례**:
- #3034, 2026-10-20, 열림, 댓글 4개: OpenAI 클라이언트 재시도와 `ApiModel` 재시도가 곱해져 rate limit 한 번에 9번 요청한다.
- #3036(2026-10-20, 닫힘)과 #3077(2026-10-26, 닫힘): 재시도 곱셈 제거와 제공자의 retry 지연 값 존중.

### microsoft/autogen
- 별 61877, 마지막 push 2026-11-12, API의 archived 값은 false
- 근거 파일(커밋 날짜): `README.md`(2026-10-16), `python/packages/autogen-ext/src/autogen_ext/teams/magentic_one.py`(2025-09-18), `python/packages/autogen-ext/src/autogen_ext/models/openai/_openai_client.py`(2025-09-18), `python/packages/autogen-core/src/autogen_core/models/_model_client.py`(2025-08-19)
- 선택 이유: README가 스스로 "유지보수 종료, 후속은 Microsoft Agent Framework"라고 밝힌 상태에서 여전히 널리 참조되는 프레임워크다.

**역할과 모델**:
- README는 "Microsoft는 버그 수정, 보안 수정, 기능, 지원을 제공하지 않는다"고 적고 새 사용자는 Microsoft Agent Framework를 쓰라고 안내한다. GitHub의 archived 플래그는 false이지만 push가 계속되는 이유는 이번 조사에서 원문 미확인이다.
- 기본 모델은 없다. 에이전트가 `model_client`를 받는다. README 예제는 `OpenAIChatCompletionClient(model="gpt-4.1")`이고, `MagenticOne` 독스트링 예제는 `gpt-4o`이다.
- 에이전트별로 다른 client를 줄 수 있다. 독스트링 예제는 FileSurfer, WebSurfer, Coder에 같은 client를 공유한다. 오케스트레이터와 SelectorGroupChat의 선택자 모델도 별도 `model_client`이다.

**폴백 / 쿼터**:
- 모델 전환 폴백과 라우터는 파일 목록의 이름 검색(fallback, router, rate_limit, retry)에서 `core_semantic_router` 샘플 외에 나오지 않았다. 이 샘플은 의미 기반 메시지 라우팅이고 모델 선택용이 아니다. OpenAI client에는 SDK 위임 `max_retries` 인자만 확인됐다.
- 사용량을 보고 모델을 바꾸는 기능은 원문 미확인이다.

**라우터 / 리드 / 소통**: Magentic-One 오케스트레이터가 리드 역할이다. 모델 기본값은 위와 같이 사용자 지정이다.

**이슈 사례**:
- #2855, 2024-06-03, 반응 +2, 닫힘: "OpenAIWrapper의 난독화된 LLM 폴백" 이슈. 구버전(v0.2)의 `config_list` 폴백을 다룬 것으로 추정되나 본문은 열람하지 않아 원문 미확인이다.
- #4793, 2024-12-23, 닫힘: rate limit 오류 때 제한을 어떻게 거는지 질문.

### ag2ai/ag2
- 별 5073, 마지막 push 2026-11-16
- 근거 파일(커밋 날짜): `README.md`, `ag2/agent.py`(2026-11-12), `ag2/config/config.py`, `ag2/middleware/builtin/llm_retry.py`(2026-09-06), `ag2/middleware/builtin/token_limiter.py`
- 선택 이유: AutoGen에서 분기한 프로젝트로서 설정 기반 폴백(`config_list`)을 버리고 미들웨어로 옮긴 새 설계를 보여준다.

**역할과 모델**:
- 기본 모델은 없다. `Agent(name, config=ModelConfig)`로 에이전트마다 설정 객체를 넘긴다. README 예제는 모두 `OpenAICompletionsConfig(model="gpt-4o-mini")`이다.
- provider 목록(`ModelProvider`): anthropic, bedrock, dashscope, gemini, mistral, ollama, openai, typesafe, vertexai, xai, zai.
- README는 기존 `autogen.*` 네임스페이스(ConversableAgent, GroupChat, `LLMConfig`/`OAI_CONFIG_LIST`)를 "AG2 Classic"이라 부르고 별도 저장소로 옮겼다고 적는다. 이 저장소 트리에는 `config_list`와 `llm_config` 문자열이 없다. Classic 저장소는 이번에 열지 않아 원문 미확인이다.

**폴백 / 쿼터**:
- 재시도는 `RetryMiddleware`(`max_retries=3`, `retry_on=(Exception,)`)이다. 시도가 이미 이벤트를 발행(스트리밍 청크 등)했으면 재시도하지 않고 예외를 올린다. 대기 시간과 백오프 로직은 이 파일에 없다. 이 동작은 이슈 #3216("stop retries after streaming chunks", 2026-08-30)으로 들어갔다.
- 모델 전환 폴백은 이 저장소의 `ag2/config`와 `ag2/middleware`에서 원문 미확인이다(`fallback` 이름의 모듈 없음). 사용량 제한 도구는 `TokenLimiter(max_tokens)`가 있으나 이는 히스토리 잘라내기이고 쿼터 감시가 아니다.

**라우터 / 리드 / 소통**: 작업 단위 모델 라우터는 원문 미확인이다. `ag2/network`에 다른 에이전트와 통신하는 정책과 피어 도구가 있다(세부는 열람하지 않음).

**이슈 사례**: 역할별 모델이나 폴백을 요구한 이슈는 검색(제목에 rate limit, retry 등)에서 찾지 못했다. #3216(스트리밍 뒤 재시도 중단)과 #2292(Bedrock 지수 백오프와 재시도 지원, 2025-12-25)만 확인됐다.

### langchain-ai/langgraph
- 별 45044, 마지막 push 2026-11-16
- 근거 파일(커밋 날짜): `libs/langgraph/langgraph/types.py`(2026-11-04), `libs/langgraph/langgraph/_internal/_retry.py`, `libs/langgraph/langgraph/pregel/_retry.py`(2026-11-04), `libs/prebuilt/langgraph/prebuilt/chat_agent_executor.py`
- 선택 이유: 모델에 관여하지 않는 오케스트레이션 런타임이라, 프레임워크가 모델 정책을 어디까지 가져가는지 보여주는 대조군이다.

**역할과 모델**: 기본 모델이 없고 그래프 노드가 임의 코드다. `prebuilt`의 `chat_agent_executor.py`는 `LanguageModelLike`를 받고, 그 안의 `AgentState`는 "`langchain.agents`로 옮겨졌다"는 deprecated 안내가 붙어 있다. 에이전트 정의는 langchain 쪽으로 이동한 상태이다.

**폴백 / 쿼터**:
- 노드 단위 `RetryPolicy`: 초기 0.5초, 배수 2.0, 최대 간격 128초, 최대 3회(첫 시도 포함), 지터 있음, `retry_on` 기본은 `default_retry_on`이다.
- `default_retry_on`은 ConnectionError와 5xx(httpx, requests)를 재시도하고, ValueError, TypeError, RuntimeError, OSError 등은 재시도하지 않는다. httpx.HTTPStatusError는 500 이상 600 미만만 true를 반환하므로 코드상 429는 기본 재시도 대상이 아니다.
- 모델 전환 폴백, 사용량 감시, 모델 라우터는 이 저장소에서 원문 미확인이다. langchain 쪽 모델 폴백 미들웨어는 이번 범위 밖이라 열지 않았다(위 open-swe 코드가 `ModelFallbackMiddleware`를 언급하므로 langchain에 있을 가능성이 있으나 원문 미확인).

**라우터 / 리드 / 소통**: 조건부 엣지로 사용자가 직접 그린다. 별도 리드 역할은 없다.

**이슈 사례**: 제목에 fallback, rate limit이 든 이슈 중 역할별 모델 배정이나 모델 폴백을 요구한 것은 검색에서 찾지 못했다.

### OpenBMB/ChatDev
- 별 34762, 마지막 push 2026-11-06
- 근거 파일(커밋 날짜): `.env.example`(2026-10-16), `entity/configs/node/agent.py`(2026-03-02), `yaml_instance/*.yaml`(45개, 예: `ChatDev_v1.yaml` 2026-01-07), `README.md`
- 선택 이유: 워크플로우를 YAML로 정의하고 노드마다 모델을 적는 선언형 설계이며, 모델 기본값이 예제 YAML에 직접 들어 있다.

**역할과 모델**:
- 전역에는 `BASE_URL`과 `API_KEY`만 있고 기본 모델 변수는 없다(`.env.example`). 모델은 에이전트 노드 설정의 `name`, `provider`, `base_url`, `api_key`, `params`에서 정한다. YAML 안에서 `${API_KEY}` 같은 치환을 쓴다.
- 예제 `yaml_instance/`의 45개 파일에서 `name:` 줄을 센 결과: `gpt-4o` 약 86줄(공백 차이로 두 집계), `gemini-3-pro-preview` 27, `gpt-4o-mini` 5, `gemini-3-flash-preview` 5, `gpt-4-turbo` 2, `gemini-2.5-flash` 2, 이미지 생성용 `gemini-2.5-flash-image-preview` 2, `gemini-2.5-flash-image` 1, `gpt-5.4` 1. 줄 수는 노드 수와 같지 않을 수 있다.
- 같은 워크플로우 안에서도 노드마다 다른 모델을 적을 수 있다. `ChatDev_v1.yaml`의 Programmer Code Review 노드는 `provider: openai`, `name: gpt-4o`이다.

**폴백 / 쿼터**:
- 노드별 재시도 설정(`AgentRetryConfig`): `enabled=True`, `max_attempts=5`, `min_wait_seconds=1.0`, `max_wait_seconds=6.0`, 재시도 상태코드 `[408, 409, 425, 429, 500, 502, 503, 504]`, 예외 타입 목록과 메시지 부분문자열 목록, 재시도 금지 예외 목록을 YAML로 바꿀 수 있다.
- 모델 전환 폴백은 `entity`와 YAML 예제에서 찾지 못했다(예제의 "fallback"은 데이터 처리 지시문 안의 단어). 쿼터 감시도 원문 미확인이다.

**라우터 / 리드 / 소통**: README(2025-05-26 항목)가 학습 가능한 중앙 오케스트레이터를 쓰는 puppeteer 방식 패러다임을 소개한다. 코드의 라우터와 모델 선택 연결은 원문 미확인이다. `GameDev_with_manager.yaml`처럼 manager 노드를 두는 예제 이름이 있다.

**이슈 사례**: 모델 관련 이슈는 2023년 것이 많다.
- #27, 2023-09-08, 반응 +44, 댓글 59개: 로컬 모델 통합 요청.
- #98, 2023-09-26, +4: 여러 LLM API 엔드포인트와 모델 선택 지원 요청.
- #163, 2023-10-10: 모델 설정 문의.

### FoundationAgents/MetaGPT (오래된 상태)
- 별 71316, 마지막 push 2026-01-21(조사일 기준 약 10개월 전이라 낡았다)
- 근거 파일(커밋 날짜): `config/config2.example.yaml`(2025-02-26), `metagpt/configs/llm_config.py`(2025-04-30), `metagpt/configs/models_config.py`(2024-07-01), `metagpt/utils/cost_manager.py`(2025-03-01)
- 선택 이유: 역할별 LLM과 예산 상한이 설정 파일에 들어간 초기 프레임워크의 사례이다.

**역할과 모델**:
- 예제 설정의 전역 `llm.model`은 `gpt-4-turbo`이다. `roles:` 목록에서 역할 클래스별로 LLM을 따로 지정한다: ProductManager는 `gpt-4-turbo-1106`(openai), Architect는 `gpt-35-turbo`(openai), ProjectManager는 `gpt-4-1106`(azure), Engineer는 `gpt-35-turbo-1106`(azure). 여기에 적힌 모델은 모두 예제 파일 기준이고 현재 권장값이라는 근거는 없다.
- `LLMConfig` 기본값: `max_token=4096`, `temperature=0.0`, `timeout=600`, `reasoning=False`, `reasoning_max_token=4000`.
- `ModelsConfig.models` 딕셔너리로 이름이나 타입으로 LLM 설정을 찾는다(`llm_name_or_type`).

**폴백 / 쿼터**:
- 모델 전환 폴백은 원문 미확인이다. provider 파일(`openai_api.py`)은 tenacity 재시도(`wait_random_exponential(min=1, max=60)`)를 쓴다. 시도 횟수는 확인하지 못해 원문 미확인이다.
- 쿼터에 가까운 것은 비용 상한이다. `CostManager.max_budget` 기본값이 10.0달러이고, 로그에 `Total running cost`와 `Max budget`을 남긴다. 예산 초과 시 동작(예외)은 이번에 끝까지 읽지 않아 원문 미확인이다.

**라우터 / 리드 / 소통**: 역할 간 메시지로 소프트웨어 회사 역할극을 구성한다. 모델 라우터는 원문 미확인이다.

**이슈 사례**:
- #2141, 2026-08-26, 닫힘: 역할마다 다른 LLM을 쓰는 설정을 단일 OpenAI 호환 게이트웨이로 단순화하자는 제안(config2.yaml 제공).
- #1266, 2024-05-13, 닫힘: config.yaml에 에이전트마다 다른 로컬 LLM을 정의할 수 있는지 질문.
- #2206, 2026-11-15, 열림: `ModelsConfig.get()`이 api_type으로 조회되지 않는 버그.


---

### openai/openai-agents-python
- 별 30727, 마지막 push 2026-11-17
- 근거 파일(커밋 날짜): `src/agents/models/default_models.py`(2026-08-07), `docs/models/index.md`(2026-10-13), `src/agents/retry.py`(2026-08-09), `docs/multi_agent.md`
- 선택 이유: 벤더 공식 SDK이고, 기본 모델, effort 기본값, 재시도 정책 API가 코드에 그대로 있다.

**역할과 모델**
- 역할별 기본 모델은 없다. 에이전트가 `model`을 지정하지 않으면 `get_default_model()`이 `OPENAI_DEFAULT_MODEL` 환경변수를 읽고, 없으면 `gpt-5.6-luna`를 쓴다.
- 문서도 같은 내용이다. 기본은 `gpt-5.6-luna`, `reasoning.effort="none"`, `verbosity="low"`이고, `gpt-5.6-sol`로 바꾸는 방법은 환경변수 또는 `RunConfig(model=...)` 두 가지다.
- effort 기본값은 모델 이름 정규식 표로 정한다. 코드에서 확인한 항목은 `gpt-5` low, `gpt-5.1`과 `gpt-5.2` none, `gpt-5.2-pro` medium, `gpt-5.2-codex` low, `gpt-5.3-codex` none, `gpt-5.4` none이다. 5.6 항목은 표 끝부분을 열지 못해 원문 미확인.
- 에이전트별 지정 키는 `Agent(model=..., model_settings=ModelSettings(reasoning=Reasoning(effort=...)))`이다. 문서는 "Mixing models in one workflow" 절에서 에이전트마다 다른 모델이나 다른 프로바이더를 쓰는 방법을 안내한다.
- 호스티드 멀티 에이전트 베타가 있다. `OpenAIHostedMultiAgentModel(model="gpt-5.6-sol", config={"max_concurrent_subagents": 3})`로 루트 모델이 서브에이전트를 서버 쪽에서 조율한다.

**폴백 / 쿼터**
- 모델 전환 폴백은 SDK에 없다. `fallback_model` 코드 검색 결과가 0건이었다.
- 재시도는 같은 모델에만 적용되고 명시적으로 켜야 한다. 문서 원문: 일반 모델 요청은 `ModelSettings(retry=...)`를 지정하고 재시도 정책이 재시도를 고를 때만 재시도한다.
- 정책 조합자가 `retry_policies.never()`, `provider_suggested()`, `network_error()`, `retry_after()`, `http_status(statuses)`, `all()`, `any()`로 나뉜다. `ModelRetrySettings`에는 `max_retries`, `backoff`, `policy`가 있고, 정책 콜백은 `RetryPolicyContext`로 오류 종류, `retry_after`, 시도 횟수를 받는다.
- `ModelSettings.timeout`은 시도 하나의 상한이며, 초과하면 `ModelTimeoutError`가 나고 재시도 정책으로 넘어간다.
- 사용량이나 쿼터를 보고 모델을 바꾸는 기능은 확인하지 못했다.

**라우터 / 리드 / 소통**
- `docs/multi_agent.md`는 핸드오프(트리아지 에이전트가 전문 에이전트로 넘기고, 전문 에이전트가 그 턴의 활성 에이전트가 되는 방식)와 에이전트를 도구로 호출하는 방식을 구분한다.
- 작업 단위 모델 라우터는 없다. 모델 선택은 `agent.clone(model=...)`로 런 전에 하는 방식이 문서에 나온다.

**이슈 사례**
- [#3782](https://github.com/openai/openai-agents-python/issues/3782) 2026-07-10, "Using LiteLLM router (with fallback and retry/cooldown) in an Agent". 폴백과 쿨다운이 있는 LiteLLM 라우터를 에이전트에 쓰고 싶다는 질문이다. 댓글 1, 반응 0, 닫힘. 폴백을 SDK 바깥(LiteLLM)에 맡기는 구조를 보여 준다.

### pydantic/pydantic-ai
- 별 21248, 마지막 push 2026-11-17
- 근거 파일(커밋 날짜): `pydantic_ai_slim/pydantic_ai/models/fallback.py`(2026-11-11), `docs/capabilities/model-fallback.md`(2026-11-11), `docs/capabilities/select-model.md`(2026-10-21), `docs/retries.md`(2026-11-17)
- 선택 이유: 프레임워크 중 폴백 모델 클래스와 단계별 모델 선택 기능을 모두 갖춘 가장 상세한 설계다.

**역할과 모델**
- 프레임워크라 기본 모델이 없다. `Agent(model)` 또는 `agent.run(model=...)`으로 지정한다. 문서 예제는 `{{ openai:medium }}`, `{{ anthropic:medium }}`, `{{ openai:small }}` 같은 치환 토큰이라 구체 모델 문자열은 원문 미확인.
- `SelectModel` capability가 단계마다 호출되는 콜러블로 모델을 고른다. 입력은 의존성, 프롬프트, 메시지 기록, 사용량, 현재 단계, 실행 ID, 마감 시간, 사용량 한도다. 문서 예제는 `task_complexity`가 `complex`이면 medium, 아니면 small을 반환한다.
- 출력 검증에 실패해 재시도할 때 `ctx.retry`와 `ctx.max_retries`를 보고 다른 모델로 보내는 예제가 문서에 있다.

**폴백 / 쿼터**
- 폴백은 두 가지 형태다. 모델 클래스 `FallbackModel(default_model, *fallback_models, fallback_on=(ModelAPIError,))`와 capability `ModelFallback(...)`이다.
- 발동 조건: 기본은 `ModelAPIError`(4xx 또는 5xx 응답 등). `fallback_on`에는 예외 타입 튜플, 예외 핸들러, 응답 핸들러(`ModelResponse`를 받아 거부 여부 반환), 이들의 혼합 시퀀스를 줄 수 있다. 문서가 적은 기본값은 두 곳이 다르다. 클래스 docstring은 `(ModelAPIError,)`이고, capability 문서 경고문은 `(ModelAPIError, ContentFilterError, OutputTokenLimitExceeded)`를 기본으로 적는다. 어느 쪽이 맞는지는 코드 본문을 끝까지 열지 못해 원문 미확인.
- 순서: 지정한 순서대로 시도하고, 한 스텝에서 이미 시도한 모델은 건너뛴다. 모두 실패하면 `FallbackExceptionGroup`으로 모든 예외를 묶어 올린다. 실패한 시도는 `response.failed_attempts`에 모델명, 결과(`error` 또는 `rejected`), 사용량으로 남는다.
- 재시도와 전환의 구분이 명시돼 있다. 문서: 폴백은 재시도가 아니다. 다음 모델은 첫 모델이 쌓은 프롬프트 캐시를 못 쓰고 답과 가격이 달라질 수 있으니, 일시적 장애는 전송 계층 재시도에 맡기라고 한다. SDK 자체 재시도가 폴백을 늦추니 `ModelSettings['max_retries']`를 0으로 두라는 주의도 있다.
- 거절(refusal) 처리: `ContentFilterError`를 `fallback_on`에 넣으면 `finish_reason='content_filter'` 응답을 거부로 보고 다음 모델로 넘긴다. 문서는 보안 작업에서 한 모델이 거절하면 다른 프로바이더의 안전 정책이 처리할 수 있다는 사용례를 든다.
- 스트리밍 요청에서는 응답 핸들러가 적용되지 않고 `UserWarning`과 함께 응답을 그대로 받는다.
- `docs/retries.md`는 재시도 계층을 표로 나눈다. 전송(`AsyncHTTPX2TenacityTransport`), 프로바이더 SDK, 내구 실행(Temporal 등), 출력 재시도(`retries={'output': N}`). SDK 기본 시도 횟수는 대부분 3회이고 Google, Mistral, Hugging Face는 1회라고 적는다.
- 쿼터 기반 전환은 `SelectModel`이 사용량과 사용량 한도를 입력으로 받는 점이 가장 가깝다. 쿼터 잔량 자동 조회는 확인하지 못했다.

**라우터 / 리드 / 소통**
- 작업 단위 라우터는 `SelectModel`이다. 리드 역할을 따로 두는 구조는 확인하지 못했다.

**이슈 사례**
- [#3023](https://github.com/pydantic/pydantic-ai/issues/3023) 2025-09-29, "Add Circuit Breaker to Fallback model". 계속 실패하는 모델을 매번 먼저 시도하지 않게 해 달라는 요청이다. 댓글 14, 반응 2, 열림.
- [#12413](https://github.com/pydantic/pydantic-ai/issues/12413) 2026-11-04, "Unified model settings chosen for one model get a 400 from the fallback model". 첫 모델에 맞춘 설정이 폴백 모델에서 400을 낸다는 보고다. 댓글 0.
- [#9896](https://github.com/pydantic/pydantic-ai/issues/9896) 2026-10-06, "Support declarative fallback models in AgentSpec". 선언형 에이전트 명세에서 폴백 모델을 지정하게 해 달라는 요청이다. 댓글 4, 닫힘.

### mastra-ai/mastra
- 별 29556, 마지막 push 2026-11-17
- 근거 파일(커밋 날짜): `docs/src/content/en/models/index.mdx`(2026-11-10), `docs/src/content/en/reference/processors/model-selection-processor.mdx`(2026-10-22), `packages/core/src/llm/model/server-side-fallback.ts`(2026-06-12), `docs/src/content/en/docs/agents/networks.mdx`
- 선택 이유: TypeScript 쪽에서 모델 배열 폴백과 비용 라우팅 프로세서를 모두 제공한다.

**역할과 모델**
- 프레임워크라 기본 모델이 없다. `new Agent({ model })`에 `provider/model` 문자열을 넘긴다. 문서 예제는 `__GATEWAY_OPENAI_MODEL__` 같은 치환 토큰이라 구체 이름은 원문 미확인.
- `ModelSelectionProcessor`는 요청을 한 번 분류한 뒤 에이전트의 모델을 바꾼다. 선택지마다 모델과 처리할 요청 설명(`criteria`)을 적는다. 문서 예제는 한두 문장으로 답할 수 있는 요청은 작은 모델(Luna 토큰), 다단계 추론은 기본 모델로 보낸다. 분류에 쓰는 모델은 별도의 decision model이다.
- 문서 경고: 라우팅이 절약보다 비용이 더 들 수 있다. 프로바이더 프롬프트 캐시는 모델 사이에서 공유되지 않아 전환할 때마다 대화 전체를 전액으로 다시 낸다.

**폴백 / 쿼터**
- 모델 배열 폴백: `model: [{ model, maxRetries: 3 }, { model, maxRetries: 2 }, ...]`. 문서 예제는 OpenAI, Anthropic Sonnet, Google Flash 순서의 세 벤더 체인이다. 500 오류, rate limit, 타임아웃이면 다음 항목으로 넘어가고, 각 항목은 자기 재시도 횟수를 쓴 뒤 넘어간다.
- 항목마다 `modelSettings`, `providerOptions`, `headers`를 따로 줄 수 있다. 병합 우선순위는 호출 시점 옵션, 항목 옵션, 에이전트 `defaultOptions` 순이다.
- Anthropic 서버 쪽 폴백도 인식한다. `providerOptions.anthropic.fallbacks`로 체인을 주고 1차 모델의 안전 분류기가 거절하면 API가 폴백 모델로 재시도한다. Mastra는 `fallback_message` 항목에서 실제 응답 모델을 읽어 추적과 지표에 기록한다.
- 쿼터 잔량으로 모델을 바꾸는 기능은 확인하지 못했다.

**라우터 / 리드 / 소통**
- 네트워크 문서의 routing agent는 LLM이 요청을 보고 서브에이전트, 워크플로, 도구 중 무엇을 어떤 순서로 호출할지 정한다. 이 라우팅 에이전트에 메모리가 필수라고 적혀 있다. 프리미티브마다 `description`이 선택 기준이다.

**이슈 사례**
- [#21280](https://github.com/mastra-ai/mastra/issues/21280) 2026-08-11, "Let an error processor advance the model fallback chain". Azure OpenAI가 rate limit을 200 OK SSE 스트림 안의 오류 이벤트로 전달해, 던져진 예외에만 반응하는 폴백 체인이 작동하지 않았다는 프로덕션 사례다. 댓글 6, 반응 1, 열림.
- [#24397](https://github.com/mastra-ai/mastra/issues/24397) 2026-09-18, "Support run-scoped model failure classification in fallback chains". 실행 범위의 모델 장애 분류를 요구한다. 댓글 1, 열림.
- [#27550](https://github.com/mastra-ai/mastra/issues/27550) 2026-10-18, "Durable/evented engines drop per-entry modelSettings and providerOptions from model fallback lists". 내구 엔진이 폴백 항목별 설정을 버리던 결함이다. 댓글 3, 닫힘.

### google/adk-python
- 별 22245, 마지막 push 2026-11-17
- 근거 파일(커밋 날짜): `src/google/adk/models/_fallback_model.py`(2026-08-27), `src/google/adk/agents/llm_agent.py`, `src/google/adk/agents/_agent_router.py`(2026-11-03)
- 선택 이유: 기본 모델이 코드에 있고, 상태 코드 기준의 순차 폴백 모델 클래스가 있다.

**역할과 모델**
- `LlmAgent.DEFAULT_MODEL = 'gemini-3.5-flash'`이다. `LlmAgent.set_default_model(...)`로 전역 기본값을 바꿀 수 있고, 에이전트별로는 `model=`을 넘긴다.
- 역할별 기본 모델 표는 없다. effort나 reasoning 설정은 이 묶음에서 확인하지 못했다.

**폴백 / 쿼터**
- `FallbackModel(models=[...])`이 있고 `@experimental(FeatureName.FALLBACK_MODEL)`로 실험 기능 표시가 붙어 있다. 예제는 `gemini-3.1-pro-preview` 다음 `gemini-3.5-flash`다.
- 발동 조건: 오류가 `retriable_status_codes`에 속하는 HTTP 상태를 가질 때만 다음 모델로 간다. 기본 집합은 429, 500, 502, 503, 504이다. 상태 코드가 없는 오류(서비스에 도달하지 못한 실패)는 그대로 전파한다. litellm이 실제로 받지 않은 500을 붙이는 경우는 상태 없음으로 취급하도록 따로 처리한다.
- 재시도와 전환의 구분: 각 모델을 정확히 한 번만 시도한다. 한 모델의 재시도는 그 모델의 `retry_options`(예: `Gemini(model=..., retry_options=...)`)가 맡고, 두 계층이 같은 실패를 두 번 재시도하지 않게 한다고 docstring이 설명한다.
- 첫 응답을 낸 뒤에는 그 모델이 턴을 소유한다. 스트리밍 중간 실패는 폴백하지 않고 전파한다. 두 번째 모델의 출력을 이어 붙이면 턴이 오염되기 때문이라고 적혀 있다. 라이브 연결도 같은 규칙이며, 연결 단계 실패만 다음 모델로 넘긴다.
- 백업 모델에 별도 설정을 주려면 항목을 모델 인스턴스로 쓴다.
- 쿼터 잔량을 보고 바꾸는 기능은 확인하지 못했다.

**라우터 / 리드 / 소통**
- `_agent_router.py`는 멀티 에이전트 라우팅과 브랜치 경로 복구용 비공개 헬퍼다. 모델 라우터가 아니라 에이전트 전환(transfer) 대상 해석과 재개 처리를 다룬다. 모델 단위 작업 라우터는 확인하지 못했다.

**이슈 사례**
- [#4087](https://github.com/google/adk-python/issues/4087) 2026-01-06, "Built-in Resilience Support for AgentTool". 서브에이전트 호출에 타임아웃, 자동 폴백, 결과 검증이 없어 LLM 추론과 프롬프트로 대체 에이전트에 보내야 한다는 불만이다. 댓글 4, 반응 0, 닫힘. 모델 폴백이 아니라 에이전트 폴백 요구다.
- 모델 폴백 자체를 요구한 이슈는 검색에서 찾지 못했다.

### TauricResearch/TradingAgents
- 별 122872, 마지막 push 2026-11-17
- 근거 파일(커밋 날짜): `tradingagents/default_config.py`(2026-10-16), `tradingagents/graph/trading_graph.py`, `tradingagents/graph/setup.py`(2026-10-03)
- 선택 이유: 역할을 deep와 quick 두 등급으로 나눠 모델을 배정하는 도메인 에이전트의 대표 사례다.

**역할과 모델**
- 기본값(`default_config.py`): `llm_provider="openai"`, `deep_think_llm="gpt-6-sol"`, `quick_think_llm="gpt-6-luna"`.
- 등급별 프로바이더와 엔드포인트를 따로 줄 수 있다. `quick_think_provider`, `deep_think_provider`, `quick_think_backend_url`, `deep_think_backend_url`이고, None이면 `llm_provider`를 따른다. 환경변수 `TRADINGAGENTS_DEEP_THINK_LLM`, `TRADINGAGENTS_QUICK_THINK_LLM` 등으로 덮어쓴다.
- `graph/setup.py` 기준 역할 배정:

| 등급 | 역할 |
|---|---|
| quick | 애널리스트 4종(market, social, news, fundamentals), Bull와 Bear 리서처, Trader, 위험 토론자 3종(Aggressive, Neutral, Conservative), Reflector |
| deep | Research Manager, Portfolio Manager |

- 토론을 진행하고 보고서를 쓰는 역할은 quick, 토론을 종합해 판정하는 관리자 두 역할만 deep이다.
- effort 설정은 프로바이더별 키로 따로 둔다. `google_thinking_level`, `openai_reasoning_effort`, `anthropic_effort`이고 모두 기본 None(프로바이더 기본값)이다. 등급별 effort 분리는 없다.

**폴백 / 쿼터**
- 모델 전환 폴백 키는 없다. 설정에 있는 복원력 관련 키는 `llm_max_retries`(SDK 재시도 횟수, 기본 None), `max_tokens`(출력 상한), `checkpoint_enabled`(LangGraph가 노드마다 상태를 저장해 중단된 실행을 재개)이다.
- `data_vendors`는 데이터 소스에 한해 순서 있는 폴백을 지원한다. 주석: 설정값이 정확한 벤더 체인이고, 순서 있는 폴백은 `"yfinance,alpha_vantage"`처럼 여러 개를 나열한다. 이는 LLM이 아니라 데이터 벤더 폴백이다.
- 사용량이나 쿼터를 보고 모델을 바꾸는 기능은 없다.

**라우터 / 리드 / 소통**
- 모델 라우터는 없다. 그래프가 정적으로 연결되며 토론 횟수(`max_debate_rounds`, `max_risk_discuss_rounds`)와 도구 호출 횟수(`max_tool_rounds`)로 비용을 제한한다. 소통 전담 역할은 없다.

**이슈 사례**
- [#1440](https://github.com/TauricResearch/TradingAgents/issues/1440) 2026-09-28, "Support different LLM providers/models per agent for true multi-model debate". 에이전트마다 다른 프로바이더를 써서 진짜 다중 모델 토론을 하자는 요구이고, 현재 설정 주석이 이 번호를 인용하며 등급별 프로바이더 키가 이에 대한 답이다. 댓글 2, 반응 0.
- [#1091](https://github.com/TauricResearch/TradingAgents/issues/1091) 2026-06-25, "Multi-agent runs abort on transient 429 rate-limit errors". 일시적 429에 멀티 에이전트 실행이 중단되고 재시도 예산을 설정할 수 없다는 불만이다. `llm_max_retries` 키가 이 번호를 인용한다. 댓글 1.

### The-PR-Agent/pr-agent
- 별 16305, 마지막 push 2026-11-16
- 근거 파일(커밋 날짜): `pr_agent/settings/configuration.toml`(2026-11-16), `pr_agent/algo/pr_processing.py`(2026-11-15), `docs/docs/usage-guide/changing_a_model.md`
- 선택 이유: 설정 파일에 `model`, `fallback_models`, 재시도 키가 모두 있는 운영형 코드 리뷰 에이전트다.

**역할과 모델**
- 기본값(`[config]`): `model="gpt-6.1-sol"`, `fallback_models=["gpt-6-luna"]`.
- `model_weak`(쉬운 작업용 약한 모델)와 `model_reasoning`(자기 성찰용)은 주석 처리돼 있다. 주석: `model_weak`는 번들 폴백과 같이 두면 Luna가 Luna를 재시도하게 되니 비워 둔다. `model_reasoning`은 `/improve`가 이제 `/review`를 실행하므로 쓰이지 않는다.
- reasoning 설정: `reasoning_effort = "medium"`(허용값 none, minimal, low, medium, high, xhigh, max). litellm 메타데이터가 모르는 모델은 `additional_reasoning_effort_models`에 추가한다. Claude 쪽은 적응형 사고 설정 키(`claude_adaptive_thinking_models_override`)와 `no_temperature_models` 목록이 있다.
- 역할(`/review`, `/describe`, `/improve` 등)마다 모델을 나누는 키는 없다. 모델 종류는 REGULAR, WEAK, REASONING 세 가지(`ModelType`)이고 기본 설정에서는 사실상 REGULAR 하나다.

**폴백 / 쿼터**
- 순서: `[model] + fallback_models`를 차례로 시도한다(`retry_with_fallback_models`). 쉼표 구분 문자열도 허용한다.
- 발동 조건: 예외가 `openai.APIError`, `asyncio.TimeoutError`, `FallbackEligibleError` 중 하나일 때만 다음 모델로 간다. 그 밖의 예외는 즉시 올린다. 모든 모델이 실패하면 시도별 오류를 합친 예외를 낸다.
- 재시도와 전환의 구분이 키로 나뉘어 있다.
  - `num_retries = 4`: 프로바이더가 거절한 요청(429, 5xx, 연결 오류)을 같은 모델에서 다시 시도한 뒤 폴백한다. `Retry-After`(최대 30초)를 기다리거나 지수 백오프를 쓴다. 0이면 즉시 폴백한다.
  - `retry_same_model_on_timeout = true`: 타임아웃은 같은 모델로 재시도한다. false면 곧바로 폴백한다.
  - `retry_same_model_on_length = false`: 출력 상한으로 잘린 빈 응답은 같은 모델 재시도 없이 폴백한다. true면 같은 모델로 재시도한다.
  - `ai_timeout = 120`초.
- 사용량 기록: `output_run_details`를 켜면 사용한 모델, 토큰, 시간, AI 호출 수를 PR 댓글에 덧붙인다. 폴백 사용 여부는 `record_model_used(model, is_fallback=...)`로 기록한다.
- 쿼터 잔량을 읽어 전환하는 기능은 확인하지 못했다.

**라우터 / 리드 / 소통**
- 작업 크기 라우터가 있다. `[model_routing]`(기본 `enable = false`, `rules = []`)은 PR이 작으면 더 싼 1차 모델로 보낸다. 규칙은 `max_hunks`, `max_files`, `max_patch_chars`, `model`, `deployment_id`를 순서대로 평가한다.
- 라우팅 결과가 기존 체인 뒤쪽 폴백과 겹치면 밀려난 1차 모델을 체인 끝에 보존하고 중복은 제거한다(`pr_processing.py` 코드에서 확인).
- 리드나 소통 역할은 없다.

**이슈 사례**
- [#3823](https://github.com/The-PR-Agent/pr-agent/issues/3823) 2026-10-03, "An empty response with finish_reason length is retried on the same model before falling back". 잘린 빈 응답이 폴백 대신 같은 모델로 재시도되는 동작에 대한 보고이고, 현재 `retry_same_model_on_length` 키가 이 동작을 선택하게 한다. 댓글 0.
- [#3459](https://github.com/The-PR-Agent/pr-agent/issues/3459) 2026-09-17, "config.reasoning_effort is unusable for OpenAI-compatible endpoints". 모델 목록이 하드코딩돼 호환 엔드포인트에서 effort가 무시된다는 불만이다. `additional_reasoning_effort_models` 키가 그 대응이다. 댓글 5.
- [#2928](https://github.com/The-PR-Agent/pr-agent/issues/2928) 2026-08-31, "fallback retry leaks the selected deployment into the next invocation". 폴백 중 선택한 배포가 다음 호출로 새는 결함이다. 코드의 `finally`에서 `openai.deployment_id`를 복원하는 부분과 관련이 있어 보이나 연결은 원문 미확인.

### langroid/langroid
- 별 4152, 마지막 push 2026-11-14
- 근거 파일(커밋 날짜): `langroid/language_models/openai_gpt.py`(2026-11-14), `langroid/language_models/rate_limiter.py`(2026-10-08)
- 선택 이유: 요청 대상이고, 사전 속도 제한기라는 다른 설계가 있다.

**역할과 모델**
- 역할별 기본 모델은 없다. `OpenAIGPTConfig.chat_model`의 기본값은 `default_openai_chat_model`이다. 선호 목록(`GPT4o`, `GPT4_1_NANO`, `GPT4_1_MINI`, `GPT4_1`, `GPT4o_MINI`, `O1_MINI`, `O3_MINI`, `O1`)에서 `OPENAI_API_KEY`로 모델 목록을 조회해 사용 가능한 첫 모델을 고르고, 없으면 `GPT4o`를 쓴다. 이 목록은 코드가 오래된 모델 이름을 담고 있다는 점이 눈에 띄지만 파일 커밋 날짜는 최근이다.
- 에이전트별 지정은 에이전트마다 `ChatAgentConfig`의 `llm`에 `OpenAIGPTConfig(chat_model=...)`를 주는 방식이다. 이 부분은 설정 클래스 정의만 보고 적었다. 에이전트 구성 예제는 원문 미확인.

**폴백 / 쿼터**
- 모델 전환 폴백은 확인하지 못했다. 파일 목록과 `openai_gpt.py` 키워드 검색에서 fallback 모델 키가 없었다.
- 같은 모델 재시도는 `retry_with_exponential_backoff` 데코레이터와 `retry_params`(`initial_delay`, `max_retries`, `exponential_base`)로 한다.
- 사전 속도 제한기 `RateLimitConfig`(`rate_limiter.py`)가 독특하다. 기본은 꺼짐(`enabled=False`)이고, 켜면 프로바이더가 응답 헤더로 알려 주는 남은 요청과 토큰을 보고 전송 속도를 조절한다. 설정: `headroom=0.1`(남길 여유 비율), `max_wait=60`초, `min_remaining_requests=1`, `warmup_interval=0.05`초. 헤더가 없는 프로바이더용으로 AIMD 방식(`backoff_factor=2.0`, `recovery_factor=0.9`, `max_interval=10.0`)이 있고, 제한기는 `(api_base, model)` 단위로 공유한다. 환경변수 접두사는 `LANGROID_RATE_LIMIT_`이다.
- 쿼터를 "초과하지 않게 맞추는" 설계이며, 한도에 도달해 다른 모델로 넘기는 설계가 아니다.

**라우터 / 리드 / 소통**
- `docs/quick-start/three-agent-chat-num-router.md`와 `examples/quick-start/three-agent-chat-num-router.py`에 라우터 에이전트 예제가 있다. 열어 읽지는 못해 모델 배정 여부는 원문 미확인.

**이슈 사례**
- 폴백이나 역할별 모델 관련 이슈는 검색에서 찾지 못했다.


---

### BerriAI/litellm
- 별 63373, 마지막 push 2026-11-17 (기본 브랜치 `main`)
- 근거 파일(커밋 날짜): `litellm/router.py`(생성자 시그니처와 docstring), `litellm/constants.py`, `litellm/router_utils/cooldown_handlers.py`(2026-11-14), `litellm/router_strategy/adaptive_router/README.md`(2026-11-14), `litellm/router_strategy/complexity_router/README.md`(2026-11-17), `litellm/proxy/auth/fallback_budget.py`, `litellm/router_strategy/budget_limiter.py`
- 선택 이유: 폴백, 쿨다운, 예산, 복잡도 라우팅을 한 코드베이스에 모두 갖춘 사실상의 기준 구현이다. 저장소 설명은 "Rust core with Python SDK"로 바뀌었고 `litellm/router_rust/` 아래에 코어가 따로 있다.

**라우팅 단위와 설정**
- 단위는 `model_list`의 `model_name`(모델 그룹)이다. 같은 `model_name`을 가진 배포 여러 개가 한 그룹이 되고, `routing_strategy`는 `simple-shuffle`(기본), `least-busy`, `usage-based-routing`, `latency-based-routing`, `cost-based-routing` 중 고른다.
- 설정은 YAML이나 Python 생성자 인자다. 폴백은 `fallbacks`, `default_fallbacks`, `context_window_fallbacks`, `content_policy_fallbacks` 네 인자로 나뉜다. 항목 모양은 `{"그룹명": ["대체그룹1", "대체그룹2"]}`이고 키가 둘 이상이거나 값이 리스트가 아니면 `refuse_malformed_fallbacks`가 거부한다(`litellm/router_rust/surface/fallbacks.py`).
- 예시 값(agentgateway 저장소의 LiteLLM 임포트 테스트 `crates/agentgateway/src/tests/import/litellm/default-fallbacks-branching.yaml`에서 확인): `fallbacks: [{primary: [backup, spare]}, {backup: [deep]}]`, `max_fallbacks: 2`, `default_fallbacks: [backup]`.

**폴백 규칙**
- 발동 조건: 일반 오류는 `fallbacks`, 컨텍스트 초과는 `context_window_fallbacks`, 콘텐츠 정책 거부는 `content_policy_fallbacks`로 각각 다른 체인을 탄다. 테스트용 `mock_testing_fallbacks`, `mock_testing_context_fallbacks`, `mock_testing_content_policy_fallbacks`, `mock_testing_rate_limit_error` 플래그가 이 네 갈림길과 대응한다.
- 쿨다운 대상 판정(`_is_cooldown_required`): 429, 401, 402, 408, 404는 쿨다운한다. 그 밖의 4xx는 쿨다운하지 않는다. 4xx가 아닌 오류(5xx 등)는 쿨다운한다. 문자열에 `APIConnectionError`가 있으면 쿨다운하지 않는다.
- 순서: 같은 그룹의 다른 배포가 먼저 선택되고(쿨다운 중인 배포는 제외), 그룹 전체가 실패하면 `fallbacks`의 다음 그룹으로 넘어간다. 다른 벤더로 넘어가는 것은 대체 그룹에 다른 벤더 배포를 넣었을 때다.
- 수치: `DEFAULT_COOLDOWN_TIME_SECONDS`는 `litellm/constants.py`에서 5, `DEFAULT_FAILURE_THRESHOLD_PERCENT`는 0.5, `DEFAULT_FAILURE_THRESHOLD_MINIMUM_REQUESTS`는 5다. 같은 코드의 `router.py` docstring은 쿨다운 기본값을 1초, `num_retries` 기본값을 2로 적고 있어 docstring과 상수가 다르다. 어느 쪽이 실제 동작인지는 원문 미확인이다.
- 복귀: 쿨다운 시간이 지나면 해당 배포가 풀에 다시 들어간다. 폴백 성공 뒤 주 모델로 복귀하는 별도 규칙은 확인하지 못했다.
- 폴백 대상에 예산과 접근권을 다시 검사한다: `fallback_budget.py` 주석에 따르면 예산은 인증 때 "요청한 모델 그룹"에만 검사되어, 무료 모델에 유료 폴백을 걸면 예산 문턱 없이 지출이 생기는 구멍이 있었다. 그래서 폴백 대상마다 키와 사용자의 `max_budget`, 팀 멤버의 모델별 상한을 재검사하며 기본 켜짐(`general_settings.enforce_fallback_budget: false`로 끔)이다. 이 검사는 카운터를 읽기만 하고 예약하지 않아 동시 요청이 몰리면 상한을 넘길 수 있다고 같은 파일이 스스로 적는다.

**쿼터 / 사용량 인식**
- `budget_limiter.py`의 공급자 예산 필터: `openai: budget_limit 0.000000000001, time_period 1d`, `anthropic: budget_limit 100, time_period 7d` 같은 모양이다. 예산을 넘긴 배포를 후보에서 걸러내므로 다른 라우팅 전략과 함께 쓴다.
- 구독 한도(Claude Max, ChatGPT 구독) 소진을 인식해 넘기는 기능은 코드에서 확인하지 못했다. 관련 요구는 이슈로 올라와 있다(아래).

**작업 내용 기반 라우터**
- `complexity_router`: 요청을 로컬에서 규칙 기반으로 점수화한다. 7개 차원과 가중치는 `tokenCount` 0.10, `codePresence` 0.30, `reasoningMarkers` 0.25, `technicalTerms` 0.25, `simpleIndicators` 0.05(감점), `multiStepPatterns` 0.03, `questionComplexity` 0.02다. 경계값은 SIMPLE 0.15 미만, MEDIUM 0.15~0.35, COMPLEX 0.35~0.60, REASONING 0.60 초과다. 설정 예: `model: auto_router/complexity_router`에 `tiers: {SIMPLE: gpt-4o-mini, MEDIUM: gpt-4o, COMPLEX: claude-sonnet-4, REASONING: o1-preview}`. 티어 값은 `{model_name, litellm_params: {reasoning_effort: xhigh}}`처럼 요청 파라미터까지 지정할 수 있다. `cache_aware_routing: true`(기본 꺼짐)이면 같은 티어 이상에서 프롬프트 캐시가 데워진 모델이 더 싸면 그쪽으로 바꾼다. 같은 디렉터리에 `jev_classifier.py`, `llm_v2.py`, `heuristic_v2`(성공 확률 예측기) 분류기도 있다.
- `adaptive_router`: 요청을 7개 `RequestType`으로 분류하고 `(request_type, model)` 셀마다 Beta 분포를 Thompson 샘플링해 `quality_weight*샘플 + cost_weight*정규화 비용`의 argmax를 고른다. 예시 가중치는 `quality: 0.7, cost: 0.3`, 모델별 `adaptive_router_preferences: {quality_tier: 3, strengths: [...]}`다. 콜드 스타트 질량은 10이고, 호출 뒤 정규식과 도구 호출 감지기로 만족, 정체, 루프 같은 신호를 받아 α, β를 갱신한다. 헤더 `x-litellm-min-quality-tier: 3`으로 최소 등급을 강제할 수 있다. 예시 모델 이름이 `gpt-6.1-sol`, `gpt-6-luna`로 적혀 있다.
- 코딩 에이전트의 역할 신호(서브에이전트 여부 등)를 읽는 기능은 확인하지 못했다.

**이슈 사례**
- [#23777](https://github.com/BerriAI/litellm/issues/23777) 하나의 인스턴스에서 ChatGPT OAuth 계정 여러 개 지원 요청(2026-03-16, 반응 46).
- [#31823](https://github.com/BerriAI/litellm/issues/31823) 공급자 쿼터 풀과 패키지 기반 라우팅 요청(2026-07-01, 반응 1).

### musistudio/claude-code-router
- 별 38192, 마지막 push 2026-11-16 (`main`)
- 근거 파일(커밋 날짜): `docs/src/content/docs/en/configuration/routing.md`(2026-11-16), 옛 설정은 태그 `v2.0.0`의 `README.md`
- 선택 이유: Claude Code용 시나리오 키(`background`, `think`, `longContext`)로 유명했던 라우터다. 현재 3.x 문서가 이 모델을 어떻게 바꿨는지 보려고 골랐다.

**라우팅 단위와 설정**
- 옛 방식(`v2.0.0` README): `Router` 객체에 시나리오 키를 둔다. 예시 값은 `default: deepseek,deepseek-chat`, `background: ollama,qwen2.5-coder:latest`, `think: deepseek,deepseek-reasoner`, `longContext: openrouter,google/gemini-2.5-pro-preview`, `longContextThreshold: 60000`, `webSearch: gemini,gemini-2.5-flash`다.
- 현재 방식(3.x 문서): 위 시나리오 키는 현재 라우팅 문서에 보이지 않는다. 내장 Claude Code 라우트(클라이언트가 인식 가능한 모델을 고르지 않았을 때 Agent Config의 기본 모델 사용)와 규칙 목록이 대신 있다. 규칙은 이름, 조건(`request.header` 또는 `request.body`의 필드와 연산자와 값), 재작성(rewrites), 켜짐 여부, 실패 시 동작으로 구성된다. 규칙은 목록 순서대로 평가하고 처음 맞는 켜진 규칙이 요청을 재작성한다. 조건으로 부족하면 Node.js 스크립트 규칙(10~30000ms 타임아웃, 예외나 타임아웃은 다음 규칙으로 넘어가는 fail-open, 같은 규칙이 60초 안에 3번 실패하면 30초 동안 서킷 브레이커)을 쓴다.

**폴백 규칙**
- 모드 셋: Off, Retry, Fallback targets. 전역 기본은 라우팅 페이지의 "Default on failure"이고 규칙마다 "On failure"로 덮어쓴다.
- 발동 조건: 네트워크 오류는 항상 다음 시도로 넘어간다. 상태 코드는 Retry 모드에서 408, 409, 429, 5xx, Fallback targets 모드에서 모든 4xx와 5xx다. 문서는 모델 없음, 인증, 공급자 거부 같은 4xx가 현재 타깃에만 영향을 줄 수 있어서 4xx도 넘긴다고 적는다.
- 순서: 현재 모델을 먼저 쓰고 설정된 폴백 모델을 순서대로 넘어간다. `retryCount`는 0~9999 정수, 기본 0이다.
- 대기: 모든 폴백 유발 실패 뒤에 대기한다. 양수 `Retry-After`가 있으면 그 값, 없으면 1초에서 시작해 시도당 30초 상한인 지수 백오프다. 응답 헤더 `x-ccr-fallback-attempts`, `x-ccr-fallback-failures`, `x-ccr-fallback-delays-ms`, `x-ccr-fallback-model`로 확인한다.
- 복귀: 요청마다 라우팅을 처음부터 다시 하므로 별도 복귀 상태는 문서에 없다.

**쿼터 / 사용량 인식**
- 라우팅 문서에는 계정 쿼터나 예산 기반 전환이 없다. README는 "retries, credential pools, key rotation, and ordered fallback models"를 언급하지만 크레딧 풀의 쿼터 인식 방식은 원문 미확인이다.

**작업 내용 기반 라우터**
- 서브에이전트 모델 선택: Models 페이지의 Description이 하나라도 있으면 CCR이 Claude Code의 `Agent`/`Task` 도구 설명에 모델 목록과 설명을 주입하고, 모델이 프롬프트 맨 앞에 `<CCR-SUBAGENT-MODEL>provider/model</CCR-SUBAGENT-MODEL>` 태그를 쓰면 그 모델로 라우팅한다. 문서는 `x-claude-code-agent-id` 헤더가 관찰용이고 모델 선택은 태그가 한다고 명시한다. 예시 설명은 "빠르고 싼 모델: 코드 검색, 파일 분류, 요약", "추론 모델: 아키텍처 분석, 리팩터 계획", "긴 컨텍스트 모델: 큰 로그, 저장소 규모 수집"이다.
- Jev 의미 라우팅(옵션): `examples/routing/jev.js`를 스크립트 규칙으로 올린다. `CCR_JEV_ROUTING_ENABLED=1`, `CCR_JEV_FAST_MODEL`, `CCR_JEV_REASONING_MODEL`, `TYPESAFE_API_KEY`가 필요하고 `model`이 `auto`인 요청만 분류한다. 최근 사용자 텍스트 최대 8192자와 토큰 수와 도구 수를 외부로 보내며 `CCR_JEV_MIN_CONFIDENCE` 기본값은 0.75다. 문서가 정확도와 지연은 측정하지 않았다고 밝힌다.

**이슈 사례**
- [#275](https://github.com/musistudio/claude-code-router/issues/275) 재시도 횟수를 정하는 폴백 모델 옵션 요청(2025-07-22, 반응 3). 현재 3.x 문서의 Fallback이 이 요구에 대응한다.
- [#252](https://github.com/musistudio/claude-code-router/issues/252) `longContext`가 동작하지 않는다는 보고(2025-07-19, 반응 0).
- [#1726](https://github.com/musistudio/claude-code-router/issues/1726) 슬롯별(default, background, think, longContext) 모델 벤치마크 제안(2026-08-26, 반응 0).

### router-for-me/CLIProxyAPI
- 별 58756, 마지막 push 2026-11-17 (`main`)
- 근거 파일(커밋 날짜): `config.example.yaml`(2026-11-16), `sdk/cliproxy/auth/quota_signals.go`, `sdk/cliproxy/auth/selector.go`
- 선택 이유: Claude Code, ChatGPT Codex, Antigravity 같은 구독 계정(OAuth)을 API로 감싸고 계정 풀을 돌리는 설계라서 구독 한도 처리를 볼 수 있다.

**라우팅 단위와 설정**
- 단위는 자격 증명(credential)이다. YAML `config.example.yaml`의 `routing.strategy`는 `round-robin`(기본), `weighted-round-robin`, `fill-first` 중 하나다. 가중치 방식은 인증 JSON의 최상위 숫자 `weight`(기본 1, 최대 1,000,000, 0 이하는 제외)를 쓴다. 그룹 설정에는 `priority`(큰 값이 먼저)와 `excluded-models`가 있다.
- 세션 고정: `session-affinity`(기본 false), `session-affinity-ttl` 1h, `session-affinity-subagents` true(서브에이전트가 부모 세션의 자격 증명을 물려받아 프롬프트 캐시 재사용). 주석에 따르면 이미 묶인 세션은 더 높은 우선순위 자격 증명이 회복되어도 유지되고, 우선순위는 처음 묶을 때와 페일오버 뒤 다시 묶을 때만 영향을 준다.

**폴백 규칙**
- 페일오버 기준: `session-affinity-rebind-on`이 `any`(기본, 자격 증명 귀속 실패면 모두 재결합), `quota`(408, 5xx, 빈 스트림, 버퍼 한도는 그 요청만 넘기고 세션은 유지, 429/401/402/403/404/`invalid_grant`는 재결합), `never` 중 하나다.
- 재시도: `retry.request-retry` 3, `retry.max-retry-credentials` 0(제한 없음), `retry.max-retry-interval` 30초. 쿨다운은 `cooldown.transient-error-cooldown-seconds`가 408/500/502/503/504/520~526에 적용되며 0이면 옛 60초 쿨다운, -1이면 일시 오류 쿨다운 해제다. `save-cooldown-status`(기본 false)는 `.cds` 파일로 쿨다운 상태를 저장한다.
- 쿼터 쿨다운 범위: 공급자별 `model-level-cooling`(기본 false)을 켜면 한도 초과 쿨다운을 요청한 모델에만 걸고 같은 자격 증명의 다른 모델은 계속 쓴다. Claude와 Codex 섹션에 각각 있다.
- 모델 간 폴백: `claude.server-side-fallback`(기본 false)이 켜지면 위장된 Claude 요청에 Anthropic 서버측 거부 폴백(`claude-opus-5-5`에서 `claude-opus-4-8`)을 주입하고, 폴백이 일어나면 응답에 실제 서비스 모델과 폴백 메타데이터를 싣는다.
- 옛 설정: `quota-exceeded.switch-project`, `switch-preview-model`은 v8 템플릿에서 빠지고 호환용으로만 남았다.

**쿼터 / 사용량 인식**
- `ProviderSupportsQuotaObservation`이 `claude`, `codex`, `devin`의 응답 헤더에서 계정 수준 쿼터 스냅샷을 수동으로 읽는다. 스냅샷은 병합하지 않고 매 응답으로 교체하며 쿨다운과 스케줄링 필드는 건드리지 않는다. Codex의 `usage_limit_reached` 쿼터 쿨다운 범위는 위 `model-level-cooling`으로 정한다. 관리 API에 `quota.go`, `plugin_quota.go`가 있다.

**작업 내용 기반 라우터**
- 내용 기반 분류는 없다. 서브에이전트는 세션 헤더(`X-Session-ID`, Claude Code, Codex, OpenCode 헤더)와 부모 참조로 식별해 부모 자격 증명을 상속한다.

**이슈 사례**
- [#1015](https://github.com/router-for-me/CLIProxyAPI/issues/1015) 쿼터가 남았는데 Antigravity 계정들이 429(2026-01-14, 반응 17).
- [#2599](https://github.com/router-for-me/CLIProxyAPI/issues/2599) OAuth로 프록시한 요청이 구독 포함 사용량이 아니라 "extra usage"로 과금됨(2026-04-08, 반응 8).

### cheaper-inference/OmniRoute
- 별 88149, 마지막 push 2026-11-17, 기본 브랜치 `release/v3.8.55`, 보관 아님
- 정체: 오너 `cheaper-inference`(조직 계정이 아닌 일반 소유로 표시되는지는 미확인), 생성 2026-02-13, MIT, 홈페이지 `omniroute.online`, 포크 아님. 옛 이름 `diegosouzapw/OmniRoute`는 변경 로그의 PR 링크(`diegosouzapw/OmniRoute/pull/15279`)에 남아 있고, `gh api repos/diegosouzapw/OmniRoute`는 `cheaper-inference/OmniRoute`로 리다이렉트된다. 저장소 설명은 "375 providers, 1,400+ models", README 히어로 이미지는 "394 providers", README 본문은 "22 routing strategies"인데 변경 로그는 `expiry-first`를 "the 21st"라고 적어 수치가 문서마다 다르다.
- 근거 파일(커밋 날짜): `docs/architecture/RESILIENCE_GUIDE.md`(2026-11-13), `docs/getting-started/AUTO-COMBO-GUIDE.md`, `docs/OMNIROUTE_ROUTING_POLICY.md`(2026-08-18), `docs/architecture/ADAPTIVE_ROUTING.md`, `changelog.d/features/15279-jev-combo-strategy.md`, `changelog.d/features/17829-combo-expiry-first-strategy.md`, `README.md`
- 선택 이유: 구독 계정과 무료 공급자를 콤보로 엮고 계정 쿼터를 점수에 넣는 설계가 가장 두껍다.

**라우팅 단위와 설정**
- 단위는 콤보(모델과 계정 단계의 체인)와 가상 모델 `auto`, `auto/coding`, `auto/fast`, `auto/cheap`, `auto/smart`, `auto/offline`이다. 콤보 단계마다 `priority`, `fill-first`, `weighted`, `round-robin`, `p2c`, `least-used`, `random`, `strict-random`, `cost-optimized`, `headroom`, `reset-window`, `reset-aware`, `expiry-first`, `jev` 같은 전략(README 기준 22개)을 섞어 쓴다. 설정은 대시보드와 API가 중심이고 저장소에 YAML 예시 콤보는 확인하지 못했다.
- `auto`는 연결된 공급자로 가상 콤보를 만들고 건강, 속도, 비용, 품질, 작업 적합성, 쿼터 여유를 점수화한다(README는 16개 요소라고 적는다).

**폴백 규칙**
- 세 층 구조(`RESILIENCE_GUIDE.md`): 공급자 서킷 브레이커, 연결(키) 쿨다운, 콤보 라우팅.
- 서킷 브레이커: 공급자 수준 상태 408, 500, 502, 503, 504만 센다. 401, 403, 429 같은 계정 수준 오류는 트립하지 않는다. 기본값은 OAuth 계열 5회에 DEGRADED, 8회에 OPEN, 리셋 60초, API 키 계열 7회, 12회, 30초, 로컬 2회, 15초다. OPEN이면 콤보 라우팅이 그 공급자를 건너뛰고, 리셋 시간이 지나면 HALF_OPEN에서 탐침 요청을 한 번 허용한다.
- 연결 쿨다운: OAuth 기본 5초, API 키 기본 3초에서 `baseCooldownMs * 2 ** failureIndex`로 오른다. 429는 업스트림 `Retry-After`를 우선하고, 한도 문구 없이 동시성 한도로 읽히는 429(`concurrency_limited`)는 고정 1초 쿨다운에 백오프를 올리지 않고 바로 다음 연결로 넘긴다. 스트림 정체는 계정 쿨다운을 걸지 않는다(기본).
- 종단 상태(쿨다운이 아님): `banned`, `expired`(재시도 3회 지수 백오프 뒤 확정), `credits_exhausted`. 운영자가 초기화하거나 자격 증명이 바뀔 때까지 유지된다.
- 옵트인 공급자 쿨다운(`PROVIDER_COOLDOWN_ENABLED`, 기본 꺼짐): OAuth 15분 창에서 10회 실패 시 5분, API 키 30분 창에서 15회 실패 시 10분.
- 복귀: 만료 시각이 지나면 지연 복귀(lazy recovery)하고, 성공 사용 시 오류 필드를 모두 지운다. 타이머는 없다.

**쿼터 / 사용량 인식**
- 계정별 쿼터 윈도를 점수와 사전 점검에 쓴다. `QUOTA_PREFLIGHT_CUTOFF_ENABLED` 토글이 있고, 라우팅 정책 문서는 "쿼터 소진, 할당 거부, 서킷 오픈은 후보에서 제외, 쿼터를 모르면 중립 계수로 후보 유지"라고 적는다. 변경 로그에는 `reset-aware`, `expiry-first`(윈도 만료가 임박한 쿼터를 먼저 소진) 전략과 Codex 쿼터 사전 점검이 있다.
- Claude 구독 5시간 한도 처리: 연결별 옵트인 `lowPriorityMode`와 `autoLimitReset`이 있다. `anthropic-ratelimit-unified-status: rejected` 헤더가 붙은 429에서 낮은 우선순위 레인을 수락해 같은 계정으로 즉시 재시도하고, 가능하면 한도 리셋을 요청한다. 문서는 Claude Code 2.1.263의 `/low-priority`, `/limit-reset` 명령 와이어를 캡처해 흉내 냈다고 적는다. 헤더 없는 일반 429는 보통 쿨다운 경로를 탄다.
- 공급자별 `rateLimitCooldownSeconds`(1~21600초) 재정의가 있고 우선순위는 업스트림 힌트, 연결별 재정의, 공급자 재정의, 환경변수, 스케일된 백오프 순이다.

**작업 내용 기반 라우터**
- 적응형 점수: `ADAPTIVE_ROUTING.md`는 성공과 지연의 EWMA를 품질 요소로 넣고 `score = 0.5 + confidence * (operational - 0.5)`, `confidence = clamp01(samples/50)`로 콜드 공급자가 0.5에서 시작하게 한다. 문서는 이 점수가 `auto` 콤보 점수의 `quality` 요소에 들어간다고 적는다.
- `jev` 콤보 전략: 사용자가 공급자 순서를 정하고 TypeSafe `choice` 호출이 승자와 신뢰도 0.15 이상인 폴백 최대 4개를 고른다. 키 없음, 타임아웃, 낮은 신뢰도면 사용자 순서로 폴백하고, 외부로 최신 사용자 메시지가 나가므로 `COMBO_JEV_STRATEGY_ENABLED` 플래그(기본 꺼짐)가 켜져 있어야 한다.
- 문서의 작업 변형은 `auto/coding` 등 이름으로 선택하며 분류 기준 코드는 읽지 못했다(원문 미확인).

**이슈 사례**
- [#13935](https://github.com/cheaper-inference/OmniRoute/issues/13935) OpenCode 무료 공급자가 OmniRoute 경유 시 모든 API 요청에 403(2026-09-17, 반응 9).
- [#1545](https://github.com/cheaper-inference/OmniRoute/issues/1545) Codex 공급자의 gpt-5.5 기본 지원 요청(2026-04-23, 반응 10).

### maximhq/bifrost
- 별 9642, 마지막 push 2026-11-17 (기본 브랜치 `dev`)
- 근거 파일(커밋 날짜): `docs/features/retries-and-fallbacks.mdx`(2026-10-15), `docs/providers/routing-rules.mdx`(2026-11-16), `docs/features/routers.mdx`(2026-11-16), `docs/features/governance/routing.mdx`
- 선택 이유: 재시도와 폴백, 키 로테이션, 실패 분류를 가장 구체적으로 문서화한 게이트웨이다.

**라우팅 단위와 설정**
- 요청 본문의 `fallbacks: ["anthropic/claude-3-5-sonnet-20241022", "bedrock/anthropic.claude-3-sonnet-20240229-v1:0"]`처럼 `공급자/모델` 체인을 직접 지정한다. 가상 키의 공급자 설정에서는 `weight`(합이 1로 정규화, 0이면 선택되지 않음, null이면 로드밸런싱 제외)로 비율을 나눈다.
- 라우팅 규칙은 CEL 식이다. 범위는 가상 키, 팀, 고객, 전역 순이고 첫 일치가 이긴다. 범위 안에서는 `priority` 오름차순(0이 먼저)이며 `chain_rule: true`면 결과로 범위 체인을 처음부터 다시 평가한다. 규칙은 공급자 선택보다 먼저 실행된다.
- 재시도는 공급자별 `network_config`에서 `max_retries`(기본 0), `retry_backoff_initial` 500ms, `retry_backoff_max` 5000ms다.

**폴백 규칙**
- 발동: 주 공급자가 재시도를 모두 쓰고도 실패하면 첫 폴백으로 넘어간다. 오류 종류는 가리지 않는다. 넘어가지 않는 경우는 호출자가 취소했을 때, 플러그인이 `AllowFallbacks = false`를 지정했을 때, 오류가 요청 자체의 문제(`caller_fault`)이면서 폴백이 호출자나 규칙이 아니라 모델 카탈로그가 붙인 것일 때다.
- 순서와 예산: 주 공급자와 각 폴백이 자기 `max_retries` 예산을 따로 가진다(주 3회에 폴백 2개가 각각 3회면 최대 12회 시도). 첫 성공이 이긴다. 모두 실패하면 첫 오류를 헤더와 함께 반환한다. 폴백에서는 라우팅을 다시 하지 않고 시맨틱 캐시, 거버넌스, 로깅 같은 시도별 플러그인만 다시 돌린다.
- 실패 분류(`failure_class`): `credential`(401 등), `quota`(402, `insufficient_quota`, Anthropic 크레딧 부족 문구), `model_access`, `model_gone`, `region_blocked`, `rate_limit`, `transient`(네트워크, 500/502/503/504/529), `caller_fault`, `unknown`, `timeout`, `cancelled`로 나뉜다. 키 문제(credential, quota, model_access, model_gone, region_blocked)는 영구 실패로 보아 그 요청에서 키를 죽은 것으로 표시하고 백오프 없이 다음 키로 돌린다. 429는 키를 돌리되 계정 수준 쿼터를 공유할 수 있어서 백오프는 유지한다. 일시 오류는 같은 키로 지수 백오프(`min(initial*2^attempt, max) * jitter(0.8~1.2)`)다.
- 힌트: `Retry-After`, `retry-after-ms`, `google.rpc.RetryInfo`를 읽어 1초~5분으로 자르지만 오픈소스판 재시도는 이 값을 대기에 쓰지 않고 기록만 한다. 엔터프라이즈 Adaptive Routing은 이 값을 키 제외 시간(최소 10초)으로 쓴다고 문서가 적는다.
- 복귀: 요청 범위의 키 상태이며, 한 요청 안에서 모든 키를 한 바퀴 돌면 사용 집합을 초기화한다. 요청이 끝나면 키는 다시 후보가 된다.

**쿼터 / 사용량 인식**
- 가상 키별 예산과 속도 제한이 있다. 모델 한도는 우선순위 4단계(모델+공급자 설정, 모델만, 전역 공급자, 가상 키 공급자 설정)로 해석된다.
- 라우팅 규칙 CEL에서 `budget_used`(공급자와 모델의 예산 사용률 0~100)와 `tokens_used`(토큰 속도 한도 사용률)를 읽을 수 있다. 문서 예시는 `budget_used > 80`이면 폴백 쪽으로 라우팅한다. 구독 한도(OAuth)를 인식해 넘기는 기능은 없고, 해당 요구는 이슈 #2316이다.

**작업 내용 기반 라우터**
- Routers(베타, v3.0.0에서 옛 Complexity Router를 대체): 분류기가 요청을 Simple, Medium, Complex 중 하나로 고르고 티어마다 모델(여러 개면 가중치)과 폴백을 지정한다. 분류기는 결정 모델(기본 TypeSafe Jev), 의미 기준 문구(임베딩 최근접), LLM 분류기 중 선택이다. 분류 실패나 티어에 모델이 없으면 요청이 원래 모델을 유지한다. 범위(가상 키, 사용자, 팀, 고객, 전역)와 CEL 조건과 우선순위로 라우터를 여러 개 병행한다. 옛 규칙에는 `complexity_tier`(SIMPLE, MEDIUM, COMPLEX) 변수가 있다.
- 코딩 에이전트의 역할 신호를 직접 읽는 기능은 확인하지 못했다(헤더는 CEL의 `headers[...]`로 읽을 수 있다).

**이슈 사례**
- [#2316](https://github.com/maximhq/bifrost/issues/2316) ChatGPT/Codex 구독용 OAuth 디바이스 코드 흐름 지원 요청(2026-03-26, 반응 9).
- [#2028](https://github.com/maximhq/bifrost/issues/2028) GitHub Copilot을 공급자로 추가(2026-03-11, 반응 18).

### katanemo/plano
- 별 7119, 마지막 push 2026-10-24 (`main`)
- 근거 파일(커밋 날짜): `docs/routing-api.md`(2026-08-18), `config/plano_config_schema.yaml`(2026-08-18), `cli/planoai/templates/coding_agent_routing.yaml`(2026-03-05)
- 선택 이유: 라우팅 선호(`routing_preferences`)를 모델별 자연어 설명으로 선언하는 설계다.

**라우팅 단위와 설정**
- 단위는 이름과 설명이 붙은 라우트이고 후보 모델 목록이 딸린다. v0.4.0 이상 설정: 최상위 `routing_preferences: [{name: "code generation", description: "...", models: [anthropic/claude-sonnet-4-6, openai/gpt-4o]}, ...]`, 모델 목록에서 `default: true`가 어디에도 안 맞을 때의 기본이다. 옛 v0.3.0 템플릿은 `model_providers` 안에 인라인 `routing_preferences`(`code generation`은 `openai/gpt-5-2025-08-07`, `code understanding`은 `openai/gpt-4.1-2025-04-14`)를 두고 `anthropic/claude-sonnet-4-5`를 기본으로 지정한다. 스키마는 인라인 방식을 deprecated로 표시하고 자동 이전한다고 적는다.
- 요청 본문의 `routing_preferences`가 해당 요청 한정으로 설정을 덮어쓴다.
- `model_aliases`로 `arch.claude.code.small.fast`를 `claude-haiku-4-5`로 연결하는 예가 있다.

**폴백 규칙**
- 라우팅 API는 순위가 매겨진 `models` 배열을 반환하고 문서의 클라이언트 패턴은 429나 5xx에서 다음 모델로 직접 재시도하는 방식이다. 게이트웨이가 모델 체인을 자동으로 넘기는지는 원문 미확인이다(스키마의 `max_retries`는 리스너 계층에 있다). 라우트가 맞지 않으면 요청의 `model`이 기본이다.

**쿼터 / 사용량 인식**
- 라우트 안에서 `selection_policy.prefer`가 `cheapest`, `fastest`, `none` 중 하나다. 비용은 DigitalOcean 가격 카탈로그나 `models.dev`에서, 지연은 Prometheus 쿼리에서 가져오는 `model_metrics_sources`가 있다. `routing_budget`은 세션 단위 비용 문턱으로, 모델을 바꾸면 프롬프트 캐시를 버리는 입력 토큰 비용이 누적되어 그대로 있었을 때 대비 일정 비율(예: 20%)을 넘으면 전환을 막는다. 캐시 입력 요율 추정 할인 기본값은 0.1이다.
- 계정이나 구독 쿼터 소진 인식은 확인하지 못했다.

**작업 내용 기반 라우터**
- 사용자 요청을 LLM 라우터가 `description`에 맞춰 분류한다(스키마의 `router: plano_orchestrator_v1`). 분류 모델의 학습 방식은 이 저장소의 읽은 파일에서 원문 미확인이다.

**이슈 사례**: 확인한 인기 이슈가 폴백과 쿼터 주제에 해당하지 않아 생략한다.

### vllm-project/semantic-router
- 별 6489, 마지막 push 2026-11-17 (`main`)
- 근거 파일(커밋 날짜): `website/docs/tutorials/signal/heuristic/agent.md`(2026-11-16), `website/docs/tutorials/algorithm/looper/escalate.md`(2026-11-16), `website/docs/tutorials/signal/application/complexity.md`, `config/fragments/decision/composite/priority-safe-escalation.yaml`(2026-11-09)
- 선택 이유: Claude Code와 Codex의 에이전트 신원 헤더를 읽어 서브에이전트 종류별로 모델을 고르는 `agent` 신호가 있다.

**라우팅 단위와 설정**
- 단위는 레시피 안의 결정(decision)이다. 결정은 `priority`(예: 160)와 `rules`(AND, OR, NOT 중첩 조건: `domain`, `keyword`, `complexity`, `jailbreak` 등 신호)와 `modelRefs`(모델과 `use_reasoning`)로 구성된다. YAML이다. 예시는 `modelRefs: [{model: qwen2.5:3b, use_reasoning: true}]`다.

**폴백 규칙**
- `escalate` 알고리즘: 결정의 후보를 순서대로 한 번에 하나씩 호출하고 확인을 통과한 첫 답을 반환한다. 기본은 작은 모델에서 큰 모델로 올라가는 모델 간 승격이다. 확인 방식은 토큰 신뢰도, 결정 모델의 `answer_check` 질문, `refusal` 질문이고 예시는 `budget: {deadline: 60s, max_calls: 2}`, `on_error: last_attempt`다.
- 발동: 답이 확인에 실패하거나 모델 호출이 실패하거나 확인을 실행할 수 없는 답이 오면 다음 후보로 넘어간다. 판정된 답이 하나도 없으면 요청이 실패한다. `on_error`는 `last_attempt`(기본, 확인이 끝난 마지막 답을 반환) 또는 `fail`이다.
- 429, 5xx 같은 전송 오류의 엔드포인트 폴백이나 쿨다운 규칙은 읽은 파일에서 원문 미확인이다.

**쿼터 / 사용량 인식**
- 승격 예산(`budget`의 데드라인과 호출 횟수)이 비용 상한 역할을 한다. 계정 쿼터 소진 인식은 확인하지 못했다. `website/docs/proposals/success-constrained-selection.md`는 제안 문서로 목록에서만 확인했다.

**작업 내용 기반 라우터**
- `complexity` 신호: 프리셋 질문 "How difficult is this request to answer well?"으로 easy, medium, hard를 판정한다. 예시 파일이 쓰는 `labels`는 easy, medium, hard이고 분류에는 예시 뱅크나 임계값 튜닝이 필요 없다고 문서가 적는다.
- `agent` 신호: Claude Code와 Codex의 헤더로 역할을 읽는다. `role`(main, subagent), `harness`(claude_code, codex), `types`(Explore, Plan, general-purpose, custom, Codex의 `collab_spawn`, `review`), `request_classes`(main, subagent, workflow, compaction, auxiliary)로 규칙을 만든다. 문서 예시는 `explore`(Explore와 collab_spawn 서브에이전트), `reviewer`(Codex review), `housekeeping`(compaction과 auxiliary)이고, 각 결정이 `modelRefs`로 모델과 effort를 정한다. 메인 에이전트는 기본 결정을 유지하되 compaction과 세션 제목은 작은 모델로 보낸다. Claude Code는 타입과 클래스를 `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`일 때만 보내며, 이 헤더는 Claude Code 2.1.325와 Codex CLI 0.166.0에서 확인했다고 문서가 적는다. 서브에이전트는 첫 요청의 모델을 평생 유지한다.
- 결정 모델 계열(`decision-1`, `decision-2`, `decision-3`)이 문서화되어 있으며 `vllm-sr connect claude-code` 명령이 설정을 써 준다.

**이슈 사례**
- [#5535](https://github.com/vllm-project/semantic-router/issues/5535) 도구 설명 16 KiB 하드코딩 제한이 Claude Code의 Artifact 도구를 거부(2026-10-27, 반응 10).

### agentgateway/agentgateway
- 별 6233, 마지막 push 2026-11-16 (`main`)
- 근거 파일(커밋 날짜): `schema/config.md`(2026-11-16), `crates/agentgateway/src/http/health.rs`(2026-10-12), `examples/llm-cost-routing/config.yaml`(2026-08-04), `examples/llm-callout-jev/README.md`(2026-10-07), `controller/pkg/agentgateway/translator/testdata/backends/llm-multi-priority.yaml`
- 선택 이유: 가상 모델의 `weighted`, `failover`, `conditional`, `callout` 라우팅을 스키마로 분리해 둔 설계다.

**라우팅 단위와 설정**
- `llm.models[]`(공급자와 파라미터, `visibility: internal`로 숨김)과 `llm.virtualModels[]`(공개 이름)이다. 가상 모델의 `routing`은 `weighted`(`targets[].weight`, 기본 1), `failover`(`targets[].priority`, 낮은 값이 먼저), `conditional`(`when` CEL 식을 순서대로 평가, 마지막 대상은 조건 없는 폴백), `callout`(외부 HTTP 서비스가 모델 선택) 중 하나다. 쿠버네티스 쪽에는 `ai.groups`(그룹 순서가 우선순위 0, 1, 2)와 `llm-multi-priority.yaml` 예시가 있다.
- 예시: `smart-model` 가상 모델이 `metadata.cost_tier`가 `economy`거나 `max_tokens <= 1024`면 `economy-model`(gpt-4o-mini), `<= 4096`이면 `balanced-model`(gpt-4o), 아니면 `premium-model`(gpt-4o)로 간다.
- `litellm` 설정을 임포트하는 테스트(`tests/import/litellm/`)가 있어 `fallbacks`, `default_fallbacks`, `max_fallbacks`, `context_window_fallbacks`, `content_policy_fallbacks`를 변환하는 사례를 볼 수 있다.

**폴백 규칙**
- 페일오버: 같은 우선순위 안에서는 건강과 지연을 합친 점수로 최선의 공급자를 고르고, 한 우선순위의 모든 모델이 저하되면 다음 우선순위 그룹으로 넘어간다(스키마 설명).
- 퇴출(`health.rs`): 응답이 비정상(CEL 또는 기본 5xx)이면 백엔드를 일정 시간 퇴출한다. 우선순위 그룹이 둘 이상인 AI 백엔드는 퇴출이 기본 켜짐이고 그 밖은 건강 정책이 필요하다. 퇴출 시간은 설정 값, 없으면 `Retry-After`(429 등), 그다음 재시도 정책의 백오프, 마지막으로 기본값(주석의 예는 3초)이다. `consecutive_failures`와 건강 임계값이 있고 둘 다 없으면 한 번의 비정상 응답이 퇴출을 일으킨다. 복귀 때의 건강 점수(예: 0.2)로 점진 회복한다. 4xx 중 어느 것이 퇴출 대상인지는 원문 미확인이다.
- 정책에는 별도로 `retry` 정책(HTTPRoute)이 있다.

**쿼터 / 사용량 인식**
- API 키별 `budgets`(`unit`이 `USD` 또는 `Tokens`, 응답이 사용량을 보고하지 않으면 과금하지 않음), `localRateLimit`과 `remoteRateLimit`(`type`이 requests 또는 tokens, `key`는 CEL로 `jwt.sub` 등 선택, 원격 서비스 실패 시 `failureMode` 기본 failClosed)가 있다. 예산 기반 모델 전환은 `conditional` CEL로 직접 만들어야 하고 자동 전환 코드는 확인하지 못했다.

**작업 내용 기반 라우터**
- `callout`: `examples/llm-callout-jev`는 `auto` 가상 모델이 `router.ts`에 묻고, 라우터가 Jev로 요청 복잡도를 점수화해 `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol` 중 고르며 오류 때는 `gpt-5.6-luna`로 폴백한다. `llm-semantic-routing` 예제도 있다. 코딩 에이전트 역할 신호 사용은 확인하지 못했다.

**이슈 사례**
- [#1255](https://github.com/agentgateway/agentgateway/issues/1255) 백엔드 간 페일오버 지원 요청(2026-03-17, 반응 1). 이후 `failover` 라우팅이 스키마에 들어온 것으로 보이나 연결은 직접 확인하지 못했다.

### tashfeenahmed/freellmapi
- 별 53577, 마지막 push 2026-11-16 (`main`)
- 근거 파일(커밋 날짜): `docs/en/architecture/01-routing-and-bandit-scoring.md`, `docs/en/architecture/02-quota-and-cooldown-engine.md`(2026-11-04), `docs/en/architecture/04-degraded-mode-and-failover.md`(2026-09-16), `README.md`
- 선택 이유: 무료 티어 87개 공급자를 키별 RPM, RPD, TPM, TPD로 추적하며 폴백과 쿨다운 단계를 가장 수치로 적은 설계다.

**라우팅 단위와 설정**
- 요청마다 `(platform, model, key)` 한 쌍을 고른다. 폴백 체인은 대시보드에서 순서를 정하고, 프로필(`profile_models`, 예: coding 체인, vision 체인)은 `auto:<프로필>`로 요청마다 고른다. 같은 모델이 여러 공급자에 있으면 한 항목으로 합쳐 엄격한 그룹 내 페일오버를 한다. 전략은 `balanced`(기본, 신뢰도 0.5, 속도 0.25, 지능 0.25), `smartest`, `fastest`, `reliable`, `custom`, `priority`, `decision`이다. 설정은 대시보드와 `PUT /api/fallback/routing`이다. 클라이언트에는 `/v1/messages`(Anthropic 형식)로 Claude Code를 붙일 수 있다.

**폴백 규칙**
- 발동: 429와 5xx에서 다음 모델로 재시도하며 쿨다운과 키 로테이션을 건다(README). 402는 24시간 `credit` 쿨다운, 403(티어에 없는 모델)은 24시간 `tier`, 일일 쿼터 소진은 UTC 자정이나 `Retry-After`까지, 401은 5분(헬스 사이클)이다.
- 쿨다운 단계(모델+키별 24시간 롤링): 1단계 2분, 2단계 10분, 3단계 1시간, 4단계 이후 24시간. 일시적인 RPM/TPM 429는 일일 카운터가 건강하면 90초 쿨다운이며 단계에 세지 않는다. 일일 한도(RPD/TPD) 도달만 단계를 올린다. 한도를 모르는 공급자는 1시간 안 429가 2번이면 사실상 일일 소진으로 보고 10분 상한까지 올린다. 로컬 엔드포인트는 5초 상한이다. `Retry-After`가 자체 쿨다운보다 길면 그 값(최대 24시간)을 권위 있는 값으로 쓴다.
- 시간 예산: 재시도 벽시계 예산 기본 45초(`FALLBACK_TIME_BUDGET_MS`), 첫 시도와 두 번째 시도는 항상 실행되어 페일오버가 구조적으로 가능하다. 예산이 지나면 진행 중 요청도 `AbortController`로 취소하고 이는 건강 불이익을 주지 않는다. 첫 바이트가 나간 뒤에는 취소하지 않는다.
- 저하 모드: 키가 하나 이상 쓸 수 있는 공급자 비율이 `DEGRADED_HEALTHY_RATIO` 0.5 미만으로 60초 지속되면 저하로 들어가고 120초 지속 복구되면 나온다(최소 공급자 3). 저하 중에는 밴딧 탐색을 끄고 남은 건강한 공급자의 점수 순서를 따른다.
- 복귀: 점수 기반이라 주 모델이 회복하면 자연스럽게 다시 선택되고, 대화는 30분 세션 고정으로 한 모델에 머물며 전환이 일어나면 옵트인 핸드오프 노트로 맥락을 잇는다.

**쿼터 / 사용량 인식**
- `(platform, model, key)`마다 RPM, TPM(슬라이딩 60초)과 RPD, TPD(UTC 자정) 카운터를 두고 공급자가 보고하는 상한을 학습한다. 진행 중 요청은 임시 사용량(lease)으로 세고 최대 2분 유지한다. 헤드룸 계수가 남은 비율 20%(`HEADROOM_RAMP_START` 0.2)부터 점수를 깎는다. 이슈 #456은 키가 늘어도 `monthly_token_budget`이 비례해 늘지 않는 문제다.

**작업 내용 기반 라우터**
- `decision` 전략(옵트인): 결정 모델(Cloudflare의 Clef, OpenRouter의 Mercury Decide)이 요청을 읽어 `smartest`, `fastest`, `balanced`, `reliable` 중 어느 프리셋이 맞는지 한 질문으로 고르고, 그 프리셋의 가중치로 체인을 점수화한다. 능력 게이트와 가드레일과 페일오버 순회는 그대로다.
- 신뢰도는 Thompson 샘플링(감쇠 반감기 2일의 Beta 사후분포)이고 미측정 모델에는 10% 탐색 하한(기본 꺼짐)이 있다.

**이슈 사례**
- [#895](https://github.com/tashfeenahmed/freellmapi/issues/895) 폴백 체인을 여러 개 두자는 요청(2026-08-15, 반응 4).
- [#456](https://github.com/tashfeenahmed/freellmapi/issues/456) `monthly_token_budget`이 공급자의 API 키 수에 비례해 늘지 않음(2026-07-03, 반응 5).

### Mesh-LLM/mesh-llm
- 별 4140, 마지막 push 2026-11-17 (`main`)
- 근거 파일(커밋 날짜): `mesh/website/src/docs/pages/automatic-routing.md`(2026-11-12), `mesh/docs/design/ROUTER_V2.md`(2026-10-05, 설계 제안)
- 선택 이유: 클라우드 쿼터가 아니라 여러 머신에 퍼진 로컬 모델을 라우팅하는 분산형이라 다른 설계의 대조 사례다.

**라우팅 단위와 설정**
- `model: "mesh"`가 자동 지시어이고 `auto`는 폐기 예정 별칭이다. 모델 이름을 직접 쓰면 그 모델로만 간다. 설정 파일은 `~/.mesh-llm/config.toml`이고 MoA는 `[[plugin]] name = "mesh-moa"`로 켠다.

**폴백 규칙**
- 요청이 도구, 이미지, 컨텍스트 길이를 처리할 수 있는 모델 하나를 고르고, 그 모델을 서빙하는 머신 중 측정 속도와 현재 부하와 세션 친화성으로 머신을 고른다.
- 발동: 머신이 바쁘면(429) 또는 불가(502~504)이면 첫 바이트 전에 건너뛴다. 500은 그대로 반환한다. 해당 모델의 머신이 모두 바쁘거나 불가면 호환되는 다른 모델을 최대 3개 더 시도한다. 타임아웃은 같은 모델의 다른 머신으로만 옮기고 다른 모델로는 옮기지 않는다. 이미지 요청인데 이미지 입력 모델이 없으면 텍스트 부분만 답하지 않고 422로 실패한다. 스트림이 시작된 뒤에는 재시도할 수 없어 응답이 끊긴다.

**쿼터 / 사용량 인식**
- 구독이나 크레딧 쿼터 개념은 없다. `/v1/models`가 모델별 `replicas`와 `active_requests`를 노출한다. 문서는 "큰 모델", "싼 모델" 같은 선호는 자동 라우팅이 받지 않고 호출자가 `/v1/models` 목록으로 직접 고르게 한다고 의도를 적는다.

**작업 내용 기반 라우터**
- 현재 v1은 정적 키워드 분류기(Code, Reasoning, Creative, ToolCall, Chat)이고 `ROUTER_V2.md`는 "Design proposal" 상태다. V2 제안은 휴리스틱(µs, 모델 없음), 더 비싼 단계 순으로 의도를 분류하며 도구 힌트, 파일 확장자, "fix/debug/refactor" 같은 패턴, 20토큰 미만이면 quick-fact 같은 신호를 쓴다. 구현 여부는 원문 미확인이다.
- MoA 플러그인(옵트인): 두 개 이상의 배치가 가능하고 하나가 10B 이상이면 비스트리밍 텍스트 채팅을 위원회가 답하고 한 모델이 종합한다.

**이슈 사례**: 폴백이나 쿼터 주제의 이슈는 찾지 못했다.

### QuantumNous/new-api
- 별 52038, 마지막 push 2026-11-16 (`main`)
- 근거 파일(커밋 날짜): `model/channel_cache.go`(2026-11-12), `setting/operation_setting/status_code_ranges.go`(2026-07-27), `service/channel.go`, `service/channel_select.go`, `common/constants.go`
- 선택 이유: 채널의 우선순위와 가중치를 재시도 횟수에 묶는 단순하고 널리 배포된 설계다.

**라우팅 단위와 설정**
- 단위는 채널이다. 채널에 그룹, 모델 목록, `priority`, `weight`, 여러 업스트림 키를 붙인다. 모델 매핑, 채널 어피니티(`channel_affinity`)가 README가 나열한 기능이다. 설정은 관리 콘솔 DB이고 파일 예시는 확인하지 못했다.

**폴백 규칙**
- 우선순위 단계: `GetRandomSatisfiedChannel`은 `retry`번째 시도에 정렬된 고유 우선순위 중 `retry`번째 값을 쓴다. 가장 높은 우선순위 채널들이 가중치 랜덤으로 먼저 선택되고, 재시도할 때마다 다음 우선순위 단계로 내려간다. 재시도 횟수가 우선순위 수를 넘으면 마지막 우선순위를 쓴다. 가중치가 모두 0이면 균등으로 본다. `auto` 토큰 그룹에서 교차 그룹 재시도가 켜지면 한 그룹의 우선순위를 모두 소진한 뒤 다음 그룹으로 간다.
- 재시도 횟수: `common.RetryTimes` 기본값은 0이다(`common/constants.go`). 즉 설정하지 않으면 폴백이 일어나지 않는다.
- 발동 상태 코드(기본, `AutomaticRetryStatusCodeRanges`): 100~199, 300~399, 401~407, 409~499, 500~503, 505~523, 525~599. 항상 건너뛰는 코드는 504와 524, 오류 코드 `BadResponseBody`다. 429와 408이 기본 범위에 들어 있다.
- 자동 비활성화: `AutomaticDisableChannelEnabled` 기본 false이고, 켜면 기본 상태 코드 401과 키워드 매칭으로 채널을 비활성화한다. 채널 키와 설정 오류는 비활성화하고 new-api가 직접 만든 로컬 오류는 하지 않는다. 자동 복구는 `AutomaticEnableChannelEnabled`로 켠다(채널 테스트 성공 때 `ChannelStatusAutoDisabled`에서 복구).

**쿼터 / 사용량 인식**
- 사용자 쿼터, 구독, 로그, 캐시 회계, 수식 기반 가격 책정이 있다(README). 채널 잔액 조회(`channel_balance`)와 `quota_reserve.go`가 있다. 공급자 구독 한도 소진 인식은 확인하지 못했다.

**작업 내용 기반 라우터**: 없음.

**이슈 사례**
- [#3192](https://github.com/QuantumNous/new-api/issues/3192) OpenAI 업스트림 `server_error`와 스트림 실패 시 자동 재시도 권장 방안 문의(2026-03-09, 반응 3).

### lm-sys/RouteLLM (낡음)
- 별 5712, 마지막 push 2024-08-10 (`main`). 약 15개월 넘게 정지되어 낡았다.
- 근거 파일(커밋 날짜): `README.md`(2024-07-20)
- 선택 이유: 강한 모델과 약한 모델 사이를 학습된 라우터로 고르는 원조 연구 구현이다.

**라우팅 단위와 설정**: 강한 모델과 약한 모델 한 쌍을 정하고 라우터 이름과 비용 임계값을 모델 문자열에 넣는다(`model="router-mf-0.11593"`). 예시는 `strong_model="gpt-4-1106-preview"`, `weak_model="anyscale/mistralai/Mixtral-8x7B-Instruct-v0.1"`, `routers=["mf"]`이다.

**폴백 규칙**: 장애 폴백 규칙은 없다. 확인한 README에 해당 설명이 없다.

**쿼터 / 사용량 인식**: 없음. 대신 `python -m routellm.calibrate_threshold --routers mf --strong-model-pct 0.5`로 강한 모델 호출 비율 50%에 맞는 임계값(예시 출력 0.11593)을 구한다.

**작업 내용 기반 라우터**: 요청별 점수가 임계값을 넘으면 강한 모델로 보낸다. 라우터 종류(`mf` 등)와 학습 데이터 설명은 README 일부만 읽었고 나머지는 원문 미확인이다.

### Portkey-AI/gateway (3개월 이상 정지)
- 별 13391, 마지막 push 2026-05-25 (`main`). 오늘(2026-11-17)로부터 약 6개월 전이라 정지 상태다.
- 근거 파일(커밋 날짜): `src/handlers/handlerUtils.ts`(2026-01-12), `src/handlers/retryHandler.ts`(2025-07-16), `src/globals.ts`(2025-12-23), `src/services/conditionalRouter.ts`, `cookbook/getting-started/resilient-loadbalancing-with-failure-mitigating-fallbacks.md`
- 선택 이유: 설정 JSON으로 `fallback`, `loadbalance`, `conditional` 전략을 중첩하는 형식이 다른 게이트웨이의 기준이 된다.

**라우팅 단위와 설정**: 설정은 `strategy.mode`(`fallback`, `loadbalance`, `conditional`)와 `targets` 배열이다. 타깃에 `weight`(예: 0.5)를 주고 타깃 안에 중첩 `strategy`를 둘 수 있다(쿡북 예시는 loadbalance 안에 fallback). 조건 라우팅은 `metadata`와 `params`를 `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte` 같은 연산자로 비교한다.

**폴백 규칙**: `fallback` 모드는 타깃을 순서대로 시도한다. `strategy.on_status_codes`가 있으면 응답 상태가 그 목록에 없을 때, 없으면 응답이 ok일 때, 또는 `x-portkey-gateway-exception` 헤더가 true일 때 폴백을 중단한다. 즉 목록이 없으면 비정상 응답이면 모두 다음 타깃으로 넘어간다. 재시도는 `retry.attempts`와 `retry.onStatusCodes`로 따로 설정하며 전역 기본은 `RETRY_STATUS_CODES = [429, 500, 502, 503, 504]`, `MAX_RETRIES = 5`, `MAX_RETRY_LIMIT_MS = 60초`다. `useRetryAfterHeader`로 `Retry-After`를 따른다. 쿨다운이나 복귀 상태 규칙은 확인하지 못했다.

**쿼터 / 사용량 인식**: 이 저장소(오픈소스 게이트웨이)에서 예산 기반 전환은 확인하지 못했다.

**작업 내용 기반 라우터**: 메타데이터와 요청 파라미터에 대한 조건 라우팅만 있고 내용 분류는 없다.

**이슈 사례**
- [#1047](https://github.com/Portkey-AI/gateway/issues/1047) AWS Bedrock 검증 예외가 처리되지 않음(2025-04-17, 반응 6).

### Wei-Shaw/claude-relay-service
- 별 12812, 마지막 push 2026-11-16 (`main`)
- 근거 파일(커밋 날짜): `src/services/scheduler/unifiedClaudeScheduler.js`(2026-07-09), `src/utils/commonHelper.js`(2026-01-22), `README.md`(2026-07-10), `.env.example`(2026-03-20)
- 선택 이유: Claude Max 같은 구독 계정을 여러 명이 나눠 쓰는 "카풀" 용도의 릴레이여서 구독 한도 처리가 핵심이다. 코드 주석과 README는 중국어다.

**라우팅 단위와 설정**
- 단위는 계정(Claude 공식 OAuth, Claude Console, Bedrock, CCR, Gemini, OpenAI, Droid 등)과 계정 그룹이다. API 키마다 전용 계정(`claudeAccountId` 등)을 묶거나 공유 풀을 쓴다. 계정에 `priority`(기본 50, 작을수록 먼저)와 `schedulable` 플래그가 있다.
- 선택 순서(`sortAccountsByPriority`): 우선순위 숫자, 그다음 `lastUsedAt`이 오래된 것, 그다음 `createdAt`이다. 스티키 세션은 `STICKY_SESSION_TTL_HOURS=1`, 갱신 임계 `STICKY_SESSION_RENEWAL_THRESHOLD_MINUTES=15`다.

**폴백 규칙**
- 전용 계정이 한도나 일시 불가면 공유 풀로 내려가는 분기가 코드에 있다(Console, Bedrock 전용 계정은 "falling back to pool"). Claude OAuth 전용 계정이 한도 걸림이면 풀로 내리지 않고 오류를 던지는 분기도 있다.
- 임시 정지 TTL(`.env.example`, 주석 처리된 기본값): 503은 60초(`UPSTREAM_ERROR_503_TTL_SECONDS`), 500/502 등 5xx는 300초, 529 과부하는 600초, 401/403 인증 오류는 1800초, 504 타임아웃은 300초다. 계정별로 "임시 냉각 끄기"와 503, 5xx 냉각 초를 덮어쓸 수 있고 우선순위는 계정 비활성, 계정 초, 호출 시 TTL, 전역 환경변수 순이다. 관리 화면은 "불가 사유"(오류 종류, 상태 코드, 총 냉각 시간, 남은 시간, 복구 예상)를 보여 주고 "상태 리셋"으로 복귀시킨다. 복귀는 TTL 경과 또는 수동 리셋이다.

**쿼터 / 사용량 인식**
- 요청 모델이 속한 한도 가족(opus, sonnet, haiku, fable)별로 독립 한도 걸림을 따로 본다(`unifiedClaudeScheduler.js`). 한도 걸림 판정은 `temp_unavailable`보다 먼저 한다는 주석이 있다(과거 버그로 `markAccountRateLimited`가 `schedulable=false`와 임시 불가를 함께 써서 복구가 꼬였다). 한도 걸림이 있는 Claude Console 계정은 쿼터 초과(`isQuotaExceeded`)도 후보에서 뺀다. 계정 잔액 서비스와 쿼터 카드 관리 라우트도 있다.

**작업 내용 기반 라우터**: 없음. 모델 이름(opus 포함 여부)으로 계정 유형을 걸러내는 정도다.

**이슈 사례**
- [#588](https://github.com/Wei-Shaw/claude-relay-service/issues/588) 한도 걸림이 잦아 체감이 나쁘다는 불만(2025-10-17, 반응 9).
- [#989](https://github.com/Wei-Shaw/claude-relay-service/issues/989) Opus 1M, Sonnet 1M 컨텍스트 모델로 구독이 한도 걸림(2026-02-18, 반응 6).


---

### QwenLM/qwen-code
- 별 30672, 마지막 push 2026-11-17
- 근거 파일(커밋 날짜): 사용자 문서 `features/sub-agents.md`(2026-11-08), `configuration/settings.md`(2026-11-16), `docs/design/subagent-model-grade.md`(2026-07-26), `docs/design/auto-classifier-main-model-fallback.md`(2026-11-13), `docs/design/auto-classifier-unavailable-fallback.md`(2026-10-10)
- 선택 이유: 서브에이전트 모델 해석 순서와 용량 오류 폴백이 사용자 문서에 있다.

**역할과 모델**
- 서브에이전트 정의의 `model` 필드는 `inherit`, `fast`, 모델 ID, `authType:modelId` 중 하나다. 필드를 생략하면 `inherit`와 같다.
- `fast`는 `fastModel` 설정을 쓰고, 유효한 값이 없으면 `inherit`로 떨어진다.
- 내장 Explore는 기본이 메인 세션 모델 상속이다. 이전 버전은 Explore에 `fastModel`을 기본으로 썼고, 그 동작을 유지하려면 `agents.builtin.exploreModel`을 `fast`로 둔다.
- 등급 선택: `agents.modelGrades`(예: `small`은 `fast`, `high`는 `qwen-max`)와 `allowedGrades`를 두면 Agent 도구 스키마에 등급 이름만 노출한다. 해석 우선순위는 비내장 에이전트의 명시 모델, 허용된 등급, 내장 Explore 설정, 부모 모델이다.
- 포크 서브에이전트는 캐시 유지를 위해 부모 모델을 그대로 쓰고 등급 지정을 거부한다.
- `claude-code`, `codex` 내장 에이전트는 별도 설치된 네이티브 도구에 위임하고, 실행 파일이 없어도 자체 모델로 폴백하지 않는다고 문서가 적었다.
- 기본 모델 문자열은 문서에서 확인하지 못했다. 원문 미확인.

**폴백 / 쿼터**
- `modelFallbacks`: 쉼표 구분 모델 ID 최대 3개를 순서대로 시도한다. 조건은 주 모델의 용량 오류(429, 503, 529)다. `--fallback-model` 플래그로도 지정하고 재시작이 필요하다.
- 권한 분류기(Auto 모드)는 `fastModel`로 돌고, 1단계 타임아웃이 나면 세션 모델이 한 번 독립 판정한다. 다른 오류는 수동 승인으로 넘어간다. 기본 예산은 1단계 10초, 2단계 30초다.
- `modelPricing` 설정으로 `/stats model`의 비용 추정을 보여 준다. 사용량을 보고 모델을 바꾸는 규칙은 확인하지 못했다.

**라우터 / 리드 / 소통**
- 작업 단위 자동 라우터는 없다. 모델이 등급 이름을 골라 서브에이전트를 띄운다.
- 팀 팀메이트는 구체 모델 ID만 받아 등급 지정을 거부한다.

**이슈 사례**
- [#13895](https://github.com/QwenLM/qwen-code/issues/13895) 2026-10-11: 공급자의 429 본문 `error.code`가 알려진 코드에 없으면 `modelFallbacks`가 건너뛰어진다. 댓글 4.
- [#8021](https://github.com/QwenLM/qwen-code/issues/8021) 2026-07-29: 의도 기반 역할에 모델 묶음을 연결하자는 요청. oh-my-pi의 `default`, `smol`, `slow`, `plan` 역할을 근거로 들었다. 반응 1.

---

### pingdotgg/t3code
- 별 63002, 마지막 push 2026-11-17
- 근거 파일(커밋 날짜): `packages/contracts/src/model.ts`(2026-11-02), `packages/shared/src/usageLimits.ts`(2026-11-14), `apps/server/src/textGeneration/ClaudeTextGeneration.ts`(2026-11-17)
- 선택 이유: 여러 에이전트 CLI를 제어하는 GUI이고 제공자별 기본 모델과 소진 폴백이 코드에 있다.

**역할과 모델**: 아래 값은 `packages/contracts/src/model.ts`에서 직접 읽었다.

| 제공자 | 기본 모델 | 텍스트 생성(커밋 메시지 등) 모델 |
|---|---|---|
| Codex | `gpt-6-astra` | `gpt-6-luna`, effort `low` |
| Claude | `claude-opus-5-5` | `claude-haiku-5-5` |
| Cursor | `auto` | `composer-2` |
| OpenCode | `openai/gpt-5` | `opencode/big-pickle` |
| Antigravity | `antigravity-default`(세션 현재 모델 유지) | 같은 값 |

- 텍스트 생성 effort 기본값은 `low`(`DEFAULT_TEXT_GENERATION_REASONING_EFFORT`)다.
- Codex 선호 목록은 `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra` 순서이고, 목록에 먼저 있는 모델이 이긴다. 없으면 Codex의 `isDefault`를 쓴다.
- 역할은 "메인 작업"과 "텍스트 생성" 두 종류뿐이다. 구현자, 리뷰어 같은 역할 구분은 없다.

**폴백 / 쿼터**
- `settings.ts`에 `fallbackModelSelection`(기본 `null`)이 있다.
- `resolveNewThreadModelSelection`은 명시 선택이 없을 때만 동작한다. 기본 선택의 제공자 사용량 창이 `usedPercent >= 100`이고 `resetsAt`이 미래면 소진으로 본다. 그때 폴백 제공자가 활성, 설치됨, 인증됨, 사용 가능, 소진 아님, 프로젝트 설정에서 허용됨을 모두 만족해야 폴백 모델로 교체한다. 하나라도 아니면 원래 선택을 유지한다.
- 소진 판정은 제공자별이다. Cursor는 `apiPercentUsed`와 `autoPercentUsed`를 구분하고, Antigravity는 모델 계열 풀(gemini, claude, gpt, 3p)로 나누며, Codex는 좌석제 플랜에서 크레딧 창을 제외한다.
- Claude 안전장치(safeguard) 플래그 때의 전환은 Claude Code의 `switchModelsOnFlag` 설정과 연동된다는 이슈가 열려 있다. 코드 원문은 확인하지 못했다.

**라우터 / 리드 / 소통**: 작업 단위 라우터는 없다. 스레드 모델은 사용자가 고르고, 폴백은 새 스레드의 암묵 선택에만 적용된다.

**이슈 사례**
- [#28203](https://github.com/pingdotgg/t3code/issues/28203) 2026-10-31: MCP `delegate_task`가 소진된 부모 모델을 그대로 상속해 설정된 폴백을 우회한다. MCP capability에도 폴백이 노출되지 않는다. 반응 0.
- [#24043](https://github.com/pingdotgg/t3code/issues/24043) 2026-10-23: `switchModelsOnFlag`를 끄면 안전장치 플래그에서 턴이 에러로 끝나고 폴백 모델로 재시도할지 묻지 않는다.

---

### multica-ai/multica
- 별 56383, 마지막 push 2026-11-17
- 근거 파일(커밋 날짜): `server/migrations/050_agent_model.up.sql`(날짜 미확인), `server/pkg/agent/claude_models.go`(2026-10-15), `apps/docs/content/docs/squads.mdx`(2026-10-26)
- 선택 이유: 에이전트를 팀원으로 두고 이슈를 배정하는 오케스트레이터이며 스쿼드 리더 구조가 있다.

**역할과 모델**
- Multica는 모델을 싣지 않고 설치된 에이전트 CLI(Claude Code, Codex, Cursor, Copilot, Kimi, OpenCode 등)를 구동한다고 README가 적었다.
- 에이전트마다 일급 `model` 컬럼 하나가 있다. 마이그레이션 주석에 따르면 이전에는 `custom_env`와 `custom_args`로만 고를 수 있었고, Codex 계열 app-server는 `-m`을 거부해서 컬럼을 만들었다. 이슈 본문에는 `thinking_level`, `service_tier` 필드도 언급된다.
- Claude 모델 목록은 설치된 CLI의 `list_models` 제어 요청으로 발견한다. 모델을 호출하지 않아 과금이 없다. 카탈로그에 없어도 저장된 설정은 지우지 않는다.
- 역할별 기본 모델은 없다. 기본값 문자열은 확인하지 못했다. 원문 미확인.

**폴백 / 쿼터**: 구현된 폴백은 확인하지 못했다. 요청 이슈만 여럿 있다.

**라우터 / 리드 / 소통**
- 스쿼드: 리더 에이전트 1명과 구성원(에이전트 또는 사람)으로 이루어진다. 이슈를 스쿼드에 배정하면 리더만 먼저 호출하고, 리더가 `@멘션`으로 한 번 위임한 뒤 멈춘다. 리더는 구현하지 않는다.
- 리더 프롬프트에는 하드코딩된 운영 규약, 구성원 명단, 사용자 지시가 매 턴 붙는다. 역할 설명은 컨텍스트일 뿐 권한을 주지 않는다.
- 리더 모델을 따로 정하는 규칙은 문서에서 확인하지 못했다.

**이슈 사례**
- [#3963](https://github.com/multica-ai/multica/issues/3963) 2026-06-09: 에이전트에 폴백 모델을 두어 장애, rate limit, 용량 오류 때 자동으로 보조 모델로 재시도하자는 요청. 현재는 에이전트당 `model` 하나뿐이라고 밝혔다. 반응 3.
- [#6531](https://github.com/multica-ai/multica/issues/6531) 2026-08-06: 주 모델과 폴백 모델의 자동 전환(failover). 반응 1, 댓글 3.
- [#5008](https://github.com/multica-ai/multica/issues/5008) 2026-07-06: 런타임 단위 기본 모델을 두고 에이전트 지정이 덮어쓰게 하자는 요청.

---

### stablyai/orca
- 별 126911, 마지막 push 2026-11-17
- 근거 파일(커밋 날짜): `skills/orchestration/SKILL.md`(2026-11-14), `README.md`(2026-11-16)
- 선택 이유: 구독 계정으로 코딩 에이전트 여러 개를 워크트리별로 돌리는 도구이고 오케스트레이션 스킬이 있다.

**역할과 모델**
- 모델은 에이전트를 띄울 때 한 번 정한다(`orca agent launch --model ...`). 바꾸려면 종료 후 재실행이라 컨텍스트를 잃는다고 이슈가 적었다.
- 오케스트레이션 스킬은 "다른 에이전트(예: Claude에서 Codex)로 리뷰시켜라" 같은 요청을 해당 에이전트의 Orca 워커로 처리하라고 지시한다. 사용자가 Orca 오케스트레이션을 요청했는데 비Orca 서브에이전트로 대체하는 것을 금지한다.
- 역할별 기본 모델은 확인하지 못했다. 원문 미확인.

**폴백 / 쿼터**
- README에 "Usage & Accounts": 에이전트 한도 사용량과 리셋 시각을 보여 주고, 로그아웃 없이 계정을 전환한다.
- 한도 소진 시 자동 폴백이나 계정 전환은 구현이 확인되지 않고 요청 이슈로만 있다.

**라우터 / 리드 / 소통**: 코디네이터 루프, 메시지와 게이트, 배치(placement)와 원격, 복구와 정리를 다루는 참조 문서가 `skill-guides/orchestration/references/`에 있다. 본문은 모델 배정이 아니라 토폴로지와 메시징 규약이다.

**이슈 사례**
- [#20512](https://github.com/stablyai/orca/issues/20512) 2026-09-13: 관리형 Claude/Codex 구독 계정의 rate limit 자동 failover 요청. 반응 10, 댓글 22, 열림.
- [#41937](https://github.com/stablyai/orca/issues/41937) 2026-11-13: 에이전트 간 모델 전환기, 사용량 표시, 한도 도달 시 폴백. 한 모델이 주간 한도에 도달하면 그 모델의 모든 에이전트가 멈춘다고 적었다. 반응 1.

---

### max-sixty/worktrunk
- 별 12576, 마지막 push 2026-11-16
- 근거 파일(커밋 날짜): `README.md`(2026-11-08)
- 선택 이유: 병렬 에이전트용 git worktree CLI라서 확인했다.

해당 없음: 모델이나 역할을 정하는 하네스가 아니라 worktree 관리 CLI다. README는 `wt switch -c -x claude feat`처럼 사용자가 고른 에이전트를 실행하고, LLM 커밋 메시지와 브랜치 요약은 사용자가 지정한 외부 명령에 맡긴다고 설명한다. 모델 기본값과 폴백 설정은 확인하지 못했다.

---

### kagent-dev/kagent
- 별 4387, 마지막 push 2026-11-16
- 근거 파일(커밋 날짜): `go/api/v1alpha3/modelconfig_types.go`(2026-11-11)
- 선택 이유: 쿠버네티스 에이전트 프레임워크이고 `ModelConfig` CRD가 있어서 확인했다.

해당 없음: 코딩 하네스가 아니라 클러스터 에이전트 런타임이다. `ModelConfig`는 제공자별 파라미터(최대 토큰, 캐시 쓰기 단가 주석, OpenAI reasoning effort 등)를 담는 자원이고 에이전트가 이를 참조한다. 이 타입 파일에서 `fallback` 항목은 찾지 못했다.

---

### block/buzz
- 별 37536, 마지막 push 2026-11-17
- 근거 파일(커밋 날짜): `crates/buzz-agent/src/config.rs`(2026-09-23), `VISION_AGENT.md`(2026-06-26)
- 선택 이유: 사람과 에이전트가 같은 방에서 일하는 작업 공간이고 자체 코딩 에이전트 크레이트가 있다.

**역할과 모델**
- 역할별 모델 기본값은 확인하지 못했다. `buzz-acp`는 환경변수 `BUZZ_ACP_MODEL` 하나를 모든 세션에 적용한다고 이슈가 적었다.
- 노력 수준은 `BUZZ_AGENT_THINKING_EFFORT`(`none|minimal|low|medium|high|xhigh|max`)로 지정하고, 미지정이면 제공자 기본 동작을 유지한다.

**폴백 / 쿼터**
- 같은 모델 안에서 지원되지 않는 노력 수준을 가장 가까운 지원 수준으로 낮춘다. `none`과 `minimal`은 서로 첫 폴백이고, `xhigh`는 미지원이면 `high`, `max`는 해당 계열 표에 없으면 낮은 수준으로 내려간다. 모델 능력 매니페스트(`model_capabilities`)의 `supported_efforts`를 쓴다.
- 모델 단위 폴백은 구현이 확인되지 않고 요청 이슈가 있다.

**라우터 / 리드 / 소통**: 작업 단위 라우터는 확인하지 못했다. 소통은 Nostr 릴레이의 이벤트 로그 하나로 사람과 에이전트가 같다.

**이슈 사례**
- [#5605](https://github.com/block/buzz/issues/5605) 2026-08-11: 구독 한도가 소진된 모델에서 헤드리스 에이전트가 한도 안내문만 계속 답한다. 모델 폴백 목록을 요청했다. 재현 예시로 Fable 5 한도 소진을 들었다. 반응 0, 댓글 1.

---

### davila7/claude-code-templates
- 별 33882, 마지막 push 2026-11-17
- 근거 파일(커밋 날짜): `cli-tool/components/agents/`(423개 md 파일, 트리 직접 집계), 표본 60개의 프런트매터
- 선택 이유: Claude Code 에이전트 템플릿 레지스트리라 역할별 모델 지정 관행을 보여 준다.

**역할과 모델**
- 에이전트 파일 423개 중 무작위 표본 60개의 `model:` 프런트매터를 읽었다: `sonnet` 15개, `inherit` 1개, `claude-sonnet-4-5` 1개, 지정 없음 43개.
- 오케스트레이터 계열 이름(`workflow-orchestrator`, `research-orchestrator` 등)이 있으나 모델은 별도 지정이 확인되지 않았다.
- 표본이라 전체 비율은 원문 미확인.

**폴백 / 쿼터**: 해당 없음. 템플릿 모음이라 런타임 폴백 로직이 없다.

**라우터 / 리드 / 소통**: 확인하지 못했다.

---

### luongnv89/claude-howto
- 별 47330, 마지막 push 2026-11-14
- 근거 파일(커밋 날짜): `04-subagents/README.md`(2026-11-14), `04-subagents/*.md` 9개
- 선택 이유: Claude Code 서브에이전트 예제와 모델 지정 설명이 있다.

**역할과 모델**
- 예제 서브에이전트 9개 중 8개가 `model: inherit`, `data-scientist`만 `sonnet`이다.
- README는 `model`이 `sonnet`, `opus`, `haiku`, 전체 ID, `inherit` 중 하나이고 `effort`가 `low`부터 `max`까지라고 적었다. `CLAUDE_CODE_SUBAGENT_MODEL`로 서브에이전트 모델을 정하고, `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`(v2.1.257 이후)은 프런트매터를 덮어쓴다고 한다. 이는 Claude Code 동작을 풀어 쓴 2차 자료이고 공식 문서 원문은 이 조사에서 확인하지 않았다.
- 내장 서브에이전트 표: `general-purpose`, `Plan`, `claude`는 상속, `Explore`는 상속하되 Opus 상한, `statusline-setup`은 Sonnet, `claude-code-guide`는 Haiku라고 적었다.

**폴백 / 쿼터**: 해당 없음. 가이드 문서다.

**라우터 / 리드 / 소통**: 확인하지 못했다.

---

### anthropics/claude-quickstarts
- 별 21072, 마지막 push 2026-11-06
- 근거 파일(커밋 날짜): `agents/agent.py`(2026-10-23), `autonomous-coding/autonomous_agent_demo.py`(2025-11-26)
- 선택 이유: Anthropic 공식 예제이고 자율 코딩 데모가 있다.

**역할과 모델**
- `agents/agent.py`의 `ModelConfig` 기본 모델은 `claude-sonnet-5-5`다.
- `autonomous-coding`의 `DEFAULT_MODEL`은 `claude-sonnet-4-5-20250929`이고 `--model` 플래그로 바꾼다. 마지막 커밋이 2025-11-26이라 오래된 기본값이다.
- 역할별 구분은 없다. 단일 모델을 쓰는 예제다.

**폴백 / 쿼터**: 확인하지 못했다. 해당 없음에 가깝다.

**라우터 / 리드 / 소통**: 없음.

---

### alibaba/open-code-review
- 별 53074, 마지막 push 2026-11-17
- 근거 파일(커밋 날짜): `cmd/opencodereview/config_cmd.go`(2026-11-16), `README.md`, `internal/llm/retry_boundary.go`
- 선택 이유: 코드 리뷰 전용 에이전트 CLI이고 리뷰 모델과 호스트 에이전트 위임 모드를 구분한다.

**역할과 모델**
- 제공자 항목(`ProviderEntry`)에 `model`, `models`(목록), `timeout_sec`, `retry_codes`, 프로토콜, 인증 헤더가 있고, 활성 제공자 하나와 활성 모델 하나를 `ocr config set`으로 고른다. 예시는 `claude-opus-4-6`이다.
- README는 두 모드를 구분한다. `ocr review`는 OCR 자체 제공자 설정으로 모델을 호출하고, `delegate-review`는 호스트 에이전트의 모델과 인증을 쓴다.
- 파일 묶음(bundle)마다 격리된 컨텍스트의 서브에이전트가 돈다. 서브에이전트별 모델 지정은 확인하지 못했다.

**폴백 / 쿼터**
- `retry_codes`로 재시도할 HTTP 코드를 설정한다. `internal/llm/retry_*.go`는 같은 요청의 재시도 기록과 오류 분류를 다룬다. 다른 모델로 넘기는 체인은 확인하지 못했다. 원문 미확인.

**라우터 / 리드 / 소통**: 결정론적 엔지니어링이 파일 묶음과 규칙 매칭을 맡고, 에이전트가 동적 컨텍스트 검색을 맡는 혼합 구조라고 README가 적었다. 모델 라우터는 없다.

---

### openai/codex-security
- 별 13801, 마지막 push 2026-11-17
- 근거 파일(커밋 날짜): `docs/project-configuration.md`(2026-11-16)
- 선택 이유: Codex 위에서 병렬 워커와 서브에이전트로 스캔하는 보안 도구라서 확인했다.

**역할과 모델**
- 모델과 effort는 이 도구가 정하지 않고 네이티브 Codex 설정(프로필 포함)에 위임한다. `codex` 항목이 `--codex`와 모델 및 제공자 플래그로 전달된다.
- 딥 스캔 기본값은 문서 예시로 `workers: 4`, `subagents_per_worker: 3`, `stop_after_no_new: 4`, `stop_after_consecutive_errors: 3`, `max_discovery_runs: 40`이다. 이 값은 Python 플러그인과 공유되는 기존 기본값이라고 문서가 밝혔다.
- 역할별 모델 구분은 확인하지 못했다.

**폴백 / 쿼터**
- 비용 상한: `limits.max_cost_usd_per_scan`(`--max-cost`). 문서 예시값 10은 설명용이라고 적었다.
- 시간 상한: 딥 스캔의 발견 단계는 기본이자 최대 5760분이다.
- 연속 오류 3회에서 중단하는 규칙(`stop_after_consecutive_errors`)이 있다. 다른 모델로의 폴백은 확인하지 못했다.

**라우터 / 리드 / 소통**: 확인하지 못했다.

**이슈 사례**: 모델 배정 요구 사례는 찾지 못했다. [#2412](https://github.com/openai/codex-security/issues/2412)는 커스텀 xAI 제공자가 `namespace` 도구 타입을 거부해 스캔이 실패하는 건이다.

---

### garrytan/gbrain
- 별 33163, 마지막 push 2026-11-17
- 근거 파일(커밋 날짜): `skills/conventions/model-routing.md`(2026-10-03), `docs/guides/chat-fallback.md`(2026-10-19), `src/core/model-config.ts`(2026-10-13)
- 선택 이유: 코딩 하네스는 아니고 에이전트 메모리 계층이다. 다만 내부 LLM 호출의 모델 티어와 폴백 체인이 문서화되어 있고 `gbrain agent run`이 멀티턴 서브에이전트 루프를 돌려서 포함했다.

**역할과 모델**: `model-routing.md`의 표다. 기본값은 Anthropic 키가 있을 때 기준이다.

| 티어 | 용도 | 기본 모델 |
|---|---|---|
| `utility` | 분류, 쿼리 확장, 판정, 중복 제거 | `claude-haiku-4-5-20251001` |
| `reasoning` | 기본 채팅, 합성, 생성 | `claude-sonnet-4-6` |
| `deep` | 느리고 비싼 추론(`gbrain think` 등) | `claude-opus-4-7` |
| `subagent` | 도구 루프(`gbrain agent run`) | `claude-sonnet-4-6` |

- 키 인식 기본값: `OPENAI_API_KEY`만 있으면 모든 티어가 OpenAI로 해석되고, 계정의 `GET /v1/models`에서 가격이 있는 최신 모델을 24시간 캐시로 고른다. 특정 모델 ID를 고정하지 않는다.
- 재정의 우선순위(높은 순): CLI 플래그, 작업별 설정, 폐기된 작업별 설정, 티어 재정의, 전역 기본, 환경변수 `GBRAIN_MODEL`, 키 인식 티어 기본, 하드코딩된 호출자 폴백.
- 서브에이전트 티어는 격리되어 있다. 도구 호출을 지원하지 않는 모델이나 모르는 제공자는 거부되고 `TIER_DEFAULTS.subagent`로 폴백하며 경고한다. 도구 호출은 되지만 프롬프트 캐시가 없는 제공자(예: OpenAI)는 비용 경고만 내고 돈다. 새 LLM 호출은 `resolveModel()`을 거치고 모델 문자열을 직접 쓰지 않는다는 규칙을 적었다.
- `gbrain models doctor`가 설정된 모델마다 1토큰 프로브를 보낸다.

**폴백 / 쿼터**: `chat_fallback_chain`(`provider:model` 쉼표 목록). 환경변수, `~/.gbrain/config.json`, 데이터베이스 세 위치 중 먼저 설정된 것이 이기고 나머지는 가려진 것으로 보고된다.
- 조건: 주 모델의 rate 또는 구독 한도, 장애, 타임아웃, 거부된 키, 그리고 모델의 거부(`refusal`, `content_filter`, 콘텐츠 정책 HTTP 400)다. 거부 전달은 `chat_fallback_on_refusal=false`로 끈다.
- 체인은 기본 꺼짐이다. 켜면 요청이 다른 벤더로 가므로 어디로 텍스트가 가는지의 결정이라고 문서가 적었다. 에이전트가 체인을 스스로 제거하지 않고 사용자에게 묻는다.
- 비용 상한(`facts.drain_budget_usd` 등)이 적용되는 경우 체인의 각 항목에 단가가 등록되어 있어야 하고, 없으면 거부된다. `gbrain pricing set`으로 등록한다.
- 첫 폴백 홉은 `chat_fallback_hop` 안전 알림을 낸다. `claude-cli:` 모델은 설치된 `claude` 바이너리의 로그인을 쓴다.

**라우터 / 리드 / 소통**: 작업 단위 라우터는 없고 호출 지점이 티어를 선언한다. 리드 역할은 없다.

---

### lobehub/lobehub
- 별 85662, 마지막 push 2026-11-17
- 근거 파일(커밋 날짜): `packages/const/src/settings/llm.ts`(2026-10-10), `packages/business/const/src/llm.ts`(2026-11-07), `packages/builtin-agents/src/agents/*/index.ts`
- 선택 이유: 에이전트 그룹과 그룹 감독자(supervisor), 내장 에이전트별 모델 지정이 있다. 코딩 하네스라기보다 에이전트 플랫폼이다.

**역할과 모델**
- 전역 기본: `DEFAULT_MODEL = 'deepseek-v4-flash'`, `DEFAULT_PROVIDER = 'deepseek'`, `DEFAULT_MINI_MODEL = 'gpt-5.6-luna'`, `DEFAULT_MINI_PROVIDER = 'openai'`(`business/const/src/llm.ts`). 이 파일은 클라우드 빌드가 교체할 수 있다고 주석이 적었다.
- 내장 에이전트: `task-agent`와 `verify-agent`는 `DEFAULT_MODEL`과 `DEFAULT_PROVIDER`를 지정한다. `nightly-review`와 `self-reflection`은 사용자 기본 대화 모델이 아니라 저렴한 미니 시스템 모델을 쓴다고 주석이 적었다. `inbox`는 모델과 제공자를 의도적으로 비워 사용자 기본 설정을 따른다. `group-supervisor`, `project-coordinator`의 모델 지정은 파일에서 찾지 못했다.
- 서브에이전트 모델 해석 순서(`resolveSubAgentModel`): 스폰하는 에이전트의 `agencyConfig.subagent` 명시 설정, 부모 실행의 실효 모델(같은 제공자와 모델), 전역 기본. 모델과 제공자를 한 쌍으로 해석해 서로 다른 출처가 섞이지 않게 한다. 주석은 Claude Code와 Codex의 서브에이전트도 부모 모델을 상속한다고 근거로 든다.

**폴백 / 쿼터**: 대화 모델 장애 폴백은 확인하지 못했다. 검색된 폴백 이슈는 비전 이해 설정과 자동 모델 선택 요청뿐이다.

**라우터 / 리드 / 소통**: `GROUP_SUPERVISOR` 내장 에이전트가 그룹 대화에서 누가 말할지, 어떤 에이전트의 전문성에 맞출지, 과제를 실행시킬지를 조율한다. 목표 감독자(`services/goal/supervisor`)는 예산, 승인, 정지를 정책으로 다룬다고 README가 적었다. 감독자 모델 지정은 확인하지 못했다.

**이슈 사례**
- [#18700](https://github.com/lobehub/lobehub/issues/18700) 2026-08-26: 모델 목록에 AUTO 모드를 두어 작업에 따라 사용 가능한 모델을 자동 선택하자는 요청. 댓글 3.

---

### JetBrains/thinkrail
- 별 8310, 마지막 push 2026-11-17
- 근거 파일(커밋 날짜): `packages/pi-subagents/src/builtins.ts`(2026-11-10), `packages/pi-subagents/SPEC.md`
- 선택 이유: 에이전트 IDE이고 내장 서브에이전트 4종과 모델 해석 규칙이 명세로 있다.

**역할과 모델**
- 내장 서브에이전트 네 개: `scout`(읽기 전용 정찰), `planner`(읽기 전용 계획), `worker`(범용 구현), `reviewer`(읽기 전용 diff 리뷰, 프로젝트 컨텍스트 상속). 내장 정의에 `model` 필드는 보이지 않는다. 기본 모델은 상속으로 보이나 이 점은 원문 미확인.
- 사용자 정의 에이전트 프런트매터는 `name`, `description`, `tools`, `model`, `thinking`, `max_turns`, `inherit_project_context` 등이다.
- 모델 해석: 정의의 고정(pin), 호출 시 `model`, 부모 상속 순서다. 참조는 세션의 가용 모델에서 `provider/id`, 정확한 id, 유일한 접두어 순으로 찾는다.
- `inherit`, `parent`, `default`와 빈 값은 "호출 모델 없음"으로 취급한다(Claude Code에서 가져온 표기라고 명세가 적었다).

**폴백 / 쿼터**: 명세가 "해석되지 않은 선택에서 제공자 치환, 커스텀 모델 합성, 부모 폴백을 허용하지 않는다"고 적었다. 즉 지정 모델을 못 찾으면 상속으로 조용히 넘어가지 않는다. 사용량 기반 전환은 확인하지 못했다.

**라우터 / 리드 / 소통**: `Agent({ subagent_type, task, model?, run_in_background? })` 도구로 부모가 위임한다. 정의는 부모의 매 모델 턴 전에 스냅샷되어 세션 중에도 편집할 수 있다고 명세가 적었다.

**이슈 사례**: 이 조사에서 찾지 못했다.

---

### superplanehq/superplane
- 별 10060, 마지막 push 2026-11-17
- 근거 파일(커밋 날짜): `pkg/components/runner/agent_fields.go`(2026-10-30), `web_src/src/lib/selectableLLMModels.ts`
- 선택 이유: "한 번에 끝내는 엔지니어링 공장"을 표방하고 작업 노드마다 에이전트 모델을 고른다.

**역할과 모델**
- 작업 노드의 모델 필드는 워크스페이스 모델(호스트 모델 타입)에서 고른다. SuperPlane 자체 에이전트 노드는 선택하지 않으면 인스턴스의 SuperPlane 에이전트 모델을 쓴다.
- BYOK 러너 모델의 기본 선택: 현재 값이 허용 목록에 있으면 유지하고, 비어 있으면 허용 목록을 정렬한 첫 번째 모델을 쓴다. Anthropic과 OpenRouter에서는 `sonnet` 같은 Claude 별칭이면 구체 모델 ID로 바꾸고 레거시 별칭은 제외한다.
- 작업 전체의 실행 시간 상한 기본은 3600초(1시간)다.

**폴백 / 쿼터**: 확인하지 못했다. 원문 미확인.

**라우터 / 리드 / 소통**: 노드로 구성한 캔버스(워크플로)가 라우팅을 대신한다. 별도의 리드 에이전트는 확인하지 못했다.

**이슈 사례**: [#9285](https://github.com/superplanehq/superplane/issues/9285) 2026-11-12, 모델별 thinking 수준 지원 요청. 폴백 요구는 찾지 못했다.

---

### CopilotKit/OpenBot
- 별 12625, 마지막 push 2026-11-17
- 선택 이유: 트렌딩에서 에이전트 계열 이름으로 잡혀 확인했다.

해당 없음: README가 "AI coworkers"를 위한 자체 호스팅 작업 공간이라고 소개하는 일반 팀 봇이다. 코딩 하네스가 아니고 역할별 모델 기본값이나 폴백 설정은 찾지 못했다. `shared/subagent.ts`는 서브에이전트 호출 이름과 도구 호출 기록 형식을 다루는 파일이고 모델 지정은 없었다.

---


---

### Not-Diamond (RoRF, not-diamond-python, notdiamond-python 외)

- 별: `Not-Diamond/RoRF` 245(마지막 push 2024-09-24), `notdiamond-python` 91(2025-12-11), `not-diamond-python` 3(2026-08-20), `awesome-ai-model-routing` 254(2025-03-24)
- 근거 파일: `Not-Diamond/not-diamond-python`의 `README.md`
- 선택 이유: 모델 라우팅 전문 서비스. 다만 저장소는 호스팅 API의 SDK라 라우팅 로직과 설정은 저장소에 없다.

- 조직 저장소 중 최근 3개월 안에 push가 있는 것은 `not-diamond-python`(별 3) 하나뿐이다. 나머지는 3개월 이상 정지 상태다.
- 설정 표면: `llm_providers`로 후보 모델 목록(`{"provider": "openai", "model": "gpt-4o"}` 형태)을 넘기면 서비스가 프롬프트마다 하나를 고른다. `cost_quality_tradeoff`는 0부터 10까지이고 0이 순수 품질(기본값), 10이 가장 저렴한 모델이다. 자기 데이터셋으로 커스텀 라우터를 학습시키는 기능이 있다.
- 폴백과 쿼터: README에서 폴백 규칙이나 사용량 기반 전환 설정은 확인하지 못했다(원문 미확인). 요청 타임아웃 기본값은 1분이다.
- 역할별 모델 기본값, 코딩 에이전트 연동은 없다. 라우팅 판단이 서버에서 일어나므로 1차 파일로 확인할 수 없다.

---

### mikecubed/Hydra

- 별 4, 마지막 push 2026-03-30(조사일 기준 약 7.5개월 정지, 3개월 기준 밖), PrimeLocus/Hydra 포크
- 근거 파일(커밋 날짜): `lib/hydra-usage.ts`(2026-03-14), `lib/hydra-dispatch.ts`(2026-03-14), `lib/hydra-agents.ts`(2026-03-25), `lib/hydra-shared/budget-gate.ts`(2026-03-14), `lib/hydra-model-recovery.ts`(2026-03-15), `hydra.config.json`, `README.md`
- 선택 이유: 리드가 지목한 사용량 기반 전환 저장소. 문서에 그치지 않고 코드에 구현이 있는지 확인했다.

**결론: 코드에 있다.** README의 "Three-tier token tracking with automatic model downgrade at thresholds"는 문장 그대로가 아니라 아래 범위로만 성립한다.

**사용량을 읽는 방식**
- Claude Code가 로컬에 쓰는 `~/.claude/stats-cache.json`을 읽는다(`findStatsCache`, 설정 `usage.claudeStatsPath`가 `auto`면 표준 경로, Windows는 `APPDATA` 경로도 탐색). 서버 한도 API가 아니라 로컬 토큰 집계다. 캐시가 없으면 세션 호출 수 기반 추정치로 내려가고 메시지에 "stats-cache unavailable"이 붙는다.
- 한도는 사용자가 설정한 토큰 예산 대비 비율이다. 기본 설정 파일 기준 `dailyTokenBudget`(claude-opus-4-6 5,000,000, claude-sonnet-4-5 15,000,000), `weeklyTokenBudget`(25,000,000와 75,000,000), 슬라이딩 창 `windowHours` 5와 `windowTokenBudget`(2,500,000과 7,500,000), `plan: "max_20x"`다. 일간, 주간, 슬라이딩 창 세 가지를 모델별로 계산한다.
- 단계는 `levelFromPercent`: 경고 `warningThresholdPercent` 기본 80, 위험 `criticalThresholdPercent` 기본 90.

**전환 로직(`hydra-dispatch.ts`의 `usageGuard`)**
- 모든 에이전트 호출 직전에 `checkUsage()`를 호출한다.
- 위험(90% 이상)이면 `MODE_DOWNSHIFT = { performance: 'balanced', balanced: 'economy' }`로 한 단계 내려 `setMode`를 호출한다. 이미 economy면 "already in economy mode" 경고만 낸다. 경고(80% 이상)는 사용률 문구만 출력하고 아무것도 바꾸지 않는다.
- 모드는 모델 티어 표(`hydra.config.json`의 `modeTiers`)를 가리킨다: performance는 gemini, codex, claude가 `default`, copilot이 `flagship`. balanced는 셋이 `fast`, copilot이 `default`. economy는 셋이 `cheap`, copilot이 `fast`. 같은 설정 파일의 기본 `mode`는 `economy`다.
- `setMode`는 설정 파일에 저장하고 각 에이전트의 활성 모델을 `default`로 초기화한다. 위로 올리는 코드는 `usageGuard`에서 확인하지 못했다(내려가기만 하고 복귀는 수동 `setMode`로 보인다).
- 하향 단위는 개별 모델이 아니라 전체 에이전트의 티어 묶음이다.

**예산 임계값이 쓰이는 다른 곳**
- `computeLocalBudgetFlags`(`hydra-agents.ts`): `DefaultBudgetGate`가 일간 80%, 주간 75% 기본값(`cfg.local.budgetGate`)을 초과("strictly exceeds")하거나 모드가 economy면 `local` 에이전트(로컬 모델) 점수에 1.5를 곱한다. performance 모드면 0.5를 곱한다. 즉 예산이 빠듯하면 로컬 모델을 더 자주 고르는 가중이다.
- 에이전트 정의마다 `economyModel` 함수가 있다(예: claude는 `claude-sonnet-4-5-20250929`, gemini는 `gemini-3-flash-preview`, codex는 `handoffModel` 설정이 있으면 그 값, 없으면 `o4-mini`, copilot은 `copilot-claude-sonnet-4-6`, 하나는 null).
- 비상 옵션 `getContingencyOptions`와 `executeContingency`(`hydra-usage.ts`)는 경고 이상에서 "fast 프리셋으로 전환", 위험에서 "Codex로 핸드오프"와 "진행 저장 후 중지"를 만든다. 코드 검색으로는 정의 파일과 테스트(`test/hydra-dispatch-deep.test.ts`)에서만 나오고 다른 호출처는 찾지 못했다(검색 색인 한계가 있을 수 있어 "미연결로 보임" 수준).

**장애 폴백**
- 모델별 서킷 브레이커(`hydra-model-recovery.ts`, `recordModelFailure`): 슬라이딩 창 안의 실패 횟수가 `failureThreshold`(기본 5)를 넘으면 열린다. 창 `windowMs` 기본 300,000(5분). 열리면 호출자는 알려진 불량 모델을 건너뛰고 바로 폴백으로 간다(주석). 설정은 `modelRecovery.circuitBreaker`. 쿨다운 길이의 기본값은 읽지 않았다(원문 미확인). `Retry-After` 문구를 오류 텍스트에서 파싱하는 함수가 있다.
- `Post-hoc detection`: 실패한 뒤에 결과를 검사해서 복구한다는 설계 주석이 있다.

**문서와 코드의 차이**: README는 임계값에서 "automatic model downgrade"라고 쓰지만 코드의 자동 동작은 위험 단계의 모드 하향 하나다. 경고 단계의 전환(`switch_model`)은 비상 옵션 목록 생성에 그친다.

---

### willynikes2/agent-orchestrator

- 별 67, 마지막 push 2026-10-14, 기본 브랜치 `master`
- 근거 파일(커밋 날짜): `daniel.py`(2026-10-14, 1,941줄), `README.md`(2026-10-14), `tests/test_agents.py`
- 선택 이유: 리드가 지목한 Claude 한도 소진 시 우회 저장소. 파일이 8개뿐인 단일 스크립트 도구다.

**역할 체인과 모델(코드의 기본 설정 딕셔너리)**

| 역할 | 기본 순서 |
|---|---|
| orchestrator | claude, codex, gemini, grok |
| implementation | codex, claude, gemini, antigravity, grok |
| uidocs | gemini, codex, claude, antigravity, grok |
| review | claude, codex, gemini, antigravity, argon, grok(argon은 Gemini API 키가 있을 때만) |
| intel | grok, gemini, claude, codex |

- 기본 모델 문자열: claude `claude-sonnet-4-5`, codex `gpt-5`, gemini `gemini-2.5-pro`, grok `grok-4.7`, antigravity 빈 값(agy 자체 기본), argon은 상수(`ARGON_MODEL`, `gemini-4-argon`을 README가 언급). 이름이 오래된 값이라 최근 모델과 어긋난다. 역할, 체인 순서, 모델은 설정 파일로 바꾼다.
- 단일 파일이라 README의 "~1100 lines"와 달리 실제는 1,941줄이다(문서가 낡음).

**전환 규칙(`_apply_auto_downtime`, `_chat_once`)**
- 요청마다 역할 체인을 앞에서부터 시도하고 실패하면 다음 에이전트로 넘기는 next-man-up 방식이다. 직접 지정(`@에이전트`)이면 체인을 건너뛴다.
- Claude 한도: 오류 텍스트에 "out of extra usage"가 있고 `resets Oct 14, 3pm (UTC)` 꼴의 문구를 정규식으로 파싱하면 `disabled_until`에 그 시각을 저장해 그때까지 Claude를 끈다. 설정 파일에 저장되고 시각이 지나면 다음 확인 때 비워져 자동 복구된다. 사용률 수치를 읽는 것이 아니라 CLI가 낸 오류 문구에서 리셋 시각을 읽는 방식이다. 문구가 일치하지 않으면 이 분기는 동작하지 않는다.
- 그 밖의 에이전트: rate limit은 5분 쿨다운(`disabled_until = now + 5분`), Antigravity 쿼터나 429도 5분, Argon은 크레딧 소진을 수동 비활성(`/service up argon`으로 복구), 인증 실패는 수동 비활성, 모델 미발견도 수동 비활성, 타임아웃은 쿨다운 없이 다음 에이전트만 시도. `/service recover`로 전체 복구.
- 모든 체인이 실패하면 오류와 복구 옵션을 보여 준다.

---

### mnvsk97/harnessctl

- 별 8, 마지막 push 2026-05-14(조사일 기준 약 6개월 정지, 3개월 기준 밖), TypeScript
- 근거 파일(커밋 날짜): `src/commands/run.ts`(2026-05-14), `src/lib/budget.ts`(2026-04-18), `src/lib/transcript.ts`(2026-04-18), `src/adapters/types.ts`, `docs/guide/configuration.md`(2026-05-01)
- 선택 이유: 리드가 지목한 `auto_failover`와 `failover_transfer` 구현을 코드로 확인하려고.

**설정(`~/.harnessctl/agents/<에이전트>.yaml`)**: `model`, `fallback`(핸드오프할 에이전트 하나), `auto_failover`(불리언, 기본 false), `failover_transfer`(`"transcript"` 또는 `"summary"`, 기본 transcript), `budget_daily`(하루 달러 상한). 폴백은 에이전트 이름 하나를 가리키고 그 에이전트의 폴백이 이어져 체인이 된다. 순환은 `visited` 집합으로 막는다.

**동작(`run.ts`의 `runWithFallback`)**
- 실행이 끝나면 종료 사유를 분류한다. `rate_limit`, `token_limit`, `auth_error` 셋이 "한도 사유"(`isLimitReason`)다.
- `auto_failover: true`이고 한도 사유면 확인 없이 폴백 에이전트로 넘어간다. 그 밖의 실패는 사용자에게 `y/n`을 묻는다. 폴백이 설치돼 있지 않으면 오류를 내고 멈춘다.
- 넘길 때 `buildTranscriptBlock`이 이전 에이전트의 세션 기록을 다음 프롬프트 앞에 붙인다. `failover_transfer: summary`면 요약만 넘기고, 어댑터가 기록 추출을 지원하지 않거나 턴이 비면 요약으로 내려간다. 타입 주석은 기록 분량을 폴백 모델 컨텍스트 창의 약 40%(창 크기를 모르면 100k 가정)로 맞춘다고 적는다.
- 사용량 수치를 읽지는 않는다. 한도 판정은 에이전트 CLI의 종료 사유 분류에 의존한다. 분류 기준(오류 문구 패턴)은 어댑터별 코드이고 읽지 않았다(원문 미확인).

**예산(`budget.ts`)**: 오늘 날짜의 실행 로그(`RUNS_DIR`)에 기록된 `cost`를 에이전트별로 합산한다. 제공자가 알려 주는 잔량이 아니라 자체 로그의 누적 비용이다. 한도의 80%를 넘으면 경고만 하고, 100%를 넘으면 해당 에이전트 실행을 거부하며 종료 사유가 `error`가 된다. `error`는 한도 사유가 아니므로 `auto_failover`가 켜져 있어도 자동 전환되지 않고 폴백 여부를 묻는 프롬프트가 나온다.

## 기존 관찰 4번 정정

기존 보고서의 관찰 4번은 "사용량 수치를 읽어 모델을 바꾸는 장치는 확인한 범위에서 없다"였다. 그 16개 범위에서는 맞았지만 전체로는 틀렸다. 확인 결과는 다음과 같다. 코드 확인과 문서만 확인을 구분했다.

**코드로 확인한 것**

| 저장소 | 읽는 수치 | 전환 규칙 | 전환 단위 |
|---|---|---|---|
| pingdotgg/t3code | 제공자 사용량 창의 `usedPercent`와 `resetsAt` | `usedPercent >= 100`이고 `resetsAt`이 미래면 소진으로 보고 새 스레드의 기본 모델을 `fallbackModelSelection`으로 교체. 폴백 대상이 활성, 설치, 인증, 소진 아님, 프로젝트 허용이어야 함 | 새 스레드 기본 모델만. 진행 중 세션과 MCP 위임은 미적용(#28203, 열림) |
| mikecubed/Hydra | Claude Code의 `~/.claude/stats-cache.json` 토큰 집계 대비 사용자 예산(일간, 주간, 5시간 슬라이딩 창) | 경고 80%는 출력만, 위험 90%면 `performance`에서 `balanced`로, `balanced`에서 `economy`로 한 단계 하향. 로컬 모델 점수는 일간 80% 또는 주간 75% 초과 때 1.5배 | 모든 에이전트의 티어 묶음. 상향은 수동. 7.5개월 정지 |
| cheaper-inference/OmniRoute | 계정별 쿼터 윈도, Claude의 `anthropic-ratelimit-unified-status` 응답 헤더 | 쿼터 소진 후보 제외, `reset-aware`와 `expiry-first` 전략, 사전 점검 토글 `QUOTA_PREFLIGHT_CUTOFF_ENABLED`. 헤더가 `rejected`인 429에서 낮은 우선순위 레인으로 같은 계정 재시도(`lowPriorityMode`, 옵트인) | 요청마다 계정과 레인 |
| tashfeenahmed/freellmapi | `(공급자, 모델, 키)`별 RPM, TPM, RPD, TPD 카운터와 공급자가 보고하는 상한 | 남은 비율 20% 아래부터 점수 감점, 일일 한도 도달은 UTC 자정이나 `Retry-After`까지 쿨다운 | 요청마다 모델과 키 |
| maximhq/bifrost | 규칙 CEL의 `budget_used`(0 ~ 100), `tokens_used` | 문서 예시는 `budget_used > 80`이면 폴백 쪽으로 라우팅. 사용자가 규칙을 써야 동작 | 요청마다, 규칙 의존 |
| BerriAI/litellm | 공급자별 예산 지출(`budget_limiter.py`) | 예산을 넘긴 배포를 후보에서 제외. 구독 한도는 인식하지 않음 | 요청마다 배포 |
| Wei-Shaw/claude-relay-service | 모델 가족(opus, sonnet, haiku, fable)별 한도 걸림 | 가족별로 독립해서 걸러 냄. 쿼터 초과 Console 계정은 후보에서 뺌 | 요청마다 계정 |
| willynikes2/agent-orchestrator | Claude CLI의 오류 문구(`out of extra usage`와 `resets <날짜>, <시> (UTC)`) | 그 시각까지 Claude를 끄고 체인 다음으로, 리셋 시각이 지나면 자동 복구. 사용률 수치가 아니라 오류 문구에서 리셋 시각을 읽음 | 에이전트 단위 |

**읽기만 하고 전환에 연결하지 않은 것**: router-for-me/CLIProxyAPI는 claude, codex, devin 응답 헤더에서 계정 쿼터 스냅샷을 읽지만 쿨다운과 스케줄링 필드는 건드리지 않는다. Codex의 `usage_limit_reached` 쿼터 쿨다운만 별도 경로로 걸린다.

**수치를 읽지만 정지나 거부로 끝나는 것**: langchain-ai/open-swe의 자동화 스레드는 UTC 하루 30,000,000 토큰(`AUTOMATION_DAILY_TOKENS`, `packages/runtime-api/src/runtime_api/catalog.py`)에서 멈추고 모델을 고정한다(모델 전환은 아님). mnvsk97/harnessctl은 오늘 날짜의 실행 로그 비용 합계가 `budget_daily`를 넘으면 해당 에이전트 실행을 거부하고, 80%에서 경고한다. 한도 사유가 아니라 `error`로 분류되므로 `auto_failover`가 켜져 있어도 자동 전환되지 않고 폴백 여부를 묻는 프롬프트가 나온다.

**문서만 확인했거나 미연결로 보이는 것**: Hydra의 `getContingencyOptions`와 `executeContingency`(경고에서 "fast 프리셋으로 전환", 위험에서 "Codex 핸드오프")는 코드 검색에서 정의와 테스트 외 호출처를 찾지 못했다. Hydra README의 "automatic model downgrade at thresholds"는 위의 위험 90% 모드 하향으로만 성립한다.

## 저장소 전체를 가로지르는 관찰

1. 사용량 기반 전환은 하네스 안보다 게이트웨이와 프록시 쪽에 있다. 읽는 수치의 종류가 다르다. 제공자가 알려 주는 사용률 창(t3code, OmniRoute의 응답 헤더), 로컬 토큰 집계(Hydra), 자체 카운터와 학습한 상한(freellmapi), 사용자가 정한 예산(LiteLLM, Bifrost, harnessctl), 오류 문구(agent-orchestrator)로 나뉜다. 구독 한도(Claude 5시간 창 등)를 응답 헤더나 문구에서 읽어 전환에 쓰는 곳은 OmniRoute, claude-relay-service, agent-orchestrator, t3code 넷뿐이다.

2. 구독 계정은 API 키와 다르게 다뤄지는 경향이 있다. 게이트웨이 사용자의 요구는 모델 전환보다 계정 로테이션과 구독 인식에 몰려 있다. LiteLLM #23777(ChatGPT OAuth 계정 여러 개, 반응 46)과 Bifrost #2316(Codex 구독 OAuth), CLIProxyAPI #2599(OAuth 프록시 요청이 구독 포함분이 아니라 "extra usage"로 과금)가 같은 맥락이다. 기존 보고서의 opencode #7602의 댓글에도 "같은 제공자 안 키 로테이션이 필요하다"는 요구가 있었다.

3. 폴백을 일으키는 조건의 정의가 게이트웨이마다 크게 다르다. 같은 429도 다르게 처리된다.
   - Bifrost: 호출자 취소와 요청 자체의 문제(`caller_fault`)만 빼고 모두 폴백. 실패를 `credential`, `quota`, `rate_limit`, `transient`로 분류해 키 문제는 백오프 없이 다음 키로, 429는 백오프를 유지한다.
   - LiteLLM: 폴백이 일반 오류, 컨텍스트 초과, 콘텐츠 정책 거부 세 체인으로 갈라진다. 쿨다운은 429, 401, 402, 408, 404와 5xx에 걸린다.
   - OmniRoute: 서킷 브레이커는 408과 5xx만 센다. 401, 403, 429는 계정 수준이라 세지 않고 연결 쿨다운으로 처리한다.
   - freellmapi: 429와 5xx에서 재시도. 402는 24시간, 일일 쿼터 소진은 UTC 자정이나 `Retry-After`까지. 모델과 키별 쿨다운이 2분, 10분, 1시간, 24시간으로 오른다.
   - new-api: `RetryTimes` 기본값이 0이라 설정하지 않으면 폴백이 일어나지 않는다. 504와 524만 빼고 재시도한다.
   - claude-code-router: Fallback targets 모드에서 모든 4xx와 5xx.

4. 에이전트 프레임워크에는 모델 전환 폴백이 사실상 없다. crewAI, smolagents, ChatDev, langgraph, ag2, autogen은 코드에서 모델 전환 폴백을 찾지 못했고 재시도만 있다. 재시도 기준도 다르다(crewAI와 smolagents는 429만, langgraph는 기본값에서 5xx만 재시도해 429 제외). 예외는 open-swe(일시 실패 때 벤더를 번갈아 감: anthropic이면 `gpt-6.1-sol`, openai면 `claude-opus-5-5`), pydantic-ai(`FallbackModel`), pr-agent(`fallback_models`), mastra(모델 배열 폴백)다. SDK 재시도와 프레임워크 재시도가 곱해져 rate limit 한 번에 요청이 9번 나가는 문제가 crewAI #8333, smolagents #3034와 #3036에 보고됐다.

5. 폴백은 "던져진 예외"에만 반응하는 한계가 있다. 응답이 200 OK로 오는 오류, 첫 응답을 낸 뒤의 실패, 스트리밍 중 실패는 폴백이 놓친다. adk-python은 첫 응답 뒤의 실패에 폴백하지 않고, pydantic-ai는 스트리밍 요청에 응답 핸들러를 적용하지 않으며, mastra #21280은 Azure OpenAI가 rate limit을 200 OK 스트림 안의 오류 이벤트로 보내 던져진 예외에만 반응하는 폴백 체인이 작동하지 않은 프로덕션 사례다. pydantic-ai 문서는 모델 전환이 프롬프트 캐시를 잃는다고 명시한다.

6. 작업 내용을 보고 모델을 고르는 라우터를 구현하는 방식이 나뉜다.
   - 규칙 점수: LiteLLM `complexity_router`(7개 차원, 경계 0.15와 0.35와 0.60).
   - 확률 학습: LiteLLM `adaptive_router`와 freellmapi(Thompson 샘플링, `quality_weight*샘플 + cost_weight*정규화 비용`).
   - 분류 모델 호출: Bifrost Routers(결정 모델, 의미 기준 문구의 임베딩, LLM 분류기), mastra `ModelSelectionProcessor`(비용이 늘 수 있다고 경고), open-swe(fast, balanced, performance), semantic-router.
   - 코딩 에이전트 신호 사용: vllm-project/semantic-router의 `agent` 신호는 Claude Code와 Codex 헤더로 main과 subagent, `Explore`, `Plan`, `review`, `compaction` 등을 읽어 모델과 effort를 정한다. claude-code-router는 프롬프트 태그로 서브에이전트 모델을 정한다. 옛 `background`, `think`, `longContext` 키는 v2.0.0 README에만 있고 현재 문서에는 없다.
   - TypeSafe의 결정 모델(Jev)을 라우터 입력으로 쓰는 곳이 LiteLLM, Bifrost, OmniRoute(`jev` 전략, 기본 꺼짐), claude-code-router(예제), agentgateway(callout 예제), freellmapi(`decision` 전략)로 다수다. 대개 옵트인이고 요청 본문이 외부로 나간다는 경고가 붙는다.

7. 역할을 모델 이름이 아니라 기능 등급으로 나누는 설계가 더 있다. gbrain은 `utility`(Haiku), `reasoning`(Sonnet), `deep`(Opus), `subagent`(Sonnet) 네 등급을 두고 `chat_fallback_chain`(기본 꺼짐)은 오류뿐 아니라 모델의 거부에서도 다음 벤더로 넘어간다. TradingAgents는 `deep`(`gpt-6-sol`)과 `quick`(`gpt-6-luna`) 두 등급으로 나눠 판정 관리자 둘만 deep에 둔다. open-swe의 역할은 메인, 서브에이전트, 리뷰어, 리뷰어 서브에이전트이고 라우팅은 fast, balanced가 `gpt-6.1-sol`(medium), performance가 `claude-opus-5-5`(high)다.

8. 폴백을 아예 금지하거나 요구가 반복되는 반대 사례가 있다. JetBrains/thinkrail 명세는 해석되지 않는 모델 지정에 부모 모델 폴백을 금지한다. 반면 multica(#3963, #6531), orca(#20512, 반응 10), buzz(#5605), qwen-code(#13895)에는 폴백을 요구하거나 불만을 낸 이슈가 열려 있다. qwen-code #13895는 공급자의 429 본문 `error.code`가 알려진 코드에 없으면 `modelFallbacks`가 건너뛰어지는 문제다.

## 설계끼리 충돌하는 지점

- 계정 단위 로테이션 대 모델 단위 폴백: 구독 사용자는 같은 모델의 다른 계정으로 넘기길 원하고(LiteLLM #23777, opencode #7602 후속 댓글), 게이트웨이의 폴백 체인은 다른 모델로 넘기는 것이 기본이다. OmniRoute와 claude-relay-service만 계정 단위를 1순위로 둔다.
- 전환 시점: t3code는 새 스레드에서만 교체하고(진행 중 세션은 유지), freellmapi는 대화를 30분 세션 고정으로 한 모델에 머물게 하고 전환 시 핸드오프 노트로 맥락을 잇는다. harnessctl은 전환 때 이전 세션의 기록을 폴백 모델 컨텍스트 창의 약 40%까지 붙인다. 프롬프트 캐시 손실과 맥락 이월 비용을 어떻게 치를지 저장소마다 다르다.
- 자동 대 확인: gemini-cli와 harnessctl은 기본이 사용자 확인이고 옵트인으로 조용히 넘긴다(`auto_failover: true`). freellmapi, OmniRoute, Bifrost는 기본이 자동이다.
- 예산 초과 처리: LiteLLM은 폴백 대상에서 예산을 다시 검사하고(무료 모델에 유료 폴백을 걸면 예산 구멍이 생겨서), 같은 파일이 동시 요청에서 상한을 넘길 수 있다고 스스로 적는다. harnessctl은 예산 초과를 한도 사유가 아닌 오류로 분류해 자동 전환에서 제외한다. open-swe는 전환 없이 정지한다.
- 문서와 코드의 시차: Hydra README는 자동 하향을 말하지만 코드는 위험 단계의 모드 하향 하나다. LiteLLM은 `router.py` docstring의 쿨다운 1초와 `constants.py`의 5초가 다르다(어느 쪽이 실제 동작인지 원문 미확인). agent-orchestrator README는 "~1100 lines"라고 쓰지만 `daniel.py`는 1,941줄이다. 이 시차는 모델 이름에서도 크다(Hydra 설정은 `claude-opus-4-6`, agent-orchestrator는 `claude-sonnet-4-5`와 `gpt-5`).

## 한계

- 원문 미확인으로 남은 것: LiteLLM 쿨다운 기본값의 실제 동작, harnessctl의 한도 사유 분류 패턴(어댑터별 코드), Hydra 서킷 브레이커의 쿨다운 길이, plano 게이트웨이 내부 폴백, semantic-router의 전송 오류 폴백, OmniRoute `auto/coding` 변형의 분류 코드, RouteLLM 라우터 학습 방식, pydantic-ai `FallbackModel`의 기본 발동 조건(docstring과 문서가 다름), openai-agents-python의 `gpt-5.6` 계열 effort 기본값 표, langroid 라우터 예제의 모델 배정, multica와 orca의 폴백 구현.
- Hydra의 호출처 확인은 `gh search code`의 색인에 의존했다. 색인이 불완전할 수 있다.
- 서브에이전트가 쓴 섹션은 제가 일부(t3code, OmniRoute, open-swe)만 재확인했다. 나머지는 각 섹션이 적은 파일 경로와 커밋 날짜를 근거로 한다.
