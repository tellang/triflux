# 커뮤니티 체감 리서치: 코딩 역할별 모델 배치와 구독 한도 (2026-09 이후)

## 목적

개발자 커뮤니티(Hacker News, Reddit)에서 사람들이 어떤 모델을 어떤 코딩 역할에 쓰는지, 여러 벤더 구독의 한도를 어떻게 나눠 쓰는지 모은다. 특정 벤더나 결론을 전제하지 않고 찬반을 같이 적는다. 작성일 2026-11-17.

## 수집 방법과 한계

- Hacker News: Algolia API로 2026-09-01 이후 스토리와 댓글을 검색하고 스토리별 댓글 트리를 직접 읽었다. 댓글 추천 수는 API가 주지 않아 스토리 점수만 적는다. 댓글은 작성일만 적는다.
- Reddit: 공개 JSON은 `www.reddit.com`이 403, `old.reddit.com`은 로그인 안내 페이지로 막혔다. Exa 본문 읽기도 Reddit은 SOURCE_NOT_AVAILABLE였다. 그래서 Brave 검색(site:reddit.com)이 돌려주는 스레드 제목과 스니펫만 썼다.
- Reddit 건수는 스레드 단위이고, 본문 전체와 추천 수와 정확한 작성일은 확인하지 못했다. 날짜는 검색 기간 필터(2026-09-01 이후, 항목에 따라 10-15, 10-25, 11-12 이후)로만 좁혔다. 스니펫은 그 스레드의 일부 댓글이라 Reddit 쪽 건수는 하한으로 읽는다.
- 직접 검색하지 못한 서브레딧: LocalLLaMA, cursor, ExperiencedDevs, programming, ChatGPTCoding, OpenAI. Brave 결과에 나온 곳은 ClaudeAI, ClaudeCode, codex, GeminiAI, Bard, google_antigravity, AntigravityGoogle, claude, GoogleGeminiAI, vibecoding, GithubCopilot, aigamedev.
- 모델 이름은 2026년 하반기 이름 그대로다. 구세대(GPT-5.6, Opus 4.x, Fable 5/5.1) 이야기는 그렇게 표시한다.
- 건수 규칙: 서로 다른 댓글 또는 스레드를 1건으로 센다. 한 사람 의견은 반복 의견에 넣지 않았다. 아래 건수는 내가 읽은 표본 기준이고 전수 조사가 아니다.
- 홍보성은 `[홍보]`로 표시한다.
- 범위 확장(2차 수집): 영어권 블로그와 뉴스레터, X, 한국어권(클리앙, GeekNews, 블로그), 일본어권(Zenn, Qiita, note, Scrapbox), 중국어권(V2EX, linux.do, 微博)을 추가했다. 섹션 6에서 10이다. 이 섹션은 Exa 검색으로 찾은 글을 Exa 본문 열람으로 읽었고, 읽지 못한 것은 스니펫만 썼다고 밝힌다.
- X는 직접 열 수 없었다. Ridge(별점 사이트), MindPattern, zeronoise 같은 집계 요약을 거친 간접 확인이고, 원문 게시물과 정확한 좋아요 수는 집계 사이트가 적은 값을 옮긴 것이다.
- 언어권별로 반복 의견을 따로 센다. 번역과 요약 사이트(GeekNews의 GN⁺ 댓글, AIwitness)는 원문 커뮤니티의 의견을 옮긴 것이라 그 언어권 건수에서 뺀다.
- Latent Space는 집계 사이트(Jyst)에 실린 AINews 요약만 확인했다. Interconnects는 기간 안에 관련 글을 찾지 못했다(6월 22일 LinkedIn 글만 있음). Zvi의 4월 글(GPT-5.5와 Opus 4.7 시대)과 Pragmatic Engineer의 3월 설문(Opus 4.5와 Sonnet 4.5 시대)은 구세대라 표시만 하고 건수에서 뺀다.

## 1. 역할별 체감

### 1-1. 계획과 설계: 가장 강한 모델이 계획하고 싼 모델이 실행 (반복 의견, HN 13건 + Reddit 7개 스레드)

가장 많이 반복된 구조다. 계획 담당은 Fable이나 Opus가 많고, GPT 쪽(Sol, Astra)을 계획이나 리뷰에 쓰는 사람도 있다. 실행 담당은 Opus 5.5, Sonnet 5.5, Sol 6.1, Luna, DeepSeek Flash, Gemini로 나뉜다.

HN 사례:
- Fable이 PLAN.md를 쓰고 Opus나 Sonnet이 실행, 속도가 빨라지고 비용이 줄었다고 함 (49673210, 2026-09-12).
- Fable과 Astra를 plan mode 전용 "자문" 에이전트로 두고, 코딩은 싼 모델에 맡김. Sol 6.1이나 Opus 5.5가 "Director"로 조율 (50172724, 2026-10-20).
- Fable로 추론하고 Opus 서브에이전트를 띄움. 부모 컨텍스트를 가볍게 유지하려는 목적 (49806051, 2026-09-22).
- Fable 5.2 max로 전략, 설계, 계획. Opus 5.5 서브에이전트로 구현. 명시적 go가 있을 때만 빌드 (50477200, 2026-11-13).
- Opus가 계획을 세우고 Fable 서브에이전트에게 검토시킴. CI 개선 12개 PR을 한 시간 미만의 개입으로 받음 (49947634, 2026-10-03).
- Sol이 계획과 디버그에 약 10유로, Luna가 구현에 약 5유로. 이전의 Opus 전용 일 30에서 50유로보다 쌌다는 API 사용자 (50004455, 2026-10-08).
- Opus 계획, DeepSeek Flash 구현, Opus 리뷰를 자동화. 강한 모델의 리뷰 없이 flash 모델만 구현시키면 실수라는 주장 (49877628, 2026-09-28).
- CC+Opus 계획, Codex+Luna 구현, Pi+Qwen 타이브레이커 (49898702, 2026-09-29). Show HN 맥락의 하네스 홍보 스레드 안의 댓글이다.
- Antigravity에서 Opus 5.5 계획, Gemini 3.8 구현, 지금은 Argon으로 전부 (50373135, 2026-11-05).
- Codex(Sol)가 설계, Claude와 Gemini가 검토, Luna가 구현, 다시 Claude와 Gemini가 구현 검토 (49546418, 2026-09-03).
- Fable 5.1 계획과 구현 지휘, Opus 5 구현 서브에이전트, Astra 리뷰 (49704032, 2026-09-14).
- Opus 5.5 리뷰와 오케스트레이션, Haiku 5.5 잡일 (50167441, 2026-10-20).
- 현재 위 목록에 안 넣은 변형: Opus가 CC 세션에서 PM 역할로 antigravity, codex, pi 에이전트를 조율 (49948057, 2026-10-03).

Reddit 사례 (스니펫 기준):
- Fable은 초기 계획과 마지막 검증, 구현은 Opus 5.5 (r/ClaudeCode 1xsbfiw).
- Opus 5.5 High가 계획과 오케스트레이션, Sol 6.1 Medium이 구현과 디버그 (r/ClaudeAI 1x6dhb0).
- Opus가 경계까지 넣은 계획을 만들고 Codex(Sol 6.1)를 headless로 실행, Luna가 구현과 리뷰 (r/codex 1x805d9).
- Fable이 오케스트레이션, Opus가 작성, Sol이 리뷰 (r/ClaudeCode 1wuayqi).
- Carbon이 계획, Fable 5.2 에이전트가 적대적 검증, 합의 뒤 Fable이 코딩 (r/GeminiAI 1xssll3).
- Opus 5.5가 PLANS_FOR_ANTIGRAVITY.md를 쓰고 Antigravity에서 Hydrogen이 실행, Claude 사용량 절약 (r/GeminiAI 1xwbrj9).
- Claude(Opus, Fable)가 아키텍트, Gemini(Argon)가 실행자. 이 조합에는 Claude Max 20x가 같이 필요하다는 말 (r/AntigravityGoogle 1x79jlx).

반론과 변형:
- Fable 없이 Opus 5.5 하나로 위임까지 한다 (49969157, 2026-10-05). Opus 5.5가 싸고 충분해서 Fable 조율 구조를 접었다는 후기다.
- 작은 모델이 서브에이전트를 지휘하면 틀린 가설을 과하게 구체화해 넘긴다. Fable이 Opus와 Sonnet을 지휘하든 반대든 같은 문제를 겪었다 (50435303, 2026-11-10).
- 계획과 실행 전환 지점에서 모델끼리 서로 권한이 있다 없다고 설득하는 실패 (49935330, 2026-10-02).
- 단일 모델 선호: "Opus 5.5가 나온 뒤로 스킬을 다 버리고 medium으로 Claude만 쓴다" (50367037, 2026-11-04), "Codex Pro 하나와 스킬 몇 개로 충분" (50367866, 2026-11-04), "프런티어 모델 사이에 차이가 안 보인다" (50376908, 2026-11-05), "제공사가 다 비슷한 수준" (50377263, 2026-11-05).

### 1-2. 구현: Opus 5.5가 기본 주력, Fable 5.2는 선택 (반복 의견, HN 6건 + Reddit 7개 스레드)

"Fable 5.2는 대부분 필요 없고 Opus 5.5가 기본"이라는 의견:
- 일반 코딩에서는 Fable 5.2와 Opus 5.5를 구분하기 어렵고, 야심 찬 프롬프트에서만 차이가 난다 (50430766, 2026-11-09). Fable 5.2는 5.1보다 빠르고 최대 출력 토큰 초과가 없다는 점도 같이 적음.
- Fable 5.1이 Opus 5.5보다 많은 SWE 작업에서 나빴고 사용량이 급감, 5.2는 직관 의존 작업에서 다시 최선일 것이라는 추정 (50434465, 2026-11-10).
- Sonnet 5.5와 Opus 5.5 medium으로 Rust/Tauri를 매일 만들고, Fable은 "다음 모델의 미리보기, 돈이 남을 때만" (50437411, 2026-11-10).
- Fable 5.1과 Opus 5.5 사이 블라인드 선택에서 Fable 자신이 Opus 결과물을 고름 (Ask HN 50368059, 2026-11-04, 2점).
- "Fable은 대부분 과잉, 더 낫긴 한데 비용만큼은 아니다" (50447027, 2026-11-10).
- 시도할 마음이 안 든다. Opus가 응답성에서 앞선다 (50430544, 2026-11-09).
- Reddit: "Is fable 5.2 actually worse than opus 5.5 in most cases" (r/ClaudeAI 1xtdfma), "Fable 5.2 sticking with Opus 5.5" (r/ClaudeCode 1xsbfiw), "Is Opus 5.5 still better than Fable 5.2" (r/ClaudeAI 1xw4dbe, "Fable 5.2는 간결하고 퉁명스럽다"), "I tested Fable 5.2 against Opus 5.5 on real tasks" (r/ClaudeAI 1xwt0ka, 루틴 코딩은 Opus 권장, 어려운 오픈엔디드 작업은 Fable), "Opus 5.5 is still the better daily driver" (r/ClaudeCode 1xul65u, Fable 5.2 발표문이 Opus 5.5를 코딩 데일리 드라이버로 두라고 말한다는 서술. 원문 미확인), "I started using Fable 5.2 today and I'd say I prefer Opus 5.5" (r/ClaudeCode 1xs6tkq), "Fable 5.2 vs Opus 5.5: Finding the Sweet Spot" (r/ClaudeAI 1xsmqdd, Opus xhigh와 Fable high와 Fable max 곡선 비교, Fable 5.2는 max에서 과잉 사고한다는 평가).

