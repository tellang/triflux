---
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

> **Deep 버전**: tfx-deep-research. "제대로/꼼꼼히" 수정자로 자동 에스컬레이션.
> 빠른 단일 소스 검색 + 요약. 토큰 최소화, 즉시 결과.

## 용도

- 빠른 팩트 체크
- 라이브러리/프레임워크 최신 정보 확인
- API 문서 검색
- 에러 메시지 해결책 검색
- 간단한 기술 질문 답변

## 워크플로우

### Step 1: 쿼리 최적화

사용자 입력을 검색에 최적화된 쿼리로 변환한다:

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

선택 결과에 따라 Step 2의 자동 선택 로직을 건너뛰고 해당 MCP를 직접 사용한다.
인자가 제공된 경우 이 단계를 건너뛰고 Step 2의 자동 선택 로직을 따른다.

### Step 2: MCP 소스 자동 선택

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

### Step 3: 검색 실행

선택된 MCP로 검색 실행. 결과를 토큰 효율적으로 포맷:

```
검색 파라미터:
  - numResults: 5 (토큰 절약)
  - highlights: true (Exa — 전문 대신 하이라이트)
  - maxCharacters: 500 (Tavily/Exa — 콘텐츠 제한)
  - freshness: 상황에 따라 자동 설정
```

### Step 4: 결과 요약

검색 결과를 구조화된 요약으로 변환:

```markdown
## 검색 결과: {query}

### 핵심 답변
{1-3문장 직접 답변}

### 상세 내용
- **[출처 1 제목](URL)**: {하이라이트 요약}
- **[출처 2 제목](URL)**: {하이라이트 요약}
- **[출처 3 제목](URL)**: {하이라이트 요약}

### 관련 키워드
{추가 검색에 유용한 키워드}
```

## 토큰 예산

| 단계 | 토큰 |
|------|------|
| 쿼리 최적화 | ~200 |
| 검색 실행 | ~2K (MCP 결과) |
| 결과 요약 | ~2K |
| **총합** | **~5K** |

## Fallback 전략

MCP 사용 불가 시 순서:
1. context7 → 2. WebSearch (내장) → 3. Brave → 4. Exa → 5. Tavily

## 사용 예

```
/tfx-research "Next.js 15 Server Actions best practices"
/tfx-research "pnpm workspace monorepo setup 2026"
/tfx-research "ECONNREFUSED 에러 Node.js 해결"
```
