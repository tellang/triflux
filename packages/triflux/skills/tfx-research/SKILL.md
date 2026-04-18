---
internal: true
name: tfx-research
description: "웹 검색/리서치가 필요할 때 사용한다. '검색해줘', '찾아봐', '최신 정보', '이거 뭐야', '심층 조사', '자세히 알아봐', 'deep research', '전면 리서치', '자율 리서치', '조사해', 'research and plan' 같은 요청에 반드시 사용. 기본값은 3-CLI 멀티소스(Exa+Brave+Tavily) 합의 딥 리서치. 빠른 Gemini Google Search 는 --quick. 자율 쿼리생성+보고서 모드는 --auto."
triggers:
  - tfx-research
  - 리서치
  - 검색
  - 찾아줘
  - search
  - web search
  - deep research
  - 심층 리서치
  - deep-research
  - autoresearch
  - 자율 리서치
  - 조사해
  - 알아봐
argument-hint: "<주제> [--quick | --auto] [--depth quick|standard|deep]"
---

# tfx-research — Web Research (Deep by Default)

> **ARGUMENTS 처리**: `--quick` → Quick. `--auto` → Auto. 그 외 → Deep (기본).

> AI makes completeness near-free. 기본은 Claude(Exa/학술) + Codex(Brave/실용) + Gemini(Tavily/DX) 3-CLI 멀티소스 교차검증 합의.
> 빠른 단일 Google Search 는 `--quick`. 자율 쿼리생성+구조화 보고서 는 `--auto`.

---

## 모드 분기

| 플래그 | 모드 | 특징 |
|--------|------|------|
| (없음) | **Deep** (기본) | 3-CLI 멀티소스 교차검증, consensus score |
| `--quick` | Quick | Gemini 단일 Google Search |
| `--auto` | Auto | 자율 쿼리생성(3-5개) + 검색 + 구조화 보고서 |

---

## Deep 모드 (기본)

### HARD RULES
1. `codex exec` / `gemini -p` 직접 호출 금지
2. Codex/Gemini → `Bash("tfx multi ...")` 만
3. Claude → `Agent(run_in_background=true)`
4. Bash + Agent 동시 호출

### 모델/소스 역할

| CLI | MCP | 관점 |
|-----|-----|------|
| Claude | Exa (neural semantic) | 학술/기술 깊이, 공식 문서, 벤치마크 |
| Codex | Brave Search | 실용/구현/산업 사례 |
| Gemini | Tavily | 비용/운영/DX |

### Depth 모드 (`--depth` 플래그)

| 모드 | 서브쿼리 | 소스/쿼리 | 라운드 | 토큰 | 시간 |
|------|---------|----------|--------|------|------|
| quick | 3 | 2 | 1 | ~20K | 2-3분 |
| standard | 5 | 3 | 1-2 | ~40K | 5-8분 (기본) |
| deep | 8-10 | 5 | 2-3 | ~80K | 10-15분 |

### EXECUTION

#### Pre-Phase: Depth 선택
`--depth` 미지정 시 AskUserQuestion.

#### Step 1: 주제 분석 및 쿼리 분해 (Claude Opus)
- depth 에 따른 서브쿼리 생성
- 각 쿼리에 관점(학술/실용/DX) 매핑

#### Step 2: 3-CLI 독립 병렬 검색 (Anti-Herding) — Bash + Agent 동시 호출

**Agent (Claude + Exa):**
```
Agent(
  subagent_type="claude",
  model="opus",
  run_in_background=true,
  prompt="서브쿼리를 Exa web_search_exa 로 검색. 서브쿼리: {sub_queries}. 관점: 학술/기술. category='research paper' 우선, highlights=true, numResults=5. 각 결과 제목/URL/핵심 추출."
)
```

**Bash (Codex + Brave, Gemini + Tavily):**
```
Bash("tfx multi --teammate-mode headless --auto-attach --dashboard \
  --assign 'codex:서브쿼리를 Brave Search 로 검색. 서브쿼리: {sub_queries}. 관점: 실용/산업. brave_web_search + brave_news_search, freshness=pw. 각 쿼리 상위 5개 구조화.:researcher' \
  --assign 'gemini:서브쿼리를 Tavily 로 검색. {sub_queries}. 관점: 비용/운영/DX. tavily_search search_depth=advanced, max_results=5, include_raw_content=false. 구조화.:researcher' \
  --timeout 600")
```