Fable 5.2 쪽 소수 의견과 근거:
- 결정과 큰 그림이 낫다. "Opus가 막히면 Fable이 풀어 준다" (r/ClaudeCode 1xs6tkq, r/ClaudeAI 1xsyx2x).
- 이미지에서 HTML로 만드는 테스트에서 원본 충실도가 Opus 5.5보다 높다고 보고 (50430962, 2026-11-09, 개인 비교 페이지).
- Fable 5.2 high가 FrontierCode에서 Opus 5.5 최고 설정과 비슷하고 작업당 비용은 절반 (r/ClaudeCode 1xs1r7u, Anthropic 차트를 인용한 댓글).
- 토큰 소모 쪽 반론: Fable 5.2는 high에서 76,158 토큰, $3.05, Opus 5.5는 19,767 토큰, $0.40. 더 똑똑하다기보다 더 쓰는 것이라는 해석 (50432975, 2026-11-09, playcode.io 벤치 `[홍보]` 성격의 회사 블로그).
- 한도 소모: Pro에서 Fable이 Opus보다 4배 빠르게 한도를 먹는다는 PSA (r/ClaudeCode 1xt1eo1), Fable이 주간 사용량 절반이라는 댓글 (r/ClaudeCode 1xqqco0).

Opus 5.5 자체에 대한 논쟁:
- Opus 5.5가 11월 3일에 너프됐는가 (스토리 50422069, 2026-11-09, 826점, 댓글 520). 지시 준수와 코드 품질이 떨어졌고 토큰 소모가 늘었다는 주장 (50423198). 같은 프롬프트로 9월과 11월을 재실행했더니 차이가 없다는 반박 (50432936, playcode.io `[홍보]` 성격). Sonnet 5.5는 변화가 없다는 말도 있음.
- xhigh보다 medium이 낫다는 SlopCodeBench 해석에 대한 이견: 점수가 15% 안팎이라 노이즈일 수 있고 medium은 잔여 코드가 가장 많다 (50108717 스레드의 50180980, 2026-10-21).

### 1-3. 리뷰: GPT 계열(Sol, Luna, Astra)을 리뷰어로 쓰는 쪽이 많다 (반복 의견, HN 11건 + Reddit 4개 스레드)

Claude가 쓰고 Codex 계열이 리뷰하는 패턴이다.
- HN: Codex가 Claude 작업을 PR마다 자동 리뷰 (50377121). Opus 5.5 high 구현을 Opus 서브에이전트와 Codex Sol 6.1 high가 리뷰 (50414824). Opus 5.5를 Sol 6.1이 리뷰 (50373589). Codex가 기본 리뷰, 중요 작업은 Grok과 Gemini(agy)도 (50370886). Fable 계획을 Sol이 리뷰 (49806051). Sol 6.1이 medium에서도 Opus 5.5 작업의 특이하지만 타당한 엣지 케이스를 찾지만 주력으로는 "숲을 못 본다"는 평 (50176207, 2026-10-21). Luna xhigh가 Fable 5.2가 놓친 버그를 찾음 (50438393, 2026-11-10, 작성자 본인의 리뷰어 플러그인 `[홍보]`). Codex가 Claude 코드를 리뷰하는 하네스, Codex는 "세부에 집착" (Ask HN 50243565). Astra로 계획과 구현 리뷰 (49704032). Codex는 리뷰와 세컨드 오피니언과 백업용 (50367676). 더 비싼 모델은 리뷰에서만 가치가 있다는 의견 (50377284).
- Reddit: Sol을 uncommitted diff와 main 대비 PR 전 리뷰어로, high effort (r/ClaudeCode 1wuayqi). Opus가 코드를 쓰고 Sol 6.1 xhigh가 리뷰, Sol의 느림을 Opus도 안다는 농담 (r/codex 1x3k1li). Opus로 고치고 Sol이 감사, "Sol은 너무 오래 걸린다" (r/codex 1xwamla). Luna가 리뷰 (r/codex 1x805d9).

반대 방향과 반론:
- 반대 배치: Sol 6.1이 일꾼, Opus 5.5가 리뷰어. 이유는 순전히 비용 (r/codex 1x9lq18).
- Fable이 리뷰에 좋다. "/code-review에서 다른 에이전트가 놓친 것을 잡는다" (r/ClaudeAI 1xsgmrp), 10만 줄 게임 코드베이스 리뷰에서 Opus보다 큰 개선 지적 (r/aigamedev 1xtallk, 댓글 한 건).
- 리뷰 루프가 소모적이다. OpenAI 모델은 항상 뭔가 지적해야 하는 경향이 있어 build와 review를 5~7회 돌아야 안정된다는 경험 (49884863, 2026-09-28). 서브에이전트 리뷰어가 점점 사소한 결함을 지적하고 하네스가 문자 그대로 따라 이상한 결과가 나온다 (49558334, 2026-09-03).
- 다른 리뷰 조합: Opus가 Argon용 리뷰 프롬프트를 만들어 agy에 수동 붙여넣기. 자동 호출은 타임아웃과 사용량 소모 때문에 포기 (50367399, 2026-11-04).

### 1-4. 디버깅과 막힌 문제: 근거가 얇다

반복 의견이라 할 만한 건수가 없다. 개별 사례만 적는다.
- Astra가 Sol 5.6과 Opus 5에 막힌 작업을 깨끗하게 풀었다 (49673437, 2026-09-12), 새 문제에서 Sol에 막혔다가 Astra가 풀어 줬다 (Ask HN 49661691의 질문자, 2026-09-11).
- Argon이 Sol 6.1 medium이 못 고친 이슈를 고쳤다 (50288820, 2026-10-29).
- Fable은 Opus가 막혔을 때 풀어 준다 (r/ClaudeCode 1xs6tkq).
- Sol은 계획과 디버그에 쓰는 사람이 있다 (50004455).
- 반대 사례: GPT 6 계열을 "투명하게 무능하다"고 평하고 Opus 5.5가 정리와 리팩터를 45분에 끝냈다 (r/codex 1xcof7y, 격한 단독 의견).

### 1-5. 탐색과 잡일: Haiku 5.5를 검색용으로 쓰는 의견과 반박이 나뉜다

- 긍정: Haiku 5.5를 Explore 서브에이전트에 쓰라는 글 (r/ClaudeCode 1x0kzbh, 가격이 Opus의 1/40이라는 주장), 파일명과 줄 번호를 돌려주는 retriever로 최적이라는 댓글 (r/ClaudeCode 1x27a6k), 서브에이전트로 쓰기 좋다 (r/ClaudeCode 1x03lg8, r/ClaudeAI 1xaur97), Haiku는 순수 기계적 셸 작업만 (r/ClaudeCode 1x5rbwy).
- 부정: "Haiku 5.5 is cheap bad", 컨텍스트가 작아 워크플로에 쓰기 어렵다 (r/ClaudeCode 1x27a6k). Sonnet explorer가 Opus explorer보다 비싸다. Opus가 단계를 덜 쓰기 때문 (r/ClaudeCode 1x0kzbh). 작은 모델은 effort를 높여야 해서 Opus medium이 Haiku max보다 2배 빨리 끝난다 (50481593, 2026-11-13).
- Haiku는 작은 수정용이고 Opus가 시켜 보면 무너진다는 5.5 이전 경험 (49996540, 2026-10-07). 5.5가 이를 고쳤는지는 커뮤니티 글에서 확인하지 못했다.
- Gemini는 탐색에 불리하다는 말: agy가 "controller 문서 수정" 같은 단순 작업에도 파일을 대량으로 컨텍스트에 넣는다 (50475502, 2026-11-12).
- 긴 컨텍스트 워커로 Gemini 3.8 Flash를 쓴다는 한 건 (r/GeminiAI 1xhw48g 스니펫). 단독 의견.

### 1-6. 프런트엔드와 디자인: Opus 5.5가 우세, 이견은 소수 (HN 2건 + Reddit 4개 스레드가 Opus 쪽)

- Opus 5.5 쪽: 프런트엔드는 Opus 5.5가 경험칙 (r/codex 1xwamla, HTML/CSS로 미리보기를 만들고 그대로 구현). Sol 6.1이 UI/UX에서 Sol 5.6보다 크게 후퇴했다는 글과 "백엔드는 Sol 6.1, 프런트는 Opus 5.5" 분업 (r/codex 1xd16fg). Codex를 떠나 Claude로 옮기자 UI와 프런트엔드가 밤낮으로 좋아졌다 (r/codex 1xphcam). ChatGPT로 UI 이미지를 렌더하고 HTML로 바꾼 뒤 Opus 5.5에 넘기는 경로 (r/vibecoding 1xa1gra). 최근 한 달 프런트엔드는 Claude Design만, 백엔드는 Codex. Codex는 "작동은 하지만 디자인은 못한다" (50367571, 2026-11-04). 이미지에서 HTML 테스트에서 Opus 5.5와 Astra가 A 등급, Sol 6.1이 그 아래, Argon이 B 등급 (50074851, 2026-10-13, 개인 비교 페이지).
- Fable 5.2도 디자인 충실도가 높다는 보고: 이미지에서 HTML (50430962). JavaScript로 그림을 그리는 능력이 별도 이미지 모델의 가치를 의심하게 한다 (50430766).
- 소수 반례: Sol 6.1이 시각 작업에서 매우 구체적인 지시를 받으면 Opus를 이긴다 (r/ClaudeCode 1x56wuh). Argon이 SwiftUI와 AppKit에서 Opus보다 좋았다 (50367399). Carbon 코드가 더 깔끔하다 (r/google_antigravity 1xsvrq5).
- Google 쪽 일반 평: Google 모델은 범용과 리서치에 좋고 코딩은 상대적으로 약하다 (50167441, 2026-10-20). 하네스가 "악몽"이라는 평은 paddo.dev 글이 HN 댓글을 인용한 말이다.

### 1-7. 문서와 글쓰기: 건수 적음, Terra 언급이 눈에 띔

- Terra를 글쓰기와 시각 이해와 컴퓨터 사용 용도로 추천. OpenAI 직원을 자처한 댓글이 "기술 커뮤니케이션은 Terra가 Astra와 Sol보다 나을 수 있다"고 적음 (50249160, 2026-10-26, 벤더 직원 발언이라 중립 근거는 아님).
- Claude의 글투를 못 견뎌 GPT-5.6 Terra high fast와 Luna로 전환. 단 Sol 이상은 코드베이스를 전부 다시 쓰려 해서 못 쓴다 (49673395, 2026-09-12, 구세대 GPT-5.6 Terra 기준).
- 집에서 Terra를 쓰는데 Sonnet보다 한 번에 쓸 만한 코드를 더 낸다 (49673603, 2026-09-12).
- Opus 5는 글이 수수께끼 같아 Fable로 갔다가, Opus 5.5가 커뮤니케이션이 좋아졌다 (49948057, 2026-10-03).
- Astra는 글(자연어)은 잘 쓰지만 코드는 줄바꿈을 생략하는 코드 골프식이다 (50171776, 2026-10-20). 같은 스레드에서 Astra 변경을 1000줄 이상에서 약 100줄로 줄였다는 경험 (50175065).

### 1-8. 오케스트레이터와 리드

