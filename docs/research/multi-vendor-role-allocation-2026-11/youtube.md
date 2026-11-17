# YouTube 조사: 코딩 에이전트와 멀티 에이전트 오케스트레이션의 모델 배치

조사일 2026-11-17. 2026-09-01 이후 업로드된 영상에서 역할별 모델 선택, 속도와 정확성 체감, 벤더 혼합 흐름을 모았다. 특정 결론을 전제하지 않았고, 영상의 주장과 영상이 직접 보여 준 실측을 구분해 적었다.

## 수집 방법과 한계

- `yt-dlp` 는 설치돼 있지 않아 `uvx yt-dlp` (버전 2026.10.26)로 임시 실행했다. `ytsearchdate` 는 이 버전에서 "Unsupported url scheme" 오류가 나서 쓰지 못했다. 대신 검색어마다 `ytsearch25:` (관련도순)와 YouTube 검색 결과 URL의 업로드 날짜 정렬(`sp=CAI%3D`)을 각각 25건씩 받았다.
- 검색어 14개(영어 8, 한국어 6)로 고유 영상 456건이 모였다. 검색어: Gemini 4 Carbon coding, Gemini 4 Hydrogen coding, Claude Fable 5.2 vs Opus 5.5 coding, GPT-6 Sol Astra coding agent, multi agent coding orchestration 2026, Claude Code subagents model Haiku Sonnet Opus, Codex vs Claude Code vs Antigravity, best model for each agent role coding, Gemini 4 Argon Antigravity agent, mix Claude Codex Gemini workflow orchestrator, 클로드 코드 서브에이전트 모델, 제미나이 카본 코딩, 코덱스 클로드 코드 안티그래비티 비교, 멀티 에이전트 오케스트레이션 클로드 코드 코덱스.
- 처음에는 Brave 영상 검색을 썼다. 무료 요금제가 초당 1건 제한이라 6건 중 3건이 429로 실패했고, 결과에 업로드 날짜와 조회 수가 없어서 yt-dlp 경로로 바꿨다. 이 때문에 Brave 결과는 표에 반영하지 않았다.
- 제목이나 설명에 모델명, 도구명, 오케스트레이션 키워드가 있는 341건의 날짜, 조회 수, 길이, 설명을 개별 조회했다. 처음에 38건이 실패했다가 재시도로 37건을 복구했고, 1건(채널 ID로 잡힌 비영상 결과)은 끝내 안 됐다. 키워드가 없는 115건은 제목만 확인하고 제외했다(부록).
- 조회 수는 2026-11-17 조회 시점 값이다.
- `홍보 또는 클릭 유도` 판정은 제목의 FREE, Unlimited와 채널 패턴으로 추정했다. 설명 전문을 읽은 영상은 후보와 정독 대상 일부뿐이다. 표의 마지막 열은 설명에서 자동으로 찾은 홍보 키워드(skool, membership, sponsor 등)다.
- 도구는 Claude Code, Codex, Antigravity 위주로 잡혔다. 검색어에 Cursor와 opencode 를 넣지 않아서 두 도구는 이번 자료로는 말할 수 있는 것이 없다.
- 영어 자막은 자동 생성이라 오인식이 있다: Sol을 "Soul", Antigravity를 "Integrity", GPT-6.1을 "JBD 6.1"로 적는 식이다. 인용에서는 문맥으로 바로잡았다.
- 자막 추출: `youtube-essence:yt-essence` 스킬과 `yt-essence --raw --json` 은 봇 확인("Sign in to confirm you're not a bot")으로 막혔다. 폴백으로 `yt-dlp --write-auto-subs` 에 `player_client=ios,web_embedded` 를 지정해서 받았고, 429가 나서 영상당 언어 하나씩 간격을 두고 받았다. 브라우저 쿠키는 쓰지 않았다.

## 훑기 결과 요약

2026-09-01 이후 업로드로 확인된 영상은 233건이다. 9월 1일 이전 업로드 107건은 날짜로 제외했다(부록).

| 판정 | 건수 | 뜻 |
|---|---|---|
| 정독 | 8 | 자막을 전부 읽음(요청 6건 + 날짜 복구 뒤 발견한 2건) |
| 후보 | 37 | 역할 분배, 벤더 혼합, 오케스트레이션이 주제이지만 정독하지 않음 |
| 참고 | 119 | 모델 단독 시험이나 벤치마크. 모션그래픽, 3D, 게임 같은 비코딩 과제가 많음 |
| 제외 | 69 | 모델 출시 소식 요약, 홍보 또는 클릭 유도 성격, 벤더 공식 데모, 코딩 아닌 주제 |

관찰 하나: 모델별 단독 시험은 매우 많고(제목에 Fable 5.2와 Opus 5.5 비교가 들어간 영상만 19건), 그중 상당수가 모션그래픽, 3D, 애니메이션이라 코딩 에이전트 선택 근거로는 약하다. 역할 분배나 혼합을 실측한 영상은 드물다.

## 정독 영상 선택 이유

| 영상 | 선택 이유 |
|---|---|
| Dubibubi, Sonnet 5.5 하위 에이전트 vs Fable 5.2 | 지휘 모델 + 저가 실행 모델을 단독 모델과 같은 과제로 비교하고 비용, 시간을 수치로 보여 줌 |
| Dubibubi, Haiku 5.5 하위 에이전트 vs Opus 5.5 | 같은 방법론을 Haiku로 반복. 위 영상과 교차 비교 가능 |
| Claude 공식, Fable 5.2 또는 Opus | 벤더가 말하는 역할 분배 기준. 주장과 실측을 대조할 기준점 |
| 후츠릿, Claude Code vs Codex 경쟁 패턴 | 서로 다른 벤더 하네스를 같은 작업에 붙이고 병합하는 흐름 |
| NERD UP, Gemini 4 Hydrogen Orchestrator 모드 | Gemini 쪽의 저가 모델 + 상위 모델 조합. Antigravity 기능 설명 포함 |
| AI Coding Daily, GPT-6 Sol과 Luna 144 프롬프트 | OpenAI 모델의 effort별 품질, 비용, 시간을 자체 리더보드로 반복 측정 |
| 챗대리의 AI연구소, 멀티 에이전트 쓰지 마세요 (추가) | 같은 모델로 팀을 꾸린 경우의 반대 실측. 실서비스 과제 사용 |
| G-CREATOR, Claude Code에 Codex 붙이기 (추가) | Claude 주도 + Codex 보조 구성을 직접 써 본 기록 |

추가 2건은 날짜 조회를 복구한 뒤에 발견해서 요청한 4~6건을 넘겼다.

## 정독 요약

### 1. Dubibubi, "Can an Army of Claude Sonnet 5.5 Subagents Beat Fable 5.2?"

- 링크: https://www.youtube.com/watch?v=QJFfRDvyr6g
- 업로드 2026-11-12, 19분, 조회 27,378, 채널 구독자 약 5만 1천. 설명에 Skool 커뮤니티 홍보가 있다(`/delegate` 스킬 판매).
- 구성: 단독 Fable 5.2 대 Fable 5.2가 계획하고 Sonnet 5.5 하위 에이전트가 구현하는 팀. 둘 다 extra high effort. 팀 쪽은 자작 `/delegate` 스킬로 Fable은 관리자, Sonnet은 실행자라고 역할을 못 박았다. 프롬프트로 "Sonnet 하위 에이전트를 써라"만 하면 Fable이 일을 직접 처리하거나 인계가 지저분해져서 스킬을 썼다고 한다.
- 채점은 과제마다 4점: 품질 2점, 최저 비용 1점, 최단 시간 1점.
- 역할별 모델: Fable이 계획과 검증, Sonnet이 구현과 버그 탐색.
- 실측(영상이 직접 보여 준 값):
  - 과제 1, 슈퍼 스매시 브라더스 복제 게임: 팀이 비용 25% 절감, 14분 빠름. 토큰은 팀이 더 많이 썼지만 Sonnet 단가가 낮아 총비용이 낮았다. 품질은 진행자가 직접 해 보고 팀 쪽 그래픽이 더 낫다고 판단(주관).
  - 과제 2, 일본풍 단편 애니메이션(JavaScript 렌더링): 단독 Fable이 품질, 속도, 비용 모두 우위. 팀 결과물은 나레이션 재생이 끊겼다. 진행자는 "애니메이션 같은 감각 과제는 저가 모델 하위 에이전트가 약하다"고 결론.
  - 과제 3, 자기 앱 코드의 버그 찾기(심사는 별도의 Opus 5.5, 확인된 버그 +1, 환각 -1):
    - 단독 Fable: $276, 55분, 약 5억 토큰, 확인 버그 90건, 환각 0건.
    - 팀 1차: $33, 21분, 약 5100만 토큰, 확인 33건, 환각 1건(점수 32).
    - 팀 2차(같은 프롬프트로 다시 요청): 추가 $17, 총 $50. 보고 90건 중 82건 확인, 환각 8건으로 74점. 이때 Fable 관리자가 후보 약 165건 중 확신하지 못한 약 130건을 Sonnet 검증자에게 재확인시켰다.
    - 비용 비율: 단독이 팀 2차의 약 5.5배. 1차만 보면 8배.
- 주장(근거 없이 말한 것): Fable 5.2는 Sonnet 5.5의 4배 가격. Anthropic이 Fable 5 + Sonnet 5로 BrowseComp에서 성능의 96%를 비용 46%에 얻었다는 인용(구세대 모델, 다른 과제라고 본인도 단서를 붙임).
- 한계:
  - 각 설정을 1회씩만 실행했다.
  - 점수 환산은 진행자 재량이다. 단독이 버그를 가장 많이 찾았지만 "관대하게" 1점만 주고 팀에 8점 대 5점으로 승리를 선언했다.
  - 심사 모델이 같은 Claude 계열(Opus 5.5)이다.
  - 첫 영상(Haiku)과 달리 이번에는 팀이 빨랐는데, 그 사이 스킬을 개선하고 Fable로 검토했다는 설명 외에 근거가 없다.
  - 비용은 사용량 대시보드 수치로, 구독 플랜 실비가 아니라 API 환산으로 보인다(영상에서 "API costs"라고 말함).

### 2. Dubibubi, "Can an Army of Claude Haiku 5.5 Subagents Beat Opus 5.5?"

- 링크: https://www.youtube.com/watch?v=Ug3x37N6Z_E
- 업로드 2026-10-09, 15분, 조회 430,165, 좋아요 4,558. 같은 채널, 같은 Skool 홍보.
- 구성: 단독 Opus 5.5 대 Opus 5.5 관리자 + Haiku 5.5 실행자(같은 `/delegate` 스킬, 둘 다 extra high). 채점 방식도 동일.
- 실측:
  - 과제 1, 앵그리버드 복제: 단독 Opus가 품질과 시간에서 우위. Haiku 팀은 비용만 약간 낮았다("큰 절감은 아님"). Haiku 토큰이 팀 총 토큰의 91%. 하위 에이전트를 한꺼번에 많이 띄워서 초반에 토큰을 앞당겨 쓴다는 관찰.
  - 과제 2, 사무라이 단편 애니메이션: Haiku 팀이 비용 약 80% 더, 1시간 더 걸리고 품질도 낮았다. 단독 Opus 승.
  - 과제 3, 버그 찾기(심사는 GPT-6 Astra, 진행자가 "현재 코드 리뷰 최강"이라고 전제): Haiku 팀 비용 61% 절감, 확인 103건, 환각 14건으로 89점. 단독 Opus는 확인 122건, 환각 0건. 단독이 10분 빨랐다. 별도 기록으로 단독 Sonnet 5.5는 87건 발견, 85점이라고 말함.
  - 최종 점수 10대 2로 단독 Opus.
- 진행자의 결론(해석): 인계와 검수 왕복이 토큰을 먹는다. 버그 탐색처럼 깔끔하게 쪼개지는 일은 Haiku 팀, 취향이나 전체 그림이 필요한 일은 Opus 단독. 다음에 Sonnet 실행자로 같은 실험을 하겠다고 예고했고, 그 결과가 영상 1이다.
- 주장: Haiku 5.5는 Opus 5.5보다 40배 저렴("달러당 2.5센트").
- 한계: 1회 실행. 심사 모델이 영상마다 다르다(여기서는 Astra, 영상 1에서는 Opus 5.5). 이번에는 진행자가 Fable이 "최근 이 과제에서 약 21건"을 찾았다고 말하는데, 영상 1에서는 단독 Fable이 90건이다. 설정 차이가 설명되지 않는다.

### 3. Claude 공식, "Fable 5.2 or Opus? When to use each model in Claude Code"

- 링크: https://www.youtube.com/watch?v=C33hJGt-ySg
- 업로드 2026-11-11, 3분, 조회 489,489, 좋아요 6,701. Anthropic 공식 채널. 실측 없음, 전부 벤더 주장이며 시연도 쇼핑몰 예제로 결과를 보여 주지 않는다.
- 역할별 모델 기준:
  - Opus 5.5 medium effort: 복잡한 코딩과 지식 작업의 기본값이자 시작점.
  - 결과가 부족하면 모델을 올리기 전에 effort를 먼저 올린다. 변경 폭이 작고 프롬프트 캐시가 대개 유지된다는 이유.
  - Fable 5.2: 대규모이고 범위가 열려 있는 일, 판단과 정확도가 중요한 일. 토큰당 가격이 Opus의 2배.
  - Sonnet 5.5: 범위가 분명한 일(재현 가능한 버그 수정). Opus보다 빠르고 토큰당 가격이 절반.
  - Haiku 5.5: 요약, 분류, 라우팅처럼 대량이고 비용에 민감한 API 호출.
  - 한 작업을 여러 모델로 쪼개기: Fable이 프레임워크 메이저 업그레이드 같은 큰 마이그레이션을 이끌고, 패키지별 업그레이드와 테스트 수정은 Sonnet 하위 에이전트에 넘긴다.
- 가격 관계: Fable = Opus의 2배, Sonnet = Opus의 절반이라면 Fable은 Sonnet의 4배다. 영상 1의 진행자 주장과 일치한다. Haiku는 영상 2의 "Opus의 40분의 1"과 달리 이 영상에서는 수치를 주지 않는다.
- 한계: 측정 방법은 영상 밖의 가이드(claude.dev 블로그)로 미뤘다. 어떤 비율로 쪼개면 비용이 얼마나 주는지 근거가 없다.

### 4. 후츠릿, "Claude Code vs Codex 최강 조합 | Orca 멀티에이전트 경쟁 패턴"

- 링크: https://www.youtube.com/watch?v=i9BLZiKzZ2o
- 업로드 2026-09-03, 36분, 조회 10,338, 구독자 약 1만. 설명에 패스트캠퍼스 강의 홍보, 본문에 멤버십 전용 실습 저장소 안내가 있다.
- 구성: Orca(여러 하네스를 한 작업 공간에 붙이는 오픈소스 에이전트 IDE)의 오케스트레이션 스킬로 Claude Code와 Codex에 같은 슬라이드 제작 스킬과 프롬프트를 병렬로 전달한다. 단계 1은 생성 비교(한 워크트리, 서로 다른 출력 파일), 단계 2는 수정 비교(같은 파일이므로 워크트리를 분리). 사람이 결과를 보고 각자 잘한 부분만 골라 병합한다.
- 결과(진행자의 눈으로 본 판단):
  - 생성: Codex가 구조와 흐름을 더 잘 잡았다고 판단. 디자인 차이는 같은 디자인 스킬이라 크지 않다고 함.
  - 병합: Codex의 구성과 내용에 Claude의 애니메이션 방식을 합쳤다.
  - 수정: Claude가 사고를 많이 해서 흐름까지 재구성하며 더 잘 고쳤다고 판단. Codex는 아이콘을 흑백으로 바꾸는 식으로 변경이 작았다.
- 운영 규칙: 서로 다른 파일을 만들면 같은 워크트리, 같은 파일을 고치면 워크트리 분리. 교차 검증은 상대 산출물을 봐야 하므로 같은 워크트리. 결과물 비교는 서로 다른 모델이, 스킬 비교는 같은 하네스가 낫다(모델 차이가 섞이므로).
- 영상 안의 모순: 도입부에서 "Claude는 구조는 깔끔하지만 화려한 걸 못 만들고, Codex는 시각적인 건 잘하지만 구조 설계가 약하다"고 말했는데, 실습 결론은 "Codex가 구조를 더 잘 잡는다"였다.
- 한계: 모델 버전을 말하지 않는다. 9월 3일 업로드라 GPT-6 Astra 공식 영상(9월 4일) 직전이다. 시간, 비용 수치가 없고 1회 실행이다. 과제가 슬라이드 HTML이라 코드 품질과 거리가 있다.

