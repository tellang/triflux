---
internal: true
name: tfx-research
description: "빠른 웹 검색과 요약이 필요할 때 사용한다. '검색해줘', '찾아봐', '최신 정보', '이거 뭐야', 'search', '공식 문서 확인' 같은 요청에 반드시 사용. 라이브러리 문서, API 레퍼런스, 에러 해결, 최신 뉴스, 팩트 체크 등 외부 정보가 필요한 모든 상황에 적극 활용한다."
triggers:
  - tfx-research
  - 빠른 리서치
  - 검색
  - 찾아줘
  - search
  - web search
argument-hint: "<검색 주제>"
---

# tfx-research — Light Web Research

> **ARGUMENTS 처리**: 이 스킬이 `ARGUMENTS: <값>`과 함께 호출되면, 해당 값을 사용자 입력으로 취급하여
> 워크플로우의 첫 단계 입력으로 사용한다. ARGUMENTS가 비어있거나 없으면 기존 절차대로 사용자에게 입력을 요청한다.

> **Telemetry**
>
> - Skill: `tfx-research`
> - Description: `빠른 웹 검색과 요약이 필요할 때 사용한다. '검색해줘', '찾아봐', '최신 정보', '이거 뭐야', 'search', '공식 문서 확인' 같은 요청에 반드시 사용. 라이브러리 문서, API 레퍼런스, 에러 해결, 최신 뉴스, 팩트 체크 등 외부 정보가 필요한 모든 상황에 적극 활용한다.`
> - Session: 요청별 식별자를 유지해 단계별 실행 로그를 추적한다.
> - Errors: 실패 시 원인/복구/재시도 여부를 구조화해 기록한다.




> **Deep 버전**: tfx-deep-research. "제대로/꼼꼼히" 수정자로 자동 에스컬레이션.
> 빠른 단일 소스 검색 + 요약. **검색 자체를 Gemini에 위임**해 Claude 토큰 최소화. Gemini CLI의 네이티브 Google Search로 검색+요약을 한 번에 처리.

## 용도

- 빠른 팩트 체크
- 라이브러리/프레임워크 최신 정보 확인
- API 문서 검색
- 에러 메시지 해결책 검색
- 간단한 기술 질문 답변

## 워크플로우

### Step 1: 쿼리 최적화 (Claude — ~100 토큰)

사용자 입력을 검색에 최적화된 영문 키워드로 변환한다. 이 단계만 Claude가 처리한다:

```
입력: "React 19에서 use() 훅 사용법"
최적화: "React 19 use() hook usage API reference 2026"
```

### Step 1.5: 검색 유형 선택 (인자 없이 호출 시)

인자 없이 `/tfx-research`만 호출된 경우, AskUserQuestion으로 검색 유형을 선택받는다:

```
AskUserQuestion:
  "검색 유형을 선택하세요:"
  1. 코드/라이브러리 문서 (context7)
  2. 학술/논문 (Exa semantic)
  3. 최신 뉴스/트렌드 (Brave)
  4. 일반 웹 검색 (Tavily)
  5. URL 콘텐츠 추출
```

선택 결과에 따라 Step 2 Gemini 위임 시 프롬프트에 검색 유형 힌트를 추가한다.
인자가 제공된 경우 이 단계를 건너뛰고 Step 2로 직행한다.

### Step 2: Gemini에 검색+요약 위임 (검색 실행 전체를 Gemini가 처리)

최적화된 쿼리를 Gemini CLI로 전달한다. Gemini는 네이티브 Google Search를 사용해 검색과 요약을 모두 수행한다:

```
Bash("bash scripts/tfx-route.sh gemini 'Research the following topic. Use Google Search to find current information. Return a structured markdown summary with sources: {optimized_query}' auto 120")
```

Gemini가 반환하는 결과에는 검색 결과, 출처 URL, 핵심 요약이 포함된다. Claude는 이 단계에서 토큰을 소비하지 않는다.

**실패 시**: Gemini CLI가 응답하지 않거나 오류가 발생하면 → [Claude Fallback](#claude-fallback-gemini-실패-시) 으로 전환.

### Step 3: 결과 포맷팅 (Claude — 경량, ~300 토큰)

Gemini 출력을 표준 결과 템플릿으로 정리한다. 새로운 검색이나 요약 없이 포맷 변환만 수행:

```markdown
## 검색 결과: {query}

### 핵심 답변
{Gemini 요약에서 추출한 1-3문장 직접 답변}

### 상세 내용
- **[출처 1 제목](URL)**: {하이라이트 요약}
- **[출처 2 제목](URL)**: {하이라이트 요약}
- **[출처 3 제목](URL)**: {하이라이트 요약}

### 관련 키워드
{추가 검색에 유용한 키워드}
```

## 토큰 예산

| 단계 | 담당 | 토큰 |
|------|------|------|
| 쿼리 최적화 | Claude | ~100 |
| 검색 실행 + 요약 | Gemini | 0 (Claude 미소비) |
| 결과 포맷팅 | Claude | ~300 |
| **Claude 총합** | | **~500 (오케스트레이션만)** |

> 기존 대비 Claude 토큰 ~90% 절감. 검색 품질은 Gemini의 Google Search 네이티브 연동으로 유지.

---

## Claude Fallback (Gemini 실패 시)

Gemini CLI가 실패하거나 응답이 없을 경우 Claude + MCP 원본 워크플로우로 폴백한다.

### Fallback Step 2: MCP 소스 자동 선택

검색 유형에 따라 최적 MCP를 자동 선택한다:

| 유형 | 선택 MCP | 이유 |
|------|----------|------|
| 코드/라이브러리 문서 | context7 (resolve → query) | 공식 문서 최적화 |
| 학술/심층 검색 | Exa (web_search_exa) | Neural semantic search |
| 최신 뉴스/트렌드 | Brave (brave_web_search) | 독립 인덱스, freshness |
| 일반 웹 검색 | Tavily (tavily_search) | 범용, 빠른 응답 |
| URL 콘텐츠 추출 | Exa (crawling_exa) | Clean text extraction |

**선택 로직:**
```
if query matches library/framework name → context7
elif query contains "논문", "research", "paper" → Exa (category: "research paper")
elif query contains "뉴스", "news", "최신" → Brave (brave_news_search)
elif query contains URL → Exa crawling
else → Tavily (가장 범용적)
```

### Fallback Step 3: 검색 실행

선택된 MCP로 검색 실행. 결과를 토큰 효율적으로 포맷:

```
검색 파라미터:
  - numResults: 5 (토큰 절약)
  - highlights: true (Exa — 전문 대신 하이라이트)
  - maxCharacters: 500 (Tavily/Exa — 콘텐츠 제한)
  - freshness: 상황에 따라 자동 설정
```

MCP 사용 불가 시 순서:
1. context7 → 2. WebSearch (내장) → 3. Brave → 4. Exa → 5. Tavily

## 사용 예

```
/tfx-research "Next.js 15 Server Actions best practices"
/tfx-research "pnpm workspace monorepo setup 2026"
/tfx-research "ECONNREFUSED 에러 Node.js 해결"
```