- Opus 5.5나 Fable이 리드, 나머지가 워커라는 구조가 대부분이다. 위 1-1 목록 참조.
- Gemini Orchestrator: Carbon이 읽기 전용 단계에서 계획을 세우고 Hydrogen이 쓰기와 테스트를 맡다가 막히면 Carbon에 넘김. 발표문 인용 (50472918, 2026-11-12, 벤더 설명). 사용자 반응은 서브에이전트 모델 선택을 모델에 맡기기 불안하다는 쪽 (50473078)과 "구독 가치가 나빠 Opus나 Sol로 전부 하는 게 낫다" (50473339).
- Antigravity /teamwork: 보조 에이전트 간 의례가 많고 Codex보다 느려졌다 (50499606, 2026-11-14), 감사 에이전트의 거짓 완료 보고 문제가 여전하다 (50503005, 2026-11-15). 스토리 50496811은 214점, 댓글 50.

## 2. 벤더 혼합 워크플로의 후기와 실패담

성공 후기는 1-1과 1-3에 있다. 아래는 실패와 비용 문제다.

- 에이전트끼리 협업하면 권한 설득, 루프 횟수 한계를 스스로 정하는 실패가 생긴다 (49935330, 2026-10-02).
- Claude가 agy를 자동 호출하게 하려다 타임아웃과 사용량 급소모로 포기, 수동 복붙으로 돌아감 (50367399, 2026-11-04).
- OMC teams와 worktree로 Max 20x 주간 토큰을 이틀 만에 소진, 컨텍스트가 모든 에이전트에 복제되고 디스크도 참 (50503464, 2026-11-15).
- 리뷰어 에이전트 루프가 사소한 지적으로 이어지고 하네스가 문자 그대로 수용 (49558334, 49884863).
- Argon 다중 에이전트의 거짓 완료 보고 (50503005), Gemini 3.8 Flash가 대규모 리팩터를 stub으로 채우고 완료라 보고, Argon이 리뷰하며 발견 (50074656, 2026-10-13). Argon도 mock이나 placeholder 함수를 코딩하고 테스트가 "항상 거짓말"이라는 평 (r/GeminiAI 1xml0js).
- Gemini 쪽 오케스트레이션 불신: 계획 모델이 서브에이전트에 틀린 가설을 구체화해 넘김 (50435303, 2026-11-10).
- 플랫폼 위험: Antigravity 약관상 서드파티 사용 시 계정 정지 가능이라는 스토리 (49548452, 2026-09-03, 338점). 서드파티 하네스를 겨냥한 가격 구조라는 지적 (50495427, 2026-11-14).
- 가용성: Claude 장애 때 "다양화"가 방법으로 거론됨. DeepSeek 하네스에 Codex와 Claude 구독과 OpenRouter를 묶어 장애, 한도 소진, "cyber" 플래그 거절에 대응 (50482070, 2026-11-13, 스토리 50481220 "Claude Is Down" 200점). Claude는 보조로만 쓰고 OpenRouter와 오픈 가중치로 갈아탔다는 사례도 있다 (50482570).
- 라우터 `[홍보]`: Weave Router (Show HN 49911500, 2026-09-30, 123점, 작성자 본인 제품). 세션당 1회 라우팅은 사실상 불가능하다는 반박 (49927566).

## 3. 한도와 구독

### 3-1. 한도가 찼을 때 넘기는 방법 (반복 의견)

- 싼 오픈 가중치와 DeepSeek Flash로 넘김 (HN 7건): OpenCode Go $10에 DeepSeek Flash (50367789), Claude $20 + DeepSeek Flash API 주력 (50367215), $20 Codex 한도 악화로 OpenCode Go 병행 (50376216), 월 약 100유로 규모의 오픈 가중치 중심 (50367326), 사내에서 Sonnet 이상이 거의 필요 없다는 사례 (50373357), Opus 리뷰와 Haiku 또는 DeepSeek Flash (50167441), mimo, deepseek flash 우선 (49673218).
- 다른 벤더 구독으로 폴백 (HN 4건, Reddit 3개 스레드): Claude 한도에 걸리면 Codex Astra (50377455), "다양화" (50482070), 구독 여러 개 병행 (50373740, 50367571, 50375606, 50367399, 50370886), 20달러 플랜 추가 (r/ClaudeCode 1xqqco0), Codex로 전환 선언 (r/ClaudeCode 1xq4ree), 무거운 grep과 테스트 실행을 Codex로 넘겨 Claude 한도를 보존하는 `[홍보]` 성격의 오픈소스 도구 (r/ClaudeAI 1xmmmte).
- 계획은 비싼 쪽에서 하고 실행은 싼 쪽(예: Hydrogen)에서 하는 사용량 분산 (r/GeminiAI 1xwbrj9).
- 모델 등급을 낮춰 한도를 늘림: Sonnet 5.5로 전환 (r/ClaudeCode 1xqqco0), Opus 5.5 medium (50367744, 50437411), Sol low나 medium (50367589).

### 3-2. 구독별 체감

Claude (Max 포함):
- 긍정: Opus 5.5 효율 덕분에 5x 플랜으로 2, 3세션 병렬도 충분 (49882083, 2026-09-28), $20 플랜이 지금은 좋은 가치, 대개 주간 한도에 못 미침 (50367744, 2026-11-04), 이전보다 세션과 주간 한도에 덜 걸림 (50373589).
- 부정: 주간 쿼터가 하루 만에 사라짐 (r/ClaudeAI 1xmmmte), 한도가 반으로 줄었다 (r/ClaudeAI 1xfs5q8), 쿼터가 비정상적으로 빨리 사라져 Opus에서 Sonnet으로 전환 (r/ClaudeCode 1xqqco0), 10월에 20x 계정 둘이 주간 리셋 전에 소진 (r/ClaudeCode 1xul65u), Ultra 3개 한도를 한 주에 소진하고 API에 $1.5k (50423198, 2026-11-09), 낮은 Max 플랜 주간 80% (50435303), Max 5x에서 Sonnet 쪽이 더 많이 먹는다는 토큰 비교 (49882650).
- Fable: Max와 Ultra 포함, Pro는 제외 (50438215가 지원 문서를 인용, 2026-11-10). 주간 Fable 사용량 한도가 따로 있고 리셋은 주간 50% 이상 남았을 때 의미가 있다 (r/ClaudeCode 1xsgguy, 1xs0nn4).
- 사용 요령: 단일 $200이 주간 한도를 올리지 않으니 $100 계정 둘이 낫다는 경험 (50367399).

ChatGPT와 Codex:
- 9월 말에는 Codex Pro 20x가 사실상 무제한이고 한도는 Claude Code 20x보다 훨씬 넉넉하다는 평 (49805972, 2026-09-22). 같은 스레드에서 정반대: $100 플랜을 하루 만에 소진, Claude에서 API 가치로 약 $5,000 대 Codex $200 (49806331).
- 10월 이후에는 불만이 많다: ChatGPT $20 플랜의 한도가 지난달 너프되어 인색 (50277629), Plus에서 Astra medium이 5시간 한도를 30분에, Sol low가 3.5분에 소진 (r/codex 1xg0vvk), Astra medium이 5시간에 50% (r/codex 1xhct16), 주간 한도를 일찍 소진 (r/codex 1xrvg8t, 11월 9일 글), $20 Codex 한도가 나빠져 해지 (50367744, 50376216).
- 변동: Pro $100, $200, $500 티어와 Business Premium의 한도를 두 배로 늘렸다는 공지 스레드 (r/codex 1xipj7s). 이후 11월 9일 글에서 다시 "한도가 조여졌다"는 보고. 시점별 변동이 커서 하나의 결론으로 묶기 어렵다.
- 효율: Sol 6.1이 Astra보다 토큰당 훨씬 효율적이라 같은 일에 한도를 덜 쓴다 (r/codex 1xm12io). Astra가 Sol보다 70% 토큰 효율이 좋다는 해석도 있다 (49587627, 2026-09-06, 벤더 수치 인용). 서로 부딪히는 경험이라 모델과 작업에 따라 다르다.
- 비교 서술: Claude가 같은 개발 작업에서 Codex 사용량의 절반쯤 소모 (r/codex 1xm12io 댓글).

Google AI Ultra와 Antigravity:
- 긍정: $20 Google 플랜의 한도가 가장 후하다. 순서는 Gemini, Claude, ChatGPT. Argon medium을 종일 써도 한도에 안 걸림 (50278012의 댓글 스레드, 2026-10-28, 개인 경험). Ultra $100에서 Argon medium과 high로 웹사이트와 앱과 리뷰를 해도 한도 근처에 안 감 (50443172, 2026-11-10). Carbon medium으로 macOS 앱을 서브에이전트 12개와 2시간 만들어 5시간 15%, 주간 6% (r/Bard 1xu4hjz). Hydrogen은 사용량이 매우 적다: 8개 프롬프트에 100%에서 96% (r/GeminiAI 1xujth6), High로 프로젝트를 구성해 5시간 한도의 20% 미만, 주간 5% 미만 (r/GeminiAI 1xuvian, 포르투갈어 댓글). Antigravity의 Claude와 GPT 모델이 같은 그룹 쿼터를 쓴다는 설명 (50277126 스레드의 댓글, 2026-10-28).
- 부정: Pro에서 Argon은 주간 약 2시간 (50288698, 2026-10-29), Argon medium 한 작업이 주간의 66% (r/google_antigravity 1xicgky), 5개 작업에 주간 Argon 한도 소진 (r/ClaudeAI 1xhu9ez), 하루 사용이 남은 주간 한도의 약 20% (r/google_antigravity 1x6tes3), "Pro에서 Ultra로 올리지 마라, 한도는 농담" (r/AntigravityGoogle 1x79jlx), 40% 소진 (50443364), 구독 가치가 나쁘다 (50473339). Antigravity 안의 Claude 쿼터는 5시간 단위 두 번 정도라는 보고 (r/google_antigravity 1xlbx3i).
- 접근성 문제: Argon은 Pro 사용자에게 몇 주 늦게 열렸고 (50277368), Carbon은 Ultra 전용이다 (50475121, 2026-11-12, agy CLI 표시). Workspace 계정은 Antigravity 가입이 막힌다 (50281040, 2026-10-28). Hydrogen은 체험 구독에서 사용 불가 (r/google_antigravity 1xuqxky).
- 요금 변수: 2026-12-01에 Argon과 Carbon 가격이 $2/$10에서 $4/$20으로 오른다 (dev.to 글, 출처 홍보성 아래 참조). 그 시점부터 토큰 비용 논의가 달라질 수 있다.
- 한도가 후하다는 쪽과 박하다는 쪽이 갈리는 원인으로 사용 플랜(Pro, Ultra, Fi 번들), effort(medium, high), 서브에이전트 사용 여부, Antigravity와 Gemini 앱 쿼터 분리 같은 변수가 보인다. 같은 조건의 비교는 못 찾았다.

기타 구독: Kimi Code는 5시간 한도가 몇 분 만에 소진되었다는 보고 (Ask HN 50222093, 2026-10-24). OpenCode Go $10 + DeepSeek Flash가 가성비 대안으로 반복 언급된다.

## 4. 모델별 체감 요약

OpenAI GPT-6:
- Luna: 싸고 빠르며 스펙을 따른다 (49673518, r/ClaudeCode 1x5rbwy). 구현과 리뷰 둘 다에 쓰인다 (r/codex 1x805d9). "Luna는 나쁘지 않고 좋지만 그 등급 최고는 아닐 수 있다" (r/GithubCopilot 1xhkc25). Artificial Analysis 코딩 에이전트 지수가 5.6 Luna보다 2점 낮고 60% 싸졌다는 인용 (49805991).
- Terra: 속도가 빠르고 덜 유능한 중간 모델. 글쓰기와 시각 이해용이라는 OpenAI 직원 설명과 "어중간한 중간 자식"이라는 평이 공존 (50249160, 50248477). 6.1 Terra는 2026-10-26 공개 (스토리 50248124, 638점).
- Sol 6.1: 토큰 효율과 가격이 장점이고 리뷰어로 좋다는 평이 많다. 단점은 느림, 루프, 코드베이스 전체를 다시 쓰려는 경향, UI/UX 후퇴, 주력으로 쓰면 숲을 못 본다는 평.
- Astra: 막힌 문제에서 가장 강하다는 평과 한도를 빨리 먹는다는 불만이 공존. 코드 스타일(코드 골프, 과잉 변경 1000줄 이상)에 대한 불만이 여러 곳에 있다 (50171776, 50175065). SlopCodeBench에서는 Astra가 종합 1위라는 스토리 제목이 있다 (50108717, 309점).

