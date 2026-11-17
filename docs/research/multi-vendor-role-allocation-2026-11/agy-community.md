2026년 11월 17일 기준으로 GitHub 멀티 에이전트 오케스트레이터 저장소와 4개 언어권 커뮤니티에서 역할별 모델 배치와 사용량 한도 전환 방식을 조사했습니다. 단일 모델로 모든 작업을 처리하던 방식에서 벗어나 오케스트레이터와 계획에는 `Claude Opus 5.5`나 `Claude Fable 5.2`, 심층 설계와 구현에는 `GPT-6 Astra`와 `GPT-6.1 Sol`, 보안과 프론트엔드와 장문 분석에는 `Gemini 4 Argon`과 `Gemini 4 Carbon`, 고속 탐색과 워커에는 `GPT-6 Luna`와 `Claude Haiku 5.5`와 `Gemini 4 Hydrogen`을 조합하는 구조가 정착했습니다.

## 1. 저장소별 역할 기본 모델과 폴백 규칙

### 주요 멀티 에이전트 오케스트레이터 역할별 기본 모델 표

| 저장소 | 오케스트레이터, 리드 | 계획, 설계 | 구현 | 리뷰, 보안 | 탐색, 테스트 | 문서, 디자인, 소통 |
|---|---|---|---|---|---|---|
| [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) | `claude-opus-5-5` (`daily-normal`), `claude-fable-5-2` (`daily-heavy`), `gpt-6-astra` (`geeky`) | 계획 `claude-fable-5-2` (`max`), 계획 리뷰 `gpt-6-astra` (`xhigh`), 설계 `claude-fable-5-2` (`max`) | 일반 `gpt-6.1-sol` (`medium`), 심층 `gpt-6-astra` (`high`/`max`), 단순 `gpt-6-luna-fast` (`low`) | 코드 리뷰 `claude-opus-5-5` (`medium`), 게이트 리뷰 `gpt-6-astra` (`high`), 보안 별도 기본값 없음 | 탐색 `kimi-for-coding-highspeed`, 2순위 `gpt-6-luna-fast` (`low`), 3순위 `claude-haiku-5-5`, QA `gpt-6.1-sol` | 문서 `gemini-4-argon` (`low`), 2순위 `claude-opus-5-5`, 디자인 `gemini-4-argon` (`low`), 2순위 `claude-fable-5-2` |
| [triflux](../../../.claude/rules/tfx-routing.md) | `claude-opus` (메타 라우팅과 계획 게이트) | 계획, 설계, 비평 `gpt-6-astra` (`xhigh`) | 일반 `gpt-6.1-sol` (`high`), 심층 `gpt-6-astra` (`xhigh`), 빌드 수정 `gpt-6-luna` (`high`) | 교차 리뷰: Codex 작성분은 `claude-opus`, Claude 작성분은 `gpt-6.1-sol` (`high`), 보안은 `gemini-4-argon` (`high`) | 탐색 `claude-haiku` (Codex는 `gpt-6-luna` `low`), 테스트와 검증 `gpt-6.1-sol` (`high`) | 문서 `gemini-4-argon` (`medium`, Codex는 `gpt-6.1-terra` `high`), 디자인 `gemini-4-argon` (`high`) |
| [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) | 호출한 `Claude Code` 세션 모델 고정 | 계획, 설계, 분석, 비평 `claude-opus` (명시 시 `claude-fable`) | 일반 `claude-sonnet`, 고난도 `claude-opus`, 단순 `claude-haiku` | 코드 리뷰 `claude-opus` (외부 설정 시 `gemini`), 보안 리뷰 `claude-sonnet` | 탐색 `claude-haiku`, 테스트와 QA와 검증 `claude-sonnet` | 일반 문서 `claude-haiku`, 외부 문서 조사와 디자인 `claude-sonnet` |
| [oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex) | `gpt-6-astra` 또는 `gpt-5.6-sol` (`default`/`team`) | 계획 `gpt-6-astra` 또는 `gpt-5.6-sol` (`medium`), 설계와 비평 (`xhigh`) | 기본 `gpt-6-astra` 또는 `gpt-5.6-sol`, 저복잡도 팀 `gpt-5.6-luna` | 비평 `gpt-6-astra` 또는 `gpt-5.6-sol` (`xhigh`), 보안 별도 기본값 없음 | 탐색 `gpt-6-astra` 또는 `gpt-5.6-luna` (`medium`), 조사 `gpt-5.6-terra` (`high`) | 요약 헬퍼(`sparkshell`)는 지정 요약 모델, 디자인 별도 기본값 없음 |
| [pi-subagents](https://pi-plugins.vercel.app/guides/subagent-models/) | 호스트 세션 모델, 사전 분류기는 `Jev`와 OpenAI 체인 | 계획(`strong` `high`): `Opus 5.5` / `GPT-6.1 Sol` / `Gemini 4 Argon`, 상위 티어는 `Fable 5.2` / `Astra` / `Carbon` | 워커(`balanced` `medium`): `Sonnet 5.5` / `GPT-6.1 Terra` / `Gemini 4 Hydrogen` | 리뷰(`strong` `high`): `Opus 5.5` / `GPT-6.1 Sol` / `Gemini 4 Argon` | 탐색(`fast` `low`/`high`): `Sonnet` 또는 `Haiku` / `GPT-6 Luna` / `Gemini 4 Hydrogen` | 문서와 조사(`balanced` `medium`): `Sonnet 5.5` / `GPT-6.1 Terra` / `Gemini 4 Hydrogen` |
| [agent-orchestrator](https://github.com/willynikes2/agent-orchestrator) | 1순위 `claude`, 2순위 `codex`, 3순위 `gemini`, 4순위 `grok` | 오케스트레이터와 동일 (`claude` 우선) | 1순위 `codex`, 2순위 `claude`, 3순위 `gemini`, 4순위 `antigravity`, 5순위 `grok` | 1순위 `claude`, 2순위 `codex`, 3순위 `gemini`, 4순위 `antigravity`, 5순위 `gemini-4-argon` | 외부 인텔리전스 탐색 1순위 `grok`, 2순위 `gemini`, 3순위 `claude`, 4순위 `codex` | UI와 문서(`uidocs`) 1순위 `gemini`, 2순위 `codex`, 3순위 `claude`, 4순위 `antigravity` |
| [Hydra](https://github.com/mikecubed/Hydra) | 컨시어지: 1순위 `OpenAI`, 2순위 `Anthropic`, 3순위 `Google` | 설계 제안 `Claude`, 분석과 비평 `Gemini`, 정제 `Claude` | 구현 `Codex`, 자문 `GitHub Copilot` | 분석과 리뷰 `Gemini`, 정제 `Claude` | 백그라운드 워커는 작업 유형별 자동 배정 | 컨시어지 대화창이 사용자 보고 담당 |
| [ccgx-workflow](https://github.com/wzyxdwll/ccgx-workflow) | `Claude Code` (단독 파일 쓰기 권한 보유) | `Claude Code` | 백엔드 `Codex`, 프론트엔드 `Gemini` (둘 다 패치만 반환) | 최종 코드 리뷰와 병합 `Claude Code` | 자료 없음 | 프론트엔드 UI `Gemini` |
| [skill-multi-agent](https://github.com/b0qi/skill-multi-agent) | `Claude Code` (작업 분할과 3-way worktree 병합) | 고불확실성 아키텍처는 `Codex`와 `Gemini` 동시 자문 | 대규모 변경과 리팩터링 `Codex` | 설계 리뷰와 세컨드 오피니언 `Gemini` | 테스트 작성 `Codex` | 최종 통합 보고 `Claude Code` |

### 저장소별 구독 한도 도달 및 장애 시 전환 규칙

- **[oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/guide/agent-model-matching.md) (2026-11 확인, 원문 확인):** 모든 폴백 체인에서 `anthropic-subscription`과 `chatgpt-subscription`이 API 키나 GitHub Copilot보다 우선하며, OpenRouter 같은 게이트웨이는 자동 선택에서 제외합니다. 연결된 계정이 해결할 수 없는 카테고리는 메인 에이전트 목록에서 숨기고, 세션 중 한도 도달 시 [agent-model-requirements.ts](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/packages/model-core/src/agent-model-requirements.ts)와 [category-model-requirements.ts](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/packages/model-core/src/category-model-requirements.ts)에 정의된 순서(예: `claude-opus-5-5`에서 `kimi-k3.1-pro`, `glm-5.3` 순)로 자동 전환합니다.
- **[triflux](../../../.claude/rules/tfx-routing.md) (2026-11 확인, 원문 확인):** `~/.claude/cache/claude-usage-cache.json`의 주간 사용량(`weeklyPercent`)이 80% 이상이면 Codex 작성 코드 리뷰를 `Claude Opus`에서 `Antigravity Gemini 4 Argon (high)`으로 바꾸고, Argon 작성 코드 리뷰는 `Codex GPT-6.1 Sol (high)`로 바꿉니다. [agent-route-policy.mjs](../../../scripts/lib/agent-route-policy.mjs#L196-L250)는 재시도 승격(`--retry auto-escalate`) 시 1단계 `Codex GPT-6 Astra (max)`, 2단계 최종 수단 `Claude Fable`로 올리며, `Google AI Ultra` 전용인 `Gemini 4 Carbon`이 없으면 같은 effort의 `Argon`으로 낮춥니다.
- **[oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim/blob/master/docs/configuration.md) (2026-11 확인, 원문 확인):** 서브에이전트에 `inheritModelFrom: "session"`과 배열 `model`을 함께 지정하면 평소에는 세션 모델을 따르다가, 레이트 리밋이나 쿼터 소진이 발생하면 현재 세션 모델을 제외한 설정 배열 순서대로 넘깁니다. 체인 전체가 한 번 실패하면 마지막 모델에서 1회 재시도한 뒤 무한 루프 없이 세션을 종료합니다.
- **[willynikes2/agent-orchestrator](https://github.com/willynikes2/agent-orchestrator) (2026-11 확인, 원문 확인):** Claude 사용량 한도 소진 시 리셋 시각까지 Claude를 비활성화하고 다음 CLI(Codex, Gemini 순)로 넘기며 리셋 시각에 자동 복구합니다. 일반 레이트 리밋과 Antigravity 429 오류는 5분 쿨다운 뒤 복구하고, `Gemini 4 Argon` API 크레딧 소진은 수동 복구(`/service up argon`) 전까지 비활성화합니다.
- **[mikecubed/Hydra](https://github.com/mikecubed/Hydra) (2026-11 확인, 원문 확인):** 일간, 주간, 슬라이딩 윈도우 3단계로 토큰 예산을 추적하며, 임계치에 도달하면 모델 티어를 `performance`에서 `balanced`, `economy` 순으로 자동 하향하고 모델별 서킷 브레이커로 장애 모델을 격리합니다.
- **[mnvsk97/harnessctl](https://github.com/mnvsk97/harnessctl) (2026-11 확인, 원문 확인):** `auto_failover: true`와 `failover_transfer: transcript` 설정 시 레이트 리밋이나 토큰 한도에 걸리면 `.harnessctl/handoffs/`에 저장된 전체 트랜스크립트나 요약을 다음 벤더 CLI(예: Claude에서 Codex)로 전달해 작업을 이어받습니다.
- **[musistudio/claude-code-router](https://github.com/musistudio/claude-code-router/blob/main/blog/en/project-motivation-and-how-it-works.md) (2026-11 확인, 원문 확인):** `default`, `background`(경량 Haiku 또는 로컬 Ollama), `think`(계획과 추론), `longContext`(tiktoken 실시간 계산 기준 32K 초과 시 전환) 4개 역할을 분리하고, [default-config.ts](https://github.com/musistudio/claude-code-router/blob/main/packages/core/src/config/default-config.ts)의 `Router.fallback` 배열에 등록된 대체 모델로 전환합니다.

### 최근 한 달(2026-10 ~ 2026-11) GitHub 트렌드 관련 저장소

- **[affaan-m/ECC](https://github.com/affaan-m/ECC) (2026-10-17 및 2026-11-13 트렌드, [agents-radar #4263](https://github.com/duanyytop/agents-radar/issues/4263) 기준 스타 302,058개, 원문 확인):** 72개 전문 에이전트와 327개 스킬을 포함한 멀티 하네스 시스템입니다. v2.2.3 기준 `Claude Code`, `Codex`, `Kimi Code` 동시 설치 마법사와 `Antigravity`, `Gemini`, `OpenCode`, `Cursor` 어댑터를 지원합니다.
- **[mattpocock/skills](https://github.com/JackEasons/github-trending/blob/main/2026/2026-11-01.md) (2026-11-01 트렌드, 스타 308,728개, 트렌드 리포트 확인):** 실무 엔지니어용 `.agents` 스킬 모음입니다.
- **[NousResearch/hermes-agent](https://github.com/duanyytop/agents-radar/issues/4263) (2026-11-13 트렌드, 스타 262,992개, 트렌드 리포트 확인):** 다중 모델과 다중 하네스 연동에 쓰이는 자율 에이전트입니다.
- **[thedotmack/claude-mem](https://github.com/duanyytop/agents-radar/issues/4263) (2026-11-01 및 2026-11-13 트렌드, 스타 116,607개, 트렌드 리포트 확인):** `Claude Code`, `Codex`, `Gemini`, `Hermes`, `OpenCode` 간에 세션 컨텍스트를 압축해 공유함으로써 벤더 전환 시 맥락 끊김을 줄입니다.
- **[stablyai/orca](https://github.com/JackEasons/github-trending/blob/main/2026/2026-11-01.md) (2026-10-19 및 2026-11-01 트렌드, 스타 111,964개, 트렌드 리포트 확인) 및 [paperclipai/paperclip](https://github.com/JackEasons/github-trending/blob/main/2026/2026-11-01.md) (스타 109,639개):** 멀티 에이전트 오케스트레이션 도구입니다.
- **[pbakaus/impeccable](https://github.com/JackEasons/github-trending/blob/main/2026/2026-11-01.md) (2026-11-01 트렌드, 스타 98,656개, 트렌드 리포트 확인):** 코딩 에이전트의 UI 디자인 품질을 높이고 AI 슬롭을 걸러내는 디자인 어휘와 감사 도구입니다.
- **[Yeachan-Heo/oh-my-claudecode](https://github.com/JackEasons/github-trending/blob/main/2026/2026-11-01.md) (2026-11-01 TypeScript 트렌드, 스타 40,474개, 원문 확인):** Claude Code 기반 멀티 에이전트 하네스입니다.
- **[Donchitos/Claude-Code-Game-Studios](https://github.com/Donchitos/Claude-Code-Game-Studios) (2026-11-01 트렌드, 스타 31,479개, 원문 확인):** 49개 에이전트와 75개 스킬로 구성된 게임 개발 스튜디오 하네스입니다. 기본값을 `modes.rigor: minimal`로 두어 불필요한 다중 디렉터 리뷰로 인한 토큰 낭비를 막습니다.
- **[Orkas-AI/Orkas](https://github.com/JackEasons/github-trending/blob/main/2026/2026-11-01.md) (2026-11-01 트렌드, 스타 7,012개, 트렌드 리포트 확인):** Commander 에이전트가 목표를 분할해 16개 내장 전문 에이전트와 `Claude Code`, `Codex`, `OpenCode`, `Hermes`를 조율하는 데스크톱 앱입니다.
- **[mksglu/context-mode](https://github.com/duanyytop/agents-radar/issues/3816) (2026-10-17 트렌드, 트렌드 리포트 확인) 및 [ruvnet/ruflo](https://github.com/duanyytop/agents-radar/issues/3834) (2026-10-18 트렌드):** 샌드박스 출력 98% 압축 라우터(`context-mode`)와 `Claude Code`, `Codex`, `Hermes` 지원 멀티 에이전트 스웜 하네스(`ruflo`)입니다.

## 2. 커뮤니티 반복 의견과 소수 의견

### 반복 의견 (여러 출처에서 확인된 의견과 건수)

- **오케스트레이터와 계획은 `Claude Opus 5.5` 또는 `Fable 5.1`/`5.2`에 맡기고, 구현과 반복 실행은 `GPT-6.1 Sol`이나 `Claude Sonnet 5.5`로 분리한다 (11건):**
  - **체감 의견:** `Claude` 상위 모델은 긴 체크리스트와 다단계 도구 호출 지시를 가장 정확히 따르고, `GPT-6.1 Sol`과 `Sonnet 5.5`는 단위 구현과 실행에서 비용 대비 효율이 높다는 평가가 지배적입니다. 확인된 출처는 [Rob Falconer 블로그](https://robfalconer.com/models/)(2026-11-13), [Tom Vance 블로그](https://shattered.io/best-ai-model-gpt-6-1-terra-vs-claude-opus-5-5-vs-gemini-4-argon-2026/)(2026-10-27), [Ars Technica #3204](https://arstechnica.com/civis/threads/adventures-coding-with-ai.1501554/page-81)(2026-11), [Zenn twinharness](https://zenn.dev/twinharness/articles/claude-code-codex-lowest-plans-duo)(2026-09-29), [Zenn tbnet](https://zenn.dev/tbnet/articles/claude-code-delegating-to-codex-and-gemini)(2026-05-16, 구세대), [Zenn mediiiiium](https://zenn.dev/mediiiiium/articles/llm-provider-resilience-design)(2026-07-04, 구세대), [V2EX #1207104](https://www.v2ex.com/t/1207104)(2026-04-21, 구세대), [GeekNews #26920](https://news.hada.io/topic?id=26920)(2026-02-23, 구세대), [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/guide/agent-model-matching.md), [oh-my-claudecode](https://github.com/yeachan-heo/oh-my-claudecode/blob/main/docs/ARCHITECTURE.md), [pi-subagents](https://pi-plugins.vercel.app/guides/subagent-models/)입니다.
  - **수치 근거:** [Reddit r/ClaudeAI Rust 압축 해제기 블라인드 테스트](https://reddit.sentinel-team.org/posts/1wso86h/snapshots/2026-10-02T18%3A00%3A12.704134Z)(2026-10-02, 4,055개 히든 테스트)에서 `Opus 5.5`($2.08, 10분 18초, 507MB/s), `Sonnet 5.5`($0.52, 3분 41초, 447MB/s), `GPT-6 Sol`($0.27, 6분 37초, 301MB/s) 모두 전체 테스트를 통과해 명확한 명세가 있는 구현에서는 `Sonnet 5.5`가 4분의 1 가격과 3분의 1 시간으로 완수했습니다.
- **단일 벤더 상위 요금제 하나보다 2~3개 벤더(Claude, ChatGPT/Codex, Google Antigravity)를 병행 구독해 한도 소진 시 넘기는 편이 안전하다 (9건):**
  - **체감 의견:** 5시간 제한과 주간 제한에 걸려 작업이 멈추는 일을 피하려고 여러 구독을 묶어 상태 표시줄이나 스크립트로 잔여량을 보며 작업을 나눕니다. 확인된 출처는 [Zenn shinai](https://zenn.dev/shinai/articles/ai-weekly-quota-autorun)(2026-11-07), [Zenn twinharness](https://zenn.dev/twinharness/articles/claude-code-codex-lowest-plans-duo)(2026-09-29), [클리앙 #19280143](https://www.clien.net/service/board/park/19280143)(2026-10-20), [Reddit r/ClaudeAI 운영진 공지](https://reddit.sentinel-team.org/posts/1vzomwt/snapshots/2026-08-28T21%3A57%3A44.576543Z)(2026-08-28), [Zenn uguisu_blog](https://zenn.dev/uguisu_blog/articles/f184b67962ce7c)(2026-08-08, 구세대), [Zenn tbnet](https://zenn.dev/tbnet/articles/claude-code-delegating-to-codex-and-gemini)(2026-05-16, 구세대), [Qiita ryun818](https://qiita.com/ryun818/items/acd7dd7eba5c4a80b456)(2026-05-17, 구세대), [HN #50078987](https://news.ycombinator.com/item?id=50078987)(2026-10), [V2EX #1187342](https://www.v2ex.com/t/1187342)(2026-01-21, 구세대)입니다.
  - **수치 근거:** [Zenn twinharness](https://zenn.dev/twinharness/articles/claude-code-codex-lowest-plans-duo)(2026-09-29)는 3개월간 지시 339건(명령 실행 4,284건) 중 Codex 한도 도달이 80회 발생했고, 9월 26일 점검 시 주간 한도를 Claude는 99% 쓴 반면 Codex는 7%(131회 호출 중 리뷰 95회, 구현 19회)만 써서 잔여량 기반 자동 배분 스크립트를 도입했다고 기록했습니다.
- **`Claude Opus 5.5`는 `medium`~`high` effort에서 토큰 효율과 가성비가 크게 개선되었으나, `xhigh`/`max`나 `Fable 5.2` 서브에이전트 다중 생성은 주간 할당량을 급격히 소진시킨다 (7건):**
  - **체감 의견:** `Opus 5.5`가 이전 세대나 `GPT-6 Astra`보다 주간 한도를 훨씬 덜 쓰면서 코딩 성능은 더 높다는 호평이 많으나, `xhigh` 이상이나 `Fable 5.2`로 서브에이전트를 여럿 띄우면 한도가 순식간에 바닥난다는 경고가 반복됩니다. 확인된 출처는 [클리앙 #19280143](https://www.clien.net/service/board/park/19280143)(2026-10-20), [HN #50078987](https://news.ycombinator.com/item?id=50078987)(2026-10-17), [Ars Technica #3203 및 #3210](https://arstechnica.com/civis/threads/adventures-coding-with-ai.1501554/page-81)(2026-11), [Reddit 1wnmxov](https://reddit.sentinel-team.org/posts/1wnmxov/snapshots/2026-09-26T00%3A10%3A19.642204Z)(2026-09-26), [Reddit 1wo1o5r](https://reddit.sentinel-team.org/posts/1wo1o5r/snapshots/2026-09-25T21%3A12%3A54.246642Z)(2026-09-25), [Reddit 1wneafc](https://reddit.sentinel-team.org/posts/1wneafc/snapshots/2026-09-22T22%3A20%3A56.692696Z)(2026-09-22), [linux.do #2977692](https://linux.do/t/topic/2977692)(2026-10-02)입니다.
  - **수치 근거:** [클리앙 #19280143](https://www.clien.net/service/board/park/19280143) 작성자는 Codex $200(20x) 요금제에서 `Astra (high)`로 computer-use를 쓰면 하루에 주간 한도의 30~40%가 소진(2~3일 만에 고갈)되는 반면, Claude Max $100에서 `Opus 5.5`는 동일 작업을 1주일 내내 버텼다고 보고했습니다. [Reddit 1wnmxov](https://reddit.sentinel-team.org/posts/1wnmxov/snapshots/2026-09-26T00%3A10%3A19.642204Z)의 SVG 생성 테스트(동일 프롬프트, `xhigh`)에서는 `Sol 6`가 126 AIU, `Astra`가 378 AIU($3.78), `Fable 5.1`이 811 AIU를 쓴 반면 `Opus 5.5 (xhigh)`는 반복 다듬기로 2,000 AIU를 넘겨 수동 중단했습니다.
- **작성한 에이전트와 다른 벤더의 모델에게 읽기 전용(`read-only`)으로 코드 리뷰를 맡기면 미탐이 줄고 메인 세션 컨텍스트도 아낄 수 있다 (6건):**
  - **체감 의견:** Claude가 짠 코드는 Codex(`Sol`/`Astra`)나 Gemini(`Argon`)에게, Codex가 짠 코드는 Claude(`Opus 5.5`)에게 교차 리뷰시키는 구성이 널리 쓰입니다. 확인된 출처는 [triflux](../../../.claude/rules/tfx-routing.md), [Zenn twinharness](https://zenn.dev/twinharness/articles/claude-code-codex-lowest-plans-duo)(2026-09-29), [Zenn read-only diff 리뷰 기록](https://zenn.dev/tbnet/articles/claude-code-delegating-to-codex-and-gemini)(2026-09-06 관찰 기록 포함), [b0qi/skill-multi-agent](https://github.com/b0qi/skill-multi-agent), [hoangsonww/AI-Agents-Orchestrator](https://github.com/hoangsonww/AI-Agents-Orchestrator/blob/main/orchestrator/README.md), [mikecubed/Hydra](https://github.com/mikecubed/Hydra)입니다.
  - **수치 근거:** 2026-09-06 기준 19회 관찰 기록에서 `git diff`를 `codex exec -s read-only`로 외부 리뷰시키면 Claude 메인 세션에 추가되는 토큰은 중앙값 약 600토큰, 대기 시간은 중앙값 13초여서 새로운 서브에이전트에 수십만 토큰을 태우는 것보다 훨씬 가벼웠습니다.
- **초기 `GPT-6 Sol`(9월 22일)은 성능이 실망스러웠으나, 일주일 뒤 나온 `GPT-6.1 Sol`(9월 29일)은 캐시 읽기 95% 할인($0.10/M)과 함께 `Astra`급 실무 가성비를 회복했다 (6건):**
  - **체감 의견:** 9월 22일 출시된 `GPT-6 Sol`은 `GPT-5.6 Sol`보다 못하다는 비판을 받았으나, 9월 29일 출시된 `GPT-6.1 Sol`은 사실상 `Astra`의 양자화/경량화 모델로 체감되며 장기 실행 워커로 많이 채택되었습니다. 확인된 출처는 [Reddit 1wtixue](https://reddit.sentinel-team.org/posts/1wtixue/snapshots/2026-10-02T15%3A31%3A06.815521Z)(2026-10-02), [Reddit 1wtftlt](https://reddit.sentinel-team.org/posts/1wtftlt/snapshots/2026-10-02T15%3A31%3A06.815521Z)(2026-10-02), [Reddit 1wo1o5r](https://reddit.sentinel-team.org/posts/1wo1o5r/snapshots/2026-09-25T21%3A12%3A54.246642Z)(2026-09-25), [linux.do #2977692](https://linux.do/t/topic/2977692)(2026-10-02), [GeekNews GPT-6.1 Sol 스레드](https://news.hada.io/topic?id=34135)(2026-10), [Zenn uhyo React 벤치마크 #19](https://zenn.dev/uhyo/articles/react-profession-bench-19?locale=en)(2026-10-09)입니다.
  - **수치 근거:** [Zenn uhyo React 벤치마크 #19](https://zenn.dev/uhyo/articles/react-profession-bench-19?locale=en)(2026-10-09)에서 `GPT-6.1 Sol (max)`는 87.13점을 기록해 `GPT-6 Astra (max)`(86.46점)와 `Fable 5.1 (high)`(86.44점)를 근소하게 앞섰고, 1위는 `Opus 5.5 (max)`(94.46점), 2위는 `Sonnet 5.5 (max)`(91.74점)였습니다. 또한 [Anass Kartit의 4개 3D/게임 과제 블라인드 테스트](https://www.kartit.net/blog/gemini-4-carbon-vs-claude-fable-5-2-opus-5-5-gpt-6-1-sol/)(2026-11-12)에서 `GPT-6.1 Sol`은 4개 과제를 모두 합쳐 40분 미만, API 정가 환산 $2.11로 끝내 `Fable 5.2`($41.85) 대비 약 20분의 1 비용이 들었습니다.
- **`Gemini 4 Argon`과 `Gemini 4 Carbon`은 프로모션 가격($2/$10, 12월 1일부터 $4/$20로 인상) 기간에 디자인, 보안, 지시사항 준수에서 가성비가 높다 (5건):**
  - **체감 의견:** 그간 코딩에서 뒤처졌던 Gemini가 `Argon`과 `Carbon`에서 크게 도약했으며, 특히 프론트엔드 디자인과 보안 취약점 분석과 명세 준수에서 강하다는 평가가 많습니다. 확인된 출처는 [HN #50078987](https://news.ycombinator.com/item?id=50078987)(2026-10-17), [Tom Vance 블로그](https://shattered.io/best-ai-model-gpt-6-1-terra-vs-claude-opus-5-5-vs-gemini-4-argon-2026/)(2026-10-27), [Anass Kartit 블라인드 테스트](https://dev.to/akartit/i-gave-gemini-4-carbon-claude-fable-52-opus-55-and-gpt-61-sol-the-same-prompt-the-ai-judges-1o21)(2026-11-12), [linux.do #3179224](https://linux.do/t/topic/3179224)(2026-11-15), [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/guide/agent-model-matching.md)입니다.
  - **수치 근거:** [Anass Kartit 블라인드 테스트](https://www.kartit.net/blog/gemini-4-carbon-vs-claude-fable-5-2-opus-5-5-gpt-6-1-sol/)(2026-11-12)에서 3개 AI 심사위원(`Gemini 4 Argon`, `Claude Opus 5.5`, `GPT-6.1 Sol`)은 3개 심사 과제 모두에서 `Gemini 4 Carbon`을 1위로 뽑았고, 사람 작성자는 블라인드 평가에서 심미성을 기준으로 `Claude Fable 5.2`를 모두 1위로 뽑았습니다. [ArtificialWatch 공개 리더보드 집계](https://artificialwatch.com/compare)(2026-11-16)에서 `Gemini 4 Carbon`은 `Opus 5.5`를 7개 보드 중 5개에서, `GPT-6 Astra`를 7개 중 6개에서, `Gemini 4 Argon`을 7개 모두에서 앞섰고 `Claude Fable 5.2`에게만 7개 모두 뒤졌습니다.

### 소수 의견 및 주의할 반론

- **장기 실행과 컴퓨터 사용(computer-use)에서는 `Opus 5.5`보다 `GPT-6 Sol`/`Astra`가 더 믿을 만하다는 의견:** [Reddit 1wo1o5r의 u/JonNordland](https://reddit.sentinel-team.org/posts/1wo1o5r/snapshots/2026-09-25T21%3A12%3A54.246642Z)(2026-09-25)는 `Opus 5.5`가 코드베이스 전체를 꼼꼼히 검색하지 않고 성급하게 수정해 심각한 실수를 내는 경향("lazy with research")과 과도한 안전 거절("nanny-state refusals")이 있는 반면, `GPT-6 Sol`은 브라우저/컴퓨터 조작과 장시간 실행에서 갑작스러운 지능 저하 없이 더 안정적이라고 평가했습니다.
- **리버스 엔지니어링과 보안 작업에서 `Opus 5.5`의 안전 가드레일 거절과 강제 폴백 문제:** [HN #50078987](https://news.ycombinator.com/item?id=50078987)(2026-10-17)에서는 `Opus 5.5 (medium)`가 스트리밍 비디오 변환 스크립트나 리버스 엔지니어링 요청을 거절해 오히려 `Opus 5.5 (low)`로 낮춰서 우회했다는 사례가 보고되었습니다. 실제로 `Opus 5.5`와 `Sonnet 5.5`는 사이버보안 고위험 요청 시 각각 `Opus 4.8`(또는 `Opus 5`)과 `Sonnet 5`로 자동 폴백되도록 설계되어 있습니다.
- **`GPT-6 Luna`가 이전 세대인 `GPT-5.6 Luna`보다 프로덕션 코드 작성 품질이 떨어졌다는 측정 결과:** [Zenn uhyo React 벤치마크 #19](https://zenn.dev/uhyo/articles/react-profession-bench-19?locale=en)(2026-10-09)에서 `GPT-6 Luna`는 `high` 기준 71.18점(`5.6 Luna`는 76.49점, -5.31점), `max` 기준 76.05점(`5.6 Luna`는 78.15점, -2.10점)으로 13개 명세 중 10개에서 점수가 하락해 `Opus 4.6` 수준으로 내려앉았습니다. 다만 `GPT-5.6 Luna` 시절의 [Reddit 198회 히든 테스트](https://reddit.sentinel-team.org/subreddits/ClaudeAI/snapshots/2026-07-20T20%3A24%3A21.6759Z)(2026-07-20, 구세대)에서는 `5.6 Sol`, `Terra`, `Luna`가 54회 전승과 존재하지 않는 파일(`services/estoque.js`) 검증 9/9 통과를 기록한 바 있어 세대 간 성격 변화가 확인됩니다.
- **Codex CLI에서 하위 모델 자동 강등 기능 거부감:** [클리앙 #19254722](https://www.clien.net/service/board/park/19254722)(2026-08-28, 구세대)에서는 `Sol` 한도 소진 시 무료인 `Luna`로 자동 전환하는 기능에 대해, 자는 동안 작업이 멈추는 것은 막아주지만 `Sol`과 `Luna`의 품질 격차가 커서 결과물을 믿기 어렵고 사용자가 모르게 뒷단에서 하위 모델로 강등하는 수단으로 악용될 수 있다는 반론이 제기되었습니다.

## 3. 언어권별 차이

### 영어권 (Reddit, Hacker News, Ars Technica, 개발자 블로그)

- **특징:** 독립 벤치마크(`Artificial Analysis`, `Terminal-Bench 4.0/4.1`, `SWE-bench Pro`, `Vals Index`)와 작업당 실측 비용($/task)을 기준으로 모델을 고릅니다.
- **주요 흐름:** [Ars Technica](https://arstechnica.com/civis/threads/adventures-coding-with-ai.1501554/page-81)(2026-11)와 [Reddit](https://reddit.sentinel-team.org/posts/1wso86h/snapshots/2026-10-02T18%3A00%3A12.704134Z)(2026-10)에서는 `Fable 5.2`를 서브에이전트로 남발했다가 주간 한도를 하루 만에 날린 실패담을 공유하며, `Opus 5.5`를 오케스트레이터로 두고 `Fable 5.2`는 최초 계획 생성이나 계획 리뷰에만 1회성으로 호출하는 방식을 선호합니다.

### 한국 (GeekNews, 클리앙)

- **특징:** 월 $100~$200 정액 구독(Claude Max, ChatGPT Pro/Work) 내에서의 체감 토큰 소모 속도와 멀티에이전트 캐시 효율을 가장 중요하게 봅니다.
- **주요 흐름:** [클리앙 #19279000](https://www.clien.net/service/board/park/19279000)(2026-10-17)에서는 OpenAI Codex 팀 리드 Tibo가 발표한 서브에이전트 간 컨텍스트 캐시 재사용과 보관 시간 연장 업데이트 전까지 멀티에이전트 구동 시 사용량이 4~5배 빠르게 줄어들었던 문제를 집중 분석했습니다. [클리앙 #19280143](https://www.clien.net/service/board/park/19280143)(2026-10-20)에서는 `Astra`의 빠른 한도 소진 때문에 Codex 요금제를 $200에서 $100으로 낮추고 `Opus 5.5`를 메인으로 옮기는 움직임이 나타났습니다.

### 일본 (Zenn, Qiita)

- **특징:** 최소 비용 조합(최저가 유료 플랜 2개 결합)과 셸 스크립트, 로컬 프록시, 작업 인계 파일(`.ai/WORKLOG.md`, `AXP/1` 포맷)을 활용한 정교한 자동화 엔지니어링이 발달해 있습니다.
- **주요 흐름:** [Zenn twinharness](https://zenn.dev/twinharness/articles/claude-code-codex-lowest-plans-duo)(2026-09-29)처럼 매 대화 시작마다 Claude와 Codex의 5시간/주간 사용률을 화면에 띄워 여유가 있는 쪽에 작업을 넘기거나, [Zenn shinai](https://zenn.dev/shinai/articles/ai-weekly-quota-autorun)(2026-11-07)처럼 주간 리셋 전에 남는 할당량(Claude Code, Codex, Antigravity Gemini 버킷, Antigravity Claude/GPT 버킷)을 토큰 소모 없이 조회해 무인 배치 작업으로 소진시키는 스크립트를 직접 만들어 씁니다. [Qiita ryun818](https://qiita.com/ryun818/items/acd7dd7eba5c4a80b456)(2026-05-17, 구세대)처럼 Pro Max OAuth 헤더를 유지한 채 429 오류 시 DeepSeek나 Gemini로 무중단 전환하는 로컬 프록시(`claude-code-fallback`)도 공유됩니다.

### 중국 (V2EX, 知乎, linux.do)

- **특징:** 지역 네트워크 차단과 계정 정지 위험 때문에 API 게이트웨이(`Nyro`, `Claude Code Hub`), 리버스 프록시, 다계정 풀링(Codex 5~20개 계정 회전), 그리고 중국산 코딩 플랜(`GLM 5.2/5.3`, `Kimi K3/K3.1 Pro`, `DeepSeek V4/V4.1 Flash`, `MiniMax M2.7/M3`)으로의 폴백이 필수 구조로 정착했습니다.
- **주요 흐름:** [linux.do #2977692](https://linux.do/t/topic/2977692)(2026-10-02, [知乎 칼럼](https://zhuanlan.zhihu.com/p/2085933690425812249) 인용, 지후 원문은 직접 열지 못해 원문 미확인)에서는 `Opus 5.5`가 `Fable 5.1`의 양자화/증류 모델이고 `GPT-6.1 Sol`이 `GPT-6 Astra`의 양자화 모델이라는 분석이 큰 호응을 얻었습니다. [V2EX #1207104](https://www.v2ex.com/t/1207104)(2026-04-20, 구세대)와 [V2EX #1187342](https://www.v2ex.com/t/1187342)(2026-01-21, 구세대)에서는 서브에이전트 리뷰가 한도를 너무 빨리 태우므로 일상 실행은 `Sonnet`이나 `GLM`/`Kimi`/`MiniMax`로 돌리고 핵심 아키텍처 정의와 리뷰에만 `Opus`나 `Codex`를 쓰는 비용 통제법이 주류를 이룹니다.

## 4. 대상 모델별 체감 및 수치 요약 (2026년 하반기)

### OpenAI GPT-6 및 GPT-6.1 계열

- **`GPT-6 Astra` (`gpt-6-astra`, 2026-09-03 출시, $10 / $50, 272K 초과 시 $20 / $75):**
  - **역할과 체감:** 고난도 아키텍처 설계(`architect`), 계획 리뷰(`plan-reviewer`), 심층 디버깅(`ultrabrain`, `deep-high`), 3D/Blender/컴퓨터 사용에 배치됩니다. 자율적인 목표 해결력과 검색 도구 활용이 뛰어나지만, 구독 할당량 소모가 매우 빠르고 공격적 사이버보안 요청은 Preparedness Framework Critical 등급에 따라 기본 거부됩니다.
  - **수치 근거:** 1.05M 컨텍스트, FrontierMath Tier 4 97.6%, OSWorld 2.0 72.6%, Terminal-Bench 4.0 57.9%를 기록했습니다.
- **`GPT-6.1 Sol` (`gpt-6.1-sol`, 2026-09-29 출시, $2 / $10, 캐시 읽기 $0.10):**
  - **역할과 체감:** 9월 22일 출시되어 혹평받은 초기 `GPT-6 Sol`을 대체한 기본 구현(`executor`, `deep-low`), 테스트 작성, 검증 워커의 주력 모델입니다. 캐시 읽기 요금이 95% 할인되어 반복 파일 읽기가 많은 에이전트 루프에서 가성비가 높습니다.
  - **수치 근거:** DeepSWE v1.1에서 초기 `GPT-6 Sol` 대비 6.4%p 상승해 `Astra`에 근접했고, Terminal-Bench Science 0.1 작업당 평균 비용이 $5.47로 `Opus 5.5`($23.21)와 `Astra`($23.80)의 4분의 1 수준입니다.
- **`GPT-6.1 Terra` (`gpt-6.1-terra`, 2026-10-26 출시, $1 / $5, 캐시 읽기 $0.05):**
  - **역할과 체감:** 균형형 중간 티어(`balanced`)로 일상적인 코딩, 시각/화면 추론, 문서 작성(`triflux`의 Codex 문서 경로), 대량 이미지/문서 처리에 쓰입니다. `Astra`와 `Sol`보다 3배 이상 빠릅니다.
  - **수치 근거:** Terminal-Bench 4.0(max effort) 50.3%, Vals AI Excel Modeling Benchmark 73.33%(6위)를 기록했으며, [ArtificialWatch](https://artificialwatch.com/compare) 기준 `Haiku 5.5`(6/6 보드)와 `GPT-6 Luna`(5/5 보드)를 모두 앞섭니다.
- **`GPT-6 Luna` (`gpt-6-luna`, 2026-09-22 출시, $0.10 / $0.50):**
  - **역할과 체감:** 초저가 고속 티어(`fast`/`spark`)로 코드베이스 탐색(`explore`), 빌드 오류 수정(`build-fixer`), 단순 파일 수정(`quick`), 대량 분류에 쓰입니다. 속도와 가격은 압도적이나 복잡한 코드 직접 작성에서는 오타나 품질 저하가 나타납니다.
  - **수치 근거:** [Reddit Rust 압축 해제기 테스트](https://reddit.sentinel-team.org/posts/1wso86h/snapshots/2026-10-02T18%3A00%3A12.704134Z)에서 비용은 $0.007로 가장 저렴했으나 오타 하나로 일반 zlib 파일 디코딩에 실패했고, [Zenn uhyo React 벤치마크 #19](https://zenn.dev/uhyo/articles/react-profession-bench-19?locale=en)에서는 `high` 71.18점으로 `GPT-5.6 Luna`(76.49점)보다 낮았습니다.

### Anthropic Claude 5.5 및 Fable 5 계열

- **`Claude Fable 5.2` (`claude-fable-5-2`, 2026-11-09 출시, $8 / $40) 및 `Fable 5.1` (2026-09-01 출시, $10 / $50):**
  - **역할과 체감:** Opus 상위의 최상위 Mythos급 모델로, 사전 계획 갭 분석(`plan-consultant`), 대규모 시스템 설계(`architect`), 창의적 해결(`artistry`), 재시도 최종 승격(`auto-escalate` 마지막 단계)에 쓰입니다. 코딩과 시각적 결과물 완성도는 현존 최고라는 평가가 많으나, 속도가 가장 느리고 서브에이전트로 다수 호출 시 주간 한도를 즉시 고갈시킵니다.
  - **수치 근거:** [ArtificialWatch](https://artificialwatch.com/compare)(2026-11-16)에서 `Fable 5.2`는 `Opus 5.5`, `GPT-6 Astra`, `GPT-6.1 Sol`, `Gemini 4 Carbon`을 상대로 7개 공개 리더보드 전부(7/7)에서 우위를 기록했습니다(AAII max 65점, Vals Index 71.31%, Vibe Code Bench 93.77% 1위, Terminal-Bench-Science 74.6%, FrontierSWE v2 69.9%).
- **`Claude Opus 5.5` (`claude-opus-5-5`, 2026-09-22 출시, $4 / $20, 캐시 읽기 $0.20):**
  - **역할과 체감:** 메인 오케스트레이터(`daily-normal`), 아키텍처 설계, 종합 코드 리뷰의 표준 모델입니다. 기본 effort가 `medium`으로 조정되고 토큰 소모가 줄어 `Opus 5` 대비 체감 가성비가 크게 올랐으나, 고위험 사이버 요청 시 `Opus 4.8`로 강제 폴백되는 제약이 있습니다.
  - **수치 근거:** SWE-bench Pro 89.9, Terminal-Bench 4.0 66.4%(xhigh), FrontierCode(medium) 54.6%를 기록했으며, [aivs.tv 3D & Shaders 비교](https://aivs.tv/coding/3d-shaders/)에서 135개 결정 포스트 중 101회 선택받아 1위를 차지했습니다.
- **`Claude Sonnet 5.5` (`claude-sonnet-5-5`, 2026-09-28 출시, $2 / $10, 캐시 읽기 $0.10):**
  - **역할과 체감:** 일상적인 코드 구현(`executor`), 프론트엔드 UI 구현, 디버깅, 테스트 엔지니어링의 기본 모델입니다. `Sonnet 5`보다 30% 이상 빠르고 명확한 요구사항이 주어졌을 때 `Opus 5.5`에 근접한 결과를 4분의 1 비용으로 냅니다.
  - **수치 근거:** Terminal-Bench 4.0 점수가 `Sonnet 5`의 10.3%에서 70.6%로 급등했고, Terminal-Bench 4.1 63.9%, OSWorld-2.1 83.9%, Vals Index 70.85%를 기록했습니다.
- **`Claude Haiku 5.5` (`claude-haiku-5-5`, 2026-10-07 출시, 100K까지 $0.10 / $0.50, 100K 초과 시 $0.50 / $2.50):**
  - **역할과 체감:** 빠른 코드베이스 탐색(`explore`), 경량 문서 작성(`writer`), 백그라운드 요약과 분류 서브에이전트에 쓰입니다. Haiku 최초로 effort 조절을 지원하지만 프롬프트가 100K 토큰을 넘으면 요금이 5배로 뛰므로 짧은 컨텍스트 작업에 적합합니다.
  - **수치 근거:** Anthropic 자체 측정 기준 `Opus 5.5 (medium)` 메인 에이전트 아래에 `Haiku 5.5` 서브에이전트를 위임하면 단독 `Opus 5.5` 대비 비용이 32% 절감되고 통과율은 약 4%p 낮아집니다.

### Google Gemini 4 계열

- **`Gemini 4 Carbon` (`gemini-4-carbon`, 2026-10-28 발표, 2026-11-10 유료 API 및 Google AI Ultra 공개, 할인가 $2 / $10, 12월 1일부터 $4 / $20):**
  - **역할과 체감:** 장기 에이전트 엔지니어링, 다중 저장소 추론, 보안 분석, Antigravity의 상위 오케스트레이터(`carbon` 프로필)로 쓰입니다. 프롬프트 지시사항 준수율이 매우 높다는 평가를 받습니다.
  - **수치 근거:** AAII v5.0 59점(high, 작업당 $7.76), AA Coding Agent Index(Antigravity CLI 결합) 59점(전체 2위, 1위는 Claude Code + Opus 5.5의 62점), SEC-bench Pro 88.2%, CWE-bench 71.0%를 기록했습니다.
- **`Gemini 4 Argon` (`gemini-4-argon`, 2026-09-30 발표, 2026-10-13 GA, 할인가 $2 / $10, 12월 1일부터 $4 / $20, 캐시 읽기 $0.20):**
  - **역할과 체감:** 프론트엔드/UI 디자인(`visual-engineering`, `designer`), 보안 리뷰(`security-reviewer`), 기술 문서 작성(`writing`, `writer`), 1M 입출력 통합 컨텍스트를 활용한 대규모 리팩터링에 배치됩니다.
  - **수치 근거:** DeepSWE v1.1 77.9%, CWE-bench v1 68%(공동 1위), LVBench 91.7%, Vals AI Excel Modeling 74.83%를 기록했습니다.
- **`Gemini 4 Hydrogen` (`gemini-4-hydrogen`, 2026-11-12 출시, 1M 전체 구간 단일 요금 $1.50 / $7.50):**
  - **역할과 체감:** `Gemini 3.8 Flash`를 대체하는 고속 실행 모델로, 일상적인 코드 작성, 테스트 실행, 변경 사항 검증, Antigravity의 워커/검증 서브에이전트에 배치됩니다. 100K 초과 할증이 없어 긴 컨텍스트 워커로 유리합니다.
  - **수치 근거:** Terminal-Bench 4.1 점수가 `3.8 Flash`의 18.2%에서 57.0%로 올랐고, SWE-sweep 13.5%(`Sonnet 5.5`는 3.1%), AA-Omniscience 환각률 8%를 기록했습니다. [GeekNews #37068](https://news.hada.io/topic?id=37068)(2026-11-12)에 정리된 Google Antigravity Orchestrator 측정에서 `Carbon`과 `Hydrogen`을 자동 전환하면 Terminal-Bench 4.0 기준 평균 할당량 소모가 24%, 완료 시간이 19% 줄었습니다.

## 5. 출처 목록

### GitHub 저장소 및 공식 설정 문서 (원문 확인)

- [code-yeongyu/oh-my-openagent Agent-Model Matching Guide](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/guide/agent-model-matching.md) (2026-11 확인, 원문 확인): 4개 메인 프로필(`daily-normal`, `daily-heavy`, `geeky-normal`, `geeky-heavy`), 4개 Curated 에이전트, 10개 작업 카테고리별 모델 폴백 체인과 구독 우선 규칙 명시.
- [code-yeongyu/oh-my-openagent agent-model-requirements.ts](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/packages/model-core/src/agent-model-requirements.ts) 및 [category-model-requirements.ts](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/packages/model-core/src/category-model-requirements.ts) (2026-11 확인, 원문 확인): `sisyphus`, `hephaestus`, `prometheus`, `oracle`, `momus` 및 카테고리별 코드 수준 폴백 정의.
- [triflux tfx-routing.md](../../../.claude/rules/tfx-routing.md), [agent-map.json](../../../hub/team/agent-map.json), [agent-route-policy.mjs](../../../scripts/lib/agent-route-policy.mjs) (2026-11-17 로컬 확인, 원문 확인): Codex(`astra`, `sol`, `terra`, `luna`), Antigravity(`carbon`, `argon`), Claude(`fable`, `opus`, `haiku`) 역할 매핑 및 Claude 주간 사용량 80% 도달 시 리뷰어 전환 규칙.
- [Yeachan-Heo/oh-my-claudecode ARCHITECTURE.md](https://github.com/yeachan-heo/oh-my-claudecode/blob/main/docs/ARCHITECTURE.md), [GETTING-STARTED.md](https://github.com/yeachan-heo/oh-my-claudecode/blob/main/docs/GETTING-STARTED.md), [PR #2614](https://github.com/Yeachan-Heo/oh-my-claudecode/pull/2614) (2026-04-13 병합 및 2026-11 확인, 원문 확인): `haiku`/`sonnet`/`opus`/`fable` 역할 배정과 `team.roleRouting` 기반 멀티 벤더 라우팅 및 동일 티어 Claude 폴백.
- [Yeachan-Heo/oh-my-codex omx-config-schema-routing.md](https://github.com/yeachan-heo/oh-my-codex/blob/main/docs/reference/omx-config-schema-routing.md) (2026-11 확인, 원문 확인): `gpt-6-astra` 및 `gpt-5.6-sol`/`terra`/`luna` 역할별 모델과 추론 수준(`xhigh`/`high`/`medium`) 설정 및 `sparkshell` 폴백.
- [alvinunreal/oh-my-opencode-slim configuration.md](https://github.com/alvinunreal/oh-my-opencode-slim/blob/master/docs/configuration.md) (2026-11 확인, 원문 확인): `inheritModelFrom: "session"`과 배열 `model`을 결합한 세션 모델 상속 및 장애 시 순차 폴백 규칙.
- [pi-subagents Choosing subagent models](https://pi-plugins.vercel.app/guides/subagent-models/) (2026-10-29 및 2026-11-12 기준, 원문 확인): Anthropic, OpenAI, Gemini, Antigravity의 4단계 티어 매트릭스와 6개 서브에이전트 역할별 기본 모델 및 effort 정책.
- [willynikes2/agent-orchestrator](https://github.com/willynikes2/agent-orchestrator) (2026-11 확인, 원문 확인): `orchestrator`, `implementation`, `uidocs`, `review`, `intel` 역할별 CLI 폴백 체인과 Claude 한도 리셋 대기, Antigravity 5분 쿨다운, `gemini-4-argon` 폴백 규칙.
- [mikecubed/Hydra README.md](https://github.com/mikecubed/Hydra/blob/main/README.md) (2026-11 확인, 원문 확인): Claude, Gemini, Codex 간 Council 워크플로우와 토큰 예산 임계치 기반 모델 티어 자동 하향.
- [hoangsonww/AI-Agents-Orchestrator README.md](https://github.com/hoangsonww/AI-Agents-Orchestrator/blob/main/orchestrator/README.md) (2026-11 확인, 원문 확인): `codex`(구현), `gemini`(리뷰), `claude`(정제/PM) 워크플로우와 성공률 0.6 미만 제외 및 로컬 모델 폴백.
- [mnvsk97/harnessctl](https://github.com/mnvsk97/harnessctl) (2026-11 확인, 원문 확인): 단계별 CLI 지정(`--plan codex --build claude --test codex`)과 한도 도달 시 트랜스크립트 인계 페일오버.
- [wzyxdwll/ccgx-workflow](https://github.com/wzyxdwll/ccgx-workflow) 및 [b0qi/skill-multi-agent](https://github.com/b0qi/skill-multi-agent) (2026-11 확인, 원문 확인): Claude Code 오케스트레이터 아래 Codex(백엔드/대규모 변경/테스트)와 Gemini(프론트엔드/설계 리뷰) 분담 및 폴백.
- [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router/blob/main/blog/en/project-motivation-and-how-it-works.md) (2026-11 확인, 원문 확인): `default`, `background`, `think`, `longContext` 4역할 라우팅과 폴백.
- [affaan-m/ECC README.md](https://github.com/affaan-m/ECC/blob/main/README.md) 및 [Donchitos/Claude-Code-Game-Studios README.md](https://github.com/Donchitos/Claude-Code-Game-Studios/blob/main/README.md) (2026-11 확인, 원문 확인): 최근 한 달 GitHub 트렌드 상위 멀티 에이전트 하네스 구조.
- [JackEasons/github-trending 2026-11-01](https://github.com/JackEasons/github-trending/blob/main/2026/2026-11-01.md) 및 [duanyytop/agents-radar #4263](https://github.com/duanyytop/agents-radar/issues/4263) (2026-11-01 및 2026-11-13, 원문 확인): 최근 한 달 GitHub 트렌드 오케스트레이터와 하네스 집계.

### 영어권 커뮤니티 및 기술 블로그

- [AutoRouter Models](https://autorouter.com/models) (2026-11 확인, 원문 확인, [홍보성]): 2026년 하반기 12개 주요 모델(`Fable 5.2`, `Astra`, `6.1 Sol`, `Opus 5.5`, `Sonnet 5.5`, `Haiku 5.5`, `6.1 Terra`, `Luna`, `Carbon`, `Hydrogen`, `Argon`)의 권장 역할과 입출력 단가 정리.
- [Rob Falconer: Latest AI Models](https://robfalconer.com/models/) (2026-11-13, 원문 확인): 작업별 추천 모델과 `Fable 5.1`/`Opus 5.5`(계획과 리뷰) 및 `GPT-6.1 Sol`/`Sonnet 5.5`(실행) 조합 제시.
- [Tom Vance (Shattered.io): Best AI Model Terra vs Opus 5.5 vs Argon](https://shattered.io/best-ai-model-gpt-6-1-terra-vs-claude-opus-5-5-vs-gemini-4-argon-2026/) (2026-10-27, 원문 확인): CI 자율 코딩은 `Opus 5.5`와 `Sonnet 5.5`, 대량 문서/이미지는 `GPT-6.1 Terra`, 보안 취약점 분류와 Google 연동은 `Gemini 4 Argon`으로 나누는 팀 라우팅 전략 제시.
- [Anass Kartit (DEV / 개인 블로그): Gemini 4 Carbon vs Claude Fable 5.2 vs Opus 5.5 vs GPT-6.1 Sol Blind Test](https://www.kartit.net/blog/gemini-4-carbon-vs-claude-fable-5-2-opus-5-5-gpt-6-1-sol/) (2026-11-12, 원문 확인): 4개 3D/게임 과제 블라인드 테스트에서 AI 심사위원단은 `Carbon`을 만장일치 1위로, 사람은 `Fable 5.2`($41.85)를 1위로 선정했고, `GPT-6.1 Sol`($2.11, 40분 미만)이 최단 시간과 최저 비용을 기록.
- [ArtificialWatch: Head-to-head on public leaderboards](https://artificialwatch.com/compare) (2026-11-16, 원문 확인): 43개 모델, 173개 공개 리더보드 맞대결 집계.
- [aivs.tv: 3D & Shaders AI coding comparisons](https://aivs.tv/coding/3d-shaders/) (2026-11 확인, 원문 확인): 1,063개 게시물 중 `Opus 5.5`가 101승 34패로 최다 선택.
- [Ars Technica OpenForum: Adventures coding with AI (Page 81)](https://arstechnica.com/civis/threads/adventures-coding-with-ai.1501554/page-81) (2026-11-16, 원문 확인): `Fable 5.2` 서브에이전트 8개 호출로 주간 할당량이 소진된 사례와 `Opus 5.5` 오케스트레이터 아래 `Fable 5.2`를 계획과 계획 리뷰어로만 제한하는 운영 경험.
- [Hacker News #50078987 (Gemini 4 Argon 스레드)](https://news.ycombinator.com/item?id=50078987) (2026-10-17, 원문 확인): `Opus 5.5`의 코딩 우위 평가, `Argon`의 속도 호평, `Opus 5.5 (medium)`의 리버스 엔지니어링 거절을 `low`로 우회한 사례, $200 플랜 주간 한도 도달로 `pi` 하네스와 Gemini Flash API로 이동한 사례.
- [Hacker News #50519153](https://news.ycombinator.com/item?id=50519153) (2026-11-16, 원문 확인) 및 [Hacker News #49914208](https://news.ycombinator.com/item?id=49914208) (2026-10-02, 원문 확인): `Fable 5.2`의 높은 비용 불만과 `Opus 5.5` 및 `Sol 6.1` 예고 없는 출시 논의.
- [Reddit r/ClaudeAI 1wso86h: Sonnet 5.5 vs Opus 5.5 Rust decompressor](https://reddit.sentinel-team.org/posts/1wso86h/snapshots/2026-10-02T18%3A00%3A12.704134Z) (2026-10-02 스냅샷, 원문 확인): `Opus 5.5`, `Sonnet 5.5`, `GPT-6 Sol`, `GPT-6 Luna`의 4,055개 히든 테스트 실측 비교.
- [Reddit 1wtixue (GPT-6.1 Sol AAII 결과)](https://reddit.sentinel-team.org/posts/1wtixue/snapshots/2026-10-02T15%3A31%3A06.815521Z) 및 [Reddit 1wtftlt (GPT-6.1 Sol 출시 반응)](https://reddit.sentinel-team.org/posts/1wtftlt/snapshots/2026-10-02T15%3A31%3A06.815521Z) (2026-10-02 스냅샷, 원문 확인): `GPT-6.1 Sol`의 가성비와 캐시 미스 디버깅 통과 사례, 초기 `GPT-6 Sol` 네이밍 비판.
- [Reddit 1wo1o5r (Opus 5.5 vs Sol 6)](https://reddit.sentinel-team.org/posts/1wo1o5r/snapshots/2026-09-25T21%3A12%3A54.246642Z) 및 [Reddit 1wnmxov (Lighthouse SVG 비교)](https://reddit.sentinel-team.org/posts/1wnmxov/snapshots/2026-09-26T00%3A10%3A19.642204Z) (2026-09-25 및 2026-09-26 스냅샷, 원문 확인): `Opus 5.5`와 `Sol 6`/`Astra`의 장단점 및 `xhigh` 토큰 과소모 비교.
- [Reddit r/ClaudeAI 멀티모델 MCP 위임 벤치마크 (구세대)](https://reddit.sentinel-team.org/subreddits/ClaudeAI/snapshots/2026-07-20T20%3A24%3A21.6759Z) (2026-07-20 스냅샷, 구세대 모델 `Fable 5`, `Opus 4.8`, `Sonnet 5`, `Haiku 4.5`, `GPT-5.6 Sol/Terra/Luna`, 원문 확인): 198회 히든 테스트에서 Codex 계열이 54/54 전승을 기록한 실험.
- [Pasquale Pillitteri: A DOS language model built with Claude fits on a 435 KB floppy](https://pasqualepillitteri.it/en/news/33724/a-dos-language-model-built-with-claude-fits-on) (2026-11-15, 기사 원문 확인, 기사 내 Reddit 작성자 코드와 가중치는 미공개라 `원문 미확인`): `Fable 5.2`가 367K 파라미터 DOS 트랜스포머 코드를 짜고 `Opus 5.5`가 3,500개 학습 데이터를 생성했다는 사례 보도.

### 한국 커뮤니티 (GeekNews, 클리앙)

- [GeekNews #37068: Gemini 4 Hydrogen 출시](https://news.hada.io/topic?id=37068) (2026-11-12, 원문 확인): `Hydrogen`의 벤치마크와 단가($1.50/$7.50), Antigravity Orchestrator에서 `Carbon`과 `Hydrogen` 자동 전환 시 할당량 24% 및 시간 19% 절감 요약.
- [GeekNews #34135: Claude Opus 5.5 출시](https://news.hada.io/topic?id=34135) (2026-09-22, 원문 확인) 및 [GeekNews #34424: Claude Opus 5.5 프롬프트 작성법](https://news.hada.io/topic?id=34424) (2026-09-28, 원문 확인): `Opus 5.5`의 C-to-Rust HAProxy 재작성(9.5시간, `Fable 5.1` 대비 비용 51% 절감) 및 `medium` effort 권장 사항.
- [클리앙 모두의공원 #19280143: codex, claude 토큰소모 경험](https://www.clien.net/service/board/park/19280143) (2026-10-20, 원문 확인): Codex $200 요금제의 `Astra (high)`가 2~3일 만에 주간 한도를 소진하는 반면 Claude Max $100의 `Opus 5.5`는 1주일을 버틴다는 실사용 비교.
- [클리앙 모두의공원 #19279000: GPT 코덱스 서브에이전트 간 컨텍스트 캐시 재사용](https://www.clien.net/service/board/park/19279000) (2026-10-17, 원문 확인): 서브에이전트 간 캐시 미적용으로 사용량이 4~5배 빠르게 줄었던 원인과 10월 17일 캐시 재사용 패치 분석.
- [클리앙 모두의공원 #19254722: Codex 한도 소진 시 하위 모델 스위칭 테스트 (구세대)](https://www.clien.net/service/board/park/19254722) (2026-08-28, 원문 확인): `Sol` 한도 소진 시 무료 `Luna`로 낮추는 기능과 역할별 수동 혼합(`Sol` 분석, `Luna` 단순 반복) 댓글 토론.
- [GeekNews #26920: 2026년 2월 기준 코딩 에이전트 활용 현황과 워크플로우 비교 (구세대)](https://news.hada.io/topic?id=26920) (2026-02-23, 원문 확인): 초기 `Opus`와 `Codex` 병행 사용 및 하네스 팬아웃 시 토큰 한도 도달 경험.

### 일본 커뮤니티 (Zenn, Qiita)

- [Zenn shinai: Claude Code, Codex, Antigravity의 주간 이용 한도를 남기지 않고 자동으로 다 쓰는 구조](https://zenn.dev/shinai/articles/ai-weekly-quota-autorun) (2026-11-07, 원문 확인): 4개 할당량 버킷을 토큰 소모 없이 읽어 목표 진행률보다 남는 버킷에 무인 작업을 배정하고 마감 임박 시 상위 모델(`Opus`, `high`)로 올리는 자동화 스크립트.
- [Zenn uhyo: React Proficiency Benchmark #19 Latest GPT Edition](https://zenn.dev/uhyo/articles/react-profession-bench-19?locale=en) (2026-10-09, 원문 확인) 및 [#17 Opus 5.5](https://zenn.dev/uhyo/articles/react-profession-bench-17?locale=en) (2026-09-24, 원문 확인): `Opus 5.5`, `Sonnet 5.5`, `Fable 5.1`, `GPT-6.1 Sol`, `GPT-6 Astra`, `GPT-6 Luna`의 React 코드 품질 정량 비교.
- [Zenn twinharness: Claude Code와 Codex를 최소 유료 플랜끼리 조합하기까지](https://zenn.dev/twinharness/articles/claude-code-codex-lowest-plans-duo) (2026-09-29, 원문 확인): 3개월간 지시 339건, 명령 4,284건, 한도 도달 80회 데이터를 바탕으로 한 교차 리뷰와 잔여 할당량 기반 동적 배분.
- [Zenn uguisu_blog: ClaudeCode 이용 제한이 오면 Codex로 갈아타는 구조를 만들었다 (구세대)](https://zenn.dev/uguisu_blog/articles/f184b67962ce7c) (2026-08-08, 구세대 `Opus 5` 및 `GPT-5.6 Sol/Terra/Luna`, 원문 확인): `/statusline`으로 5시간/7일 사용률을 감시하고 한도 도달 직전 `.ai/WORKLOG.md`를 남겨 Codex CLI로 인계하는 절차.
- [Zenn mediiiiium: 모델은 깨진다는 전제로 설계한다 (구세대)](https://zenn.dev/mediiiiium/articles/llm-provider-resilience-design) (2026-07-04, 원문 확인): Antigravity CLI 주간 락아웃(168시간) 경험과 `CLAUDE.md` 기반 `Opus`/`Sonnet` 역할 분리 및 Gemini-Claude 자동 폴백(`fallback.js`).
- [Qiita ryun818: /fallback 명령으로 DeepSeek / Gemini / ChatGPT에 심리스 전환 (구세대)](https://qiita.com/ryun818/items/acd7dd7eba5c4a80b456) (2026-05-17, 원문 확인): Pro Max OAuth를 유지하면서 429/5xx 발생 시 타 벤더로 세션을 끊지 않고 넘기는 로컬 프록시.
- [Zenn tbnet: Claude Code에서 Codex / Gemini에 작업을 위임하기 (구세대)](https://zenn.dev/tbnet/articles/claude-code-delegating-to-codex-and-gemini) (2026-05-16 본문 및 2026-09-06 read-only diff 리뷰 관찰 기록, 원문 확인): Claude(사령탑), Codex(반증과 구현), Gemini(구조 발상) 역할 분담.

### 중국 커뮤니티 (linux.do, V2EX, 知乎)

- [linux.do #3179224: Claude Sonnet 5.5 也有自尊心](https://linux.do/t/topic/3179224) (2026-11-15, 원문 확인): `Fable 5.2`, `Gemini 4 Carbon`, `Opus 5.5`, `Sonnet 5.5`, `GPT-6 Astra`의 벤치마크와 단가 비교(본문 내 인용된 2개 저장소 105개 인공 버그 테스트 수치는 1차 출처가 없어 `원문 미확인`).
- [linux.do #2977692: 揭秘 Opus 5.5 和 Sol 6.1 的身世](https://linux.do/t/topic/2977692) (2026-10-02, linux.do 원문 확인, 본문에 링크된 [知乎 칼럼 p/2085933690425812249](https://zhuanlan.zhihu.com/p/2085933690425812249)는 `원문 미확인`): `Opus 5.5`가 `Fable 5.1` 기반 경량화 모델이고 `GPT-6.1 Sol`이 `GPT-6 Astra` 양자화 모델이라는 근거와 캐시 반값 정책 분석.
- [linux.do #3003619: gpt6astra 强还是 claude sonnet5.5 强](https://linux.do/t/topic/3003619/19) (2026-10-10, 원문 확인) 및 [linux.do #3033460: Fable과 Argon 문서 작업 선택](https://linux.do/t/topic/3033460/10) (2026-10-16, 원문 확인): 모델 간 체감 비교.
- [V2EX #1227492: 5.6 三个模型和 5.5 速度差距好大啊 (구세대)](https://www.v2ex.com/t/1227492) (2026-07-15, 구세대 `GPT-5.6 Sol/Terra/Luna` vs `5.5`, 원문 확인): 요구사항 및 버그 분석에서 `Sol (medium)`(1분 42초)만 1차에 원인을 맞히고 `Terra (high)`(2분 53초)와 `Luna (high)`(1분 13초)는 1차에 오답을 낸 실측 비교.
- [V2EX #1207104: 一行代码让 Claude Code / Gemini / Codex 接入任意 LLM (구세대)](https://www.v2ex.com/t/1207104) (2026-04-20, 원문 확인, 본문 Nyro 게이트웨이 소개는 [홍보성], 댓글 #80/#100은 실사용자 의견): 서브에이전트 리뷰로 인한 할당량 급감 문제와 `Sonnet` 실행 + `Opus` 아키텍처 리뷰 분리.
- [V2EX #1189815: Claude Code Hub 다중 공급자 로드밸런싱 (구세대)](https://www.v2ex.com/t/1189815) (2026-01-31, 원문 확인, [홍보성]) 및 [V2EX #1187342: token 不够用，大家是一个什么组合 (구세대)](https://www.v2ex.com/t/1187342) (2026-01-21, 원문 확인): `oh-my-opencode` 역할 분담과 Antigravity/Codex 다계정 및 `GLM`/`MiniMax` 폴백 조합.

--- HANDOFF ---
status: ok
lead_action: accept
verdict: 2026년 11월 17일 기준 GitHub 멀티 에이전트 오케스트레이터 저장소 13곳과 최근 한 달 트렌드 저장소, 영어/한국어/일본어/중국어 커뮤니티의 역할별 모델 배치 및 사용량 한도 폴백 방식을 원문 확인과 수치/체감 구분 원칙에 맞춰 정리했습니다.
files_changed: none
confidence: high
