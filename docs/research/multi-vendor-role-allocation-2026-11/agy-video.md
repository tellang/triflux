조사했습니다. 2026년 9월 1일 이후 업로드된 영상을 중심으로 코딩 에이전트와 멀티 에이전트 오케스트레이션의 역할별 모델 배정, 속도, 비용, 정확성 실측, 다중 벤더 혼합 워크플로를 정리했습니다.

### 1. 사용한 검색어 목록

영어 10개, 한국어 4개, 일본어 4개 등 총 18개 검색어로 Google Search와 인덱싱된 YouTube 자막 데이터를 조회했습니다.

- **영어 검색어 (10개):**
  1. `site:youtube.com "Claude Code" "Codex CLI" multi-agent orchestration 2026`
  2. `site:youtube.com coding agents multi-agent orchestration Claude Code Codex CLI Cursor Antigravity opencode 2026`
  3. `site:youtube.com "Opus 5.5" OR "Sonnet 5.5" OR "Haiku 5.5" OR "Fable 5.2" "Claude Code"`
  4. `site:youtube.com "GPT-6 Luna" OR "GPT-6.1 Terra" OR "GPT-6.1 Sol" OR "GPT-6 Astra" "Codex"`
  5. `site:youtube.com "Gemini 4 Hydrogen" OR "Gemini 4 Argon" OR "Gemini 4 Carbon" "Antigravity"`
  6. `site:youtube.com GPT-6 Terra Sol Astra Claude Opus 5.5 Sonnet 5.5 Fable 5.2 Gemini 4 Argon Carbon coding agent benchmark 2026`
  7. `site:youtube.com "AI Engineer" OR "Anthropic" OR "OpenAI" multi-agent coding agent orchestration Claude Code Codex subagents 2026`
  8. `site:youtube.com "GPT-6.1 Sol" OR "GPT-6.1 Terra" OR "GPT-6 Luna" OR "Fable 5.2" OR "Haiku 5.5" OR "Gemini 4 Hydrogen" Claude Code Codex Cursor opencode Antigravity`
  9. `site:youtube.com "AI Engineer" multi-agent coding orchestration subagents Claude Code Codex 2026`
  10. `site:youtube.com ("GPT-6 Luna" OR "GPT-6.1 Terra" OR "GPT-6.1 Sol" OR "Haiku 5.5" OR "Fable 5.2" OR "Gemini 4 Hydrogen") coding agent`
- **한국어 검색어 (4개):**
  11. `site:youtube.com 클로드 코드 코덱스 안티그래비티 커서 멀티 에이전트 오케스트레이션 서브에이전트 Opus 5.5 GPT-6 Gemini 4`
  12. `site:youtube.com "클로드 코드" OR "안티그래비티" OR "오픈코드" 코딩 에이전트 비교 실측 벤치마크 2026`
  13. `site:youtube.com "클로드 코드" "코덱스" 멀티 에이전트 오케스트레이션`
  14. `site:youtube.com "Opus 5.5" OR "Sonnet 5.5" OR "GPT-6" OR "Gemini 4" 클로드 코드 코덱스 안티그래비티 커서`
- **일본어 검색어 (4개):**
  15. `site:youtube.com "Claude Code" OR "Codex" OR "Cursor" OR "Antigravity" マルチエージェント 並列 "Opus 5.5" OR "Sonnet 5.5" OR "GPT-6" OR "Gemini 4"`
  16. `site:youtube.com "Claude Code" "Codex" マルチエージェント オーケストレーション`
  17. `site:youtube.com Claude Code Codex マルチエージェント サブエージェント 並列 開発 比較 2026`
  18. `site:youtube.com "Opus 5.5" OR "Sonnet 5.5" OR "GPT-6" OR "Gemini 4" 解説 検証 コーディング`

### 2. 훑은 영상 목록

YouTube 페이지 직접 요청이 `HTTP 429`로 차단되어, 영상 화면은 직접 재생하지 못하고 검색 인덱스에 수집된 전문 자막(Transcript)과 설명 메타데이터로만 확인했습니다. 조회 수와 일부 정확한 업로드 일자는 인덱스에서 제공되지 않아 `원문 미확인`으로 표기했습니다.