Anthropic Claude 5.5와 Fable:
- Haiku 5.5: 싸고 빠르고 Explore 서브에이전트용이라는 의견과 "cheap bad"라는 의견이 갈림. 100K 토큰 이하 요청 가격 $0.10/$0.50 (스토리 49996437, 1049점).
- Sonnet 5.5: 일상 코딩용으로 일관적이라는 5건(50424311, 50437411, 50373357, 50367589, 50377284)과, Opus 5.5가 충분하거나 토큰을 더 먹어 쓸 곳이 좁다는 5건(49882650, 50250366, 49882083, 49882102, r/ClaudeAI 1x03k4j)으로 나뉜다. Sonnet이 Opus의 약 90% 성능을 절반 가격에 낸다는 요약도 있다 (49882685).
- Opus 5.5: 가장 널리 쓰이는 기본 주력. 프런트엔드와 응답성과 효율에서 호평. 11월 너프 논쟁이 있고 증거가 나뉜다.
- Fable 5.2: 큰 그림, 결정, 막힌 문제 해결, 리뷰, 이미지에서 HTML 충실도가 장점. 단점은 비용과 한도 소모, 간결함 또는 퉁명스러움, 게임 메커닉을 시키지 않았는데 바꿨다는 사례 (50434424), 5.1 대비 속도와 안정성은 좋아졌다 (50430766).

Google Gemini 4:
- Argon: 느리고 확인을 자주 요구, 환각과 거짓 완료 보고 불만. 반면 SwiftUI 사례와 일부 개인 벤치에서 좋았다는 후기가 있다. 이미 "Argon은 사실상 끝났다"는 추측 (50475502).
- Carbon: Opus 5.5급 품질이라는 평(r/google_antigravity 1xsvrq5, r/GeminiAI 1xssll3)과 속도가 Argon의 약 3배, Opus의 약 1.5배라는 한 건(r/google_antigravity 1xszqoj)이 있는 반면, "Carbon과 Argon은 쓸 수 없을 만큼 느리다, /code-review가 Sol 15분인데 4~6시간" (r/GoogleGeminiAI 1xwq5rp)과 Opus medium보다 덜 끝난다 (r/ClaudeCode 1xuew04)는 반대도 있다. 엣지 케이스를 덜 잡지만 코드가 더 깔끔하다는 서술도 한 건. 속도 평가는 서로 정반대라 확정할 수 없다.
- Hydrogen: Flash 대체용 빠른 모델. Antigravity에서 사용량을 거의 안 먹는다는 보고가 반복되고(Reddit 4건), 3.8 Flash보다 두 배 빠르지만 연말까지 Flash를 유지한다는 팀(r/GeminiAI 1xv94ps)과 "코딩에 Gemini를 쓸 이유가 없다"는 평(50473339)이 공존. 낮은 thinking에서는 점수가 크게 떨어진다는 서술(r/google_antigravity 1xvc2ig)과 "high 유지"를 권하는 글(r/Bard 1xxed6e).

## 5. 소수 의견과 반론 모음

- 벤더 혼합이 불필요하다: 단일 모델과 단순 구성이 낫다 (50367037, 50367866, 50376908, 50377263).
- 비용 구조를 보고 모델을 고르면 안 된다는 주장: 토큰당 가격이 아니라 작업당 총비용으로 봐야 한다. Argon은 같은 가격표에서 코딩 작업당 5.8배라는 인용 (50075460), 한 개인 벤치에서는 Argon이 총비용 1.26배, 12월 이후 2.5배 (paddo.dev, 6건 변경, 20회 실행, 단일 코드베이스).
- 구독 보조금 구조 자체가 지속 불가능하다는 주장 (50473017, 2026-11-12).
- 벤치마크 불신: 벤더가 유리한 벤치를 고른다 (50278526), 하니스가 결과를 바꾼다 (50073879 계열, AA는 Carbon을 Antigravity CLI에서, Opus를 Claude Code에서 측정했다는 지적: ahmetbalaman.com).
- 오래된 인식: 3.x 시절 Gemini는 비에이전트 작업이 훌륭했다 (50074141).

## 6. 영어권 블로그, 뉴스레터, X 요약

### 6-1. 개발자 본인 글 (1인칭 사용 후기)

- Simon Willison (simonwillison.net, 2026-10-13에서 11-15):
  - Fable 5.2를 Datasette 1.0 마일스톤 작업에 "leaning hard"로 쓰고, 프롬프트 한 번으로 플러그인(datasette-maplibre)을 만들었다고 적음 (11-15).
  - Carbon을 Antigravity에서 같은 프롬프트로 시험함 (11-10). Fable 5.2 max는 128K 토큰을 사고에 쓰고 결과를 못 내는 버그가 Opus 5.5와 같다고 적음 (11-09).
  - 벤더 혼합 사례: GPT-6 Astra가 만든 파이썬 프로파일링 보고서를 Opus 5.5에 넣어 최적화를 쓰게 함 (10-13). 변경 대부분이 Claude Code나 Codex가 열어 주는 PR이라는 서술도 있음.
- Theo (t3.gg, YouTube, zeronoise 요약 경유):
  - Opus 5.5가 데일리 드라이버, Fable 5.2 max는 피하라(코딩 대부분에서 더 나쁘고 더 비쌈).
  - 자기 코드베이스(T3 Code 분석, PR 리뷰)에서는 Fable이 Opus와 Sonnet보다 거의 모든 테스트에서 낮았다고 함.
  - 디자인 스킬이 없으면 프런트엔드가 "Tailwind template slop"으로 돌아간다. Fable이 불필요한 부제 문구를 계속 넣어서 agent.md로 억제했다는 보고(고집 사례).
- 시키지 않은 변경에 관한 벤더 문서: Anthropic은 Fable 5.2가 "코드의 주인이 누구인가"에 민감하다고 적는다. 소유 문장을 넣으면 중복 코드를 통합하는 비율이 10% 미만에서 약 75%로 올랐다는 내부 테스트 수치다(Simon Willison 인용, 벤더 수치).
- Fireship: Fable이 Three.js 말을 43분 만들면서 스크린샷으로 자기 결함을 고치는 루프를 돌았다(zeronoise 요약).

### 6-2. 뉴스레터와 분석 글

- SemiAnalysis, 구독 가치 분석(2026-10-05, 유료 글이라 하이라이트와 요약 기사 확인):
  - Opus 5.5와 GPT-6.1 Sol을 "데일리 드라이버" 층으로 비교하면 Claude 구독의 API 환산 가치가 약 5배다. $20 기준 Claude Pro $1,178 대 ChatGPT Plus $211, $100 기준 $5,725 대 $1,055, $200 기준 $11,726 대 $2,084 (explainx 요약표 인용).
  - 플래그십 비교(Fable 5.1 대 Astra)는 비슷하지만 Fable은 한도의 50%까지만 쓸 수 있다.
  - OpenAI가 $200 플랜 가치를 절반으로 줄이고 $500 플랜을 신설했다는 추적 결과도 있다.
- 같은 글에 달린 HN 댓글 (50435497, 2026-11-10): Sol 6.1 High가 잘 정의된 작업에서 Opus 5.5 Medium과 비슷하지만 오케스트레이션은 Opus가 훨씬 낫다. 쓰는 구성은 Claude에서 Opus Medium이 Opus Medium 서브에이전트를 지휘, Codex에서 Astra Medium이 Sol High 서브에이전트를 지휘. 반론은 두 가지다. OpenAI 구독은 리셋이 잦고 5시간 한도가 없어 표보다 경쟁력이 있다. 작업당 비용과 토큰 효율을 빼고 비교하면 안 된다.
- SemiAnalysis GDPx 벤치마크, 소프트웨어 엔지니어링 영역(수치 근거, 3회 평균): Fable 5.2 24.4%에 작업당 $46.95, Carbon 11.1%에 $8.16, Sonnet 5.5 11.1%에 $18.26, Opus 5.5 8.9%에 $16.97, Sol 6.1 8.9%에 $2.57, Argon 8.9%에 $7.29, Astra 6.7%에 $13.41.
- Pragmatic Engineer (2026-10-20, 27개 회사 조사):
  - 지출이 여름에 정점이고 이후 줄었다. API 플랜 회사는 비용이 약 절반으로 줄었고 이유는 Opus 5.5 사용과 오픈 모델 전환이다.
  - 데이터 안에서 Claude와 Opus 5.5가 선호 모델. 구독 보조금이 끝나면 비용이 5배에서 10배 늘 수 있다는 회사들의 경고.
  - 같은 뉴스레터의 Satya Nadella 인터뷰(11-16)는 모델, 하네스, 메모리를 분리해 단일 벤더 종속을 피하라고 말하고, 모델을 "내부자 위험"으로 보고 별도 검증 시스템을 두라고 한다.
  - 구세대 표시: 2026-03 설문(906명, Opus 4.5와 Sonnet 4.5 시대)은 Claude Code 사랑 46%, 70%가 도구 2개에서 4개 병행.
- Latent Space AINews (2026-11-10, Jyst 요약 경유): Fable 5.2가 1위를 되찾았고 GDPx 작업당 비용이 31% 올랐다. max 설정에서 high보다 점수가 떨어진다는 독립 분석을 언급.

### 6-3. X 게시물 (집계 사이트 요약, 원문 미확인)

- Ridge 요약(2026-11-09에서 12, 11-12에서 16):
  - Fable 5.2: 데모가 인기(약 210 좋아요). 불만도 꾸준하다. 토큰을 Opus 5.5보다 30에서 50% 더 쓴다는 게시물(약 150 좋아요), 느리다, 플랜 한도를 빨리 먹는다. 이틀 쓰고 한도 리셋 두 번 뒤에 Opus 5.5로 돌아간다는 글(과잉 사고 때문).
  - Opus 5.5: "Opus 5.5 will still remain my workhorse, and I'll use Fable 5.2 sparingly as an orchestrator"라는 인용. "Opus 5.5 >>> Fable 5.2" 복사 게시물이 약 1,300 좋아요와 66,000 조회. 같은 섬 장면을 둘로 돌린 비교는 Fable($78 대 $55)이 이겼다.
  - Carbon: 가성비 칭찬(같은 복셀 프롬프트 약 $0.95 대 약 $12, 약 110 좋아요)과 느림 불만(약 150 좋아요)이 같이 나온다. 같은 프롬프트 4개에서 Fable은 4개 모두 첫 시도 성공, Carbon은 1개이고 시간은 거의 2배라는 팀 보고. 얼음 대성당 테스트에서 Carbon 2시간 39분에 $8.83, Sol 54분에 $3.11, Hydrogen $4.27. Antigravity의 Gemini 4 컨텍스트 한도가 11월 16일에 두 배가 됨.
  - Sonnet 5.5와 Haiku 5.5: "Sonnet이나 Haiku가 일하고 Opus가 자문하는" Anthropic advisor 구성 복사 게시물이 널리 퍼졌지만 품질 정보는 적다.
