---
id: 0021
title: 키워드 훅을 명시 호출 중심으로 줄이고 자연어는 제안으로 낮춘다
status: accepted
date: 2026-10-04
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0009, 0020]
pr: null
---

# ADR-0021: 키워드 훅을 명시 호출 중심으로 줄이고 자연어는 제안으로 낮춘다

이 결정은 [ADR-0023](0023-remove-command-hooks-hub-and-adopt-mods.md)의 키워드 라우팅 제거 결정으로 대체되었다. 이 문서는 당시의 판단과 측정 기록으로 보존한다.

## 컨텍스트와 문제 (Context)

`scripts/keyword-detector.mjs`(UserPromptSubmit 훅)는 `hooks/keyword-rules.json`의 정규식이 프롬프트에 맞으면 "You MUST invoke the skill" 문구와 프롬프트 원문을 주입한다. 2026-07-17 lane2-d 결정은 광역 동사(`리뷰해`, `분석해`, `계획`, `진행해`, `확인해`, `implement`, `review` …)를 모두 `tfx-unified`(→ `tfx-auto`)로 잡도록 잠갔고(`tests/unit/lane2-d-routing-contract.test.mjs`), 서비스 맨명사(`메일`, `일정`, `chrome`, `github`, `위키`)는 MCP 라우트로 보냈다.

2026-10-04 감사는 두 머신의 최근 60일 사용자 프롬프트에 그 규칙을 그대로 재생했다.

| 코퍼스 | 프롬프트 | 주입 | 정탐 | 오탐 |
|---|---:|---:|---:|---:|
| m2 | 1,221 | 108 | 18 | 90 (83%) |
| m5 | 10,770 | 2,331 | 213 | 2,118 (91%) |
| 합계 | 11,991 | 2,439 | 231 | 2,208 (91%) |

오탐의 출처는 다음과 같다.

- `tfx-unified` 광역 동사: "진행해", "확인해", 상태 질문, 문서·대본 작업 요청이 대부분이다
- 서비스 맨명사 MCP 라우트: 대화 속 명사, "You have new mail" 같은 붙여넣기. 진짜 요청도 대상이 틀렸다(브라우저 조작은 claude-in-chrome 이 맞다)
- 슬래시 명령 줄(`/resume`, `/chrome`, `/tfx-auto …`)과 붙여넣기 태그 안의 스킬 목록
- 다른 에이전트가 만든 프롬프트(핸드오프 continuation, 팀 리드 부트스트랩, tfx-live 중계 토픽 태그)와 스킬 선언 목록 줄(`- /tfx-x — 설명`)
- `gstack-ship`의 맨 `배포해`(클라우드·dev 배포), `gstack-retro`의 `회고`(회의 회고 문서 작성)
- gstack 스킬 이름이 머신마다 다르다(m2 `ship`·`context-restore`, m5 `gstack-ship`·`gstack-context-restore`). 규칙이 한 이름을 고정해 다른 머신에서는 없는 스킬을 MUST 로 불렀다
- `handoff` action 은 detector 에 구현이 없어 매칭돼도 아무것도 하지 않았다

MUST 문구는 오탐이 나면 Claude가 질문·대화 중에 엉뚱한 스킬을 불러오게 만든다. 주입문이 프롬프트 원문을 다시 붙이고 "OMC [MAGIC KEYWORD:] 지시를 무시하라"고 적어 컨텍스트만 늘렸다.

## 결정 (Decision)

우리는 키워드 훅을 명시 호출 중심으로 줄이고, 자연어 매칭은 강제하지 않는 제안으로 낮추기로 한다. lane2-d의 광역 동사 잠금은 이 ADR이 대체한다.

1. 주입하지 않는 입력(코드 가드):
   - 프롬프트 선두가 슬래시 명령(`^\s*/[\w:.-]+` 뒤 공백 또는 끝)이다. 선두에만 적용한다. 문장 중간의 `/tfx-harness`는 Claude Code 가 확장하지 않으므로 주입이 유일한 호출 경로다.
   - 붙여넣기를 뺀 직접 입력이 자동 생성 봉투다: `^\s*(?:Continuation (?:skills|contract)\b|-\s*Handoff envelope|리드 에이전트:|[A-Z][A-Z0-9_]{7,}[:\s])|Continuation contract:`.
   - 붙여넣기를 뺀 직접 입력이 공백 제외 12자 이하이고 문장 중간 `/tfx-` 토큰이 없다(짧은 반응).