| 번호 | 제목 | 채널 | 날짜 | 조회 수 | 설명 요지 | 포함 여부와 이유 |
|---|---|---|---|---|---|---|
| 1 | [What Will You Build With Coding Agents That Don’t Quit? \| DevDay 2026](https://www.youtube.com/watch?v=U1IVZy9FhVQ) | OpenAI | 2026년 가을 (정확한 일자 원문 미확인) | 원문 미확인 | `Codex`에서 메인 스레드와 서브에이전트, `git worktree`, `/goal`, `/side`, `ultra` 모드로 1,000시간 이상 CI 버그를 고친 사례 발표 | 포함: 컨퍼런스 발표 및 벤더 공식 영상으로 대규모 서브에이전트 실측과 설정을 공개함 |
| 2 | [How Gemini 4 Argon & Carbon were built](https://www.youtube.com/watch?v=sUcvhFGc4mw) | Google Cloud Tech | 2026년 10~11월 (정확한 일자 원문 미확인) | 원문 미확인 | DeepMind 제품 총괄 Tulsee Doshi가 `Gemini 4 Argon`, `Carbon`의 장기 작업 지속성과 `Antigravity`의 `Teamwork Preview`를 설명함 | 포함: 벤더 공식 채널 영상으로 `Gemini 4 Argon`, `Carbon`의 역할 분담과 보안 패치 사례를 다룸 |
| 3 | [Which Coding LLM is Best "Value for Money"? (November 2026)](https://www.youtube.com/watch?v=G8XY9--Jg7E) | AI Coding Daily | 2026년 11월 (정확한 일자 원문 미확인) | 원문 미확인 | 8개 코딩 프로젝트(90점 만점)와 `Bug Hunt` 3회 반복 테스트로 `Opus 5.5`, `Fable 5.2`, `GPT-6 Astra`, `Sol`, `Terra`, `Haiku 5.5`, `Sonnet 5.5`, `Gemini 4 Hydrogen`의 점수, 추론 수준 차이, 주간 한도 소모율을 실측함 | 포함: 대상 신세대 모델 대다수의 반복 실행 편차와 구독 한도 실측을 제시함 |
| 4 | [I Tested NEW GPT-6.1 Terra on Coding. Better than Luna?](https://www.youtube.com/watch?v=HHJRWx6eejE) | AI Coding Daily | 2026년 10월경 (정확한 일자 원문 미확인) | 원문 미확인 | 27개 프롬프트 기준으로 `GPT-6.1 Terra`의 추론 수준별(`medium`, `high`, `xhigh`, `max`) 소요 시간과 API 비용을 `GPT-6 Luna`, `GPT-6.1 Sol`, `Sonnet 5.5`, `Haiku 5.5`와 비교함 | 포함: `GPT-6.1 Terra`와 `GPT-6 Luna`의 속도 및 비용 실측과 서브에이전트 배정 기준을 제시함 |
| 5 | [I Tested Claude/Codex/Cursor $20/mo Plan Limits: 10 Coding Prompts](https://www.youtube.com/watch?v=KcuS-_f4X24) | AI Coding Daily | 2026년 10월경 (정확한 일자 원문 미확인) | 원문 미확인 | 동일한 Laravel 검증 프롬프트 10개를 `Claude Code`(`Opus 5.5`, `Sonnet 5.5`), `Codex CLI`(`GPT-6.1 Sol`), `Cursor CLI`(`Grok 4.6`)에서 실행해 5시간 한도와 주간 한도 차감률을 실측함 | 포함: 3개 도구와 신세대 모델의 구독 한도 소모율, 소요 시간, 테스트 통과율을 직접 비교함 |
| 6 | [6 Ways Opus 5.5 + GPT-6 Astra Upgrade Your Workflow](https://www.youtube.com/watch?v=ucer2chlfM8) | Mark Kashef | 2026년 9~11월 (정확한 일자 원문 미확인) | 원문 미확인 | `Claude Code`(`Opus 5.5`)와 `Codex CLI`(`GPT-6 Astra`, `Sol`, `Luna`)를 CLI 호출과 `/handoff`, `/prime` 인계 파일로 연결하는 6단계 혼합 워크플로를 시연함 | 포함: 다중 벤더 모델을 기획, 비판, 구현, 컴퓨터 조작, 리뷰 역할로 나누는 구체적 설정을 보여 줌 |
| 7 | [Gemini 4 Argon vs Opus 5.5 vs GPT-6 Astra: I Gave Them the SAME Prompt](https://www.youtube.com/watch?v=5t07FpWZAVg) | AnassKartit | 2026년 10~11월 (정확한 일자 원문 미확인) | 원문 미확인 | `opencode`의 `Gemini 4 Argon`, `Claude Code`의 `Opus 5.5`, `Codex`의 `GPT-6 Astra`에 동일한 5개 과제를 부여하고 시간, 줄 수, 실제 API 청구서 금액, `opencode` 타임아웃 및 토큰 설정을 공개함 | 포함: 3개 도구와 3개 플래그십 모델의 시간, 비용 실측과 `opencode` 환경변수 설정을 상세히 다룸 |
| 8 | [I Tested GPT-6.1 Terra vs. Sonnet 5.5 on 10 Real Use Cases](https://www.youtube.com/watch?v=812dIgIrbUg) | Duncan Rogoff \| Learn Claude Code | 2026년 10월경 (정확한 일자 원문 미확인) | 원문 미확인 | 랜딩페이지, 3D 게임, 대시보드, 버그 점검 등 10개 과제에서 `GPT-6.1 Terra`와 `Claude Sonnet 5.5`를 모두 `high` 추론 수준으로 실행해 승패, 총 시간, 총 비용을 실측함 | 포함: 10개 과제의 과제별 및 누적 시간(16.5분 대 95분)과 비용($0.68 대 $13.36) 실측을 제시함 |
| 9 | [I Tested Opus 5.5 vs. GPT-6 Astra on 12 Real Use Cases](https://www.youtube.com/watch?v=GmLcJVzkxPA) | Nate Herk \| AI Automation | 2026년 9~10월 (정확한 일자 원문 미확인) | 원문 미확인 | `Opus 5.5`와 `GPT-6 Astra`를 별도 `git worktree`에서 12개 실무 과제로 비교하고, 코딩 과제는 `Grok`, `Fable 5.1`, `GPT-6 Sol`로 교차 채점하여 총 시간과 API 환산 비용을 집계함 | 포함: 12개 과제의 누적 시간(11시간 대 6시간)과 비용($214 대 $132) 실측 및 멀티 모델 교차 채점을 포함함 |
| 10 | [Fable 5.2は最強モデル？最新アプデで追加されたClaude最新モデルを徹底検証してOpus 5.5などと比較します！](https://www.youtube.com/watch?v=1tsV9RcABCo) | いまにゅのAIプログラミング塾 | 2026년 10~11월 (정확한 일자 원문 미확인) | 원문 미확인 | 일본어 영상으로 `Claude Code`에서 `Opus 5.5`를 주축으로 두고 `Fable 5.2`를 `/advisor`와 스킬 개선, 상위 설계에 배치하는 설정 및 4개 모델(`Fable 5.1`, `Opus 5.5`, `Sonnet 5.5`, `Fable 5.2`) 출력 비교를 다룸 | 포함: `Fable 5.2`의 구체적인 역할 배정(`/advisor`)과 모델 간 산출물 비교를 확인함 |
| 11 | [Gemini 4 Argon vs Claude Opus 5.5: Pricing, Benchmarks, and Hands-On Results](https://www.youtube.com/watch?v=5jJDxxKn9HI) | AI Stack Engineer | 2026년 10월경 (정확한 일자 원문 미확인) | 원문 미확인 | `Antigravity` 안에서 `Gemini 4 Argon`과 `Opus 5.5`로 3D 게임과 차트 재구성을 1회 실행으로 비교함 | 제외: 정독 상한(10개) 내에서 소요 시간과 비용 실측치가 더 구체적인 7번 영상(`AnassKartit`)을 우선 채택함 |
| 12 | [GPT-6.1 Sol (Fully Tested) + Dots & All DevDay Launches Explained](https://www.youtube.com/watch?v=7eyrcRTi6Co) | AICodeKing | 2026-09-29 이후 (정확한 일자 원문 미확인) | 원문 미확인 | `Codex`에서 `GPT-6.1 Sol`(`medium`)로 KingBench 3의 8개 과제를 테스트해 80점 만점에 78점(97.5%)을 기록함 | 제외: 단일 모델(`GPT-6.1 Sol`) 위주 테스트여서 다중 모델 및 오케스트레이션을 다룬 3, 4, 5번 영상을 우선함 |
| 13 | [제미나이 4 하이드로젠 출시! 아르곤 넘은 구글 새 기본 모델](https://www.youtube.com/watch?v=9p4PwTBxS9I) | 단테 | 2026년 11월 (정확한 일자 원문 미확인) | 원문 미확인 | 한국어 영상으로 `Gemini 4 Hydrogen`의 가격(입력 $1.5, 출력 $7.5)과 `Cursor` 자체 테스트 수치(54.3%), `Sonnet 5.5` 및 `GPT-6.1 Terra` 대비 지표를 요약함 | 제외: 직접 코딩 에이전트를 실행한 실측이나 설정 시연 없이 발표 자료와 외부 지표만 소개함 |
| 14 | [Gemini 4 Hydrogen登場！Sonnet 5.5に1点差, 作り話8%, APIは入力1.5ドル](https://www.youtube.com/watch?v=Qtd54oDMHcw) | ラビビット \| AI活用メディア | 2026년 11월 (정확한 일자 원문 미확인) | 원문 미확인 | 일본어 영상으로 `Gemini 4 Hydrogen`, `Carbon`, `Fable 5.2`, `Opus 5.5`, `Sonnet 5.5`, `GPT-6.1 Sol`, `Terra`의 Artificial Analysis 점수와 환각률(8% 대 43% 대 52%)을 정리함 | 제외: 자체 실행 실측 없이 벤치마크 표를 해설한 뉴스 요약 영상임 |
| 15 | [HUGE ANTHROPIC BOMBSHELL! Claude REA UNBANNED?! GPT-6.1 Terra, Qwen 4 27B, & Fable 5.5! AI NEWS](https://www.youtube.com/watch?v=SyUjFWgqDNo) | WorldofAI | 2026년 10~11월 (정확한 일자 원문 미확인) | 원문 미확인 | `GPT-6.1 Terra` 출시 소식과 `Fable 5.5` 루머, `Antigravity` 유출 루머 등을 묶은 일일 뉴스 영상 | 제외: 자극적인 제목의 클릭 유도성 뉴스 모음이며 직접 측정한 실측이 없음 |
| 16 | [3 Frontier AI Models Dropped in 3 Days: Here’s Who Won?](https://www.youtube.com/watch?v=fjgTkF3GZ_g) | BitBiasedAI | 2026-09-10 | 원문 미확인 | `GPT-6 Astra`와 `Fable 5.1`의 출시 벤치마크 및 ARC Prize 하네스 점수 차이(62.7% 대 99.9%)를 분석함 | 제외: 벤치마크 메타 분석 중심이며 직접 코딩 과제를 실행한 실측이나 설정이 없음 |
| 17 | [Build Agents That Run for Hours (Without Losing the Plot)](https://www.youtube.com/watch?v=mR-WAvEPRwE) | AI Engineer | 2026-05-18 | 원문 미확인 | Anthropic 엔지니어들이 장기 실행 에이전트와 생성자, 평가자 계약 구조를 발표함 | 제외: 2026-09-01 이전 업로드 영상이며 `Opus 4.6`, `Sonnet 4.6` 구세대 모델을 다룸 |
| 18 | [클로드 코드 + 코덱스 + 제미나이 동시에 굴리는 멀티 에이전트 시스템](https://www.youtube.com/watch?v=iNCOuMCzzDg) | AI 치트키 | 2026-05-19 | 원문 미확인 | 한국어 영상으로 `Claude Code`가 오케스트레이터를 맡고 `Codex`가 크리틱, `Gemini`가 제3자 검토를 맡는 파일 기반 설계를 소개함 | 제외: 2026-09-01 이전 업로드 영상이며 2026년 하반기 신세대 모델 실측이 없음 |
| 19 | [클로드코드 vs 안티그래비티 vs 코덱스 AI 에이전트 바이브코딩 승자는?](https://www.youtube.com/watch?v=G7XCtMg8uHc) | QJC 퀀텀점프클럽 | 2026-05-23 | 원문 미확인 | 한국어 영상으로 메탈슬러그 게임 구현을 두고 세 도구를 비교함 | 제외: 2026-09-01 이전 업로드 영상이며 `Opus 4.7`, `Gemini 3.5 Flash`, `GPT-5.5` 구세대 모델만 다룸 |
| 20 | [【2026年2月最新】Claude vs Codex｜AIエージェント決戦の結論と賢い使い分け](https://www.youtube.com/watch?v=PWVcymhnC_w) | ソフトバンク公式 ビジネスチャンネル | 2026년 2월 (정확한 일자 원문 미확인) | 원문 미확인 | 일본어 영상으로 `Claude Code`와 `Codex` 데스크톱 앱의 역할 분담을 설명함 | 제외: 2026-09-01 이전 업로드 영상이며 `Opus 4.6`, `GPT-5.3 Codex` 구세대 모델만 다룸 |

### 3. 정독 영상별 요약 (10개)

10개 영상 모두 직접 영상 재생이 차단된 환경이므로 추출된 자막 전문과 설명 메타데이터만으로 내용을 확인했습니다.

#### 1) [What Will You Build With Coding Agents That Don’t Quit? | DevDay 2026](https://www.youtube.com/watch?v=U1IVZy9FhVQ)
- **분류 및 확인 방식:** 컨퍼런스 발표 및 벤더 공식 채널 (`OpenAI`) / 자막 전문으로 판단함.
- **역할별 모델 선택과 이유:** `Codex`에서 초기에는 `GPT-5.6 Sol` 단일 스레드로 시작했으나 어려운 버그 하나에 메인 스레드가 묶이는 병목이 생겼습니다. 그래서 메인 스레드는 테스트 트리거, 실패 수집, 서브에이전트 조율, 동료와의 Slack 메시지 전송만 맡기고, 코드 체크아웃과 반복 디버깅은 서브에이전트(`child threads`, 각각 별도 `git worktree` 격리)에 맡겼습니다. 단순 병렬 작업은 일반 차일드 스레드로 쪼개고, 비결정적 GPU 부동소수점 하이젠버그 같은 고난도 단일 난제는 내부적으로 다중 탐색 서브에이전트를 띄워 깊게 추론하는 `ultra` 모드로 전환했습니다. 테스트 삭제처럼 위험한 해결책이 나오면 별도 검증 서브에이전트를 띄워 1차 에이전트의 코드를 심문하고 리뷰하게 했습니다.
- **보여 준 실측:** 200단어 프롬프트 하나로 6주(1,000시간 이상) 동안 연속 실행했습니다. 약 50만 회 미만 도구 호출, 5,800개 이상 서브에이전트 세션 생성, 67,000회 이상 CI 대기 호출을 기록했습니다. 주당 100개 이상 PR을 열었고, 총 1,000개 이상 커밋, Slack 조율 메시지 600건 이상, 최종 머지된 자체 수정 PR 213건 이상을 달성했습니다. 비용 수치는 `원문 미확인`입니다.
- **주장과 실측의 구분:** 6주간 213개 PR 머지와 5,800개 서브에이전트 세션 수치는 사내 CI 운영 로그에서 나온 실측입니다. 반면 서버 측 자동 컴팩션 덕분에 "컨텍스트 열화(context rot)와 장기 실행(long-horizon) 문제는 완전히 해결된 문제"라는 발표자의 발언은 주장입니다.
- **한계:** 자사 제품(`Codex`)을 홍보하는 OpenAI 내부 엔지니어의 공식 발표이며, 외부 개발자가 재현할 수 있는 총 토큰 비용이 공개되지 않았습니다.

#### 2) [How Gemini 4 Argon & Carbon were built](https://www.youtube.com/watch?v=sUcvhFGc4mw)
- **분류 및 확인 방식:** 벤더 공식 채널 (`Google Cloud Tech`) / 자막 전문으로 판단함.
- **역할별 모델 선택과 이유:** `Gemini 4 Argon`은 100만 출력 토큰 한도를 바탕으로 긴 컨텍스트 추론, 3D 시각화, 대규모 마이그레이션, 그리고 `Antigravity`의 `Teamwork Preview` 다중 에이전트 실행용 기본 모델로 배치합니다. 2주 뒤 공개된 `Gemini 4 Carbon`은 `Argon`에서 지적된 환각(fabrication)과 웹 앱 UI 심미성 부족을 보완하고, 방어적 사이버보안 패치와 수일간 이어지는 장기 자율 버그 추적 역할에 배치합니다.
- **보여 준 실측:** `Carbon`은 Artificial Analysis Intelligence Index 1위를 기록했고, `Terminal-Bench 4.0` 및 `Gray Swan` 벤치마크에서 치팅과 간접 프롬프트 인젝션 공격 성공률을 `0%`로 낮췄습니다. Google 인수 보안 기업 Wiz의 `Scan for Good` 프로그램에 투입되어 수십만 건의 환자 기록이 노출될 뻔한 병원 시스템 취약점을 실제로 찾아 패치했습니다. 구체적인 소요 시간과 토큰 비용은 `원문 미확인`입니다.
- **주장과 실측의 구분:** `Terminal-Bench 4.0`과 `Gray Swan`의 `0%` 공격 허용률 및 병원 취약점 패치 건은 보고된 실측 사례입니다. 반면 `Carbon`이 막다른 길에서 포기하지 않고 수일간 스스로 우회로를 찾으며 일한다는 설명은 정량 시간표가 없는 정성 주장입니다.
- **한계:** Google DeepMind 임원 인터뷰 영상으로 자사 플랫폼 홍보 목적이 있으며, `Carbon`은 일반 공개 전 사이버 방어 파트너에게만 우선 배포된 상태에서 발표되었습니다.

#### 3) [Which Coding LLM is Best "Value for Money"? (November 2026)](https://www.youtube.com/watch?v=G8XY9--Jg7E)
- **분류 및 확인 방식:** 독립 크리에이터 (`AI Coding Daily`, 운영자 Povilas Korop) / 자막 전문으로 판단함.
- **역할별 모델 선택과 이유:** 최고 품질 구현에는 `Claude Opus 5.5`(`high`)를 쓰고, 코드 리뷰와 오케스트레이션, 큰 그림 기획에는 구현 점수보다 리뷰 능력이 뛰어난 `Claude Fable 5.2`를 배정합니다. 가성비와 서브에이전트용으로는 주간 구독 한도를 거의 쓰지 않는 `Claude Haiku 5.5`(`medium` 또는 `high`)를 최우선 추천합니다. `Claude Sonnet 5.5`는 `medium`이 극도로 불안정해 반드시 `high` 이상으로만 쓰고, `GPT-6.1 Sol`(`medium`)은 `Opus 5.5`의 대안으로 씁니다.
- **보여 준 실측:** 8개 프로젝트(90점 만점) 리더보드에서 `Opus 5.5`(`high`)가 `84.95점`(프롬프트당 API 평균 비용 `$0.83`)으로 1위를 기록했습니다. 16개 버그를 심어 둔 코드 리뷰 과제 `Bug Hunt`를 기존 1회에서 3회 반복 실행으로 바꾸자, `Opus 5.5`(1차 `9.58점`)와 `GPT-6 Astra`(`high`, `medium`) 등 대다수 모델의 평균 점수가 하락했고 `Astra`는 최소-최대 점수 편차가 1점 이상 벌어져 페널티를 받았습니다. 반면 `Fable 5.2`는 1차 `9.17점`에서 3차 `10점` 만점을 받아 두 계단 상승했습니다. `Gemini 4 Hydrogen`(`low`)은 16개 중 `2개`만 찾았습니다. $20 구독 요금제(20개 프롬프트 기준) 주간 한도 소모율 실측에서 `GPT-6.1 Terra`(`max`)는 `14%`, `GPT-6.1 Sol`은 `10%`, `Haiku 5.5`(`medium`, `high`)는 `1%`를 소모했습니다.
- **주장과 실측의 구분:** 3회 반복 실행 점수, 프롬프트당 단가(`Opus 5.5 high` `$0.83`), 주간 한도 차감 비율(`Terra max` `14%`, `Haiku` `1%`)은 실측입니다. `Fable 5.2`가 세부 구현보다 오케스트레이션과 기획에 적합하다는 해석은 엣지케이스 테스트 감점에 기반한 크리에이터의 분석입니다.
- **한계:** `Bug Hunt` 외 다른 일부 프로젝트나 일부 추론 수준(`low`, `xhigh`, `max`)은 전수 측정하지 않고 선별 측정했으며, 구독 사용량 대시보드가 소수점을 표시하지 않아 정수 퍼센트 단위로만 반올림 측정되었습니다. 스폰서 여부는 없으며 자체 뉴스레터 홍보만 포함합니다.

#### 4) [I Tested NEW GPT-6.1 Terra on Coding. Better than Luna?](https://www.youtube.com/watch?v=HHJRWx6eejE)
- **분류 및 확인 방식:** 독립 크리에이터 (`AI Coding Daily`) / 자막 전문으로 판단함.
- **역할별 모델 선택과 이유:** 고품질 코딩에는 `GPT-6.1 Sol`이나 `GPT-6 Astra`를 쓰고, 소규모 작업이나 서브에이전트 역할에서는 비용을 아끼려면 느리지만 저렴한 `GPT-6 Luna`를, 비용보다 응답 속도가 중요하거나 화면 조작(Computer Use) 에이전트를 제품에 넣을 때는 `GPT-6.1 Terra`(`medium`)를 선택합니다.
- **보여 준 실측:** 27개 코딩 프롬프트 벤치마크에서 일반 모델들이 평균 3~4분 걸리던 작업을 `GPT-6.1 Terra`는 첫 테스트에서 `26초`(최종 1.5분)에 끝냈습니다. 추론 수준별 프롬프트당 평균 실측치는 `Terra medium`과 `high`가 `1분 미만`에 품질과 가격이 거의 같았고, `Terra xhigh`는 평균 `1.5분`, API 비용 `$0.07`이었습니다. 진행 중이던 `Terra max`는 프롬프트당 평균 `7~8분`, 비용 `$0.24~$0.27`(일부 테스트 실패)로 급격히 느려졌습니다. 비교군인 `GPT-6 Luna`는 `max` 수준에서도 프롬프트당 API 비용이 `$0.03`이었고, 외부 벤치마커 Pavel의 표에서 `Terra max` 총비용은 `$3.88`로 `Sol xhigh` 및 `Sol max`와 맞먹었습니다.
- **주장과 실측의 구분:** 추론 수준별 시간(`26초`, `1.5분`, `7~8분`)과 프롬프트당 비용(`Luna max` `$0.03`, `Terra xhigh` `$0.07`, `Terra max` `$0.24~$0.27`)은 실측입니다. `Terra`가 개발자용 코딩 모델이 아니라 컴퓨터 조작 특화 모델이라는 진단은 출시 문구와 벤치마크 성향을 종합한 주장입니다.
- **한계:** `Terra max`의 코드 품질 두 개 열은 벤치마크 스크립트가 아직 도는 중에 영상을 촬영해 중간 집계치(30점 만점 기준)만 반영했습니다. 스폰서 여부는 없습니다.

#### 5) [I Tested Claude/Codex/Cursor $20/mo Plan Limits: 10 Coding Prompts](https://www.youtube.com/watch?v=KcuS-_f4X24)
- **분류 및 확인 방식:** 독립 크리에이터 (`AI Coding Daily`) / 자막 전문으로 판단함.
- **역할별 모델 선택과 이유:** $20 요금제 기준 완벽한 테스트 통과율이 필요할 때는 `Claude Code`의 `Opus 5.5`(`medium`)나 `Codex CLI`의 `GPT-6.1 Sol`(`medium`)을 주력으로 씁니다. 5시간 단기 한도가 부족할 때는 `Opus 5.5`보다 5시간 한도를 적게 먹는 `Sol`(`medium`)로 분산합니다.
- **보여 준 실측:** 캐시 없는 새 CLI 세션에서 PHP/Laravel 코드 검증 프롬프트 10개(2개 프로젝트 각 5회)를 동일하게 실행했습니다.
  - `Claude Code` + `Opus 5.5`(`medium`): 총 `27분` 소요, API 환산 비용 `$6.96`, 테스트 통과율 `10/10` 완벽 통과(프로젝트별 41/41, 29/29), 5시간 한도 `41%p` 소모(7%에서 48%로 증가), 주간 한도 `4%p` 소모(28%에서 32%로 증가).
  - `Claude Code` + `Sonnet 5.5`(`high`): 5시간 한도 `27%p` 소모(48%에서 75%로 증가), 주간 한도 `2%p` 소모(32%에서 34%로 증가), 일부 프로젝트에서 테스트 2개 실패.
  - `Codex CLI` + `GPT-6.1 Sol`(`medium`): 실행당 `4~10분` 소요로 `Opus 5.5`보다 느림, 테스트 통과율 `10/10` 완벽 통과, 5시간 한도 `25%p` 소모(잔여 93%에서 68%로 감소), 주간 한도 `4%p` 소모(잔여 90%에서 86%로 감소).
  - `Cursor CLI` + `Grok 4.6`(`high`): 총 `1시간 이상`(개별 실행 약 12분) 소요, 일부 테스트 실패, 월간 한도 `2%p` 소모.
- **주장과 실측의 구분:** 도구별 한도 차감률(`41%p` 대 `25%p`, 주간 각 `4%p`)과 소요 시간, 테스트 통과 여부는 실측입니다. `Astra`가 `Sol`보다 훨씬 느리고 비쌀 것이라는 언급은 이 영상에서는 직접 돌리지 않은 추정입니다.
- **한계:** 장기 단일 세션이 아니라 캐시가 없는 독립 단발 프롬프트 10개만 측정했기 때문에, 장기 세션의 컨텍스트 캐싱 효율은 반영되지 않았습니다. 스폰서 여부는 없습니다.

#### 6) [6 Ways Opus 5.5 + GPT-6 Astra Upgrade Your Workflow](https://www.youtube.com/watch?v=ucer2chlfM8)
- **분류 및 확인 방식:** 독립 크리에이터 (`Mark Kashef`) / 자막 전문으로 판단함.
- **역할별 모델 선택과 이유:** 여러 벤더 모델을 섞는 6단계 워크플로에서 모델 성향에 따라 역할을 나눕니다.
  - 기획 초안 작성(Level 1) 및 핵심 기능 구현 70%(Level 3): 구조화와 생성에 강하지만 자기 계획을 과신하는 낙관적 성향의 `Claude Opus 5.5`(`Claude Code`)를 배치합니다.
  - 계획 허점 비판(Level 1) 및 최종 코드/문서 다회차 리뷰 30%(Level 3): 회의적이고 비판적인 성향의 `GPT-6 Astra` 또는 `GPT-6.1 Sol`(`Codex CLI`, `medium` 추론)을 배치합니다.
  - 인포그래픽 및 다이어그램 이미지 생성(Level 2): 별도 Gemini API 비용을 아끼기 위해 $20 요금제에 포함된 `Codex`에 위임합니다.
  - 브라우저 조작, 로그인 클릭, 자격증명 복사(Level 4): 보안 가드레일 때문에 자격증명 취급을 거부하거나 컴퓨터 조작이 약한 `Opus 5.5` 대신 컴퓨터 조작 성능이 뛰어나고 제약이 덜한 `Codex`(`Astra`, `Sol`, `Luna`)에 넘깁니다.
  - 세션 간 컨텍스트 인계(Level 6): 플러그인 없이 한쪽 CLI에서 `codex exec` 또는 `claude` CLI를 직접 호출하게 하거나, 세션 종료 시 `/handoff` 명령으로 결정 사항과 다음 단계만 적은 최신 마크다운 인계 파일을 만들고 반대쪽 도구에서 `/prime`으로 읽게 합니다.
- **보여 준 실측:** 데모 화면에서 `Claude` 앱이 `codex exec`로 `Astra`(`medium`)를 호출해 수분 내 응답을 받고 반대로 `Codex`가 `Opus 5.5`(`medium`)를 호출하는 동작만 시연했으며, 정량적인 시간, 비용, 성공률 수치는 `자료 없음`입니다.
- **주장과 실측의 구분:** 두 도구가 서드파티 플러그인 없이 내장 터미널 명령만으로 서로의 헤드리스 CLI(`codex exec`, `claude`)를 호출할 수 있다는 점은 데모로 확인된 사실입니다. 반면 구현 비율 70 대 30이나 "10번 중 9번은 `Codex`가 로그인 작업을 처리한다"는 말은 경험적 주장입니다.
- **한계:** 정량 벤치마크 없이 정성적 워크플로 시연에 그쳤습니다. 스폰서 여부는 `원문 미확인`입니다.

#### 7) [Gemini 4 Argon vs Opus 5.5 vs GPT-6 Astra: I Gave Them the SAME Prompt](https://www.youtube.com/watch?v=5t07FpWZAVg)
- **분류 및 확인 방식:** 독립 크리에이터 (`AnassKartit`, 프랑스어 음성 자막) / 자막 전문으로 판단함.
- **역할별 모델 선택과 이유:** 3D 씬, Blender 연동, 시각 디자인, 빠른 원샷 게임 프로토타이핑에는 `opencode`의 `Gemini 4 Argon`을 선택합니다. 한 번의 응답으로 체크리스트를 완벽히 충족하는 완성도 높은 앱에는 `Codex`의 `GPT-6 Astra`를 선택하고, 별도 환경설정 조정 없이 안정적으로 돌아가는 코딩에는 `Claude Code`의 `Opus 5.5`를 선택합니다. 또한 `Test 1`에서는 `Codex`로 슈퍼카 4면도 레퍼런스 이미지를 생성한 뒤 이를 `opencode`의 `Gemini 4 Argon`에 넘겨 Blender MCP로 3D 모델링하는 다중 벤더 파이프라인을 구성했습니다.
- **보여 준 실측:**
  - `Test 1` (Blender MCP 3D 자동차 모델링): `Argon`(`opencode`)이 43개 오브젝트와 라이트, 240프레임 카메라 애니메이션을 완성했으나, 매 턴 이미지 포함 전체 대화가 재전송되어 입력 토큰 약 `1,000만 개`(캐시 적중률 `4%`)가 발생했고 단일 세션 API 비용이 `$22.13` 청구되었습니다.
  - `Test 2` (순수 코드 3D 람보르기니 주행): `GPT-6 Astra`(`Codex`)는 `9분`, `193줄`로 완료했습니다. `Opus 5.5`(`Claude Code`)는 `15분 미만`, `1,166줄`로 완료했습니다. `Gemini 4 Argon`(`opencode`)은 첫 실행에서 첫 토큰 출력 전 긴 추론 때문에 `opencode` 기본 5분 헤더 타임아웃으로 실패하고, 이어서 `opencode`의 32,000 토큰 출력 제한에 걸려 파일이 3번 잘렸습니다. 이를 `header timeout = 30분`, `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX = 65536`으로 수정한 뒤 재실행하여 `2,540줄` 작성 및 `17분` 추가 자체 디버깅으로 완주했습니다.
  - `Test 3` (OpenRouter 경유 3D 카트 레이싱 게임 원샷): `Argon`은 `221초`, `$0.31`로 작동 성공했습니다. `Astra`는 `323초`, `$0.70`으로 체크리스트 `10/10` 만점을 받았습니다. `Opus 5.5`는 추론 토큰에 예산을 소진해 32,000 토큰 한도에 걸려 코드가 끊기며 실패했습니다.
  - `Test 5` (82문항 단답): `Argon`과 `Astra` 모두 `82/82` 정답, `Opus 5.5`는 `81/82`(포맷 오류 1건)를 기록했으며 `Argon`이 응답당 `3.4초`로 가장 느렸습니다.
- **주장과 실측의 구분:** 각 테스트의 시간, 코드 줄 수, 실제 API 청구 금액(`$22.13`, `$0.31`, `$0.70`), `opencode` 설정값(`65536`)은 실측입니다. 자동차 외관 디자인 우열 평가는 제작자의 주관적 판단입니다.
- **한계:** 과제당 1회 실행(설정 오류 수정 후 재실행 1회) 결과이며, `Test 3`에서 `Opus 5.5`가 실패한 원인은 모델 자체 결함뿐 아니라 OpenRouter 호출 시 설정된 32,000 토큰 상한과 맞물린 결과입니다. 스폰서 없이 본인 API 키로 결제한 테스트입니다.

#### 8) [I Tested GPT-6.1 Terra vs. Sonnet 5.5 on 10 Real Use Cases](https://www.youtube.com/watch?v=812dIgIrbUg)
- **분류 및 확인 방식:** 독립 크리에이터 (`Duncan Rogoff | Learn Claude Code`) / 자막 전문으로 판단함.
- **역할별 모델 선택과 이유:** 창의적 기획, 인터랙티브 UI, 높은 완성도가 필요한 작업에는 느리고 비싸더라도 `Claude Sonnet 5.5`(`high`)를 선택하고, 속도와 저비용이 최우선인 단순 프로토타이핑에는 `GPT-6.1 Terra`(`high`)를 선택합니다.
- **보여 준 실측:** 스킬이나 사전 에셋 없이 클린 상태에서 두 모델 모두 `high` 추론 수준으로 10개 과제(랜딩페이지, 3D 브라우저 게임, 5개 비주얼 월드, 스프레드시트 대시보드 변환, 버그 점검 등)를 실행했습니다.
  - 과제 1 (랜딩페이지): `Sonnet 5.5` `11분` 소요, `$1.65` 대 `GPT-6.1 Terra` `약 2분` 소요, `$0.08` (`Sonnet` 승).
  - 과제 2 (3D 브라우저 게임): `Sonnet 5.5` `12분` 소요, `$1.68` 대 `GPT-6.1 Terra` `1분 47초` 소요, `$0.06` (`Sonnet` 승).
  - 10개 과제 누적 합계: 품질 승패는 `Sonnet 5.5`가 `9승 1무`로 압승했으나, 총 소요 시간은 `Sonnet 5.5`가 `95분` 대 `Terra`가 `16.5분`, 총 API 비용은 `Sonnet 5.5`가 `$13.36` 대 `Terra`가 `$0.68`이었습니다.
- **주장과 실측의 구분:** 과제별 및 10개 누적 소요 시간(`95분` 대 `16.5분`)과 비용(`$13.36` 대 `$0.68`)은 실측입니다. 시각적 완성도에 따른 9승 1무 판정은 제작자 1인의 블라인드 및 육안 평가입니다.
- **한계:** 각 과제를 원샷 1회 실행으로만 비교했고, 유료 커뮤니티(`Claude Code Club`) 홍보 링크가 포함되어 있습니다(외부 벤더 스폰서는 없음).

#### 9) [I Tested Opus 5.5 vs. GPT-6 Astra on 12 Real Use Cases](https://www.youtube.com/watch?v=GmLcJVzkxPA)
- **분류 및 확인 방식:** 독립 크리에이터 (`Nate Herk | AI Automation`) / 자막 전문으로 판단함.
- **역할별 모델 선택과 이유:** 각 모델을 별도 `git worktree`에 격리해 실행했습니다. 코딩 벤치마크 과제 설계와 사후 코드 채점에는 단일 모델의 편향을 피하려고 `Grok`, `Fable 5.1`, `GPT-6 Sol`을 섞은 다중 심사단(Mixture of Experts)을 구성했습니다. 창의적 디자인, 영상 편집(Hyperframes), 사용자 의도 파악에는 `Claude Code`의 `Opus 5.5`(`high`)를, 빠른 실행 속도와 토큰 비용 절감 및 실행 중 역질문(clarifying questions)을 통한 요구사항 구체화에는 `Codex`의 `GPT-6 Astra`(`high`, `/goal` 모드)를 배치합니다.
- **보여 준 실측:** 12개 과제 전체를 `high` 추론 수준으로 돌린 결과, 종합 승패는 `Opus 5.5`가 `8승`, `GPT-6 Astra`가 `4승`을 거두었습니다.
  - 과제 1 (브랜드 랜딩페이지): `Opus 5.5` `40분`, `$18.32` 대 `Astra` `32분`, `$11.33` (품질은 `Opus` 승).
  - 과제 2 (105GB 영상 폴더 기반 30초 홍보 영상 편집): `Opus 5.5` `31분`, `$10` 대 `Astra` `39분`, `약 $21~$22` (품질, 속도, 비용 모두 `Opus` 승).
  - 과제 3 (인스타그램 릴스 편집): `Astra`가 `Opus`의 약 절반 시간, 비용 `$9` 대 `Opus` `$11` (품질은 `Opus` 승).
  - 코딩 챌린지 과제: 두 모델 모두 `100/100` 통과(단, 심사 모델 중 `Fable 5.1`만 한쪽에 2점 감점 부여), `Astra`가 시간은 `1/5`, 비용은 `1/2` 수준으로 압도적 효율을 기록했습니다.
  - 12개 과제 누적 합계: `Opus 5.5`는 총 `약 11시간`, API 환산 비용 `$214`가 들었고, `GPT-6 Astra`는 총 `6시간`, API 환산 비용 `$132`가 들었습니다. 토큰당 단가는 `Astra`가 `Opus 5.5`보다 2.5배 비싸지만, 총 실행 시간은 `45%` 빠르고 총비용은 `38%` 저렴했습니다.
- **주장과 실측의 구분:** 12개 과제의 총 시간(`11시간` 대 `6시간`)과 API 환산 비용(`$214` 대 `$132`), 다중 모델 채점 점수(`100/100`)는 실측입니다. 최근 `Astra`의 영상 편집 창의성이 출시 초기보다 저하되었다는 발언은 제작자의 체감 주장입니다.
- **한계:** 과제당 1회 실행이며, 디자인과 영상 과제는 제작자의 주관적 취향이 반영되었습니다. 본인 무료 스킬 팩 및 커뮤니티 홍보가 포함되어 있습니다.

#### 10) [Fable 5.2は最強モデル？最新アプデで追加されたClaude最新モデルを徹底検証してOpus 5.5などと比較します！](https://www.youtube.com/watch?v=1tsV9RcABCo)
- **분류 및 확인 방식:** 독립 크리에이터 (`いまにゅのAIプログラミング塾`, 일본어) / 자막 전문으로 판단함.
- **역할별 모델 선택과 이유:** `Claude Code`에서 일상 코딩과 구현의 주축(메인 모델)은 토큰 효율이 좋은 `Claude Opus 5.5`(`high` 또는 `medium`)나 `Sonnet 5.5`로 둡니다. 최상위 모델인 `Claude Fable 5.2`는 토큰 소비량이 커서 상시 메인으로 쓰지 않고 세 가지 역할에만 투입합니다. 첫째는 `Claude Code`의 `/advisor` 명령으로 등록해 메인 모델(`Opus 5.5`)이 막히거나 판단이 어려운 지점에서만 자문하는 어드바이저 역할, 둘째는 하위 모델들의 성능을 끌어올리기 위한 `SKILL.md` 지침서 작성 및 개선 역할, 셋째는 최상류 아키텍처와 전략 설계 역할입니다.
- **보여 준 실측:** 동일한 단순 프롬프트로 커피숍 랜딩페이지, 회의록 SaaS 랜딩페이지, SVG 코드 일러스트(자전거를 타는 펠리컨, 후지산과 신칸센)를 `Fable 5.1`, `Opus 5.5`, `Sonnet 5.5`, `Fable 5.2` 4개 모델에서 동시에 생성해 비교했습니다. 웹 랜딩페이지에서는 `Opus 5.5`와 `Fable 5.2`의 체감 격차가 크지 않았고 `Sonnet 5.5`는 품질이 눈에 띄게 낮았습니다. 반면 복잡한 기하 구조와 디테일을 코드로 그려야 하는 SVG 과제(후지산과 신칸센, 펠리컨의 그림자와 구름 텍스처)에서는 `Fable 5.2`가 나머지 3개 모델을 큰 격차로 앞섰습니다. 개별 실행 시간과 비용 수치는 영상에서 공개되지 않아 `원문 미확인`입니다(단, Anthropic 공식 발표 수치로 `Fable 5.1` 대비 최대 30% 속도 향상, Fast 모드 시 2.5배 속도 및 2배 요금, 10개 서브에이전트로 8일간 OS 시제품 제작 사례를 인용함).
- **주장과 실측의 구분:** 4개 모델의 웹 페이지 및 SVG 산출물 동시 생성 비교는 영상에서 직접 수행한 검증입니다. `Fable 5.2`로 `SKILL.md`를 다듬으면 하위 모델(`Opus 5.5`, `Sonnet 5.5`)의 실행 품질이 함께 오른다는 설명은 워크플로 운용 주장입니다.
- **한계:** 프롬프트가 매우 짧은 원샷 시각물 위주이며, 정량적 시간 및 비용 측정표가 없고 라인(LINE) 등록을 통한 자체 스킬 배포 홍보가 포함되어 있습니다.

### 4. 영상 전체를 가로지르는 관찰과 서로 충돌하는 주장

#### 1) 전체 영상을 관통하는 공통 관찰
- **역할별 모델 계층화(Tiered Routing)의 정착:** 단일 모델을 모든 작업에 쓰는 대신, 상위 설계와 스킬 작성, 난제 자문(`/advisor`) 및 최종 코드 리뷰(`Bug Hunt`)에는 `Claude Fable 5.2`나 `Opus 5.5`, `GPT-6 Astra`를 두고, 주력 구현에는 `Opus 5.5`(`medium`/`high`)나 `GPT-6.1 Sol`(`medium`)을 쓰며, 코드베이스 탐색(`explore` 서브에이전트)과 반복 잔업에는 주간 한도를 1%만 쓰는 `Haiku 5.5`나 저렴한 `GPT-6 Luna`, 빠른 `GPT-6.1 Terra`(`medium`)를 배정하는 구조가 표준으로 정착했습니다.
- **자가 검증 편향 회피를 위한 이종 벤더 교차 검증:** `Mark Kashef`, `Nate Herk`, `AnassKartit` 등 다수 크리에이터가 "모델은 자신이 짠 계획과 코드에 과도한 확신을 갖는다"는 점을 지적합니다. 그래서 `Claude Code`(`Opus 5.5`)가 계획과 초안을 짜면 `Codex CLI`(`GPT-6 Astra` 또는 `Sol`)가 이를 비판 및 리뷰하고, 시각 레퍼런스 생성(`Codex`)이나 3D 및 대규모 컨텍스트 처리(`Gemini 4 Argon`), 브라우저 및 컴퓨터 조작(`Codex`)을 각자 잘하는 벤더 CLI로 넘기는 멀티 하네스 파이프라인이 널리 쓰입니다.
- **토큰 단가와 실제 과금(또는 구독 한도)의 괴리:** API 토큰당 단가가 싸다고 작업당 비용이 싸지지 않고, 반대로 토큰당 단가가 비싸다고 총비용이 비싸지지도 않습니다. `Nate Herk`의 12개 과제 실측에서 토큰 단가가 2.5배 비싼 `GPT-6 Astra`가 `Opus 5.5`보다 총비용이 38% 덜 나왔고(`$132` 대 `$214`), 반대로 `Sonnet 5.5`는 `max` 추론 수준에서 작업당 평균 193,000 출력 토큰을 쏟아내어 토큰 단가가 절반임에도 작업당 `$7.60`이 들었습니다. 또한 `opencode`나 `Claude Code` 같은 하네스의 타임아웃, 최대 출력 토큰(`32,000` 대 `65,536`), 캐시 적중률(`4%`일 때 단일 세션 `$22.13`)이 모델 자체만큼이나 성패와 비용을 좌우합니다.

#### 2) 영상 간 서로 충돌하는 주장과 실측
- **충돌 1: `GPT-6 Astra`의 추론 수준별 성능 격차와 안정성 (`AI Coding Daily` 대 `Nate Herk`, `AnassKartit`)**
  - `AI Coding Daily`는 `Bug Hunt`를 3회 반복 실행하면 `GPT-6 Astra`의 2, 3차 점수가 하락하고 최소-최대 점수 편차가 커서 페널티를 받으며, `low`, `medium`, `high` 간 품질과 가격 차이가 거의 없다고 실측했습니다.
  - 반면 `Nate Herk`와 `AnassKartit`의 원샷 실측에서는 `Astra`가 코딩 및 3D 카트 게임 체크리스트에서 `100/100`과 `10/10` 만점을 기록하며 가장 빠르고 안정적인 실행기라는 상반된 평가를 받았습니다. 이는 1회 실행(원샷) 평가와 다회 반복(엣지케이스 일관성) 평가의 차이에서 비롯됩니다.
- **충돌 2: `Claude Sonnet 5.5`의 가성비와 실전 효용 (`Universe of AI`, 벤치마크 표 대 `Duncan Rogoff`, `AI Coding Daily`)**
  - 공식 벤치마크(`Terminal-Bench 4.0` `70.6%`)를 인용하는 채널들은 `Sonnet 5.5`가 `Opus 5.5`(`66.4%`)를 이기면서 비용은 저렴한 최고 가성비 모델이라고 주장합니다.
  - 그러나 실제 과제를 돌린 `AI Coding Daily`는 `Sonnet 5.5 medium`이 극도로 불안정하고 `high`에서도 $20 플랜 5시간 한도를 `27%p`나 소모하며 테스트 실패가 발생해 가성비가 `Haiku 5.5`나 `Opus 5.5`보다 어중간하다고 평가했고, `Duncan Rogoff`의 실측에서도 10개 과제에 `95분`, `$13.36`를 소모해 결코 가볍거나 싸지 않음이 드러났습니다.
- **충돌 3: 장기 자율 실행에서 단일 스레드 컴팩션 대 다중 서브에이전트 분리 (`OpenAI DevDay` 대 `AnassKartit`, 독립 크리에이터들)**
  - `OpenAI DevDay 2026` 발표자는 내장 컴팩션 덕분에 3개월짜리 단일 스레드를 계속 유지해도 컨텍스트 열화가 해결되었다고 주장합니다.
  - 반면 `AnassKartit`는 장기 멀티턴 세션에서 캐시 적중률이 깨지면 입력 토큰이 1,000만 개로 불어나 단일 세션에 `$22.13`가 청구된다고 실측하며 세션을 짧게 끊으라고 경고하고, `Mark Kashef` 역시 컨텍스트 비대화를 막기 위해 세션을 종료하고 `/handoff` 마크다운 파일로 깨끗한 새 세션에 넘기는 방식을 주장합니다.
- **충돌 4: $20 구독 요금제에서 `Claude Code` 대 `Codex` 중 어느 쪽이 한도를 덜 소모하는가 (`AI Coding Daily` 자체 실측 대 Pavel의 리서치)**
  - `AI Coding Daily`의 10개 프롬프트 직접 실측에서는 `Opus 5.5`(`medium`)와 `GPT-6.1 Sol`(`medium`) 모두 주간 한도를 똑같이 `4%p` 소모했고 5시간 한도는 `Sol`(`25%p`)이 `Opus 5.5`(`41%p`)보다 덜 소모해 `Codex`가 유리하게 나왔습니다.
  - 그러나 같은 영상 말미에 인용된 벤치마커 Pavel의 구독 보조금(Subsidy) 실측 표에서는 반대로 `Claude` 구독이 `ChatGPT/Codex` 구독보다 더 많은 API 가치를 제공하는 것으로 집계되어, 프롬프트 길이와 캐싱 여부에 따라 결론이 정반대로 나뉩니다.

--- HANDOFF ---
status: ok
lead_action: accept
verdict: 2026년 9월 이후 업로드된 코딩 에이전트 및 멀티 에이전트 오케스트레이션 영상을 영어, 한국어, 일본어 18개 검색어로 조사하여 20개 후보 표와 10개 정독 요약, 교차 관찰 및 충돌 주장을 정리했습니다.
files_changed: none
confidence: high