- MindPattern 요약(11-11, 11-12): a16z의 Martin Casado는 "Carbon is really good at code", Mikhail Parakhin은 코딩은 아직 신뢰하지 않지만 Carbon high가 수학과 ML에서 Fable 5.2를 자주 이긴다고 적음. 두 사람이 같은 날 정반대라 Carbon의 코딩 품질은 갈린다.

### 6-4. 영어권 블로그와 X의 반복 의견

- Opus 5.5가 데일리, Fable 5.2는 가끔 또는 오케스트레이터 (3건: Theo, Ridge 요약의 다수 게시물, Pragmatic Engineer의 Opus 5.5 선호).
- Carbon은 품질 대비 가격은 좋지만 느리다 (6건: Ridge 요약 2건, bito.ai, kartit.net, openteam.so `[홍보]`, MindPattern의 엇갈림). 수치 예시는 섹션 11-1 아래에 둔다.
- 구독 가치는 Claude 쪽이 크다는 분석 1건(SemiAnalysis)과, 토큰 효율과 리셋 때문에 단정하기 어렵다는 반론 2건(HN 댓글).

### 6-5. 외부 블로그의 자체 테스트 (표본이 작은 수치 근거)

- kartit.net (2026-11-12): 같은 프롬프트로 4개 과제를 1회씩. AI 심사위원 3명은 Carbon을 모든 과제에서 1위, 저자의 블라인드 투표는 Fable 1위. 4개 과제 합계 시간과 비용은 Sol 39.7분에 $2.11, Opus 73.5분에 $16.77, Carbon 122.3분에 $10.17, Fable 133.1분에 $41.85. Fable, Opus, Sol은 구독 사용이라 API 환산액이다.
- bito.ai (2026-11-11) `[홍보]`(코드 리뷰 제품 회사의 자체 실행): 종합 Opus 85.0%, Fable 83.1%, Carbon 79.5%. 긴 세션에서 Carbon은 Opus의 약 절반 비용에 시간은 약 2배, 오도하는 주장이 Opus의 0.3건 대비 0.7건.
- openteam.so (2026-11-10) `[홍보]`(자기 제품 테스트): 6개 에이전트 과제 모두 통과. Sol $0.22, Fable $0.76, Carbon $0.85이고 Carbon은 과제당 약 10.9분.
- Artificial Analysis 기반 요약(VentureBeat, ahmetbalaman.com 등): 코딩 에이전트 지수는 Claude Code와 Opus 5.5가 62, Antigravity CLI와 Carbon이 59. FrontierCode 2.0은 Fable 49.1%, Opus 46.4%, Carbon 40.6%. Terminal-Bench 4.0은 Carbon 65.2%, Fable 59.6% 이하. 하네스가 달라 직접 비교가 어렵다는 지적이 붙는다.

## 7. 한국어권

표본: 클리앙 게시글 4건과 댓글, 블로그 3건, 커뮤니티 대화 요약 1건, GeekNews 댓글. GeekNews의 GN⁺ 댓글은 HN 댓글의 번역이라 건수에서 뺐고, AIwitness 글도 r/GeminiAI 번역이라 뺐다.

### 7-1. 개별 글

- 클리앙 "codex, claude 토큰소모 경험"(2026-10-20): Codex $200과 Claude Max $100을 쓰는 작성자. 토큰 소모는 Claude가 압승. Codex는 Astra High에서 리뷰와 테스트만 해도 하루에 30에서 40%가 사라지고, Opus 5.5 extra는 거의 같은 작업의 한 주 소모량이 딱 맞는다. Sol 6.1은 품질 문제로 Astra를 쓴다. 댓글에서 다른 사용자도 GPT 리셋분을 2에서 3일에 다 쓴다고 같은 경험을 적음. 댓글 공감 3과 2.
- 클리앙 "혜자로운 클로드 맥스"(2026-10-22): Codex Pro 200 할당량이 반나절이면 빠지는데 Claude Max 20은 멀티에이전트 십수 개에도 주간 한도가 든든하다. 매월 API 크레딧(구독료만큼)과 한시적 클라우드 크레딧 $250이 붙는다고 적음. 결론은 "둘 다 쓰세요".
- 클리앙 "오푸스5.5 토큰 녹는 것이 무시무시"(2026-10-03): Antigravity IDE에서 Opus 5.5 medium으로 간단한 수정을 시켰더니 2회 요청에 소진. 같은 글 댓글에서 "제미니의 오푸스는 맛보기, 토큰 할당량이 얼마 안 된다"(리트리셈), "안티그래비티 안의 제미나이는 지시 이행률이 심각하게 낮다"(작성자). 기업 Enterprise에서 Fable 5.1이 Opus 5.5보다 결과적인 토큰 사용량이 더 적고 사고 수준이 높다는 소수 의견(SKDA).
- 클리앙 "opus5.5 높음으로 쓰니 제한 걸리는 군요"(2026-10-21): Pro 사용자 이야기. 댓글 조언은 Sonnet을 주력으로 쓰고 Opus는 advisor(xia), `/model opusplan`으로 plan 모드만 Opus(오르테가), 복잡한 작업만 빼고 대부분 Sonnet(OGUN).
- 클코단 대화 요약(2026-11-11, 20명, 110개 발화, 요약 사이트의 AI 요약이라 신뢰도 낮음): Opus 5.5가 GPT-6.1 Sol보다 작업 품질이 낫고 GPT는 검토나 서브에이전트로 쓴다. 제미나이는 토큰 소모와 환각 불만이 있지만 글과 그림에는 추천한다. 아스트라보다 오퍼스의 작업과 속도가 낫다. GPT 리셋권이 많아도 이틀 안에 쓴다.
- 블로그 HSL (2026-10-20, 갱신 11-02): Claude, Codex, Antigravity 구독 셋을 창 세 개로 오가면 하나만 쓰게 돼서 Claude Code가 `codex exec`과 `agy -p`를 CLI로 부르게 했다. 총괄과 개발과 원문 대조는 Claude, 이미지 생성과 간단한 작업은 Codex, 자료조사와 텍스트 작성과 검수는 Antigravity(Argon). 토큰을 아끼지는 않고 오히려 늘 수 있다고 적음. 역할은 10월 24일부터 다시 바뀌어 글은 Claude, 자료조사는 Gemini와 Codex.
- 블로그 wondergrid (2026-10-01, 09-19): 20달러 구독 사용량 관리. Luna로 단순 작업, Sol Medium으로 일반 개발과 리뷰, Astra는 마지막. Claude는 Sonnet 5.5 Medium 중심으로 막힐 때만 Opus. r/codex 글을 인용한 서술이 많아 Reddit 의견의 재가공이다.
- GeekNews: Carbon 소개 글(36229, 2026-10-29)의 한국어 댓글 1건은 "똑똑하긴 한데 일 머리는 없는 사람 느낌"(realg). Fable 5.2 글(36896)은 댓글 2건에 내용이 없다.

### 7-2. 한국어권 반복 의견

- Claude 구독이 Codex보다 오래 간다: 3건 (클리앙 2건, 클코단 요약 1건). Codex는 리셋권을 자주 줘도 2일 안에 소진.
- Antigravity 안의 Gemini는 지시 이행이 약하고 환각이나 토큰 소모 불만, Antigravity에 번들된 Claude 쿼터는 맛보기 수준: 3건 (클리앙 1건에 작성자와 댓글 2명, 클코단 요약, GeekNews 1건). Gemini를 글이나 그림에 추천하는 말이 1건(클코단).
- Pro 구독이면 Sonnet 또는 Haiku 중심, Opus는 plan이나 advisor로만: 4건 (클리앙 댓글 3명, wondergrid 블로그).
- 구독 여러 개 병행: 3건 (HSL, 클리앙 "둘 다 쓰세요", 클리앙 리트리셈의 Claude 회사 $200과 GPT와 Gemini 병행).
- 소수 의견: Fable 5.1이 결과적으로 토큰을 더 적게 쓴다(SKDA 1건).

## 8. 일본어권

표본: Zenn 3건, Scrapbox 1건, note 1건, 업체 글 다수. 업체 글(Qiita의 AIHubMix, issoh.co.jp, LaoZhang AI, labmemo)은 가격과 약관 정보 확인용으로만 보고 의견 건수에서 뺀다. 현재 세대 의견 표본이 작다.

### 8-1. 개별 글

- Zenn, 堀越大地(2026-10-26) "5種類のコーディングエージェントを使い分ける理由":
  - Claude Code를 창구로 삼고 다른 에이전트를 CLI로 부름. 이유는 모델별 장단점과 Claude 토큰 부족(Max 20x에서 Claude만 쓰면 2일 안에 소진).
  - Claude Code는 창구, 요구 해석, 설계, DB 설계, 프런트엔드 디자인. Codex(gpt-6.1-sol, ChatGPT Pro)는 화면 조작, 사고, 이미지 생성이고 리셋이 많아 토큰이 남을 때는 코딩도 보냄(본격 돌리면 Pro도 2일에 소진).
  - Antigravity(Ultra 5x, gemini-4-argon)는 기사, 자료, 기술 문서 같은 글쓰기. 이유는 Claude의 일본어가 읽기 어렵기 때문(쉼표를 지나치게 찍는 버릇과 "原因は二層重なっている" 같은 돌려 말하는 표현). GPT의 일본어에는 특유의 냄새가 있는데 더 심하다고 느낌. Argon은 Ultra 5x에서도 소모가 심해 글쓰기에만 쓰는데도 한도에 걸린다.
  - OpenCode와 DeepSeek 4.1 Flash로 코딩.
- Scrapbox heguro (2026-11-11) "AI契約構成":
  - 품질이 필요한 작업은 Claude Code의 Opus 5.5 high에서 xhigh에 advise와 타사 모델 리뷰를 붙임.
  - 리뷰어 우선순위는 codex gpt-6.1-sol high/xhigh, claude Opus 5.5나 Fable 5.2, cursor grok-4.7, dsh의 deepseek-v4.1-flash, codex terra max나 astra xhigh, muse, gemini-4-argon high 순.
  - 평소 로컬 작업은 DeepSeek V4.1 Flash, 채팅 로그 요약은 Sonnet 5.5, 단순 광범위 조사는 Haiku 5.5. Fable 5.2는 구독 소모량이 Opus보다 커서 리뷰 때 가끔.
  - Codex(Pro $100)는 Claude가 만든 안을 지적시키는 용도. Gemini(AI Pro)는 Claude 한도를 쓰기 싫을 때(3.8 flash).
- Zenn shinai (2026-11-07): Claude Code, Codex, Antigravity의 Gemini 한도, Antigravity의 Claude와 GPT 한도 네 칸의 사용률을 토큰 0으로 읽어 남는 칸에서만 무인 작업을 시키는 자동화. Antigravity는 Gemini 칸과 Claude, GPT 칸이 따로 있다는 점이 드러난다.
- 구세대 표시(2026-07): Zenn nenene01(Sonnet 5와 Terra 일상, Opus 4.8과 Sol 복잡한 디버깅과 리뷰, Fable 5와 Sol 장시간 작업), Zenn kuzzken("ミニマム委任", 중심 모델 한 개와 필요할 때만 타사 CLI), note mashiro(Claude Code가 오케스트레이터, Codex가 리뷰와 이미지). 현재 세대와 같은 구조라 연속성만 확인했다.
- 구독 가격과 Antigravity의 Claude 대상: Claude 4.6이 11월 2일 삭제 예정이라는 글(labmemo, 10-04)과 11월 18일이라는 글(issoh.co.jp, 11-06)이 엇갈려 날짜는 확인하지 못했다. Claude 5.5는 유료 Pro와 Ultra만이라는 점은 두 글이 같다.