### 5. NERD UP, "Gemini 4 Hydrogen Review: Coding & Orchestrator Mode"

- 링크: https://www.youtube.com/watch?v=_qTGMyuvxek
- 업로드 2026-11-12, 8분, 조회 11,563, 구독자 약 4만 4천.
- 벤더 주장(Google 블로그를 읽어 준 내용):
  - Hydrogen은 Artificial Analysis 지수에서 기본 high 사고 수준에서 51점으로 Argon(50)을 앞서고 xhigh에서 54점.
  - Gemini 3.8 Flash보다 2.8배 빠르고 토큰 소모가 12~23% 적다.
  - 입력 가격 100만 토큰당 $1.50. 출력 가격은 자막이 "750 per million"으로 불명확하다.
  - Antigravity의 Orchestrator 모드는 주 모델(Carbon 또는 Argon)이 큰 과제를 맡고 Hydrogen이 하위 작업을 처리한다. Google은 기능 작업과 디버깅 같은 일상 작업에 최상위 추론 모델을 쓰면 루프가 느려지고 최상위 모델 할당량이 소모된다고 설명한다. Carbon의 `/swarm` 은 병렬 에이전트 팀으로 대형 엔지니어링 작업을 추적하며, 며칠 새 수만 건이 실행됐다고 한다.
  - Google 비교표는 Sonnet 5.5, GPT-6.1 Terra와 나란히 놓였다.
- 진행자 실측: 집 청소 서비스 웹사이트를 한 프롬프트로 만들게 했고(high), 결과는 "텍스트가 많고 보기 나쁜 사이트"였다. 진행자는 Hydrogen을 단독이 아니라 Carbon, Argon과 조합해서 쓰도록 만든 모델이라서 그렇다고 해석했다.
- 진행자가 차트에서 읽은 반론: Artificial Analysis에서 Hydrogen xhigh는 과제당 $3.16에 54점, GPT-6 Sol max는 과제당 $1.27에 더 높은 점수. 이 수치는 영상이 보여 준 차트를 진행자가 읽은 것이며 직접 확인하지 못했다.
- 한계: Orchestrator 모드를 실제로 돌려 본 장면이 없다. 조합 효과는 Google의 주장만 전달했다. 웹사이트 1회 시험만 직접 했다.

### 6. AI Coding Daily, "I Tested NEW GPT-6-Sol and GPT-6-Luna on 144 Coding Prompts"

- 링크: https://www.youtube.com/watch?v=Zvy--4U146M
- 업로드 2026-09-24, 14분, 조회 26,303, 구독자 약 1만 7천. 설명에는 광고 문의 링크 외에 홍보가 없고 영상 끝에 프리미엄 멤버십 안내가 있다.
- 방법: 자체 리더보드. PHP, Dart, Flutter, Go 프로젝트의 엣지 케이스와 비정상 경로 자동 테스트(최대 20점), 코드 품질 평가(GPT-5.6 Sol medium이 채점, 같은 계열이 채점하는 아이러니를 본인이 언급), 프론트엔드와 백엔드 품질. 모델과 effort 조합 12개를 24개 프롬프트로 시험(GPT-6부터 품질 평가는 3회 시도로 변경).
- 실측:
  - GPT-6 Sol은 5.6 Sol보다 품질이 낮다. 60점 만점에서 medium 기준 5.6이 52점, 6이 50점. high는 1.5점 하락.
  - 대신 비용이 3~5배 낮다. 프롬프트당 high 평균 $1.18에서 약 3~4분의 1, medium $1에서 $0.21. 시간은 high에서 48% 단축, medium은 5분에서 3분 30초.
  - Luna medium 이하는 쓸 수 없다. 프로젝트 하나에서 29개 중 0개 통과, 코드를 제대로 못 낸 경우도 있었다. high부터 시작하고, 더 올리면 프롬프트당 10~11분으로 느려진다. 모든 Luna의 비용은 평균 50% 이상 하락.
  - Sol xhigh와 max는 느리고 비싸서 같은 가격대의 Astra가 더 빠르고 품질이 낫다고 권한다.
  - 백엔드 품질 상위는 모두 Anthropic 계열, Astra는 상위에 없다. Opus 5.5가 품질에서 크게 앞선다고 표현했다.
- 진행자 해석: GPT-6 Sol은 5.6 Terra와 가격, 속도, 품질이 비슷해서 "이름 정리"에 가깝다. Luna는 DeepSeek Flash, GLM 5.3 Flash 같은 저가 모델의 경쟁자. 커뮤니티 트윗도 같은 방향(Sol 실망, Luna 만족)이라고 인용.
- 한계: 자체 벤치마크이고 언어가 PHP, Dart, Flutter, Go, React 정도로 한정된다. 프롬프트당 1~3회라 Sol 점수의 변동성이 크다(본인도 같은 Sol high에서 72.5~87.5점이 나왔다고 언급). 심사가 같은 벤더 모델이다. 업로드 시점이 9월 24일이라 이후 나온 GPT-6.1 Sol에는 적용되지 않는다. 제목 수준으로는 10월에 "GPT-6.1 Sol이 Astra에 근접한 성능을 더 싸게"라는 영상이 있어(미정독) 이 결론과 충돌할 수 있다.

### 7. 챗대리의 AI연구소, "멀티 에이전트 쓰지 마세요.. (실제 테스트 결과)"

- 링크: https://www.youtube.com/watch?v=cIGRF-acSzs
- 업로드 2026-11-04, 9분, 조회 38,667.
- 구성: 모델은 Sonnet 5.5 하나로 고정. 설정 세 가지는 (1) 단독 세션, (2) 계획부터 보안 리뷰까지 에이전트 5명 팀(외부 GitHub 저장소 ECC의 에이전트), (3) 계획과 구현은 메인, 코드 리뷰만 별도 에이전트 1명.
- 실측:
  - 미니 칸반 보드(로그인, 카드 CRUD, 권한, 비밀번호 암호화, 추가 기능 4개): 세 설정 모두 기능을 구현했다. 단독 6분, 팀 약 40분(7배 가까이).
  - 실서비스(진행자 팀의 MCP 서버 2주치 분량, 14개 작업을 미리 만든 정답 테스트로 채점): 팀이 80분으로 단독보다 40분 이상 더 걸렸고, 하위 에이전트를 9번 호출했으며, 점수는 3개 중 최저, 토큰은 약 2배. 단독은 가장 빠르고 쌌지만 자체 검수가 부족해 자잘한 버그가 남았다. 리뷰어 1명을 붙인 설정은 버그 5개를 정확히 잡았고, 단독 세션에서 `code-review` 슬래시 명령을 쓰면 비슷한 결과가 나왔다(시간과 토큰은 2인 체제와 비슷).
  - Opus 5.5로 상향한 재시험(단독 vs 팀만): 단독 약 40분, 팀 약 1시간. 핵심 기능 테스트 64점 대 62점으로 차이가 작았고, 토큰은 팀이 단독의 약 2배. Opus 단독은 지시하지 않았는데 계획 단계에서 탐색 에이전트 3개를 스스로 띄웠다.
  - 종합: 단독 세션 총 약 40분, 팀 약 2시간에 토큰 2~3배. 순위는 단독(리뷰 기능 포함)과 2인 체제가 공동 1위, 팀이 마지막.
- 진행자가 권하는 경우: 구현 뒤 독립 코드 리뷰, 넓은 코드베이스 사전 조사, 서로 독립적인 기능의 병렬 구현. 단독이 나은 경우: 계획에서 구현과 테스트까지 하나의 맥락이 이어지는 일, 작고 빠른 수정. 진행자는 Anthropic 공식 문서에 이와 같은 경고가 있다고 인용했고 이 인용은 원문으로 확인하지 않았다.
- 한계: 각 설정 1회 실행이다. 같은 모델에 역할만 나눈 팀이라서 저가 모델에 위임하는 구성(영상 1, 2)과 다른 조건이다. 팀 에이전트 정의가 외부 저장소 것이라 팀 구성이 결과에 영향을 줬을 수 있다. 벤더 혼합 없음.

### 8. G-CREATOR, "클로드 코드에 코덱스를 붙였더니? AI가 서로 검증합니다"

- 링크: https://www.youtube.com/watch?v=4BDNTubxwP4
- 업로드 2026-10-22, 13분, 조회 10,886.
- 구성: OpenAI의 Codex 공식 플러그인을 Claude Code에 설치한다. 진행자 설명으로는 3월 말에 출시됐다. Claude가 메인 오케스트레이터, Codex가 보조 작업자다. 반대(Codex 주도, Claude 보조)는 안 된다고 한다. Claude와 OpenAI 구독이 모두 필요하다.
- 명령: `/codex:review`(간단 리뷰), `adversarial-review`(까다로운 리뷰), `rescue`(작업 위임. Claude 토큰이 바닥났을 때나 기분 전환용), status, result, cancel.
- 실측: `rescue` 로 "1분 안에 만들 앱"을 시켰더니 처음에 "Codex 바이너리가 옛 버전" 오류가 나서 업데이트한 뒤 재요청했고, 7분 넘게 걸렸다. 진행자는 오류가 잦고 느려서 메인 작업은 Claude로 하는 게 낫다고 판단했다. `adversarial-review` 는 Claude가 만든 앱에서 배포를 보류할 만한 문제를 찾았고(키 길게 눌렀을 때 이동 문제 등), 수정까지 이어졌다. 진행자는 작업이 끝난 뒤 리뷰용으로 쓰고, 훅으로 응답마다 자동 리뷰를 걸 것을 권한다.
- 한계: 1회 시연이다. 시간 수치는 체감("느낌상")이다. 비용 수치가 없고 사용한 Codex 모델 버전이 화면에 안 보인다(오류 메시지에 "GPT 5.4나 Spark"가 언급돼 옛 구성일 가능성이 있다). 가장 구체적인 결과는 리뷰 한 건뿐이다.

## 영상 전체를 가로지르는 관찰

1. 비싼 모델이 계획과 검증을 하고 싼 모델이 실행하는 구성은 벤더와 제3자 모두 말한다. Anthropic은 Fable이 이끌고 Sonnet 하위 에이전트가 맡는 구성을 권하고, Google은 Carbon 또는 Argon이 이끌고 Hydrogen이 하위 작업을 한다는 Orchestrator 모드를 낸다. 같은 구조가 두 벤더에서 나온다. 다만 Google 쪽 조합 효과를 실제로 돌려 본 영상은 이번에 못 찾았다.
2. 실측에서 절감은 쪼개지는 작업에서만 나왔다. 버그 탐색(코드를 모듈로 나눠 탐색)은 Haiku 팀 61%, Sonnet 팀 82~88% 절감이었다. 반면 단편 애니메이션 같은 일체형 작업은 Haiku 팀이 비용 약 80% 더, 1시간 더 걸렸다. 이 해석은 영상 2의 진행자 설명과도 같다.
3. 저가 모델 팀은 정밀도가 낮다. 확인된 버그 대비 환각이 Haiku 팀 14/117(약 12%), Sonnet 팀 2차 8/90(약 9%), 단독 모델(Opus, Fable)은 0건이었다. 영상 1에서 Fable 관리자가 확신 없는 후보 130건을 걸러서 Sonnet 검증자에게 보낸 동작도 같은 문제를 겨냥한다.
4. 같은 모델을 여러 역할로 나눈 팀은 효용이 낮았다(영상 7). Sonnet 5.5 단독이 5역할 팀보다 약 7배(칸반) 또는 약 2배(실서비스) 빠르고 점수도 높았다. Opus 5.5로 바꿔도 같은 방향이었다(64점 대 62점, 토큰 약 절반). 이 결과는 "싼 모델에 위임"이 아니라 "같은 모델로 역할 분할"에 대한 것이라서, 위의 2번과 모순이 아니라 조건이 다르다(해석).
5. 별도 리뷰어 하나는 이득이 있었다. 영상 7에서 리뷰어 1명이 버그 5개를 정확히 잡았고, 영상 8에서도 Codex 적대적 리뷰가 배포 보류 사유를 찾았다. 영상 2에서는 심사를 다른 모델(Astra)에 맡겼다. 쓰는 방식은 제각각이지만 "만든 모델과 다른 눈으로 검토"라는 점이 같다.
6. 하위 에이전트 위임은 프롬프트만으로 안정적이지 않다는 신호가 있다. 영상 1, 2의 진행자는 프롬프트에 "Sonnet 하위 에이전트를 써라"만 쓰면 모델이 일을 직접 처리하거나 인계가 엉성해져서 역할을 정의한 스킬이 필요했다고 한다. 제목만 본 영상(미정독)에도 "하위 에이전트가 Haiku 5.5를 건너뛴다. 파일 2개로 고친다", "Claude가 위임을 아예 안 하는 경우가 많다"는 내용이 있다. Opus 5.5는 지시 없이도 탐색 에이전트 3개를 스스로 띄웠다는 관찰(영상 7)과 함께 보면 위임 동작이 모델과 설정에 따라 다르다.
7. 벤더 혼합 흐름에 대한 실측은 얇다. 영상 4는 서로 다른 벤더에 같은 일을 시키고 병합했지만 시간과 비용이 없고 주관 판단이다. 영상 8은 Claude 주도, Codex 보조로 리뷰 용도를 보여 줬을 뿐이다. 모델별 심사자로는 Claude 팀을 Astra가, Sonnet 팀을 Opus가, GPT 모델을 GPT-5.6 Sol이 채점하는 식으로 벤더가 섞이지만 같은 벤더 심사의 편향은 영상 6의 진행자가 직접 거론했다.
8. 모델별 체감(영상 6): 속도는 GPT-6 Sol이 5.6 Sol보다 48% 빠르고 비용도 크게 낮은 대신 품질이 약간 낮았다. Luna는 medium 이하에서 불안정했고 high부터 쓸 만했다. 백엔드 품질 상위는 Anthropic 계열이었다. 이 모두 9월 24일 시점의 GPT-6(6.1 이전) 측정이다.

## 서로 충돌하는 주장

| 주제 | 주장 A | 주장 B | 차이의 원인으로 보이는 것 |
|---|---|---|---|
| 팀과 하위 에이전트의 속도 | Sonnet 팀이 단독 Fable보다 14분 빠름(게임), 21분 대 55분(버그 탐색) (영상 1) | Haiku 팀이 단독 Opus보다 느림(게임, 애니메이션 +1시간, 버그 탐색 +10분) (영상 2) | 실행 모델(Sonnet 대 Haiku)과 그 사이 스킬 개선. 진행자는 스킬 개선과 Fable 검토를 언급 |
| 단독 Fable의 버그 탐색 건수 | 약 21건 (영상 2, "최근") | 90건 (영상 1) | 설정이 영상에 나오지 않아 알 수 없음 |
| 팀 구성의 효용 | 지휘 + 저가 실행으로 82~88% 절감 (영상 1) | 같은 모델 5역할 팀은 7배 느리고 점수 최저 (영상 7) | 비교 대상이 다름. 단가 차 활용 대 역할 분할 오버헤드 |
| Claude와 Codex의 강점 | 영상 4 도입부: Claude 구조, Codex 시각 | 영상 4 결론: Codex 구조, Claude 수정 | 한 영상 안의 모순. 모델 버전이 안 나옴 |
| GPT-6 Sol의 수준 | 5.6 Sol보다 품질이 낮다. Astra를 쓰라 (영상 6) | 제목 수준에서 "GPT-6.1 Sol이 Astra에 근접(더 저렴)" (10월 영상, 미정독) | 6.0과 6.1이라는 버전 차이일 수 있음. 미확인 |
| Hydrogen의 위상 | Google 지표로 Argon을 앞서는 저가 모델 (영상 5) | 진행자의 1회 시험은 결과가 나쁨. AA 차트상 Sol max가 더 싸고 높음 (영상 5) | 벤더 주장 대 진행자 시험. 조합 시험은 없음 |
| Haiku 가격 | Opus의 40분의 1 (영상 2 진행자) | 공식 영상은 수치 없음, Sonnet은 Opus의 절반 (영상 3) | 영상 2 수치는 출처 불명 |