2. 매칭 전 sanitize 에 속성 달린 닫는 태그(`</pasted_content id="1">`) 짝, `~/` 경로, 줄 머리 `>` 인용문, 스킬 선언 목록 줄(`^\s*[-*]\s*/[\w:.-]+\s*[—–-]\s.*$`) 제거를 더한다.
3. 규칙에 `strength: "explicit" | "suggest"`(기본 explicit, 패턴별 덮어쓰기)와 `suggest_when`을 둔다. 명시 토큰은 explicit → MUST 호출. 자연어 매칭은 suggest → "`<suggest_when>`이면 `<skill>`을 고려하라. 질문·상태 확인·대화·다른 도메인이면 무시하라." `selectPrimaryMatch`는 explicit 매칭이 하나라도 있으면 그 안에서만 고른다.
4. `tfx-auto`·`tfx-harness`·`tfx-multi`의 명시 토큰은 문장 중간 슬래시(`(?<![\w/.-])/tfx-x`) 또는 "토큰 + 로/으로 + 실행 동사"(`tfx-auto 로 돌려`)만 인정한다. "tfx-auto에 합쳐졌을텐데", "tfx-harness? tfx-auto?" 같은 이름 언급은 잡지 않는다.
5. 규칙에 `exclude_patterns`를 둔다. 맞으면 그 규칙의 suggest 매칭을 버린다. explicit 매칭은 버리지 않는다.
6. 규칙에 `skill_candidates`를 둔다. gstack 규칙은 `[<name>, gstack-<name>]`을 적고, detector 가 `<cwd>/.claude/skills`, `$CLAUDE_CONFIG_DIR/skills`(기본 `~/.claude/skills`) 순으로 `SKILL.md`가 있는 첫 이름을 고른다. 하나도 없으면 그 규칙은 주입하지 않는다. `TRIFLUX_SKILL_ROOTS`로 탐색 경로를 바꿀 수 있다.
7. 주입문에서 프롬프트 원문 재첨부와 OMC 무시 지시를 지운다. `context_hint`의 Windows 전용 `wt.exe` 끝맺음을 지운다.
8. 규칙을 45개에서 31개로 줄이고 남은 규칙을 좁힌다.
   - 삭제: 맨명사 MCP 라우트 10개(`chrome`·`mail`·`calendar`·`github`·`confluence`·`notion`·`jira`·`slack`·`playwright`·`canva`), 구현 없는 `handoff-route`, 60일 사용 0회인 `tfx-analysis`·`tfx-prune` 토큰, `tfx-doctor`로 합친 `tfx-hub`.
   - `tfx-unified`: 광역 동사 단독을 지우고 "대상 명사 + 구현·수정 동사"(대상어에 `프론트|화면|버튼|위젯|셸|\.sh|경로|콜백|생성기` 포함, `README|리드미` 제외, 동사에 `지워|넣어|바꿔` 포함), `구현\s*(해|하자|할 거|해 줘)`, 영문 `implement`·`refactor`·`fix the bug/test/…`만 suggest 로 잡는다. 질문형 끝맺음은 제외한다.
   - `tfx-ship`: 맨 명사 `배포`·`릴리즈` 대신 `(?:배포|릴리[즈스])\s*(?:해|하고|하자|진행|가자|시작)`만, 질문형 제외, `repo_scope: triflux` 유지. `gstack-ship`: `PR\s*(?:만들|올려|생성|열어)|머지하고\s*배포|릴리스\s*해`, `ship it/this`만, 질문형 제외. `gstack-retro`: 기간 + 회고/리뷰, `retro` 토큰만, `회고 문서/록/템플릿|회의|전사` 제외.
   - `gstack-checkpoint`: 영문 맨 `resume` 제거. `host-ai-slop-cleaner`: 맨 `슬롭`·`클린업` 제거. `suppress-omc-team`: `team` 단어와 `팀 모드/으로/구성`만, 사용자가 직접 친 `/team`과 `레드팀|개발팀|팀 저장소` 제외. `tfx-harness-meta`: "뭐/어떤/무슨 스킬", "스킬 있나" 추가.
   - 나머지 gstack 자연어 규칙과 Windows `wt-tab-*` 규칙은 suggest 로 둔다. 스킬명 토큰 패턴(`office hours`, `cso`, `retro`, `autoplan`, `deslop`)만 explicit 이다.