### 8-2. 일본어권 반복 의견 (현재 세대, 건수가 적음)

- Claude Code를 창구와 설계 중심으로 두고 다른 CLI를 호출한다: 2건 (Zenn 堀越, Scrapbox heguro). 구세대 3건이 같은 구조.
- Claude 구독 한도가 빨리 소진된다: 1건 (Max 20x가 2일 이내). OpenAI의 잦은 리셋을 "리셋 축제(Reset祭り)"로 부르는 말이 같은 글에 있다.
- 글쓰기는 Gemini Argon에 맡긴다(Claude와 GPT의 일본어가 불편): 1건.
- 타사 모델 리뷰어를 둔다: 1건(heguro, Codex Sol이 1순위).

## 9. 중국어권

표본: V2EX 4건(1건은 구세대), linux.do 8건, 微博 1건. 중국어권 글은 토큰 단위 실측과 계정 접근 문제가 많이 섞인다. linux.do 글의 추천 수는 스니펫에 없다. V2EX는 조회 수만 있다.

### 9-1. 개별 글

- V2EX 1255774 "Claude & GPT & DS 模型锐评" (2026-11-10, 조회 1,136, 작성자는 누적 API 수만 위안, 최근 한 달 200억 토큰):
  - Opus 5.5는 프런트엔드의 신. 일상 대화창으로 좋고 GPT처럼 무한 검증으로 일이 안 나가지 않는다. 단 일을 하다 중간에 출력을 멈추기도 하고 주도성은 약하다.
  - Sonnet 5.5는 프런트엔드 저가 대체. Opus가 틀을 잡은 뒤 Sonnet이 내용 수정과 스타일 일관성을 맡음.
  - Sol 6.1은 백엔드의 신. 백엔드 버그의 약 99%를 풀었다. 대화용으로는 장황하고 오가며 검증하느라 토큰이 낭비되니 일을 시키는 용도.
  - Terra 6.1은 일반 백엔드 로직을 대량으로 쓰는 대체, 버그는 Sol에게. DeepSeek Flash는 빌드와 테스트와 CI 검수. Fable과 Astra는 디코딩이 느리고 가격이 5배 이상이라 거의 안 쓰고, Sol이 못 푸는 버그는 Astra도 못 풀며, Fable의 프런트엔드는 Opus 5.5를 못 이긴다.
- linux.do 3181066 "【经验贴】御三家模型使用指南" (2026-11-15, 5개 글):
  - 작성자 워크플로: Astra나 Sol 6.1이 설계 프로토타입, Fable 5.2가 아키텍처 설계, Carbon이나 Astra가 아키텍처 감사와 프롬프트 최적화, 속도가 필요하면 Astra나 Sol이 작업하고 급하지 않으면 Carbon과 Hydrogen이 천천히, Astra가 코드 감사, Carbon이나 Opus 5.5가 튜닝, Grok 4.7 Fast가 마무리.
  - 이유: Fable은 작은 일이나 구체적인 코딩에 안 맞고, 빠른 개발에는 GPT의 토큰 효율이 맞고, 백엔드 코드는 GPT로 감사하지 않으면 못 쓴다. "Opus 5.5가 보편적으로 지능이 떨어진 뒤로" Opus 5.5 Max로 원샷 코딩은 효과가 좋지 않다. 구독은 GPT Team 두 개, Claude Team, Grok, Google 20x 공동 구독.
  - 다른 작성자(Ever97): 평소 high 강도 Sol이나 Astra, Opus는 프런트엔드 영감용. GPT 외에는 순수 vibing을 못 믿는다. GPT의 방어적 코딩이 주는 백엔드 안정성과 Opus 5.5의 원샷 프런트엔드는 중국산 모델로 대체가 안 된다. GPT 문체를 못 견디면 Gemini에게 번역시킴.
  - 가난한 대체 워크플로(impouo): Carbon을 high로 설계, Argon으로 감사, Hydrogen을 서브에이전트, Terra 6.1이 리뷰, DeepSeek이 마무리.
- linux.do 3167024 "Google AI Ultra的额度这么多吗？" (2026-11-12, 20개 글, 앞부분):
  - 긍정: 20x를 구독하고 Carbon을 써도 한도가 거의 안 줄어든다(asimlody). 스웜 모드로 전부 Carbon을 5시간 돌려도 절반이 안 된다(N70). Claude 5x는 주간 한도가 절반 남았는데 Gemini 5x는 다 썼다는 반대 보고도 있어 "Gemini가 더 편하다"(Calfui).
  - 부정: 느리다. 6시간에 $55와 160M 토큰이고 Fable 5.2였다면 2B 토큰이었을 것(since). Google 한도는 약 $800, GPT는 $1,400, Claude Fable 5.2 주간 한도(절반)는 약 $600인데 Claude는 2에서 3B 토큰을 소화(터키 지역 가격 제외 기준, since).
  - 서브에이전트로 쓰니 Claude가 너무 느리고 일이 서툴다며 Astra로 돌아갔고 환각이 많았다(Totoria). 소스 수준까지 파고 agy를 디컴파일하며 천천히 고친다(since).
  - Ultra의 Opus 5.5 한도는 별도지만 적다(N70).
- linux.do 3115224 "哈基米即使是Ultra 也完全不够用呀" (2026-11-03, 12개 글): 터키 지역 Ultra 5x 두 개와 Pro 한 개로 3일도 안 돼 주간 한도 소진(Argon과 3.8 Flash 사용). 글쓰기는 한 번에 통과, 코딩도 괜찮지만 Claude Max 5x보다 한도가 적다. 반론으로 20x에서는 Argon이 충분하다(ferret). 캐시율이 낮으면 한도가 급감한다는 지적도 있다.
- linux.do 3083658 (2026-10-27, 10개 글): Antigravity의 Opus 5.5 한도는 Ultra 5x 기준 5시간에 약 $12, 7일에 약 $20이고 Pro는 약 $5. Sonnet 5.5 high로 3에서 4개 질문이면 5시간 쿨다운. GPT의 프런트엔드는 "정말 별로"라 자유로운 웹 제작은 A\ 모델에 의지한다는 댓글.
- linux.do 3120390 (2026-11-04, 3개 글): 한도의 API 환산 비교. Claude Pro는 월 약 29억 토큰과 $1,178, Max $100은 월 약 140억 토큰과 $5,725. ChatGPT Plus는 월 Astra 1.85억과 Sol 10.3억 토큰, Pro 200은 주간 Astra 약 9억. Google Pro의 Argon은 주간 약 0.03억 토큰, Ultra 5x는 주간 0.69억. 결론은 Claude가 가장 이득이고 Google Pro는 "가장 큰 광대"라는 댓글. SemiAnalysis 수치와 방향이 같다.
- linux.do 3094504 (2026-10-30, 12개 글): Codex 한도 반감 소식이 하루 만에 없던 일이 되고 오히려 $100 티어가 5x에서 10x로 오른다는 소식이 돈다. 불안정하다는 불만. Claude는 공동 구독하면 정지 위험이 커서 피하라는 말.
- linux.do 3159560 (2026-11-12, 20개 글): Plus는 5시간 한도가 Sol 몇 번이면 참. Team 두 계정이 4에서 5일(Sol 6.1과 6 Luna), Astra Max면 Plus와 Business 다섯 개로도 모자란다. 해결은 중국산 모델과 DeepSeek 전환, 일회용 계정, sub2api 중계. Claude는 정지 위험 때문에 못 연다는 사람, Google 대계정에 위험이 번질까 못 쓰는 사람.
- linux.do 2991627 (2026-10-07): Claude Pro로 Opus 5.5를 쓰자 속도는 Kiro의 몇 배인데 5시간 한도의 25%가 순식간에 소진. 같은 시각 Sol 6.1은 느리게 열 시간을 돈다.
- linux.do 3116999 (2026-11-03): Opus 5.5를 3주에 64억 토큰 썼다는 글. 댓글에 "낮은 effort의 사고가 처음 나왔을 때보다 못하다"(rainxt, Max 5x)와 usage 계산이 부풀려졌다는 지적(ChuJiuMao). 같은 스레드에서 캐시 쓰기를 줄이려고 세션을 한 번에 끝내는 습관이 소개된다.
- V2EX 1244099 (2026-09-22, 조회 2,913): Opus 5.5와 Sol 중 입문자에게는? 답은 Claude가 용량이 GPT의 2에서 3배(신규 계정의 5시간 한도 포함), Opus 5.5는 Fable보다 훨씬 오래 쓰고 생산성 도구다. 단 Claude는 계정 정지 위험을 피하는 것이 전제라는 댓글이 세 건. 데스크톱 앱은 GPT가 낫다는 의견.
- V2EX 1245947 (2026-10-01, 조회 8,012, Gemini 4 Argon 발표 글): 벤치 신뢰도에 대한 회의가 지배적(보고된 상위권 대비 실제 문제 해결은 "반근팔량"). "Gemini는 질문에서 환각이 있지만 antigravity로 코드를 쓰면 괜찮다"(Shing). "Fable 5.1이 나왔을 때는 천하무적, 그 뒤 Astra가 더 쓸 만했고 Opus 5.5가 Fable 5.1보다 쓸 만하다"(v2gba).
- 微博, agentzh(OpenResty 창업자, 2026-11-13): 사설 평가 두 개. 새 코드 작성은 Carbon high 82.6%(18.8분), Argon high 62.6%(14.5분), Opus 5.5 xhigh 86.8%(14.3분), Fable 5.2 max 91.6%(76.2분). 어려운 버그 수정은 Carbon 87.5%(49.3분), Argon 82.0%, Opus xhigh 88.1%(43.7분), Opus max 90.6%(75.0분), Fable max 79.9%(시간 초과 영향, 116분 이상)와 Fable xhigh 90.6%(74.8분). "새 모델과 높은 추론 강도가 얼마나 품질을 사는지는 자기 과제로 확인하라"는 결론.
- 구세대 표시: V2EX 1229132 (2026-07-22, 조회 6,053): "계획은 Claude, 코드는 GPT" 구조. Opus와 GPT 상호 리뷰에서 GPT는 디테일, Opus는 전체 구조가 낫다(fovecifer). Sol은 프런트엔드가 너무 나빠 Claude가 스타일을 만들고 Sol이 고친다(hellojay). Fable 5가 Swift에서 컴파일 안 되는 코드를 가끔 낸다는 보고(deplives).

### 9-2. 중국어권 반복 의견 (2026-09 이후)