#### Step 3: 결과 수집 및 교차검증

교차검증 기준:
1. 사실 일치
2. 추천 일치
3. 수치 일치 (벤치마크/가격/성능)
4. 리스크 일치

소스 가중치: 공식 1.0 / 논문 0.9 / 엔지니어링 블로그 0.7 / 일반 0.5. 날짜: 6개월 ×1.0 / 1년 ×0.8 / 2년 ×0.5.

#### Step 4: 합의 종합 보고서

```markdown
# Deep Research Report: {topic}
**Depth**: {depth} | **Consensus**: {score}% | **Sources**: {n}개

## Executive Summary
## Key Findings (consensus 기반)
### 1. {finding} — 합의도: 3/3 또는 2/3
## Comparative Analysis
## 미합의 사항 (Disputed)
## 추천
## 소스 목록 (신뢰도 + MCP)
```

#### Step 5: Recursive Depth (deep 모드 전용)
중요 하위 주제 발견 시 최대 3개까지 재귀 실행.

### Token (Deep): quick ~18K / standard ~35K / deep ~80K

---

## Quick 모드 (`--quick`)

### Step 1: 쿼리 최적화 (Claude ~100 토큰)
사용자 입력 → 영문 검색 키워드.

### Step 1.5: 검색 유형 선택 (인자 없을 때)

```
AskUserQuestion:
  1. 코드/라이브러리 (context7)
  2. 학술/논문 (Exa semantic)
  3. 뉴스/트렌드 (Brave)
  4. 일반 웹 (Tavily)
  5. URL 콘텐츠 추출
```

### Step 2: Gemini Google Search 위임

```
Bash("bash ~/.claude/scripts/tfx-route.sh gemini 'Research: use Google Search, return structured markdown with sources. Query: {optimized_query}' auto 120")
```

**Fallback**: Gemini 실패 시 MCP 순서 — context7 → WebSearch → Brave → Exa → Tavily.

### Step 3: 결과 포맷팅 (Claude ~300 토큰)

```markdown
## 검색 결과: {query}
### 핵심 답변
### 상세 내용 (출처 + 요약)
### 관련 키워드
```

### Token (Quick): ~500 (Claude), 0 (Gemini 외부)

---

## Auto 모드 (`--auto`)

> 자율 쿼리생성 → 검색 → 핵심 추출 → 구조화 보고서.

### Step 1: 주제 수집
인자로 받거나 대화로 요청. 모호하면 범위 좁히기 후속 질문.

### Step 2: 검색 쿼리 자동 생성 (3-5개)

규칙:
1. 한국어 주제 → 한국어 2-3 + 영어 1-2
2. 영어 주제 → 영어 3-5
3. 일반 + 비교 + 최신 동향 조합

예 ("Next.js 15 변경점"):
```
- "Next.js 15 주요 변경점 정리"
- "Next.js 15 App Router 변경사항 2026"
- "Next.js 15 breaking changes migration"
- "Next.js 15 vs 14 comparison"
```

### Step 3: 웹 검색 실행
brave-search MCP 우선, 없으면 WebSearch. 쿼리당 상위 5-10개, URL 중복 제거, 실패 시 쿼리 변형 재시도.

### Step 4: 핵심 정보 추출
- 제목/URL/스니펫 정규화
- 관련성 높은 것 우선
- 사실 vs 의견 구분
- 날짜순 정렬

### Step 5: 구조화 보고서 생성

```markdown
# Research: {topic}
Date: {date}

## Executive Summary
## Key Findings (3-5개)
## Comparative Analysis (비교 대상 있을 때)
## Actionable Recommendations (실행 가능)
## Sources (URL + 한줄 요약)
```

### Step 6: 저장

`.tfx/reports/research-{timestamp}.md`

### Token (Auto): ~10-15K

## 사용 예

```
/tfx-research "2026 실시간 파이프라인 아키텍처 비교"      # Deep
/tfx-research --depth deep "Claude vs Cursor vs Windsurf"  # Deep
/tfx-research --quick "Next.js 15 Server Actions"          # Quick
/tfx-research --auto "Rust vs Go 백엔드 성능 비교"          # Auto (쿼리생성+보고서)
```