## 검토한 대안 (Considered Options)

- **규칙만 고치고 코드는 그대로 둔다**: 같은 재생에서 슬래시 명령·붙여넣기·자동 생성 봉투 오탐이 남는다. 정규식 규칙으로는 "지금 사용자가 친 문장"과 "인용·붙여넣기·다른 에이전트의 출력"을 가를 수 없다. 기각한다.
- **키워드 훅을 끈다**: 오탐은 0이 되지만 문장 중간 `/tfx-harness`처럼 훅만이 호출 경로인 명시 토큰과, 지운 스킬 이름의 흡수 경로(ADR-0020)가 사라진다. 기각한다.
- **suggest 없이 자연어 규칙을 모두 지운다**: 남는 자연어 정탐(구현 요청, "어떤 스킬 써?")까지 잃는다. 제안 문구는 오탐이어도 Claude가 무시할 수 있어 비용이 작다. 기각한다.
- **gstack 이름을 한 머신 기준으로 고정한다**: 다른 머신에서는 없는 스킬을 부르게 된다. 기각한다.
- **`exclude_patterns`가 explicit 매칭까지 지운다**: "tfx-ship 돌려도 되나?"처럼 스킬을 직접 부른 질문이 사라진다. 사용자가 이름을 댄 경우는 스킬이 직접 확인 질문을 하도록 둔다.

## 결과 (Consequences)

두 코퍼스를 새 코드로 다시 재생한 결과다. 라벨은 감사의 수동 판정을 그대로 썼다.

| 코퍼스 | 주입 | 정탐 | 오탐 | 정밀도 |
|---|---:|---:|---:|---:|
| m2 | 6 | 4 | 2 | 67% |
| m5 | 96 | 58 | 38 | 60% |
| 합계 | 102 | 62 | 40 | 61% |

감사의 제안 시뮬레이션(합계 104 / 60 / 44)과 다른 4건은 이 구현의 두 선택에서 나온다. 직접 친 `/team`을 억제하지 않아 `suppress-omc-team` 오탐 2건이 빠졌고, explicit 매칭 우선 선택으로 문장 중간 `/tfx-harness`가 같은 프롬프트의 `ai-slop-cleaner` 제안을 이겨 2건이 정탐이 됐다.

m2 기준선 정탐 18건 중 12건은 선두 슬래시 명령이라 호스트가 직접 실행하고, 2건은 그대로 잡는다. 놓치는 4건 중 2건은 "그거로 만들어서 올려봐"처럼 대상 명사 없이 맥락에 기대는 짧은 지시이고, 2건은 질문형 끝맺음에 걸린 실행 지시다. m5 에서도 놓치는 정탐은 같은 두 부류(대상 명사 없는 지시, 질문형 끝맺음)와 오탐이던 MCP 라우트의 진짜 요청이다. Claude가 대화 맥락으로 판단하는 영역으로 넘긴다.

짧은 반응 가드는 "로그인 기능 구현해줘"(공백 제외 9자) 같은 짧은 실행 지시도 거른다. 질문형 제외는 "구현해줄래?" 같은 의문형 요청도 놓친다. 둘 다 제안 강도라 놓쳐도 비용이 작다고 보고 받아들인다. ADR-0020이 말한 `tfx analysis`·`tfx prune` 명시 토큰 흡수는 이 결정으로 끝난다. `tfx qa`(→ `tfx-review`)와 `tfx hub`(→ `tfx-doctor`)는 남는다.

자연어 신호표(`.claude/rules/tfx-routing.md`의 행동 유형 표)는 Claude가 판정할 때 쓰는 지도로 남고 훅이 강제하지 않는다. 오탐이 다시 늘면 같은 재생 방식으로 규칙별 정탐·오탐을 다시 센다.