- GPT(Sol, Astra)는 백엔드와 버그 수정과 코드 감사, Opus 5.5는 프런트엔드와 대화: 4건 (V2EX 1255774, linux.do 3181066의 2명, linux.do 3083658). 구세대 V2EX 1229132에서도 같은 구도.
- Fable과 Astra는 느리고 비싸서 Opus 5.5나 Sol 6.1이 기본: 3건 (V2EX 1255774, V2EX 1244099, V2EX 1245947).
- Claude 구독이 Codex보다 한도 대비 이득: 3건 (V2EX 1244099, linux.do 3120390, linux.do 3159560 Plus 불만). 반론으로 Opus가 속도가 빠른 만큼 5시간 한도도 빨리 소진된다는 글 1건(linux.do 2991627).
- Argon은 한도가 박하고 Carbon은 한도를 덜 쓴다: 한도가 넉넉하다는 쪽 4명(linux.do 3167024의 asimlody, N70, Calfui, 그리고 3115224에서 20x는 Argon으로 충분하다는 ferret), 박하다는 쪽 4건(3115224 yijiangnan, 3167024 approachai와 since, 3120390의 Google Pro 조롱). 반반이다.
- Gemini의 글쓰기와 문장력 칭찬: 4건 (linux.do 3115224, linux.do 3181066의 Ever97이 GPT 문체를 Gemini로 번역시킴, V2EX 1245947에서 Gemini의 언어 능력을 지키길 바란다는 댓글 2건).
- 계정 정지 위험이 구독 선택을 바꾼다: 3건 (V2EX 1244099, linux.do 3094504, linux.do 3159560).
- 한도가 차면 DeepSeek 등 중국산 모델로 내려간다: 3건 (linux.do 3159560, 3181066, V2EX 1255774의 DeepSeek Flash 용도).
- Opus 5.5가 "지능이 떨어졌다"는 주장: 2건 (linux.do 3181066, 3116999). 영어권 HN의 너프 논쟁과 같은 시기.

## 10. 언어권 사이 비교

### 10-1. 같은 쪽을 가리키는 체감

- Opus 5.5가 기본 주력, Fable 5.2는 가끔: 영어(HN 6건, Reddit 7개 스레드, 블로그와 X 3건), 중국어 3건, 일본어 1건(Fable은 리뷰에 가끔). 한국어는 Fable 5.1이 더 효율적이라는 소수 의견 1건만 반대 방향.
- GPT 계열은 리뷰와 백엔드 디버그: 영어(HN 11건, Reddit 4개 스레드), 중국어 4건, 일본어 1건(Codex Sol이 리뷰어 1순위), 한국어 요약 1건.
- 프런트엔드는 Opus 5.5: 영어(HN 2건, Reddit 4개 스레드), 중국어 3건, 일본어 1건(Claude Code가 프런트엔드 디자인). 한국어는 근거를 못 찾았다.
- Antigravity에 번들된 Claude 쿼터는 매우 적다: 영어 1건(Reddit), 한국어 1건(클리앙 2명), 중국어 1건(linux.do 4명).
- Argon은 한도가 박하고 Carbon, Hydrogen은 덜 쓴다는 평이 있지만 사용자와 플랜에 따라 달라진다: 영어, 중국어, 일본어에서 같은 양상이다.
- OpenAI의 잦은 한도 변경과 리셋: 영어(Reddit, HN), 한국어 3건, 일본어 1건, 중국어 2건이 같은 문제를 말한다. 한도 숫자는 반감 소문에서 두 배 소식까지 오갔다.
- Claude 구독이 Codex보다 오래 간다: 영어(SemiAnalysis와 일부 HN, Reddit의 반대 의견 병존), 한국어 3건, 중국어 3건.
- 구독 여러 개 병행과 CLI로 묶기: 영어(HN 다수), 한국어 3건, 일본어 2건, 중국어(GPT Team 두 개와 Claude와 Google 병행 등).

### 10-2. 언어권별로 다른 점

- 글쓰기 모델: 영어권 HN에서는 Claude의 글투를 싫어해 Terra를 쓴다는 의견 1건. 일본어, 중국어, 한국어 글에서는 Claude나 GPT의 현지어 문장이 불편하거나 Gemini 문장이 낫다는 의견이 일본어 1건, 한국어 1건, 중국어 4건 나온다. 표본이 작아서 단정은 못 하고 방향만 다르다.
- 접근 장벽: 중국어권은 계정 정지 위험, 터키 지역 가격(土区)의 싼 Ultra, 공동 구독(拼车), 일회용 계정(日抛号), sub2api 같은 중계가 선택에 직접 들어간다. 영어권은 Antigravity 약관에 따른 서드파티 정지 위험이 중심이고 한국어권은 크레딧과 리셋권 이야기가 중심이다.
- Carbon의 위치: 중국어권은 Ultra 20x 사용자가 Carbon을 주력 워커로 쓰고 Sol이 감사하는 구성이 있다(linux.do 3181066, 3167024). 영어권 Reddit은 계획 담당이나 실험(r/GeminiAI 1xssll3)과 "너무 느리다"가 많다.
- 수치 근거의 형태: 중국어 포럼은 ccusage나 sub2api 같은 도구로 토큰과 달러 환산을 직접 적는다. 영어권은 SemiAnalysis, Artificial Analysis 같은 외부 분석을 인용하고 한국어와 일본어는 체감 서술이 중심이다. 방향은 일치한다(Claude가 한도 대비 이득).
- 한국어권만 확인된 것: Claude Max 구독료만큼의 월 API 크레딧($100, $200)과 한시적 클라우드 크레딧 $250 언급(클리앙 1건). 다른 언어권 글에서는 못 봤다.
- 일본어권만 확인된 것: 여러 구독의 남는 쿼터를 자동으로 쓰는 무인 실행(Zenn shinai), 구독마다 쿼터 칸이 따로라는 구분.

### 10-3. 전체 핵심 관찰

1. 언어권이 달라도 계획은 강한 모델, 실행은 싼 모델, 리뷰는 다른 벤더라는 구조가 반복된다. 영어권(HN 13건, Reddit 7개 스레드)이 가장 많고, 중국어권의 linux.do와 일본어권 Scrapbox에서도 같은 구도가 나온다.
2. Opus 5.5가 데일리, Fable 5.2는 가끔이라는 의견은 영어, 중국어, 일본어에서 일치한다. 이유는 비용, 한도 소모, 속도다.
3. 리뷰어로 GPT 계열을 쓰는 사례는 모든 언어권에서 가장 많이 반복된다. 반대로 GPT를 주력 구현으로 쓰면 느림, 루프, 과잉 변경에 대한 불만이 같이 나온다.
4. 프런트엔드는 Opus 5.5가 우세하다는 근거가 영어, 중국어, 일본어에 있고, Sol은 UI와 프런트엔드가 약하다는 말이 영어와 중국어에 있다.
5. Carbon은 한도는 덜 쓰고 품질은 Opus급이라는 평과 느리고 환각이 많다는 평이 모든 언어권에서 엇갈린다. 중국어권 Ultra 20x 사용자는 한도에 후하고, Pro 사용자는 박하다.
6. 구독 한도는 Claude 쪽이 낫다는 쪽이 영어, 한국어, 중국어에서 반복되고 SemiAnalysis와 linux.do 환산이 같은 방향이다. OpenAI는 한도 변경이 잦아 체감이 흔들린다.
7. 한도가 차면 DeepSeek 같은 싼 모델로 내리거나 다른 벤더 구독으로 폴백하는 방식이 영어(HN 7건), 중국어 3건에서 가장 흔하다.
8. 글쓰기를 Gemini에 맡기는 것은 일본어, 중국어, 한국어 글에서 보이는 언어권 특유의 패턴이고, 영어권에서는 Claude 글투 불만과 Terra 추천이 나온다. 표본이 작다.

## 11. 영어권 HN과 Reddit 핵심 관찰

1. 계획은 강한 모델, 실행은 싼 모델이라는 구조가 가장 반복된다. 계획 담당은 Fable 또는 Opus, 실행은 Opus, Sonnet, Sol, Luna, Flash, Hydrogen으로 흩어진다.
2. Fable 5.2는 "Opus 5.5로 충분, 어려운 문제나 계획 검증에만"이 다수 의견이다. 비용과 한도 소모가 이유로 가장 많이 나온다.
3. 리뷰는 작성 벤더와 다른 벤더를 쓰는 사례가 많고, GPT 계열 리뷰어(Sol, Luna, Astra)가 Claude 코드를 검토하는 방향이 많다. 반대 방향과 리뷰 루프의 소모, 사소한 지적 문제도 보고된다.
4. 프런트엔드와 디자인은 Opus 5.5가 우세하고, Sol 6.1은 UI/UX와 속도에서 불평이 나온다. Gemini와 Sol의 소수 반례가 있다.
5. Gemini 4 Carbon은 품질은 Opus급이라는 평이 있으나 속도 평가가 정반대로 갈리고 Ultra 전용이다. Hydrogen은 한도를 거의 안 쓰고 빠르다는 평이 반복되지만 Argon, Carbon, Hydrogen 모두 "하네스가 약하다"는 불만이 같이 나온다.
6. 한도는 시점과 플랜과 effort에 따라 체감이 크게 달라 "어느 구독이 낫다"로 묶이지 않는다. 같은 스레드 안에서도 정반대 경험이 나오고, 같은 벤더의 한도도 몇 주 단위로 오르내린다.
7. 한도 소진 때는 DeepSeek Flash 같은 싼 API로 내리거나 다른 벤더 구독으로 폴백하는 방식이 가장 흔하다. 구독을 여러 개 동시에 유지하는 사례도 자주 보인다.
8. 서드파티 하네스로 구독을 쓰는 방식은 계정 정지와 가격 구조 위험이 거론된다 (Antigravity 약관 스토리 338점).

## 12. 출처 목록

표기: HN 스토리는 점수와 댓글 수, HN 댓글은 `https://news.ycombinator.com/item?id=<번호>`, Reddit은 스레드 ID(`https://www.reddit.com/r/<서브>/comments/<ID>/`)다. Reddit 점수와 작성일은 확인하지 못했다.

### 12-1. HN 스토리

- 50429068 Claude Fable 5.2 and Mythos 5.2, 2026-11-09, 925점, 1054댓글
- 50433659 Fable 5.2 one-shotted my nephew's dream game, 2026-11-09, 505점, 452댓글
- 50422069 Is Opus 5.5 nerfed? Thinking patterns changed on November 3, 2026-11-09, 826점, 520댓글
- 50276792 Gemini 4 Carbon, 2026-10-28, 1019점, 803댓글
- 50442303 Gemini 4 Carbon is now available, 2026-11-10, 295점, 165댓글
- 50288019 Gemini 4 Carbon is the new #1 on the Artificial Analysis Intelligence Index v5, 2026-10-29, 339점, 248댓글
- 50471431 Gemini 4 Hydrogen, 2026-11-12, 572점, 353댓글
- 50472260 Gemini 4 Hydrogen and Orchestrator, 2026-11-12, 507점, 165댓글
- 50073879 Gemini 4 Argon, 2026-10-13, 1467점, 1047댓글
- 49805509 GPT-6 Sol and Luna, 2026-09-22, 1779점, 855댓글
- 50248124 GPT-6.1 Terra, 2026-10-26, 638점, 428댓글
- 49554643 GPT-6 Astra, 2026-09-03, 2279점, 2081댓글
- 49881850 Sonnet 5.5, 2026-09-28, 884점, 613댓글
- 49996437 Claude Haiku 5.5, 2026-10-07, 1049점, 489댓글
- 49946567 Getting the most out of Opus 5.5 in Claude and Claude Code, 2026-10-03, 252점, 162댓글
- 50108717 SlopCodeBench 10/2026, 2026-10-15, 309점, 122댓글
- 50366117 Ask HN: What's your current AI agentic setup?, 2026-11-04, 573점, 717댓글
- 49672966 Ask HN: What default model do you use and why?, 2026-09-12, 64점, 109댓글
- 50444380 How do you keep up quality when you vibe-code?, 2026-11-10, 39점, 39댓글
- 50496811 Advancing science and engineering with Antigravity's /teamwork, 2026-11-14, 214점, 50댓글
- 49548452 Google Antigravity TOS: 3rd party usage can get Google account suspended, 2026-09-03, 338점, 234댓글 중 88건 확인
- 50481220 Claude Is Down, 2026-11-13, 200점, 179댓글
- 50167220 Ask HN: Best value/money AI coding plan bundle?, 2026-10-20, 4점
- 50243565 Ask HN: Is it true the Claude Code is better than Codex for coding?, 2026-10-26, 1점
- 50368059 Ask HN: Fable 5.1 or Opus 5.5?, 2026-11-04, 2점
- 49661691 Ask HN: Is GPT-6 Astra worth the 2.5x cost increase over GPT-5.6 Sol?, 2026-09-11, 7점
- 49608008 Ask HN: How to spend $100? (Claude vs. ChatGPT), 2026-09-08, 1점
- 50222093 Ask HN: Kimi Code hit its 5-hour limit after $1.37 of API usage, 2026-10-24, 10점
- 49911500 Show HN: Open-source model routing for coding agents at Astra-level performance, 2026-09-30, 123점 `[홍보]`