## 후속으로 볼 만한 것(미정독)

- eo0As3rieA8 (0xSero, 26분): 하네스(pi, omp)별 사용법과 모델 분담, advisor 루프 구간.
- 02k-qEC1nk0 (Krumbs, 8분): Opus 지휘 + Haiku 하위 절감 주장을 문서와 대조. 근거가 "한 사람과 한 에이전시"에서 나왔다고 설명.
- O_hDTzkByG0 (11-03, 12분): 멀티 에이전트가 실제로 쓸모 있는지 다룬 한국어 영상.
- 04K89r_fdS4 (11-12, 33분): Carbon과 Claude Code Opus 비교(시즌 4).
- 11월 중순 영상 3건(WorldofAI, BitBiasedAI)의 제목에 "Gemini 4 Krypton" 이라는 이름이 나온다. 요청한 모델 목록에 없고 영상을 열지 않아서 실재 여부를 확인하지 못했다.
- Cursor와 opencode 는 이번 검색에서 다루지 않았다.

## 부록 A. 훑은 목록(2026-09-01 이후, 233건)

판정 열은 정독, 후보, 참고, 제외다. 마지막 열은 설명에서 자동 탐지한 홍보 키워드다. 같은 날짜 안에서는 검색 결과 순서를 따른다.

| ID | 업로드 | 조회 수 | 길이 | 채널 | 제목 | 판정 | 이유 | 설명 속 홍보 신호 |
|---|---|---|---|---|---|---|---|---|
| byrinHQ1wL8 | 2026-11-17 | 6 | 50분 | ELON Tube | 구글 제미나이 4 카본·아르곤·하이드로젠 공개와 90% 비용 절감: 안티그래비티 생태계 실체 총정리 | 제외 | 모델 출시 소식과 요약 | - |
| CweOG3HrCA0 | 2026-11-16 | 19698 | 78분 | Vaibhav Sisinty | Google’s AI Studio Lead Gave Me a Gemini 4 Masterclass | 참고 | 모델 단독 시험이나 비코딩 과제 중심(애니메이션, 게임, 웹사이트, 트레이딩 등) | community,sponsor |
| laJh1r9NuAE | 2026-11-16 | 6700 | 22분 | BitBiasedAI | Gemini 4 KRYPTON Is INSANE - It Just Coded an Entire Game! | 참고 | 모델 단독 시험이나 비코딩 과제 중심(애니메이션, 게임, 웹사이트, 트레이딩 등) | - |
| -UnVlPimhqY | 2026-11-16 | 625 | 5분 | Tested for Creators | FREE Gemini 4 Hydrogen vs $100 Claude Fable 5.2: Same Prompt, 3D Jet E | 제외 | 홍보 또는 클릭 유도 성격(채널 패턴, 제목의 FREE, Unlimited 등) | - |
| jZVWQH_4gCI | 2026-11-16 | 8704 | 10분 | Julian Goldie SEO | Gemini 4 Hydrogen's 3D Skills Are INSANE! 🤯 | 제외 | 홍보 또는 클릭 유도 성격(채널 패턴, 제목의 FREE, Unlimited 등) | community,course,skool |
| 8qKEzW-4C7g | 2026-11-16 | 8 | 9분 | Dev Mode | Gemini 4 Hydrogen and VS Code 1.146: This Week in Dev / Dev Week 11/16 | 제외 | 모델 출시 소식과 요약 | - |
| 3KfeQHOBras | 2026-11-16 | 2953 | 7분 | Julian Goldie SEO | New Gemini 4 Hydrogen Is INSANE! | 제외 | 홍보 또는 클릭 유도 성격(채널 패턴, 제목의 FREE, Unlimited 등) | community,course,skool |
| uarhqBuzRak | 2026-11-16 | 8 | 0분 | ODYXS | Claude Code Orchestrator: Haiku first, Opus only if it fails (Orchestr | 후보 | Haiku 먼저, 실패 시 Sonnet으로 올리는 오케스트레이터 30초 데모. 구독자 8명, 실측 근거 약함 | - |
| ZKKP6jbdNbg | 2026-11-16 | 72187 | 32분 | 조코딩 JoCoding | AI뉴스 - AI 부정행위 못 잡는다, 전문직 종말, Fable 5.2, MS365, GPT-6.2 Astra, 젠슨 황 사임 | 제외 | 모델 출시 소식과 요약 | 멤버십 |
| iXvttGCoc1g | 2026-11-15 | 134460 | 30분 | WorldofAI | Gemini 4 Krypton BEATS FABLE 5.2!?, GPT-6.2 Preview, GLM-5.5 LEAKED &  | 제외 | 모델 출시 소식과 요약 | community,discount,skool,sponsor |
| GAFSxnBSNco | 2026-11-15 | 4729 | 8분 | Julian Goldie SEO | Google Just Released Gemini 4 Hydrogen! | 제외 | 홍보 또는 클릭 유도 성격(채널 패턴, 제목의 FREE, Unlimited 등) | community,course,skool |
| Y-G4RXLJyqs | 2026-11-15 | 6488 | 3분 | Tested for Creators | FREE Gemini 4 Hydrogen Made This 3D Animation in 2 Messages | 제외 | 홍보 또는 클릭 유도 성격(채널 패턴, 제목의 FREE, Unlimited 등) | - |
| tRyJRmfhlCQ | 2026-11-15 | 1888 | 3분 |  知恵の宝物 | FREE Claude Code Unlimited: Fable 5.2 + Opus 5.5 (No Local, Claude Cod | 제외 | 홍보 또는 클릭 유도 성격(채널 패턴, 제목의 FREE, Unlimited 등) | affiliate,sponsor |
| DdrR6dQctDo | 2026-11-15 | 3136 | 3분 | deva.toontales | FREE ChatGPT PRO Unlimited: GPT 6 Astra Free + GPT 6.1 Sol, ChatGPT Fr | 제외 | 홍보 또는 클릭 유도 성격(채널 패턴, 제목의 FREE, Unlimited 등) | affiliate,sponsor |
| -uOAmbSkQpk | 2026-11-15 | 1659 | 3분 | Arcanum | ChatGPT PRO Free & UNLIMITED: GPT 6 Astra + GPT 6.1 Sol, Free ChatGPT  | 제외 | 홍보 또는 클릭 유도 성격(채널 패턴, 제목의 FREE, Unlimited 등) | affiliate,sponsor |
| 91ryb0wXu1o | 2026-11-14 | 403 | 8분 | AI with Tech Dad | Gemini 4 Carbon vs Argon vs Hydrogen vs 3.8 Flash: I Tested All Four | 참고 | 모델 단독 시험이나 벤치마크 비교 | discount |
| 8R8c4NqYExY | 2026-11-14 | 319 | 10분 | The Last Analog | Use Gemini 4 Carbon for FREE / Google's Latest AI Model | 제외 | 홍보 또는 클릭 유도 성격(채널 패턴, 제목의 FREE, Unlimited 등) | affiliate,sponsor |
| DKAcdG3iW_w | 2026-11-14 | 794 | 4분 | HMA WebCode | Google Just Released Gemini 4 Hydrogen! FREE AI API Key in VS Code 🔥 | 제외 | 홍보 또는 클릭 유도 성격(채널 패턴, 제목의 FREE, Unlimited 등) | - |
| ua8OVSw2wYU | 2026-11-14 | 99677 | 13분 | AI Revolution | Google Just Dropped HYDROGEN: The New King of Everyday AI | 제외 | 모델 출시 소식과 요약 | - |
| 6bwVh9Un0R8 | 2026-11-14 | 87 | 13분 | AI Delta | Gemini 4 HYDROGEN Beats Argon?! Qwen 4 Max Is INSANE at Building Games | 제외 | 홍보 또는 클릭 유도 성격(채널 패턴, 제목의 FREE, Unlimited 등) | - |
| oP_gzOJlbC8 | 2026-11-14 | 8850 | 11분 | Skynet News | [Rumor] Why OpenAI Delayed GPT-6.2 Astra & Sol: Gemini 4 Hydrogen & Fa | 제외 | 모델 출시 소식과 요약 | community |
| zk71qePMzAY | 2026-11-14 | 7099 | 21분 | Krystian Wojtarowicz A | I Tested Fable 5.2 vs Opus 5.5 on Motion Graphics & Animations | 참고 | 모델 단독 시험이나 비코딩 과제 중심(애니메이션, 게임, 웹사이트, 트레이딩 등) | community,course,hostinger,skool |
| 8hvzRy3alm0 | 2026-11-14 | 119 | 4분 | 팩트 K | 클로드·코덱스만 MCP 쓴다고? 세계 1위 제미나이 '무중력(Antigravity)'에 손발 달았더니 벌어진 일 (설치부터 실 | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| _BjMCeHFle0 | 2026-11-13 | 105034 | 20분 | Stefan 3D AI | I Tested Gemini 4 Carbon vs Claude Fable 5.2 to Build a Game | 참고 | 모델 단독 시험이나 비코딩 과제 중심(애니메이션, 게임, 웹사이트, 트레이딩 등) | course,discount |
| GyUkqLPjYVQ | 2026-11-13 | 19648 | 21분 | NeuralNine | Google is Back: Gemini 4 Hydrogen, Carbon, Decisions API & Omni | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| V-NiDeMY-8E | 2026-11-13 | 25163 | 13분 | AI Coding Daily | I Tested NEW Gemini 4 Hydrogen on Coding: It's a GAME-CHANGER | 참고 | 모델 단독 시험이나 비코딩 과제 중심(애니메이션, 게임, 웹사이트, 트레이딩 등) | sponsor |
| Wjz-9shPits | 2026-11-13 | 27222 | 6분 | JC BuenaVentura | Who Wins? Build a 2D Godot Game Using ONLY CODE: Gemini 4 Carbon vs Cl | 참고 | 모델 단독 시험이나 비코딩 과제 중심(애니메이션, 게임, 웹사이트, 트레이딩 등) | community,sponsor |
| d_CSS58yrxY | 2026-11-13 | 10780 | 11분 | The Learn Up | Gemini 4 HYDROGEN vs ARGON vs CARBON (Benchmarks, Pricing & Free Tier) | 참고 | Hydrogen, Argon, Carbon 벤치마크와 요금 비교(무료 티어 언급) | sponsor |
| prA0iTPDqfo | 2026-11-13 | 95504 | 32분 | Bijan Bowen | Gemini 4 Hydrogen Is the BEST Flash Model Yet - Full Test! | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| 9tZGphHbWww | 2026-11-13 | 13955 | 21분 | AsapGuide | I Tested Gemini 4 Hydrogen vs. Sonnet 5.5 and GPT 6.1 Terra | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| yvq3lEyWdE8 | 2026-11-13 | 17592 | 10분 | AI with Surya | Gemini 4 Hydrogen Is Here: 2.5x Faster, Tested | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| 2naJDLShbEs | 2026-11-13 | 55627 | 8분 | Tested for Creators | Gemini 4 Hydrogen vs Claude: FREE 3D Animation With Code | 제외 | 홍보 또는 클릭 유도 성격(채널 패턴, 제목의 FREE, Unlimited 등) | - |
| wRdIl5dnqUY | 2026-11-13 | 30840 | 0분 | Google Gemini | Turn Lightning into Music with Gemini 4 Hydrogen | 제외 | 벤더 공식 마케팅 데모 | community |
| t2xod2KdmnI | 2026-11-13 | 67229 | 10분 | 코드팩토리 | 왜 또 좋음? Gemini 4 Hydrogen | 참고 | 모델 단독 시험이나 벤치마크 비교 | 강의 |
| GdMnqbGPlyY | 2026-11-13 | 78771 | 19분 | Jason Lee | I Tested Fable 5.2 vs Opus 5.5 Building Websites, Apps, Motion Graphic | 참고 | 모델 단독 시험이나 비코딩 과제 중심(애니메이션, 게임, 웹사이트, 트레이딩 등) | hostinger |
| NWNF-YnKvww | 2026-11-13 | 14671 | 20분 | Internet Made Coder | Codex vs Claude Code in 2026 - Honest Comparison | 후보 | Codex vs Claude Code 비교 | sponsor |
| OIklaxZleik | 2026-11-13 | 9301 | 15분 | 쫑대표의 딸깍일기 | 새 AI가 또 쏟아졌는데 뭘 써야 할까? 클로드 Fable 5.2 vs 구글 Gemini 4 Carbon, 그리고 Fable  | 참고 | 모델 단독 시험이나 벤치마크 비교 | 멤버십,할인 |
| 9p4PwTBxS9I | 2026-11-13 | 25618 | 10분 | 단테 | 제미나이 4 하이드로젠 출시! 아르곤 넘은 구글 새 기본 모델 | 제외 | 모델 출시 소식과 요약 | - |
| f9_ER2gbclA | 2026-11-13 | 104793 | 10분 | 스마트대디_SmartDaddy | 왕의 귀환? 제미나이 카본 VS 클로드 페이블 완전 비교 (2D/3D/게임) | 참고 | 모델 단독 시험이나 비코딩 과제 중심(애니메이션, 게임, 웹사이트, 트레이딩 등) | - |
| MyZzhTyDc4I | 2026-11-13 | 22935 | 14분 | Alex AI | 제미나이 4 하이드로젠 실기 테스트 / AI가 AI를 만든다, 구글·앤트로픽·오픈AI의 실제 성적표 | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| NxTybE2ha88 | 2026-11-13 | 1216 | 4분 | 근쌤 | 제미나이 하이드로젠 출시 / 카본 이틀 만에 또, 매일 쓰는 빠른 Gemini 4 Hydrogen | 제외 | 모델 출시 소식과 요약 | - |
| l5xRNnziBb4 | 2026-11-13 | 21875 | 12분 | 김경원의 AI | AI에게 콜 오브 듀티를 만들라고 시켰더니 / 클로드 페이블5.2 vs 제미나이 카본 | 참고 | 모델 단독 시험이나 벤치마크 비교 | 강의 |
| 3tacaSEZM9M | 2026-11-12 | 27078 | 1분 | Google Antigravity | Bug Triage with Gemini 4 Hydrogen and Gemini 4 Carbon | 후보 | Antigravity 공식. Hydrogen이 분류, Carbon이 해결하는 역할 분담 1분. 벤더 데모 | - |
| kyhw-v_iVf0 | 2026-11-12 | 85227 | 1분 | Google Antigravity | Gemini 4 Hydrogen available in Google Antigravity | 제외 | 벤더 공식 마케팅 데모 | - |
| _qTGMyuvxek | 2026-11-12 | 11563 | 8분 | NERD UP | Gemini 4 Hydrogen Review: INSANE Coding & Orchestrator Mode | 정독 | Gemini 4 Hydrogen을 Antigravity Orchestrator 하위 작업 모델로 쓰는 구성 | - |
| bm8x0hopWTU | 2026-11-12 | 187795 | 8분 | Paul J Lipsky | Gemini 4 Hydrogen Just Dropped (Personally Tested) | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| VMraE40YKrU | 2026-11-12 | 71487 | 20분 | TheAIGRID | Anthropic Just Got a BIG Problem… Gemini 4 Carbon Is Here | 제외 | 모델 출시 소식과 요약 | community,skool,sponsor |
| 5gH3SCNCyX4 | 2026-11-12 | 11162 | 6분 | Evan Burger | I Tested Gemini 4 Carbon vs Fable 5.2: Google's Back? | 참고 | 모델 단독 시험이나 벤치마크 비교 | community,skool |
| Pc65QyNIOuM | 2026-11-12 | 15392 | 9분 | Universe of AI | Gemini 4 Carbon Is HERE! (Google's Strongest Model Yet) | 참고 | Carbon을 Argon 대신 고를 때 설명 | community,sponsor |
| oh8AyMFU5S8 | 2026-11-12 | 172500 | 0분 | Google Gemini | Build Interactive 3D Visualizers with Gemini 4 Hydrogen | 제외 | 벤더 공식 마케팅 데모 | community |
| OFkDCJ9Yjzo | 2026-11-12 | 33154 | 11분 | Universe of AI | Gemini 4 Hydrogen, Jensen Huang RESIGNS, OpenAI's resets! | 제외 | 모델 출시 소식과 요약 | sponsor |
| E4TzPbJUrX0 | 2026-11-12 | 5876 | 9분 | Hyperautomation Labs | Gemini 4 Hydrogen Just Beat Argon (And It's Cheaper) | 제외 | 홍보 또는 클릭 유도 성격(채널 패턴, 제목의 FREE, Unlimited 등) | affiliate,join the community |
| 6GA_zSxtSHE | 2026-11-12 | 5480 | 12분 | Fahd Mirza | Gemini 4 Hydrogen: Everyday Model for Everyone from Google | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| lhCad7WDyHw | 2026-11-12 | 120467 | 43분 | WorldofAI | Google's Gemini 4 KRYPTON Is INSANE! Carbon 4, Grok 4.8, GPT-6.2 Relea | 제외 | 모델 출시 소식과 요약 | community,discount,skool,sponsor |
| msbNkZ16C-M | 2026-11-12 | 12434 | 8분 | Leo Ai | Claude Fable 5.2 vs Opus 5.5 Make Animated Video From Scratch | 참고 | 모델 단독 시험이나 비코딩 과제 중심(애니메이션, 게임, 웹사이트, 트레이딩 등) | - |
| NnlVDQbydG8 | 2026-11-12 | 4249 | 8분 | Clearmud | I tested Ultracode on Extra High comparing Opus 5.5 & Fable 5.2 | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| DP_9FdS0c8I | 2026-11-12 | 16421 | 8분 | Kevis Unfiltered | Gemini 4 Carbon vs. Claude Fable 5.2 vs. Opus 5.5: Same Animated Video | 참고 | 모델 단독 시험이나 비코딩 과제 중심(애니메이션, 게임, 웹사이트, 트레이딩 등) | - |
| qncw2tZZ7IA | 2026-11-12 | 1683 | 15분 | lustoykov | Claude Code's New BEST Practices & Features for 2027 | 후보 | Claude Code 모범 사례. 조회 수 낮음 | - |
| QJFfRDvyr6g | 2026-11-12 | 27378 | 19분 | Dubibubi | Can an Army of Claude Sonnet 5.5 Subagents Beat Fable 5.2? | 정독 | Fable 지휘 + Sonnet 5.5 하위 에이전트를 단독 Fable과 직접 비교, 비용 수치 제시 | skool |
| DDy_HhjC9OA | 2026-11-12 | 6215 | 15분 | 단테 | 제미나이 4 카본 출시! 구글이 칼을 갈았다 | 제외 | 모델 출시 소식과 요약 | - |
| 57UgdAeM5Qs | 2026-11-12 | 71895 | 11분 | 코드팩토리 | 갑자기 쓸만해져서 더 열받는 잼미니 Gemini 4 Carbon | 참고 | 모델 단독 시험이나 벤치마크 비교 | 강의 |
| jVjDjCDQI0s | 2026-11-12 | 488 | 4분 | 근쌤 | 제미나이 카본 출시 / 구글이 꼽은 가장 강한 AI, Gemini 4 Carbon 발표와 공식 시연 | 제외 | 모델 출시 소식과 요약 | 할인 |
| 04K89r_fdS4 | 2026-11-12 | 6454 | 33분 | 편집자P | [시즌 4] 제미나이 Carbon VS 클로드 코드 Opus 진지한 비교 평가, 테스트 | 후보 | Carbon vs Claude Code Opus 33분 비교(시즌 4). 미정독 | .app,할인 |
| vja8JLbVbWs | 2026-11-12 | 99 | 4분 | Daniel Vision School K | 구글이 일냈습니다. 미친 성능으로 나온 '제미나이 4 카본' / 아르곤과 뭐가 다를까? (성능·가격·/swarm 완벽 정리) | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| cXgFL4s4KEs | 2026-11-11 | 9461 | 9분 | AI with Surya | Gemini 4 Carbon Is Finally Here: I Built 5 Things in One Day | 참고 | Carbon으로 하루 5개 제작 | - |
| OBNVzWYMKbE | 2026-11-11 | 197983 | 29분 | Theo - t3․gg | Progress? | 참고 | Theo 29분, 내용 미확인 | sponsor |
| SvXR3bNktMA | 2026-11-11 | 17756 | 15분 | AICodeKing | Gemini 4 Carbon vs Claude Fable 5.2 (Fully Tested) | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| kyEpgBPC08o | 2026-11-11 | 7588 | 8분 | Julian Goldie SEO | Google's NEW Gemini 4 Carbon Is INSANE! 🤯 | 제외 | 홍보 또는 클릭 유도 성격(채널 패턴, 제목의 FREE, Unlimited 등) | community,course,skool |
| CfnLlM4UmZc | 2026-11-11 | 5458 | 7분 | Julian Goldie SEO | Google Gemini 4 Carbon Is WILD! | 제외 | 홍보 또는 클릭 유도 성격(채널 패턴, 제목의 FREE, Unlimited 등) | community,course,skool |
| 0ecXAZiX9uM | 2026-11-11 | 6633 | 5분 | Codedigipt | I Tested Gemini 4 carbon For FR*EE | 제외 | 홍보 또는 클릭 유도 성격(채널 패턴, 제목의 FREE, Unlimited 등) | affiliate |
| G8rzzawst4s | 2026-11-11 | 2236 | 68분 | Every | LIVE Vibe Check: Gemini 4 Carbon | 참고 | Every 68분 라이브 감상 | - |
| AQWgE5LWQ4A | 2026-11-11 | 44418 | 24분 | Brock Mesarich / AI fo | I Tested Claude Fable 5.2 vs Opus 5.5 (WILD RESULTS) | 참고 | 모델 단독 시험이나 벤치마크 비교 | hostinger |
| C33hJGt-ySg | 2026-11-11 | 489489 | 3분 | Claude | Fable 5.2 or Opus? When to use each model in Claude Code | 정독 | Anthropic 공식. Claude Code 모델별 역할 분배 기준(벤더 주장) | - |
| IwXn5UYIt0g | 2026-11-11 | 209614 | 17분 | RandomAI | I Tested Claude Fable 5.2 vs Opus 5.5 on Motion Graphics & Animations  | 참고 | 모델 단독 시험이나 비코딩 과제 중심(애니메이션, 게임, 웹사이트, 트레이딩 등) | community,skool |
| bfU8R9m5KHw | 2026-11-11 | 37704 | 27분 | Jack Roberts | I Tested Fable 5.2 vs Opus 5.5 on 7 Real Tasks | 참고 | 모델 단독 시험이나 벤치마크 비교 | community,course |
| ZBUOs-SdrhY | 2026-11-11 | 8940 | 21분 | Duncan Rogoff / Learn  | I Tested Fable 5.2 vs Opus 5.5 (You Need To See This) | 참고 | 모델 단독 시험이나 벤치마크 비교 | skool |
| ceU0tS6sXbU | 2026-11-11 | 68690 | 36분 | Nick Vasilescu | I Stole the Best Part of Every AI Agent... With One Prompt (Open Sourc | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| HaFfexk1h84 | 2026-11-11 | 153595 | 14분 | Stefan 3D AI | Claude Fable 5.2 is Scary Good at 3D | 참고 | 모델 단독 시험이나 비코딩 과제 중심(애니메이션, 게임, 웹사이트, 트레이딩 등) | course,discount |
| yA3VZC9yAnk | 2026-11-11 | 508 | 4분 | AI 설명서 | 제미나이 카본, 내 작업에 필요할까? 문서·코딩·이용 조건 | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| ijLTC-d1TMs | 2026-11-11 | 52045 | 8분 | 안될공학 - IT 테크 신기술 | AI 신규 모델 대격돌 / 구글 카본 vs 클로드 페이블 5.2 / 새로 나온 두 AI의 코딩 실력과 실제 비용을 따져봤습니다 | 참고 | 모델 단독 시험이나 벤치마크 비교 | 할인 |
| v65FQ_za4fM | 2026-11-11 | 48344 | 9분 | 성공지식백과 | 드디어 풀렸습니다.. 구글 최강 모델 제미나이 4 카본 정식 출시.. ㄷㄷ | 제외 | 모델 출시 소식과 요약 | - |
| WHC8JhjT6fI | 2026-11-11 | 7178 | 8분 | Alex AI | 제미나이 4 카본 vs 클로드 페이블 5.2 / 벤치마크·가격·실제 사례 총정리 | 제외 | 모델 출시 소식과 요약 | - |
| Yrb-C6S6uS8 | 2026-11-11 | 1134 | 3분 | StefanCho | Gemini 4 Carbon 나오자마자 3D 웹게임 6개 만들어 봤습니다 (Antigravity) | 참고 | 모델 단독 시험이나 비코딩 과제 중심(애니메이션, 게임, 웹사이트, 트레이딩 등) | - |
| llhVMSEbIME | 2026-11-11 | 39 | 8분 | ICBM | 제미나이 4 카본: 혁신의 경계 | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| 4onc5T6VHSM | 2026-11-10 | 10582 | 4분 | codeSTACKr | Gemini 4 Carbon Built This Voice Assistant in 4.5 Hours (On Its Own) | 참고 | 모델 단독 시험이나 벤치마크 비교 | affiliate |
| YTA_DsiYwAc | 2026-11-10 | 204415 | 17분 | Paul J Lipsky | Gemini 4 Carbon Is Here (Fully Tested) | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| 0GSvcg9wncc | 2026-11-10 | 126472 | 38분 | Bijan Bowen | Gemini 4 Carbon Is INSANE - Seriously, This Model Is Ridiculous! | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| lQ6wwLHqDAg | 2026-11-10 | 53143 | 18분 | Prompt Engineering | Gemini 4 Carbon Is Finally Here, And It's a Beast! | 참고 | Carbon 얼리 액세스 시험(Three.js 등 산출물 중심), 벤치마크 생략 | - |
| BowFrTjy2XE | 2026-11-10 | 8431 | 19분 | Mansel Scheffel | Claude Fable 5.2 Vs Opus 5.5 (feat. Reverse Engineer Anything) | 참고 | 모델 단독 시험이나 벤치마크 비교 | community,join my community,skool |
| bOjNZnDvjZw | 2026-11-10 | 43147 | 7분 | g russ | Claude Fable 5.2 vs Opus 5.5 Makes RicksClips Short (INSANE RESULTS) | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| jPW1PrTOV10 | 2026-11-10 | 2715 | 13분 | Daniel Morgan | Claude Fable 5.2 vs Opus 5.5: Can You Tell the Difference? | 참고 | 모델 단독 시험이나 벤치마크 비교 | sponsor |
| iTnq8ZwT_-k | 2026-11-10 | 16255 | 4분 | Kyle Skelly | Claude Fable 5.2 vs Opus 5.5 = One Prompt Website (Who Wins?) | 참고 | 모델 단독 시험이나 비코딩 과제 중심(애니메이션, 게임, 웹사이트, 트레이딩 등) | - |
| PhCpq0Eagak | 2026-11-10 | 104401 | 21분 | Dubibubi | I Made Claude Fable 5.2 & Opus 5.5 Build the Same App (RAW RESULTS) | 참고 | 모델 단독 시험이나 벤치마크 비교 | community,skool |
| f1rBBymPxos | 2026-11-10 | 2006 | 10분 | The GameDev Atelier | Claude Fable 5.2 vs Opus 5.5 Build 3D Models in Blender. Who Won the B | 참고 | 모델 단독 시험이나 비코딩 과제 중심(애니메이션, 게임, 웹사이트, 트레이딩 등) | - |
| U9UZZ5T16Jo | 2026-11-10 | 33045 | 8분 | Tensaikun | Claude Fable 5.2 vs Opus 5.5 Make a 3D Animated Video From Scratch | 참고 | 모델 단독 시험이나 비코딩 과제 중심(애니메이션, 게임, 웹사이트, 트레이딩 등) | - |
| pXZ04w-JuYg | 2026-11-10 | 8862 | 14분 | Artturi Jalli | Fable 5.2 vs Opus 5.5 AI Motion Graphics (This is crazy) | 참고 | 모델 단독 시험이나 비코딩 과제 중심(애니메이션, 게임, 웹사이트, 트레이딩 등) | affiliate,sponsor |
| H0OeHaQ3L84 | 2026-11-10 | 23009 | 16분 | Lukas Margerie | I Tested Fable 5.2 vs Opus 5.5 on Motion Design, UI and 3D Games | 참고 | 모델 단독 시험이나 비코딩 과제 중심(애니메이션, 게임, 웹사이트, 트레이딩 등) | .app,skool |
| Rv6cghBFqO4 | 2026-11-10 | 17912 | 8분 | Model World | Is Fable 5.2 Worth $41 More Than Opus 5.5? | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| ajfQWhGQGLE | 2026-11-10 | 142062 | 110분 | freeCodeCamp.org | Codex & AI Coding Agents - Learn Agentic Coding | 후보 | freeCodeCamp 110분 Codex 강좌. 입문 위주 | course,sponsor |
| jJbl7YEfLmk | 2026-11-10 | 29 | 24분 | Signal Atlas | Which Claude Model Should You Use? A Practical Guide | 후보 | Claude 모델 선택 가이드. 조회 수 29 | - |
| B3XPxjdvf8Q | 2026-11-10 | 527 | 2분 | AI Full Stack Lab | Claude vs Codex vs Antigravity Built STEAL AN EGG in 1 Hour | 참고 | 모델 단독 시험이나 비코딩 과제 중심(애니메이션, 게임, 웹사이트, 트레이딩 등) | - |
| chr5gsSNDWE | 2026-11-10 | 98 | 17분 | Sonny Labs | Claude Code, Codex, Cursor, OpenClaw, Pi: Choosing an AI Agent Harness | 후보 | 에이전트 하네스 선택 가이드(11월). 소형 채널 | affiliate,sponsor |
| 1NMRKNwcJC0 | 2026-11-10 | 13962 | 7분 | 코난쌤 conanssam | [속보] Gemini 4 Carbon 정식 출시｜활용 사례 7분 총정리 | 제외 | 모델 출시 소식과 요약 | - |
| CXIy3PWMsV0 | 2026-11-10 | 318 | 10분 | 뉴럴서랍 | 구글이 2주 만에 또? 제미나이 4 카본 쉽게 정리 - 해킹 막는 AI, 왜 아무나 못 쓸까 | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| q5Ka21skdPs | 2026-11-10 | 2442 | 7분 | 브릿지AI에듀 | Claude Fable 5.2 vs Gemini 4 Carbon 비교 / 하루 사이 나온 두 최상위 모델, 내 요금제로 쓸 수 | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| sUcvhFGc4mw | 2026-11-09 | 24937 | 41분 | Google Cloud Tech | How Gemini 4 Argon & Carbon were built (ft. DeepMind’s Head of Gemini  | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| UChuafFEalg | 2026-11-09 | 6152 | 11분 | Mervin Praison | Claude Fable 5.2 vs Opus 5.5: What It REALLY Costs | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| SsSKJA0EHD4 | 2026-11-09 | 147006 | 21분 | Peter Yang | I Tested Fable 5.2 vs Opus 5.5 (Full Breakdown) | 참고 | 모델 단독 시험이나 벤치마크 비교 | .app |
| 7cx2unMXBYY | 2026-11-09 | 18482 | 5분 | DIY Smart Code | Claude Fable 5.2 Release vs Opus 5.5: Don't Pay for Max Effort | 참고 | 모델 단독 시험이나 벤치마크 비교 | affiliate,community,discount,hostinger |
| 9ZxdXEd1pZw | 2026-11-09 | 199250 | 3분 | Tensaikun | Claude Fable 5.2 vs Opus 5.5 Make an Animated Video From Scratch | 참고 | 모델 단독 시험이나 비코딩 과제 중심(애니메이션, 게임, 웹사이트, 트레이딩 등) | - |
| Czy26e6Lhpg | 2026-11-09 | 3556 | 7분 | Coding Crash Courses | Claude Fable 5.2 Benchmarks: Worth Twice the Price? | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| Z6FWcaCD8Es | 2026-11-09 | 14382 | 11분 | Hostinger Academy | Codex vs Claude Code - One Prompt, Who Wins? (2026 FULL Comparison) | 후보 | Codex vs Claude Code 같은 프롬프트 비교. 호스팅 업체 스폰서 | community,hostinger |
| KxkHcfgYSus | 2026-11-07 | 35177 | 3분 | Tech Ai | AgentGit Tutorial: Share and Resume AI Coding Workflows (Claude Code,  | 후보 | Claude Code, Codex 작업 공유와 재개 도구 소개 | - |
| ViDXvJ1dlno | 2026-11-06 | 1108 | 4분 | Phúc Nguyễn Vlog | Free ChatGPT in VS Code: GPT 6 Astra for Free - Unlimited | 제외 | 홍보 또는 클릭 유도 성격(채널 패턴, 제목의 FREE, Unlimited 등) | affiliate,sponsor |
| OBoD65nbPuE | 2026-11-06 | 107 | 7분 | Nyxo | Claude Code Skills & Subagents: Full Tutorial (Build Your Own AI Team) | 후보 | Claude Code 스킬과 하위 에이전트 튜토리얼. 소형 채널 | - |
| g_C-jhweR-k | 2026-11-05 | 4733 | 8분 | Julian Goldie SEO | NEW Gemini 4 Argon + Antigravity Is INSANE! | 제외 | 홍보 또는 클릭 유도 성격(채널 패턴, 제목의 FREE, Unlimited 등) | community,course,skool |
| BQ8ptkZ4kdg | 2026-11-04 | 11494 | 13분 | Dante's Datalab | Herdr 데스크톱으로 멀티 에이전트 오케스트레이션 / Hermes·Codex·Claude Code 한 화면에서 | 후보 | Herdr로 Hermes, Codex, Claude Code 한 화면 오케스트레이션. 도구 소개 성격. 미정독 | - |
| cIGRF-acSzs | 2026-11-04 | 38667 | 9분 | 챗대리의 AI연구소 | 멀티 에이전트 쓰지 마세요.. (실제 테스트 결과) | 정독 | 추가 정독. Sonnet 5.5, Opus 5.5 단독 vs 5역할 팀 vs 리뷰어 1명, 실서비스 과제 실측(반대 근거) | - |
| GGWyDIrNSD8 | 2026-11-03 | 25723 | 8분 | Dom the AI Tutor | Claude Fable 5.2 Coded These Animations (vs Astra, Gemini & Opus 5.5) | 참고 | 모델 단독 시험이나 비코딩 과제 중심(애니메이션, 게임, 웹사이트, 트레이딩 등) | - |
| eVRosuVwPxs | 2026-11-03 | 580 | 8분 | AI사업해부 | 제미나이 4 카본, 왜 방어 담당자에게 먼저 줬나 외부 평가 환각률 11% | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| O_hDTzkByG0 | 2026-11-03 | 38762 | 12분 | 허드의 AI딸깍 | 멀티에이전트, 진짜 쓸모 있을까? | 후보 | 멀티 에이전트 효용 검토 한국어 12분. 미정독 | - |
| gwtNn2cFPqc | 2026-11-02 | 33827 | 17분 | Julian Goldie SEO | Antigravity + Gemini 4 Argon Is CRAZY! 🤯 | 제외 | 홍보 또는 클릭 유도 성격(채널 패턴, 제목의 FREE, Unlimited 등) | skool |
| pMTdySOUNcQ | 2026-11-02 | 70869 | 31분 | 조코딩 JoCoding | AI뉴스 - Gemini 4 Carbon, 검색의 종말, 앤트로픽 S1, GPT-6.1 테라, Subvocal, LFM3, a | 제외 | 모델 출시 소식과 요약 | 멤버십,할인 |
| I2nYuAGWuLs | 2026-10-31 | 1247 | 20분 | Salesforce Apex Hours | Multi Agent Orchestration in Salesforce | 제외 | Salesforce 멀티 에이전트, 코딩 아님 | - |
| M1ZjvZwlhMQ | 2026-10-31 | 1178 | 13분 | The Token Desk | Claude Code vs Codex vs Cursor vs Antigravity: Which Plan to Pick | 후보 | Claude Code, Codex, Cursor, Antigravity 요금제 비교 | - |
| nLkeklttiRs | 2026-10-31 | 924 | 7분 | 제로빌더 / AI 네이티브 | 클로드 코드 대신 제미나이 4 카본? / 코딩 62점 대 59점 | 참고 | 모델 단독 시험이나 벤치마크 비교 | 할인 |
| Ptq4ZjJmqEw | 2026-10-31 | 13892 | 14분 | 모냐구 | 제미나이 4 카본, 1위 AI를 왜 아무나 못 쓰나? 코드 한 줄에서 갈라지는 '공격'과 '패치' | 참고 | 모델 단독 시험이나 벤치마크 비교 | community |
| cLbzOsQsHeI | 2026-10-30 | 497 | 8분 | Manjarul Ch / AI Autom | How to Use Claude Code and ChatGPT Codex Together (Full Setup) | 후보 | Claude Code와 Codex 병행 설정. 소형 채널 | - |
| VnoUZjrPIHQ | 2026-10-29 | 187 | 3분 | 테크감도 | Gemini 4 Carbon (제미나이4 카본)- 복잡한 코딩, 문제해결 능력 | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| yTEP4M1h95g | 2026-10-29 | 19921 | 12분 | 투더제이 TTJ / AI·코딩 수익화 | 제미나이 4 카본 미친 성능과 가격,  AI 1위 클로드를 꺾었다. 그런데 가격은 절반? | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| 2yK5xWVdH8M | 2026-10-28 | 597 | 2분 | AI Full Stack Lab | Claude vs Codex vs Antigravity: Who Builds the Best Fortnite? | 참고 | 모델 단독 시험이나 비코딩 과제 중심(애니메이션, 게임, 웹사이트, 트레이딩 등) | - |
| slWbqtH5PSk | 2026-10-28 | 1558 | 1분 | David Kahl | How I Set Up Claude Code, Codex & Antigravity in One VS Code Window | 후보 | VS Code 한 창에 세 도구 설정. 1분 | community |
| G2gWaFdeV8M | 2026-10-28 | 719 | 7분 | The Token Desk | Claude Code vs Codex: Even Their Makers' Judges Chose Antigravity | 후보 | Claude Code vs Codex vs Antigravity 판정 비교. 짧고 조회 수 낮음 | community |
| pQ_Dnr9Q4k8 | 2026-10-28 | 29932 | 2분 | Google for Developers | Functional smart devices using Gemini 4 Argon and Google Antigravity | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| 7lmsf25DgPM | 2026-10-26 | 14208 | 10분 | Nick Ponte | Google's Gemini 4 Argon + Antigravity: What Can It Really Build From O | 참고 | 모델 단독 시험이나 벤치마크 비교 | affiliate,join my community |
| DIFo-GgELig | 2026-10-26 | 123 | 1분 | Stoic Soft | Run Claude Code, Codex and Gemini as One Team - 1DevTool Orchestration | 후보 | Claude, Codex, Gemini 한 팀 오케스트레이션. 도구 홍보 성격, 1분 | - |
| SVdby-KF7iY | 2026-10-25 | 66 | 1분 | 시니어백과 | 개발 오류 잡는 구글 제미나이 4 카본 실전 코딩 활용법 | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| AIDnOeHHng8 | 2026-10-24 | 67 | 8분 | Aizo | Claude Opus, Sonnet and Haiku vs the Free Models | 참고 | Claude 3종 vs 무료 모델 비교, 소형 채널 | - |
| 8QgBcI40VC8 | 2026-10-23 | 169874 | 7분 | Better Stack | The Best Agent IDE I've ever used (Orca) | 후보 | Claude Code, Codex를 한 IDE에서 병렬 운용(Orca). 도구 소개 성격 | community |
| 4BDNTubxwP4 | 2026-10-22 | 10886 | 13분 | G-CREATOR | 클로드 코드에 코덱스를 붙였더니? AI가 서로 검증합니다 (Claude Code × Codex) | 정독 | 추가 정독. Claude Code에 Codex 공식 플러그인을 붙여 교차 검증하는 혼합 벤더 흐름 | - |
| -Fj8hMkNOvc | 2026-10-22 | 29921 | 61분 | 단테 | 에이전트 워크플로우 최강 도구 Herdr 완벽 가이드 / Claude Code·Codex 동시에 쓰기 (1시간 무료 강의) | 참고 | 모델 단독 시험이나 벤치마크 비교 | course,강의 |
| F3AdCP6uwGk | 2026-10-19 | 11451412 | 0분 | Google Gemini | Build a Playable 3D Game with Gemini 4 Argon and Google Antigravity in | 제외 | 벤더 공식 마케팅 데모 | community |
| SBYCw-oHjlQ | 2026-10-18 | 153358 | 21분 | Mikey No Code | Gemini 4 Argon Full Tutorial for Beginners: How to Use (Like a Pro) | 참고 | 모델 단독 시험이나 벤치마크 비교 | .app,arcade,skool |
| nWVlVKwelNI | 2026-10-17 | 25758 | 8분 | Julian Goldie SEO | Gemini 4 Argon + Antigravity Is Absolutely INSANE! | 제외 | 홍보 또는 클릭 유도 성격(채널 패턴, 제목의 FREE, Unlimited 등) | community,course,skool |
| mKjxGy6vCnY | 2026-10-16 | 143088 | 18분 | Chase AI | The SECRET Claude Code Upgrade That Has Everyone Going Nuts (Full Guid | 후보 | Claude Code 업그레이드 가이드. 모델 혼합 여부 미확인 | community,skool |
| xq6S6g6BWnc | 2026-10-16 | 90026 | 21분 | Jack Roberts | New Gemini 4 Argon vs Opus 5.5 Building the Same App (Raw Results) | 참고 | 모델 단독 시험이나 벤치마크 비교 | community,course,join my community,spons |
| nSwmcs37Jd4 | 2026-10-15 | 39302 | 1분 | Google for Developers | Gemini 4 Argon in Antigravity | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| jEOUUAPC1sc | 2026-10-15 | 102240 | 30분 | Greg Isenberg | Make cool things with AI that people buy (Gemini 4 Argon) | 제외 | 창업 아이디어 제작, 코딩 에이전트 선택 근거 아님 | - |
| pHtYe9ZqxaA | 2026-10-15 | 1609 | 1분 | AI로 시드 모으는 중 | 클로드 코드에 AI 직원 뽑는 법 (서브에이전트, 파일 하나면 끝) | 후보 | 하위 에이전트 파일 정의 한국어 숏 | - |
| pPTsaD0B4X4 | 2026-10-14 | 50 | 6분 | MUHAMMAD ZAIN UL ABIDI | Claude Haiku 5.5 in Claude Code: Cut AI Coding Costs 20x | 제외 | 홍보 또는 클릭 유도 성격(채널 패턴, 제목의 FREE, Unlimited 등) | - |
| o-vqgLUUBaw | 2026-10-14 | 28087 | 39분 | Google Antigravity | Google Antigravity Livestream: Behind the Product and Gemini 4 Argon | 제외 | 벤더 공식 마케팅 데모 | - |
| KGHaOmKHDjw | 2026-10-14 | 20601 | 6분 | AI with Surya | Gemini 4 Argon is very Impressive | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| WP4bC8sTIN8 | 2026-10-13 | 19128616 | 2분 | Google Antigravity | Multi-Agent Localization with Gemini 4 Argon | 제외 | 벤더 공식 마케팅 데모 | - |
| 1dAcJEIlQM8 | 2026-10-13 | 15856635 | 2분 | Google Antigravity | Gemini 4 Argon: 3D World in Blender | 제외 | 벤더 공식 마케팅 데모 | - |
| T2Wfds62ZjM | 2026-10-13 | 19822940 | 2분 | Google Antigravity | Building Real-Time Animation with Gemini 4 Argon | 제외 | 벤더 공식 마케팅 데모 | - |
| biOWEPYyS5c | 2026-10-13 | 19871783 | 2분 | Google Antigravity | Gemini 4 Argon: Modernizing 40 year code | 제외 | 벤더 공식 마케팅 데모 | - |
| YSYpxqXhiTY | 2026-10-13 | 17170 | 3분 | Smitha Kolan - Machine | Gemini 4 Argon in Antigravity: Long-Horizon Reasoning & Agent Security | 참고 | 모델 단독 시험이나 벤치마크 비교 | course |
| OYp5j2RihPE | 2026-10-13 | 177411 | 1분 | Google for Developers | Gemini 4 Argon and Google Antigravity: From 2D concept to 3D cathedral | 참고 | 모델 단독 시험이나 비코딩 과제 중심(애니메이션, 게임, 웹사이트, 트레이딩 등) | - |
| T4PC_yrNSl4 | 2026-10-13 | 59669 | 11분 | Telusko | Gemini 4 Argon + Antigravity: 20K-Line Rust App | 참고 | 모델 단독 시험이나 벤치마크 비교 | community,coupon,course,discount |
| opNsprLPCKc | 2026-10-13 | 20551 | 2분 | Google Cloud | Hands on with Gemini 4 Argon | 제외 | 벤더 공식 마케팅 데모 | - |
| gRhM1h10T3U | 2026-10-13 | 357850 | 12분 | Google Cloud Tech | Gemini 4 Argon: 10 incredible AI demos (1M token output in action) | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| ftkic7Tdpcg | 2026-10-13 | 1053162 | 2분 | Google DeepMind | Using Gemini 4 Argon to protect against Cyber attackers | 제외 | 벤더 공식 마케팅 데모 | - |
| Xy2FkHoR4Vc | 2026-10-13 | 97294 | 135분 | BridgeMind | Vibe Coding With Gemini 4 Argon | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| 02k-qEC1nk0 | 2026-10-12 | 106 | 8분 | Krumbs / AI Explained  | Claude Code Subagents: Is the Opus + Haiku Savings Claim Real? | 후보 | Opus 지휘 + Haiku 하위 절감 주장을 문서와 대조. 정독 차순위, 소형 채널 | - |
| kfLrpLl3NMc | 2026-10-11 | 712 | 11분 | AI Dive | Your Claude Code Subagents Skip Haiku 5.5. 2 Files Fix That | 후보 | 하위 에이전트가 Haiku 5.5를 안 쓰는 문제와 설정 수정. 소형 채널 | - |
| -ZJ_xK5dMpQ | 2026-10-11 | 34 | 5분 | ParseAI | Make Claude Code 26x Cheaper With One Change | 제외 | 홍보 또는 클릭 유도 성격(채널 패턴, 제목의 FREE, Unlimited 등) | coupon |
| Ug3x37N6Z_E | 2026-10-09 | 430165 | 15분 | Dubibubi | Can an Army of Claude Haiku 5.5 Subagents Beat Opus 5.5? | 정독 | 같은 방식의 Opus 5.5 + Haiku 5.5를 단독 Opus와 3개 과제로 비교 | community,skool |
| -5Znwa-G35g | 2026-10-08 | 39598 | 18분 | ByteGrad | GPT-6 Astra vs GPT-6.1 Sol - STOP Wasting Your Usage Limit | 참고 | 모델 단독 시험이나 비코딩 과제 중심(애니메이션, 게임, 웹사이트, 트레이딩 등) | affiliate,arcade,course,plug.dev,sponsor |
| luf5RgfpzSA | 2026-10-08 | 109956 | 7분 | AI EXPLORE | GPT-6.1 Sol Is Here - Near GPT-6 Astra Performance for Less? | 제외 | 모델 출시 소식과 요약 | course,discount,sponsor |
| 3lIhvC1h-9Y | 2026-10-08 | 814 | 4분 | Nick Babich | Claude Haiku 5.5: The Most Underrated Claude Model Just Got a Major Up | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| i1yOt0HmON4 | 2026-10-08 | 194 | 15분 | The Output | We Tested Claude Haiku 5.5 Against Sonnet and Opus | 후보 | Haiku 5.5 vs Sonnet vs Opus 시험. 소형 채널 | - |
| k3fArbXUzQM | 2026-10-08 | 766 | 8분 | Keystone AI Protocols | Why Google Antigravity & Gemini 4 Argon Make Single AI Prompts Obsolet | 참고 | 모델 단독 시험이나 벤치마크 비교 | community,discount,skool |
| 0y-N-jhiPDs | 2026-10-08 | 43276 | 3분 | MINDUNG | 개발자들이 코덱스에서 다시 클로드로 돌아가는 진짜 이유 | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| gOZVEAtPnp8 | 2026-10-08 | 993 | 9분 | 단테 | Claude Code·Codex를 뜯어 본 논문, 90줄 에이전트를 직접 돌려 봤습니다 | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| jlj7MtNn3to | 2026-10-05 | 189 | 8분 | Tech Uncovered | Gemini CLI vs Claude Code vs Codex CLI - Best FREE AI Coding Assistant | 참고 | Gemini CLI, Claude Code, Codex CLI 무료 티어 비교, 소형 채널 | - |
| Mky9VkY27sY | 2026-10-04 | 964 | 7분 | RainyTech | GPT-6.1 Sol vs GPT-6 Astra: Same Power for $2 Instead of $10? | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| PDPuo2Z6scc | 2026-10-04 | 474 | 2분 | AI Full Stack Lab | Claude Code vs Codex vs Antigravity: 3 AIs Built a Haunted City Game F | 참고 | 모델 단독 시험이나 비코딩 과제 중심(애니메이션, 게임, 웹사이트, 트레이딩 등) | .app |
| M5KOgtk9VfI | 2026-09-30 | 492433 | 20분 | Make Form | I Gave GPT-6 Astra Control of FreeCAD (It Designs Like an Engineer) | 제외 | FreeCAD 설계, 코딩 아님 | - |
| J-i0LMEMK_Y | 2026-09-30 | 1865 | 3분 | AI Full Stack Lab | Claude Code vs Codex vs Antigravity - I Asked 3 AI Agents to Build the | 참고 | 모델 단독 시험이나 비코딩 과제 중심(애니메이션, 게임, 웹사이트, 트레이딩 등) | .app,arcade |
| vIgeZTEolVw | 2026-09-29 | 2274 | 4분 | Seb Moska | Sonnet 5.5 vs Opus 5.5: Which One Should You Use in Claude Code? | 후보 | Claude Code에서 Sonnet 5.5 vs Opus 5.5 선택 | - |
| 08wKJgoc7Ac | 2026-09-29 | 451 | 7분 | Manjarul Ch / AI Autom | How To Use Subagents in Claude Code Like a Pro | 후보 | Claude Code 하위 에이전트 튜토리얼 | - |
| eg_1NXDcoPk | 2026-09-28 | 139877 | 17분 | Nate Herk / AI Automat | I Gave GPT 6 Astra $10,000 to Trade Stocks...And This Happened | 제외 | 주식 매매, 코딩 아님 | hostinger,skool,sponsor |
| s5nkj-L2vAw | 2026-09-28 | 14535647 | 0분 | Claude | Introducing Claude Sonnet 5.5 | 제외 | 벤더 공식 마케팅 데모 | - |
| 674zmjTtNdE | 2026-09-26 | 3020 | 18분 | Alex Volkov from Thurs | GPT-6 Sol vs Astra: which one should you actually use? | 후보 | GPT-6 Sol vs Astra 선택 기준 | - |
| NUsPCwb-ScY | 2026-09-25 | 8177 | 16분 | BitBiasedAI | GPT-6 Sol Is INSANE… 5X Cheaper Than GPT-6 Astra! | 참고 | 모델 단독 시험이나 벤치마크 비교 | discount |
| -zeUl3-Onl4 | 2026-09-25 | 9262 | 11분 | Travis Automates | VS Code AI Agent Setup 2026: Claude Code, Codex & Antigravity | 후보 | VS Code에서 세 도구 설정 | community,skool |
| Zvy--4U146M | 2026-09-24 | 26303 | 14분 | AI Coding Daily | I Tested NEW GPT-6-Sol and GPT-6-Luna on 144 Coding Prompts | 정독 | GPT-6 Sol, Luna를 effort별로 24개 프롬프트 반복 측정 | - |
| -nYnLDA0Vf0 | 2026-09-24 | 3768 | 18분 | TeqTalk | Multi Agent Orchestration Explained in 18 Minutes | 후보 | 멀티 에이전트 일반 설명 | .app |
| eF3yeJuifoQ | 2026-09-23 | 211278 | 34분 | Nate Herk / AI Automat | I Tested Opus 5.5 vs. GPT-6 Sol on 10 Real Use Cases | 참고 | 모델 단독 시험이나 벤치마크 비교 | course,hostinger,skool,sponsor |
| GmLcJVzkxPA | 2026-09-23 | 165058 | 42분 | Nate Herk / AI Automat | I Tested Opus 5.5 vs. GPT-6 Astra on 12 Real Use Cases | 참고 | 모델 단독 시험이나 벤치마크 비교 | course,hostinger,skool,sponsor |
| a6e_lTGRnwo | 2026-09-23 | 568 | 2분 | Mule Ace Academy | Claude Opus 5.5 vs GPT-6 Astra vs GPT-6 Sol - Which Should You Use? | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| vUjAgGa8tAU | 2026-09-23 | 81577 | 23분 | Dubibubi | I Made Claude Opus 5.5 & GPT 6 Astra Build the Same App (Raw Results) | 참고 | 모델 단독 시험이나 벤치마크 비교 | community,skool |
| U_sjnF3jvCo | 2026-09-22 | 73808 | 5분 | Chase AI | GPT 6 Sol & Luna Are Here (And 50% CHEAPER!) | 제외 | 모델 출시 소식과 요약 | community,skool |
| lPNgeaF2Nk4 | 2026-09-22 | 78168 | 4분 | Paul J Lipsky | GPT-6 Sol Is Here (50% Cheaper!) | 제외 | 모델 출시 소식과 요약 | - |
| QzTkVaC-da4 | 2026-09-19 | 121159 | 14분 | Jay E / RoboNuggets | 24 Hacks to Solve GPT-6 Astra Usage Limits (in 15 mins) | 참고 | 모델 단독 시험이나 비코딩 과제 중심(애니메이션, 게임, 웹사이트, 트레이딩 등) | .app,affiliate,community,skool |
| XgMhU4CE-lQ | 2026-09-19 | 187718 | 11분 | Sharbel A. | Paste This Into GPT-6 Astra, Never Run Out Of Tokens Again | 참고 | 모델 단독 시험이나 비코딩 과제 중심(애니메이션, 게임, 웹사이트, 트레이딩 등) | - |
| bjDDsdSfun8 | 2026-09-18 | 61558 | 12분 | Jack Roberts | I Built JARVIS with GPT-6 Astra… It's Insane | 제외 | JARVIS 제작, 코딩 에이전트 선택 근거 아님 | skool |
| 63KRIQYKY0E | 2026-09-18 | 79717 | 8분 | Jay Choi / 인디해커 라이프 | 클로드 코드 1000시간 쓰고 GPT로 넘어간 후기 | 후보 | Claude 1000시간 사용 후 GPT로 전환한 후기. 경험담. 미정독 | - |
| dcJzJCDrHsM | 2026-09-17 | 402 | 6분 | Code With K5KC | Claude's Model Family in 2026 - Haiku, Sonnet, Opus, Fable, and Mythos | 참고 | Claude 모델 가족 설명, 소형 채널 | - |
| GkIpNkCcfF4 | 2026-09-16 | 53567 | 18분 | Mikey No Code | How to Build Your First App with GPT 6 Astra In 18 Minutes | 참고 | 모델 단독 시험이나 벤치마크 비교 | .app,skool |
| TVNOTqv0n1k | 2026-09-16 | 145370 | 26분 | AI Pathways | How To Actually Use GPT-6 Astra For Trading (Everyone's Wrong) | 제외 | 트레이딩, 코딩 아님 | community,skool |
| ifz8NGHuHtY | 2026-09-14 | 342289 | 114분 | Riley Brown | 28 Insane Things Astra Can Do (2 Hour Course) | 참고 | 모델 단독 시험이나 비코딩 과제 중심(애니메이션, 게임, 웹사이트, 트레이딩 등) | - |
| sQwp9GrkGi4 | 2026-09-14 | 320313 | 18분 | Paul J Lipsky | GPT-6 Astra + ChatGPT Work Changes Everything | 제외 | 모델 출시 소식과 요약 | sponsor |
| vKRwpWbpW_E | 2026-09-11 | 2846 | 12분 | Brodie Legget | GPT-6 Astra vs GPT-5.6 Sol: Is It Worth Upgrading? | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| G-FpN6_uoug | 2026-09-11 | 43007 | 11분 | Eric Michaud | GPT 6 Astra Has A Usage Problem (Solved) | 참고 | 모델 단독 시험이나 비코딩 과제 중심(애니메이션, 게임, 웹사이트, 트레이딩 등) | course,hostinger,skool |
| gscSpnNKA5w | 2026-09-11 | 1108 | 19분 | Tito Space | How to Build Multi-Agent Systems in Antigravity (Copilot + Claude Inte | 후보 | Antigravity 멀티 에이전트(Copilot + Claude 연동) | - |
| 5EhrMJ9HIfU | 2026-09-10 | 173811 | 17분 | Chase AI | You're Using GPT 6 Astra Wrong (Here's How to Fix It) | 참고 | Astra 사용법 팁 | community,skool |
| nHBNa2IKWvk | 2026-09-10 | 209565 | 19분 | Stefan 3D AI | You're Using GPT-6 Astra Wrong - This Setup Is Insane | 참고 | Astra 설정 팁 | course |
| eVBJIUxv8N8 | 2026-09-08 | 581202 | 5분 | Two Minute Papers | GPT-6 Astra Changes Everything | 제외 | 모델 출시 소식과 요약 | - |
| OQipTxv9Qv0 | 2026-09-08 | 127800 | 17분 | Mark Kashef | I Tested Every GPT-6 Astra Effort Level. Here’s What I’d Use | 참고 | 모델 단독 시험이나 벤치마크 비교 | skool |
| dQudtNmDjJw | 2026-09-08 | 119957 | 7분 | Codex Community | OpenAI GPT 6 Astra Web Design is Insane! | 참고 | 모델 단독 시험이나 비코딩 과제 중심(애니메이션, 게임, 웹사이트, 트레이딩 등) | community,course,sponsor |
| Ju41cQSe7hY | 2026-09-07 | 765978 | 23분 | Riley Brown | I Spent 100 Hours Using GPT-6 Astra (This Feels Like AGI) | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| TLQLfa7yH4I | 2026-09-07 | 589745 | 17분 | Nate Herk / AI Automat | I Turned GPT-6 Astra Into a 24/7 Stock Trader (tutorial) | 제외 | 주식 트레이더, 코딩 아님 | hostinger,skool,sponsor |
| KebgB_cgDgM | 2026-09-07 | 187464 | 63분 | Julian Goldie SEO | GPT 6 Astra AI Full COURSE 1 HOUR (Build & Automate Anything) | 제외 | 홍보 또는 클릭 유도 성격(채널 패턴, 제목의 FREE, Unlimited 등) | community,course,skool |
| yysILVsfLFM | 2026-09-07 | 242210 | 19분 | Nate Herk / AI Automat | I Turned GPT-6 Astra Into the Ultimate AI Second Brain | 제외 | 개인 지식 관리, 코딩 아님 | hostinger,skool,sponsor |
| DoXEpKaIMRE | 2026-09-07 | 2191 | 3분 | Dev xịn | Codex vs Claude Code vs Antigravity - Ai Xứng Đáng Đồng Tiền Của Dev? | 후보 | Codex vs Claude Code vs Antigravity. 베트남어 | - |
| pu77fT3Z4I4 | 2026-09-07 | 1226 | 4분 | Duo Talks AI | This FREE Tool Lets You Use Claude, Codex, Gemini & DeepSeek Together  | 후보 | Claude, Codex, Gemini, DeepSeek를 함께 쓰는 무료 도구 소개. 도구 홍보 성격 | - |
| ZanDMmlWSzk | 2026-09-06 | 36763 | 16분 | AI Coding Daily | I Tested NEW GPT-6-Astra on Coding Benchmarks | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| 1qGH6NwTj3o | 2026-09-06 | 403821 | 27분 | AI News & Strategy Dai | GPT-6 Astra Doesn't Need Your Instructions Anymore. | 제외 | 모델 출시 소식과 요약 | .app |
| WfJPBVXPt8k | 2026-09-06 | 404646 | 38분 | Nate Herk / AI Automat | I Tested GPT-6 Astra vs Fable 5.1 on 15 Real Use Cases | 참고 | 모델 단독 시험이나 벤치마크 비교 | hostinger,skool,sponsor |
| gIlSJHRRoj0 | 2026-09-06 | 11707 | 34분 | Matthew Devaney | Multi-Agent Workflows In Copilot Studio | 제외 | Copilot Studio 멀티 에이전트, 코딩 아님 | - |
| 76gS56Bnhjg | 2026-09-06 | 99102 | 10분 | Lex Clips | Best AI model for coding: Fable vs Opus 5 vs Sol vs Grok vs DeepSeek / | 후보 | DHH 인터뷰 발췌. 코딩 모델 의견이며 실측 아님 | discount,sponsor |
| XeMtZeXxHqw | 2026-09-05 | 424702 | 20분 | Chase AI | I Tested GPT 6 Astra vs Fable 5.1 (No Hype Assessment) | 참고 | Astra vs Fable 5.1 15개 과제. Fable 5.1은 이전 버전 | community,skool |
| tU-fO6cADvQ | 2026-09-05 | 56881 | 16분 | Mark Kashef | GPT-6 Astra’s Computer Use Is Ridiculously Good | 참고 | 모델 단독 시험이나 비코딩 과제 중심(애니메이션, 게임, 웹사이트, 트레이딩 등) | skool |
| EvCMaE94p1g | 2026-09-04 | 231262 | 177분 | BridgeMind | Vibe Coding With GPT 6 Astra | 참고 | 모델 단독 시험이나 벤치마크 비교 | - |
| XvmixEXPT3Q | 2026-09-04 | 480771 | 11분 | Caleb Writes Code | GPT-6 Astra.. full analysis.. | 참고 | Astra 분석 | sponsor |
| bOC3DisEOfg | 2026-09-04 | 1255356 | 3분 | OpenAI | Introducing GPT-6 Astra for developers | 제외 | 벤더 공식 마케팅 데모 | - |
| Q1Pm9lUyW8E | 2026-09-04 | 34273 | 8분 | Julian Goldie SEO | NEW GPT-6 Astra Just Changed Everything! | 제외 | 홍보 또는 클릭 유도 성격(채널 패턴, 제목의 FREE, Unlimited 등) | community,course,skool |
| uCWHdk5f4bI | 2026-09-04 | 948 | 27분 | Tengency AI / 10x Your | Multi-Agent Orchestration in 27 Minutes (4 Live Demos) | 후보 | 멀티 에이전트 데모 4건. 벤더 불명확 | - |
| wtYHTJvMdAw | 2026-09-04 | 652 | 7분 | Super Lazy Coder | Codex vs Claude Code vs Antigravity 2.0 - Which AI Wins | 후보 | Codex vs Claude Code vs Antigravity 2.0. 소형 채널 | - |
| i9BLZiKzZ2o | 2026-09-03 | 10338 | 36분 | 후츠릿 - AI 자동화로 삽질 줄여주는  | Claude Code vs Codex 최강 조합 / Orca 멀티에이전트 경쟁 패턴 | 정독 | Claude Code와 Codex를 같은 작업에 경쟁시키고 병합하는 혼합 벤더 흐름 | 강의,멤버십,쿠폰,패스트캠퍼스 |
| eo0As3rieA8 | 2026-09-02 | 79742 | 26분 | 0xSero | Best AI agent harnesses and how I use them (pi, omp, Zcode) | 후보 | 하네스별 사용법. 모델 분담과 advisor 루프 구간 있음. 정독 차순위 | - |
| hMQgNAksgHw | 2026-09-01 | 28254 | 7분 | Serop / AI Automation | I Tested Google Antigravity vs Claude Code (Honest Results) | 참고 | 모델 단독 시험이나 벤치마크 비교 | skool |

## 부록 B. 날짜로 제외한 목록(2026-09-01 이전, 107건)

모두 9월 1일 이전 업로드라 제외했다. 모델 세대 확인은 하지 않았다.

| ID | 업로드 | 조회 수 | 채널 | 제목 |
|---|---|---|---|---|
| seWpr3HgXM4 | 2026-08-31 | 76914 | 코딩알려주는누나 | 코덱스로 바이브코딩 하는 법 부터 클로드와 비교,  최종 추천까지! |
| frnzlNhzNb0 | 2026-08-29 | 1832 | 방구석컴퍼니 | 클로드코드·Codex·안티그래비티, 하나만 쓴다면 / 점수 말고 성격·돈·다음 달 조건으로 골랐습니다 |
| sbuwHi1Sz6k | 2026-08-27 | 203161 | Tech With Tim | Codex vs Claude - an Honest Comparison |
| 3X0-Jia87LA | 2026-08-24 | 295 | AI and Beyond | Claude Agent SDK: Agentic Loops and Multi-Agent Orchestration |
| xxUbF6EPyfU | 2026-08-24 | 5766 | G-CREATOR | Claude Code(클로드 코드) 서브에이전트 1초컷! 순식간에 전문 비서 만든다! |
| U0YJ-ySOLLY | 2026-08-23 | 1094 | SECHNO | I Tested Claude Code vs Google Antigravity vs OpenAI Codex - Honest Re |
| oBuWXUy7stw | 2026-08-23 | 32144 | WorldofAI | Claude Code + Codex = AI GOD MODE! (Open source + Free) |
| k_Ty8yiBz98 | 2026-08-21 | 5695 | TechWhistle | Multi Agent Orchestration / Claude Certified Architect Foundations - 0 |
| bSpwsDM5pqo | 2026-08-18 | 133402 | CNV AI | AI 에이전트 만들기 1단계 / Codex·Claude·Gemini를 하나의 환경에서 쓰는 법 |
| JhKWfmmxYH4 | 2026-08-17 | 981 | Jonathan Acuña - Doc | Claude Code vs Codex vs Gemini / Which AI Is Best? |
| qWvJ3j91GTM | 2026-08-16 | 525 | Ali Code Journey | Is Claude Code REALLY Better Than Antigravity & Codex? I Gave 3 AI the |
| niOEns2ePg8 | 2026-08-15 | 561 | Bryan Software | Gemini 3.6 vs Claude Code vs Codex: Which Is Best for Coding? |
| hrdx4cVVzPY | 2026-08-13 | 763 | Bryan Software | Antigravity vs Claude Code vs Codex: Which Is Better? |
| bx7c6usBWPk | 2026-08-08 | 316 | Techknoowlogy | Claude Code vs Codex vs Antigravity: I Built the SAME Website with All |
| QER-0DaC-Gk | 2026-08-04 | 14617 | Owain Lewis | Build Your Own Coding Agent Like Pi (With 1 Prompt) |
| BM39OouLNsM | 2026-07-31 | 127082 | DSwithBappy | Build an End-to-End Multi-Agent AI System with LangGraph, MCP, Supervi |
| Zy7EXDONlTY | 2026-07-30 | 638440 | freeCodeCamp.org | Agentic AI - Complete Course for Beginners |
| ZDh1005AOtM | 2026-07-29 | 32686 | Sean Kochel | The EASIEST Way to Use Codex and Claude Code Together |
| qiDalcMeBFk | 2026-07-26 | 6539 | The Code City | How to Use Multi-Agent Workflows in Claude Code: Skills, Subagents & H |
| hcDz6yGT59M | 2026-07-21 | 22365 | techyoo | ORCA로 Claude, Codex AI 에이전트를 동시에 제어하는 방법 |
| tRi9g3urhyE | 2026-07-16 | 23592 | Eliot Prince | Claude Haiku vs Sonnet vs Opus vs Fable Clearly Explained (& use cases |
| 8i0HYZq98VI | 2026-07-14 | 14614 | 배움의 달인 (AI·자동화) | Orca IDE 완전정복 / Claude·Codex·Grok 동시에 돌리는 멀티 에이전트 오케스트레이션! |
| XMF4WCRCP_A | 2026-07-10 | 220 | InterSystems Develop | Multi-Agent Orchestration for Enterprise Workflows |
| ZVPlLaehjLk | 2026-07-09 | 144737 | IBM Technology | Agentic AI Frameworks Explained: Workflows, Multi-Agent, & Production |
| WAFUMBLOjHo | 2026-07-06 | 43973 | IndyDevDan | SEE CMUX SOLVE Multi-Agent Orchestration (Claude Code and Pi Agent) |
| GCd4Ft4tcMA | 2026-07-05 | 937 | AI Agent Lab | Multi-Agent Orchestration: The #1 Skill AI Engineers NEED in 2026 |
| Vza7WbT_2Bk | 2026-07-02 | 1101 | Jonathan Acuña - Doc | Claude Code Beginner to Advanced in 27 Minutes Using Claude, Codex, Gr |
| S3oWbc83By4 | 2026-06-24 | 1557 | CREATIVES SUMAN | Google Antigravity vs Claude Code vs Codex: One Clear Winner |
| xFLC2lCNHdo | 2026-06-24 | 2219 | React Conferences by | Claude Code, Codex, Gemini - parallel agents in one editor / Zed live  |
| tEAPnx4q0u8 | 2026-06-23 | 23 | Aetherlink | Agentic AI & Multi-Agent Orchestration in Enterprise 2026 / AetherLink |
| gL-qwdpyHMc | 2026-06-22 | 21 | AI탐험대 | 서브에이전트·플랜모드로 복잡한 작업 처리하기 - 클로드코드 제대로 쓰기 최종편 |
| Y3IFeghhT9Y | 2026-06-20 | 372 | Gdg Vaasa | Mastering Multi-Agent Orchestration with Google Cloud ADK / Build with |
| Mq_kiDmsrOA | 2026-06-17 | 34267 | WeekdayCode | 1인 개발자, 클로드코드를 버리고 코덱스로 갈아탄 이유 |
| oGE_Dwz-rMk | 2026-06-15 | 43933 | Cole Medin | Omnigent: The New Meta-Harness for EVERY Coding Agent - Claude Code, C |
| e18sdZLwP7o | 2026-06-09 | 100909 | Nate Herk / AI Autom | How to Build Claude Subagents Better Than 99% of People |
| AUQz5JAmtc4 | 2026-06-05 | 28708 | Ava - 凜 | " Claude Code " vs " Codex " vs " Antigravity "：到底怎麼選？ |
| n-ifKF4tn-4 | 2026-06-04 | 31667 | Visual Studio Code | Multi-agent patterns in VS Code you won't learn from docs / BRK201 |
| b4LscPd-c-Q | 2026-06-04 | 17691 | SHIFT AI ニュース | 【自動化が当たり前】初心者は「Claude Code」「Codex」「Antigravity」の中からこれだけ触れ！ |
| B8kSsEDk0TQ | 2026-05-29 | 11609 | AI with Avthar | My Multi-Agent Claude Code Setup (steal my workflows!) |
| _SbRR_dhBVU | 2026-05-29 | 31383 | Devsplainers | Google Antigravity vs Claude Code vs Codex: The Real Test |
| P4_iywFuKQc | 2026-05-28 | 15379 | 조코딩 JoCoding | 구글 부사장님께 직접 Claude Code, Codex에서 Antigravity로 갈아타야 하는 이유 물어봤습니다. |
| P_OO-Dkk4ws | 2026-05-28 | 6965 | 시스템빌더 개발곰곰 | 바이브코딩 실력 향상에 필수 /GOAL 기능 / 클로드코드 / 코덱스 / 제미나이 / 성능비교 / Gemini 3.5 / AI |
| 3dj9m90tbY8 | 2026-05-27 | 18099 | Build Great Products | Codex vs Claude Code vs Cursor vs Antigravity (My Honest Review) |
| r20NxDMe9pc | 2026-05-27 | 15916 | Jedi Trinupab | ศึกท้าชน ChatGPT Codex vs Claude Cowork vs Google Antigravity |
| RLjaUES9P8A | 2026-05-26 | 157666 | Nate Herk / AI Autom | 100 Hours Testing Claude Code vs ChatGPT Codex (honest results) |
| bToB46YkKKs | 2026-05-22 | 2965 | AgenticEngineering | Multi-Agent AI Orchestration Explained: 5 Frameworks Compared (May 202 |
| sJ5wks10tgA | 2026-05-20 | 5800 | AI 솔로프러너 랩 | Antigravity vs Claude Code vs Hermes, 최강 에이전트는? |
| RWT3sh68PWE | 2026-05-19 | 164153 | Warp | Introducing multi-agent orchestration |
| j1gWoZ5QAnE | 2026-05-19 | 910 | 패스트캠퍼스 | 바이브코딩 왕초보는 꼭 시청하세요 / 안티그래비티 vs 클로드코드 vs 커서 |
| xwBE67ILCTg | 2026-05-19 | 26967 | 바이브랩스 | 왜 개발자들은 클로드 코드를 떠나 코덱스로 향할까? |
| NqIUYJcyC80 | 2026-05-18 | 194 | Power Tech Speck (Gi | Multi Agent Orchestration - Copilot Studio User Group (21 April 2026 S |
| PIdETjcXNIk | 2026-05-18 | 70534 | IndyDevDan | Pi to Pi: Two-Way Agent Orchestration with the Pi Coding Agent |
| kB9iMD0EjT8 | 2026-05-18 | 82065 | Nate Herk / AI Autom | How to Use Your Claude Code Projects in Codex in 5 Mins |
| EDBZ7xkCvdo | 2026-05-16 | 16559 | Building Aeon | How to Setup Unity MCP with Claude Code, Codex & Gemini CLI |
| xCFbMXk5ul4 | 2026-05-16 | 18754 | Citizen Developer 9c | Claude Code vs Codex? 비교하지 말고 이렇게 쓰세요 |
| MPWKZzP-bQs | 2026-05-12 | 41917 | 개발동생 | 클로드코드 대박 신기능 Agent View / 멀티 에이전트 관리가 너무 쉽습니다 |
| Mg4WUTNM1hw | 2026-05-07 | 3022 | Ramanpal Singh - Kwe | Claude Code + Codex + Gemini CLI Working Together (Full Tutorial) |
| r6p6iFczeoI | 2026-05-06 | 12493 | Stack n Spark | Setup Multi-Agent Workflows in VS Code Github Copilot / Agent Orchestr |
| ZkGzEMDeJos | 2026-05-05 | 300680 | Paul J Lipsky | OpenAI Codex Explained for Normal People (“Claude Cowork Killer”) |
| f0hcByvsyjU | 2026-05-05 | 47310 | 메이커 에반 / Maker Evan | 클로드 코드 하나만 쓰면 이제 망합니다(feat. Codex) |
| 0DaddV-vRc4 | 2026-05-04 | 5581 | Tech Bridge | [한글자막] 끝났습니다… 클로드코드 vs 코덱스 논쟁이 마침내 종결되었습니다 |
| fWeTQyAxlWE | 2026-05-01 | 917 | Dylan Michael / AI A | I Made Claude Code 10X Smarter (Codex + Gemini) |
| vRYBG_R8JAI | 2026-04-29 | 85361 | ExamPro | Claude Architect: Multi-Agent Orchestration |
| ETvz1qhQDXE | 2026-04-29 | 52576 | Jack Roberts | Claude Code just got 10X Better (Codex + Gemini) |
| Ubv-Cf3nUzw | 2026-04-27 | 163 | TechWealth Hub | Claude Code vs Codex vs Gemini CLI: I Gave Them the Same Real Bug |
| Fu5KIG2Jm1g | 2026-04-26 | 55856 | Mark Kashef | You Can Run Claude AND Codex Together. Here's How. |
| xHr3m5COcVo | 2026-04-26 | 655 | 게이머TV | ClaudeCode(클로드코드) - SubAgent(서브에이전트) |
| I9lT8m0NoiU | 2026-04-22 | 1772 | TechWhistle | Multi-Agent Orchestration: Teams, Protocols & Worktrees Explained |
| F9zFdHG4YsQ | 2026-04-21 | 8887 | AI 하남자 | 💵코덱스 vs 클로드 코드, 아직도 고민이라면 이 영상 보세요 |
| sADhmL_q4CQ | 2026-04-20 | 4139 | 미국주부, Mompreneur Dia | 클로드 코드 vs 안티그래비티 강점 비교! AI 코딩 도구 200% 활용하는 '최강의 조합' 전략 |
| ke5bSL2LWb0 | 2026-04-17 | 5591 | 소스놀이터 | 멀티 에이전트 대시보드 - 여러 에이전트의 움직임을 정교하게 조율합니다 (클로드 코드 & 코덱스 동시 지원) |
| -5DPCDRHmKI | 2026-04-14 | 649 | Michael Negele | 3 AI Agents, 1 Terminal: Setting Up Claude, Gemini & Codex |
| 99VHENEKA9o | 2026-04-13 | 261789 | Nate Herk / AI Autom | 100 Hours Testing Claude Code vs Antigravity (honest results) |
| Qr3pyVpd8CY | 2026-04-12 | 81831 | Theuxlabs | 서브에이전트 모르면 클로드 코드 돈 버리는 겁니다 / EP.06 |
| nSqlRFRAZcA | 2026-04-09 | 3049 | Clearmud | From Zero to Vibe Coding in 10 Minutes (Claude Code + Gemini CLI + Cod |
| 2czYyrTzILg | 2026-04-08 | 64755 | AI Engineer | From Chaos to Choreography: Multi-Agent Orchestration Patterns That Ac |
| 4rN-UWKSmp0 | 2026-04-08 | 167212 | 헤이제임스, 플랫폼 하나 만들어줘 | Claude Code 비용 80% 절감하는 settings.json 3줄과 14만명이 쓰는 everything-claude-c |
| L7NPhaUBpZE | 2026-03-31 | 78055 | Chase AI | Claude Code + Codex = AI GOD |
| B2Kh_ZoLVTM | 2026-03-31 | 128569 | Nate Herk / AI Autom | Codex Just 10x’d Claude Code Projects |
| e8fpKMcXzQk | 2026-03-31 | 38854 | 코드팩토리 | OpenAI의 "제발 한입만": 클로드 코드에서 코덱스 공식 지원! |
| 9d9RQ74FMpQ | 2026-03-29 | 2579 | 마케팅 트루먼쇼 Marketing T | (가이드 무료) AI가 팀을 꾸려서 일한다?! 클로드 서브에이전트 핵심 정리 / 클로드 서브에이전트 |
| A3d3ZdNCqlk | 2026-03-28 | 1226 | LOADING_ | [Harness Review] Claude Code 멀티 에이전트 오케스트레이션: oh-my-claudecode |
| J5KTpq7hVn4 | 2026-03-18 | 116321 | Visual Studio Code | Multi-agent workflows in VS Code |
| tcRzFSExN0U | 2026-03-11 | 839 | Decoded AI | 코덱스 vs 클로드 코드: 최강의 코딩 AI 비교 분석 |
| NH_aFsqaFyA | 2026-03-09 | 14552 | 迈克 Mike Chong | $20/月 AI编程工具怎么选？Codex vs Claude Code vs Antigravity (2026年3月) |
| dRPMXOsuNAc | 2026-03-06 | 3355 | Fru Dev | Tmux + AI Coding Workflow: Manage Claude Code, Gemini & Codex in One T |
| qGm8odiBkBg | 2026-02-28 | 52725 | 짐코딩 | 클로드 코드 Agent Teams 완벽 정리 / Subagent와 차이점 |
| 8pT2pljLAp0 | 2026-02-23 | 702 | Cmd+AI | 2026 Is the Year of Agent Orchestration! Enter Oz Agents by Warp |
| v3m-QXMCZ6M | 2026-02-23 | 21966 | 오늘코드todaycode | 구글 안티그래비티 기본 설정 및 사용방법, 코덱스 앱, 클로드 코워크와 비교 Google Antigravity, Codex A |
| vFaesKP4g10 | 2026-02-19 | 65 | 오늘노트 | 클로드 코드의 서브에이전트와 스킬 아키텍처의 구조적 분석 |
| AX-JIsu92Ms | 2026-02-17 | 888 | CSharpCorner | Which AI Designs UI Best? Claude Code vs Codex vs Antigravity |
| ewwZ3dcjhBc | 2026-02-13 | 4096 | 투더제이 TTJ / AI·코딩 수익화 | 클로드 오퍼스 4.6 달라진점, 에이전트 팀과 서브 에이전트 비교, 클로드 코드 올인원 가이드북 무료 배포 |
| RpUTF_U4kiw | 2026-02-09 | 70121 | IndyDevDan | Claude Code Multi-Agent Orchestration with Opus 4.6, Tmux and Agent Sa |
| 2eqPBLgVH0U | 2026-02-09 | 287323 | 코딩알려주는누나 | 클로드 스킬, 서브에이전트, 커맨드 개념 몰랐던 사람 한번에 이해시켜드림 |
| BsAHunfVwNs | 2026-02-04 | 64958 | Visual Studio Code | Multi-agent development in VS Code |
| jjdkpTlPDJ0 | 2026-02-02 | 6494 | 헤이제임스, 플랫폼 하나 만들어줘 | 클로드 컨텍스트 85% 절감하는 서브에이전트 시스템 실전 활용법 |
| xYFcJT9XOIk | 2026-01-25 | 31727 | Bijan Bowen | Codex vs Claude Code vs Antigravity - Agentic Coding Comparison! |
| nJfqO5edMFk | 2026-01-10 | 6895 | Alex AI | AI들끼리 일하게 만들기 (Antigravity, Claudecode, GPT, Gemini, Codex) Multi LLM  |
| mItQTafhx_M | 2026-01-08 | 7439 | 엔드플랜 Endplan AI | 아직도 커서만 쓰세요? Antigravity vs Kiro vs Cursor vs Claude Code 비교 |
| sNI18nzwgn8 | 2025-12-24 | 92648 | Web Dev Cody | Claude Code Subagents are Absolutely Insane |
| sWH0T4Zez6I | 2025-12-15 | 117155 | IBM Technology | Multi Agent Systems Explained: How AI Agents & LLMs Work Together |
| ANEldLXatwM | 2025-11-30 | 2917 | Alex AI | Google Antigravity, Claude code, GPT5.1Codex Max 코딩 대결 소름돋는 결과 |
| oPUjTRvNunM | 2025-11-22 | 3778 | Alex AI | Gemini3 Antigravity VS GPT5.1 Codex-Max 비교 |
| hqzRzK7rIKk | 2025-11-21 | 217 | Travis Eric - AI Con | Vibe Coding Antigravity Gemini 3 x Claude Code Multi-agent Live (Teneo |
| HcDyc9N5JZI | 2025-09-07 | 214 | Jacob Chak | How to Manage All Your AI Coding CLI Agents at Once (Claude, Codex, Ge |
| DNGxMX7ym44 | 2025-07-25 | 305085 | Developers Digest | Claude Code NEW Sub Agents in 7 Minutes |
| Cvy9KzJT4ro | 2025-07-25 | 20845 | 코드팩토리 | 클로드 코드 커스텀 서브에이전트 신규 업데이트 |

## 부록 C. 날짜를 끝내 못 구한 목록(1건)

| ID | 제목 | 채널 | 조회 수 |
|---|---|---|---|
| UC_eVxIPHFZm7oF_gET0x-8Q | Google Antigravity | Google Antigravity | - |

## 부록 D. 키워드가 맞지 않아 제목만 보고 제외한 목록(115건)

제목이나 설명에 모델명, 도구명, 오케스트레이션 키워드가 없어서 날짜 조회를 하지 않았다.

- EsTrWCV0Ph4 | AI Agents Full Course 2026: Master Agentic AI (2 Hours)
- 0hUko6Fj9kc | My Entire AI Agent Setup (Claude Code + Dev Containers)
- eSP7PLTXNy8 | Build a proactive agent workflow with Claude Code
- iQyg-KypKAA | L8 Principal's Agentic Engineering Workflow
- AtaehXB4hPQ | Orchestrating Multiple Agents in VS Code with Ben & Peng
- WIW5hN-hApQ | AI Engineering Full Course / 10 Advanced Projects / LLMs, RA
- eT1F2BAZJ64 | 2026 The Year of Agent Orchestration
- -1K_ZWDKpU0 | Claude Code's Agent Teams Are Insane - Multiple AI Agents Co
- -BhfcPseWFQ | After This Video, You'll Actually Understand Agent Orchestra
- fJGa7xhJ8bs | How To Use Multiple Agents In Claude Code (2026) [Step By St
- 5gsBIv9wg0c | How to Run Multiple Agents in Cursor (2026)
- hTAWHgQI4xg | 5 Concepts to Know for Coding with AI Agents
- M30gp1315Y4 | One Agent Is NOT ENOUGH: Agentic Coding BEYOND Claude Code
- zcWXwVaizvM | Claude 4.7 Explained: Opus, Sonnet, Haiku (98.5% Accuracy, A
- Bj73yVdIdDw | Which Claude Model Should You Use? (Opus vs Sonnet vs Haiku 
- EstrsAlmxd4 | Haiku vs Sonnet vs Opus: Which Claude Model Should You Use? 
- 2NccSbOqjGU | How to Switch Claude Models (Haiku, Sonnet & Opus)
- 8nA5tXVxdXU | Claude Models Explained: When to Use Haiku, Sonnet & Opus
- qTb6vaD4_Xw | The Secret to Choosing the Right Claude Model: Opus, Sonnet 
- 7CpcDL53QFM | Claude Code Opus vs Sonnet: Which Model to Use
- hBU0WpTTbes | Claude Code: Sonnet + Opus + Haiku. A Smarter AI Agent Setup
- LPdD-Ima4UY | Claude 3.5 Opus, Sonnet, and Haiku explained / Dario Amodei 
- aA9KP7QIQvM | Claude HAIKU 4.5 is LIGHT SPEED Agentic Coding… BUT can it B
- YMUsjQoDPYI | Opus vs Sonnet vs Haiku in Claude Code: Same Score, 24x the 
- Dqf1Pt2alY0 | Claude Haiku 4.5 is My Best Model in GitHub Copilot (AI Codi
- P60LqQg1RH8 | Stop Using Claude Code Like This (Use Sub-Agents Instead)
- mwnSwhkuqOQ | Claude Haiku 4.5 is HERE (Side by Side Comparison to Sonnet)
- eFSP0i_DbpY | Stop Wasting Opus on Claude Pro (Claude Code Sub-Agents)
- sqw3MSoD8NM | Qual o melhor modelo do Claude? Haiku, Sonnet e Opus na prát
- wvo5Ipxgc8k | Make Sonnet as Smart as Opus (Without Paying for It) / Claud
- 84-sHkG4AQU | Top 7 AI Agent Tools That Actually Work
- DMEoOdUdLzM | Build an agent: Choose the right model for your agent
- Y8Uze4HtLR0 | VS Code Compare Models & Agent Harnesses / AI Coding Agents 
- fXizBc03D7E | 5 Types of AI Agents: Autonomous Functions & Real-World Appl
- qYNs80FKIVc | 5 Best Practices for Building AI Agent Skills
- ulNsa0sD8N0 | Harness Engineering: What Separates Top Agentic Engineers Ri
- _C57BxSXRbU | The Best AI Tools for Developers in 2026 (That I Actually Us
- Lg-meK5IU8Q | What AI Agent Skills Are and How They Work
- vlfCjWuv4es | Rethinking Claude Code Best Practices - Lydia Hallie, Anthro
- hfba9dAT6xE | The Best LOCAL Agentic Coding Workflow (Complete Guide)
- oUcfICRYPjs | OpenCode: 200+ AI Models in ONE FREE Coding Agent! 🚀
- X4FVEEegCbk | Skills vs MCP vs RAG vs Memory: What AI Agents Need to Know
- UngVdAsQEiU | The Best Local Agentic Coding Workflow (Complete Guide)
- F8jidmEkIeM | Claude Code: Build Your First AI Agent in 20 Minutes (100% N
- -INveHwbRz4 | Introducing agent view in Claude Code
- bcM9dP_uXJU | How to Build an AI Agent with Claude Code (Claude AI Agent T
- pvxNcQTcIy4 | Agent Skills or MCP in the era of Claude Code?
- f8cfH5XX-XU | The Pi Coding Agent: The ONLY REAL Claude Code COMPETITOR
- XhliUzOmSa8 | Pi Coding Agent is now my absolute favorite...
- Q-CK0lJ8_JA | Top Coding Agents: The One 65% of Senior Developers Uses
- 5NJ1Jbqpfz0 | Devin, Factory, Jules, OpenHands: What Each Cloud Coding Age
- td52e2tQFIU | The Biggest AI Coding Agent Upgrade Is Already on Your Machi
- OH7G6ko5aQc | 5 Best AI Coding Agents in 2026 / Every Developer Should Kno
- jsy3m7Emkr0 | How to Setup AI Agent Skills for Better Code / TRAE SOLO
- WYjxN8QUJi8 | Parallel Agents in Kilo Code
- 5NxGqnTazR8 | The Ultimate Agent Mode Tutorial in VS Code: Vision, MCP, Cu
- lK9o5Wu2upU | Pi is INCREDIBLE - Building a Custom Coding Agent Live
- DRNbxPk9Ab8 | Code Mode Is Claude Code's BIGGEST Harness Change Yet
- Fgzm_b_8iw8 | 1018
- XdtBAm2pM-0 | How to use Claude Code and Gemini Cli Together
- wlpBCazAY9Q | AI-Assisted Coding Tutorial - OpenClaw, GitHub Copilot, Clau
- rGYECOUsjA0 | How to Use ChatGPT + Claude + Gemini Together?
- g9b9G8dcS8Y | Master All 6 Claude Code Dynamic Workflows
- xjSzEzVC3vc | Learn 95% of Claude in Under 25 Minutes (2027 Guide)
- 2CR9tDNAzB0 | herdr is a must use
- mViFYTwWvcM | Spec-Driven Development: AI Assisted Coding Explained
- GWtx-d3dALQ | How To Use Claude For Academic Research (My Actual AI Stack)
- z9rdrNrkvDY | Learn 80% of Claude Cowork in Under 20 Minutes
- GNHqMyc95OM | Claude and ChatGPT Can Finally Talk (100% Free)
- gdrPkpXuNks | My Full Claude Cowork Setup (steal my workflows!)
- HhZdNYI4pJs | I Tried 100+ Github Repos for Claude. These 6 Are the Best
- p7M6BrwGWq8 | Anthropic 엔지니어는 Claude Code를 이렇게 씁니다 - 상위 1%의 3가지 방법
- 6MJ-pmckowQ | How to Build a 100% Automated Marketing Agent Team with Clau
- vxEvo2BLM6A | [전체강의 통합본] 클로드 코드 2시간  안에 마스터하기 / 입문→실전→심화 완전 정복 (풀버전)
- urlbNkusl1Q | AI 에이전트, 진작 만들어볼걸… / 구독자 무료 자료 제공, 클로드로 ai 에이전트 만들기 활용법 총정리
- XYk8R4ElBxs | Claude Code(클로드 코드) 팀 에이전트! 이제는 AI끼리 알아서 일한다! 🤖🤝🤖
- 4PvOQJsgFCg | 클로드 코드 95% 마스터하기, 2시간이면 충분합니다 (완전 초보용)
- 3GhDS0OWPE8 | AI 에이전트 사무실 이렇게 준비하세요 / 혼자서 클로드 코드 세션 60개를 돌리는 실제 구조
- c-a4GBOxhXQ | My AI Agent Transition (w. Claude Code, OpenClaude)
- xwx9kHKBPgg | 클로드 코드 2026 하반기 총정리 / 하네스가 바뀌었으니 사용법도 바꿔야 합니다
- C6xlOsQFyOQ | Claude Code: A Beginner's Guide for Office Workers Who Don't
- OMC7d4dNgcw | '진짜' 클로드 코드 실무편ㅣ회사에서 바로 쓰는 AI 에이전트 5단계 완성
- 0ESZJFUZD-k | [Paid Course Free Access] I Built a Blog Agent Team with Cla
- mP2mWReIzck | Claude 2.0 Editing
- yh05xGAUyRc | Claude Code 에이전트 왕초보 입문 튜토리얼(60분 풀가이드, 설치, 사용법, 기획서, 에이전트 설계
- 5Ge3KRGgDYU | 클로드 코드 / AI 고수가 200% 쓰는 방법 / 팀장처럼 동시에 일 시키기 / 서브 에이전트 시각화 / 
- 45eweEBM5Ys | 클로드 코드를 내 맞춤 AI로 만드는 5가지 ㅣ 폴더 정리, 규칙 파일, 검사 담당, 반복까지
- GL3LXWBZfy0 | AI 에이전트 100개를 한 번에 관리하는 1인 유니콘 개발자 (커서맛피아 최수민님)
- 8H3NwQL-Aew | 메타 엔지니어의 클로드코드 완벽 가이드 [심화편] - Skills, Sub-Agent, Hooks, 병렬 실
- IcoK2gFyc98 | [Claude Code Masterclass Part 2] Coding Skills Not Required!
- jKjbXXBahiY | 코딩 배우지 마세요, 말 한마디로 주식 에이전트 만드는 법
- gGN0CS8lRHU | 클로드 입문 필수 AI 용어 19가지 총정리 / Claude code 프롬프트 스킬 MCP 에이전트 사용법 
- t5wgKwVIUgY | Master 80% of Claude Code Before 2027 [2-Hour Full Course]
- F15aMeaHOII | 최신 클로드코드 신기능 정리, 이 6가지만 알면 됩니다 / 깔끔 정리 #클로드코드 #ClaudeCode #A
- _kKX2kqBD58 | [Vibe Coding Introductory Course] Lesson 6: Building a Devel
- xRAsUlqswlY | 구글 AI 스튜디오 완전 무료, 게임·쉐이더·웹사이트까지 제미나이 4 하이드로젠으로 / AI 야학당
- PLdasAkLYrwQU | [시즌 4] 진지한 인공지능·에이전트 지식
- FQIFB6LOjC0 | "This could actually work!" I presented a Gemini marketing p
- eJudYn6Iuf0 | 클로드 코드 vs 코덱스 vs 안티그래비티, 나한테 맞는 AI 코딩 도구는? #AI코딩 #클로드코드 #코덱스
- _dN-RMh0Tl0 | 클로드·코덱스·안티그래비티를 한 팀으로 돌리는 법
- -yvXmaRmALY | [AI 리뷰] 안티그래비티, 커서, 클로드 코드... 도대체 뭐 써야 하나요?
- V2fbkHvnYsI | 클로드 코드 vs 코덱스, 2026 AI 코딩 도구 비교 (초보용)
- G7XCtMg8uHc | 클로드코드 vs 안티그래비티 vs 코덱스 AI 에이전트 바이브코딩 승자는? - 게임 개발 20분 대결 (메탈
- 0JXEPjFDyE4 | 코덱스로 건너타기 전에 - 클로드코드 vs 코덱스 결정 차이 7가지 양면 비교 정리
- A2sEO38uxzo | 코덱스가 클로드 코드를 죽이고 있습니다
- XoVLXiouOW0 | 클로드코드 vs 안티그래비티? 그거 아직 고민하면 2026년 망합니다
- iNCOuMCzzDg | 클로드 코드 + 코덱스 + 제미나이 동시에 굴리는 멀티 에이전트 시스템 (한 번 쓰면 못 돌아감)
- XOYFwXejbvc | 디스코드 하네스 멀티 에이전트 - 클로드·코덱스·제미나이를 API 없이 구독만으로
- DvSAD90VWM0 | (Easy Practice) Command Agents at Your Own with Claude Code!
- 0ScISw3Wuv8 | 클로드·코덱스·제미나이로 동시에 에이전트 루프 - 한 모델이 만들고 다른 모델이 채점합니다
- HNlBFesXiW8 | 클로드·코덱스·제미나이를 동시에 제어합니다｜하네스 멀티 에이전트 2.0
- fW7axMVPnQQ | AI 에이전트, 어렵게 생각했는데 직접 만들어보니
- OMTZkWt08fM | 클로드 코드, 코덱스, 제미나이 CLI를 동시에? 멀티 에이전트 터미널 cmux 실전 활용법
- 5buNm0pA1mg | 하네스 엔지니어링 40분 개념 정리 / 클로드 코드 × 코덱스
- Gb2VMWrUmZ0 | How to Make Today's Hottest Claude Code 10x Smarter! Claude 