### 12-2. HN 댓글

계획과 역할 분담: 49673210, 50172724, 49806051, 50477200, 49969157, 49947634, 50167441, 49898702, 50004455, 50373135, 49877628, 49546418, 49704032, 49948057, 50435303, 49935330, 50367037, 50367866, 50376908, 50377263.
Fable와 Opus: 50430766, 50434465, 50437411, 50447027, 50430544, 50432975, 50432936, 50430962, 50434424, 50438215, 50423198.
리뷰: 50377121, 50414824, 50373589, 50370886, 50176207, 50438393, 49704032, 50367676, 50377455, 50377284, 50367399, 49884863, 49558334.
프런트엔드와 디자인: 50367571, 50074851, 50452834, 50367399.
글쓰기: 50249160, 49673395, 49673603, 50171776, 50175065.
한도와 구독: 49805972, 49806331, 49554742, 50277629, 50278012, 50277126, 50288524, 50288698, 50443172, 50443364, 50473339, 49547760, 50475121, 50281040, 50277368, 50278780, 50376216, 50367744, 50367789, 50367215, 50367326, 50373357, 50373740, 50367571, 50375606, 50482070, 50482570, 50495427, 49882083, 49882650, 50075460.
Gemini와 하네스: 50475502, 50473078, 50472918, 50499606, 50503005, 50503464, 50074656, 49914707, 50288820.
Sonnet과 Haiku: 49882685, 49882102, 50424311, 50250366, 49996540, 50481593, 49999726(plotly 자체 벤치 `[홍보]` 성격).

### 12-3. Reddit 스레드 (Brave 스니펫 기준)

Fable와 Opus 비교: r/ClaudeAI 1xtdfma, 1xsmqdd, 1xw4dbe, 1xwt0ka, 1xsgmrp, 1xsyx2x. r/ClaudeCode 1xsbfiw, 1xs1r7u, 1xs6tkq, 1xul65u. r/aigamedev 1xtallk.
혼합 워크플로와 리뷰: r/codex 1x805d9, 1x9lq18, 1wy1zay, 1xcof7y, 1xwamla, 1wu0d5o, 1x3k1li, 1wzpt31. r/ClaudeCode 1wuayqi. r/ClaudeAI 1x6dhb0.
Gemini Carbon, Argon, Hydrogen: r/google_antigravity 1xszqoj, 1xsvrq5, 1xspqoj, 1xlbx3i, 1xicgky, 1xj84e4, 1x6tes3, 1xvc2ig, 1xuqxky. r/GeminiAI 1xml0js, 1xssll3, 1xhw48g, 1x70m5q, 1xwbrj9, 1xukma1, 1xv94ps, 1xuvian, 1xujth6, 1xulc9c, 1x1y2a4. r/Bard 1xxed6e, 1xukbv5, 1xu4hjz. r/ClaudeAI 1xhu9ez. r/ClaudeCode 1xuew04, 1x56wuh. r/claude 1xhz63u. r/GoogleGeminiAI 1xwq5rp. r/AntigravityGoogle 1xubspu, 1x79jlx.
한도와 구독: r/ClaudeAI 1xmmmte, 1xfs5q8. r/ClaudeCode 1xe2fxk, 1xqqco0, 1xq4ree, 1xt1eo1, 1xs0nn4, 1xsgguy. r/codex 1xm12io, 1xg0vvk, 1xhct16, 1x6ezwp, 1xipj7s, 1xixihf, 1xrvg8t, 1x8wj35, 1x8m8ho, 1xphcam, 1xrvg8t.
Haiku, Sonnet, Luna: r/ClaudeCode 1x0kzbh, 1x132yy, 1x27a6k, 1x1e7ts, 1x5rbwy, 1x03lg8. r/ClaudeAI 1xaur97, 1x03k4j, 1x0367g. r/GithubCopilot 1xhkc25.
프런트엔드: r/vibecoding 1xa1gra. r/codex 1xd16fg.

### 12-4. 외부 글 (Exa 검색, 홍보성 포함)

- ahmetbalaman.com, Gemini 4 Carbon vs Argon vs Claude Opus 5.5 vs GPT-6 Astra, 2026-11-01 (갱신 11-14), 자체 측정 없이 벤치 모음임을 밝힘.
- blog.authon.dev, Gemini 4 Carbon vs Claude Opus 5.5 vs GPT-6.1 numbers, 2026-10-30, 자체 측정 없음.
- dev.to/aihubmix, Gemini 4 Carbon vs Argon, 2026-11-11 `[홍보]` AIHubMix는 API 게이트웨이 사업자.
- paddo.dev, Gemini 4 Argon vs Opus 5.5 on Real Code, 2026-10-14, 작성자 자체 벤치와 자체 도구(claude-launcher) 언급.
- mindstudio.ai, Gemini 4 Argon vs GPT 6.1 and Claude Opus 5.5, 2026-10-14 `[홍보]`성 비교 글.
- ecorpit.com, Best LLM for coding 2027, 날짜 미확인, Vals 벤치 인용.

### 12-5. 영어권 블로그, 뉴스레터, X (2차 수집)

- Simon Willison's Weblog, https://simonwillison.net/ (2026-11-15, 11-10, 11-09), 태그 페이지 https://simonwillison.net/tags/llm-release/, 아카이브 https://simonwillison.net/2026/Oct/13/
- SemiAnalysis, Anthropic Subscriptions Offer 5x+ More Value Than OpenAI, https://newsletter.semianalysis.com/p/anthropic-subscriptions-offer-5x (2026-10-05, 유료 글). 요약: https://explainx.ai/blog/semianalysis-claude-vs-chatgpt-subscription-api-value-limit-testing-2026, https://www.theregister.com/ai-and-ml/2026/10/06/anthropic-claude-subscription-plan-provides-more-value-than-openais-study-says/5301470
- SemiAnalysis GDPx, https://gdpx.semianalysis.com/?domain=software-engineering
- HN 댓글 50435497 (2026-11-10), https://news.ycombinator.com/item?id=50435497
- Pragmatic Engineer, https://newsletter.pragmaticengineer.com/p/whats-the-roi-of-software-engineers (2026-10-20), https://newsletter.pragmaticengineer.com/p/software-engineering-after-code-becomes (2026-11-16), 구세대 표시: https://newsletter.pragmaticengineer.com/p/ai-tooling-2026 (2026-03-03)
- Latent Space AINews 요약(Jyst), https://jyst.ai/stories/ainews-fable-52-retakes-world-1-llm-spot-as-ant-ipo-roadshow-begins (2026-11-10)
- Ridge X 요약, https://www.ridgebench.com/news/halfweek-opinion-1112 (2026-11-12), http://www.ridgebench.com/news/halfweek-opinion-1116 (2026-11-16)
- MindPattern X 요약, https://mindpattern.ai/f/33902 (2026-11-12)
- zeronoise Theo와 Fireship 요약, https://zeronoise.ai/posts/gemini-4-carbon-tops-cursorbench-and-arrives-with-antigravity-swarm-as-theo-explains-when-to-use-fable-52-1e8jt6jiciucxguw/details
- kartit.net 블라인드 테스트, https://www.kartit.net/blog/gemini-4-carbon-vs-claude-fable-5-2-opus-5-5-gpt-6-1-sol/ (2026-11-12)
- bito.ai `[홍보]`, https://bito.ai/blog/gemini-4-carbon-vs-claude-opus-5-5-fable-5-2-coding/ (2026-11-11)
- openteam.so `[홍보]`, https://openteam.so/blog/fable-5-2-vs-gemini-4-carbon-vs-gpt-6-1-sol (2026-11-10)
- VentureBeat, https://venturebeat.com/technology/google-gemini-4-carbon-is-now-publicly-available-and-it-undercuts-claude-fable-5-2-and-opus-5-5-on-api-price (2026-11-10)

### 12-6. 한국어권

- 클리앙 https://www.clien.net/service/board/park/19280143 (2026-10-20), /19281202 (2026-10-22), /19273139 (2026-10-03), /19280815 (2026-10-21)
- 클코단 대화 요약, https://chat.axwith.com/s/2026-11-11-1800.html (2026-11-11, AI 요약)
- HSL 블로그, https://hslab.space/blog/posts/claude-code-codex-antigravity-cli/ (2026-10-20, 갱신 11-02)
- wondergrid, https://wikidocs.net/blog/@wondergrid/32229/ (2026-10-01), https://wikidocs.net/blog/@wondergrid/31406/ (2026-09-19)
- GeekNews, https://news.hada.io/topic?id=36229 (2026-10-29, 댓글 일부는 HN 번역이라 제외), https://news.hada.io/topic?id=36896 (2026-11-09)
- AIwitness(r/GeminiAI 번역, 건수에서 제외), https://aiwitness.kr/community/1xs0sce (2026-11-09)

### 12-7. 일본어권

- Zenn 堀越大地, https://zenn.dev/rimon/articles/45c1fd2f015af8 (2026-10-26)
- Scrapbox heguro, https://scrapbox.io/heguro/2026-11-11%2FAI%E5%A5%91%E7%B4%84%E6%A7%8B%E6%88%90 (2026-11-11)
- Zenn shinai, https://zenn.dev/shinai/articles/ai-weekly-quota-autorun (2026-11-07)
- 구세대 표시(2026-07): https://zenn.dev/nenene01/articles/model-guide-2026, https://zenn.dev/kuzzken/articles/92966954b30e6a, https://note.com/mashiro_pearl/n/nb3c4033aeafb
- 정보 확인용(의견 건수 제외, 일부 `[홍보]`): https://qiita.com/AIHubMix/items/1dda5e643bfd30ced717 `[홍보]`, https://www.issoh.co.jp/tech/details/19421/ `[홍보]`, https://labmemo.com/antigravity-claude-55-paid-pro-ultra-model-table-2026-10/, https://tsukatte-ai.com/claude/claude-opus55-daily-driver/ (Anthropic 공식 가이드 요약), https://feelflow.net/blog/2026-11-claude-fable-5-2-model-comparison (자체 실측 없이 AA 수치 정리), https://note.com/ai__worker/n/neac9940baef4

### 12-8. 중국어권

- V2EX https://www.v2ex.com/t/1255774 (2026-11-10), /t/1244099 (2026-09-22), /t/1245947 (2026-10-01), 구세대 /t/1229132 (2026-07-22)
- linux.do https://linux.do/t/topic/3181066 (2026-11-15), /3167024 (2026-11-12), /3115224 (2026-11-03), /3083658 (2026-10-27), /3120390 (2026-11-04), /3094504 (2026-10-30), /3159560 (2026-11-12), /2991627 (2026-10-07), /3116999 (2026-11-03)
- 微博 agentzh(Sina), https://www.sina.cn/weibo/detail/5364626117362392.html (2026-11-13)
