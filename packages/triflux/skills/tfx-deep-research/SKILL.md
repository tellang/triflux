---
internal: true
name: tfx-deep-research
description: "기술 비교, 아키텍처 조사, 경쟁사 분석 등 깊이 있는 리서치가 필요할 때 사용한다. '심층 조사', '자세히 알아봐', 'deep research', '전면 리서치', '비교 분석 보고서', '종합 리서치' 같은 요청에 반드시 사용. 단순 검색이 아닌 멀티소스 교차검증이 필요한 리서치에 적극 활용."
triggers:
  - deep research
  - 딥 리서치
  - 심층 리서치
  - deep-research
  - thorough research
  - 깊이 조사
  - 전면 리서치
argument-hint: "[--depth quick|standard|deep] <리서치 주제>"
---

# tfx-deep-research — Multi-Source Deep Research with Tri-CLI Consensus

> **ARGUMENTS 처리**: 이 스킬이 `ARGUMENTS: <값>`과 함께 호출되면, 해당 값을 사용자 입력으로 취급하여
> 워크플로우의 첫 단계 입력으로 사용한다. ARGUMENTS가 비어있거나 없으면 기존 절차대로 사용자에게 입력을 요청한다.


> **Light 버전**: tfx-research. 기본값. 깊이 수정자 없으면 Light 선택.
> 쿼리 분해 → 3-CLI 독립 병렬 검색 → 교차검증 → 합의 기반 종합 보고서.
> STORM(Stanford) perspective-guided + GPT-Researcher recursive tree + Tavily deep research pipeline 영감.

## 용도

- 기술 선택 전 심층 조사
- 경쟁사/대안 분석
- 새 도메인 학습을 위한 종합 리서치
- 아키텍처 결정 근거 수집
- 학술/산업 동향 파악

## HARD RULES

> headless-guard가 이 규칙 위반을 **자동 차단**한다. 우회 불가.

1. **`codex exec` / `gemini -p` 직접 호출 절대 금지**
2. Codex·Gemini → `Bash("tfx multi --teammate-mode headless --auto-attach --dashboard --assign 'cli:프롬프트:역할' --timeout 600")` **만** 사용
3. Claude → `Agent(run_in_background=true)`
4. Bash + Agent를 같은 메시지에서 동시 호출하여 병렬 실행

## MODEL ROLES

| CLI | MCP | 관점 |
|-----|-----|------|
| Claude | Exa (neural semantic) | 학술/기술 깊이 (논문, 공식 문서, 벤치마크) |
| Codex | Brave Search | 실용/구현/산업 사례 중심 |
| Gemini | Tavily | 비용/운영/DX(개발자 경험) 중심 |

## Depth 모드

| 모드 | 서브쿼리 | 소스/쿼리 | 라운드 | 토큰 | 시간 |
|------|---------|----------|--------|------|------|
| quick | 3개 | 2 | 1 | ~20K | 2-3분 |
| standard | 5개 | 3 | 1-2 | ~40K | 5-8분 |
| deep | 8-10개 | 5 | 2-3 | ~80K | 10-15분 |

기본값: standard

## EXECUTION STEPS

### Pre-Phase: Depth 선택

`--depth` 플래그가 지정되지 않은 경우, AskUserQuestion으로 depth를 선택받아라:

```
AskUserQuestion:
  "리서치 깊이를 선택하세요:"
  1. quick (3 서브쿼리, ~20K 토큰, 2-3분)
  2. standard (5 서브쿼리, ~40K 토큰, 5-8분) [기본]
  3. deep (8-10 서브쿼리, ~80K 토큰, 10-15분)
```

사용자가 빈 응답을 보내면 기본값 `standard`를 적용하라.

### Step 1: 주제 분석 및 쿼리 분해

Claude Opus로 주제를 분석하고 서브쿼리로 분해하라:

- depth에 따라 서브쿼리 수를 결정한다 (quick=3, standard=5, deep=8-10)
- 각 서브쿼리에 관점(학술/기술, 실용/산업, 비용/운영)을 매핑한다
- sub_queries 목록과 perspectives 목록을 내부적으로 보유한다

### Step 2: 3-CLI 독립 병렬 검색 (Anti-Herding)

**아래 2개 도구를 반드시 같은 응답에서 동시에 호출하라.**

Claude Agent를 백그라운드로 실행하라:

```
Agent(
  subagent_type="claude",
  model="opus",
  run_in_background=true,
  prompt="다음 서브쿼리를 Exa web_search_exa로 검색하라.
  서브쿼리 목록: {sub_queries}
  관점: 학술/기술 깊이 (논문, 공식 문서, 벤치마크)
  각 쿼리에서 category='research paper' 우선, highlights=true, numResults=5로 검색하라.
  각 결과의 제목, URL, 핵심 내용을 추출하여 구조화하여 반환하라."
)
```

Codex와 Gemini를 headless dispatch로 동시에 실행하라:

```
Bash("tfx multi --teammate-mode headless --auto-attach --dashboard \
  --assign 'codex:다음 서브쿼리를 Brave Search로 검색하고 결과를 종합하라. 서브쿼리 목록: {sub_queries}. 관점: 실용/구현/산업 사례 중심. brave_web_search와 brave_news_search를 활용하고, freshness=pw로 최신 결과를 우선하라. 각 쿼리당 상위 5개 결과의 제목, URL, 핵심 내용을 구조화하여 반환하라.:researcher' \
  --assign 'gemini:다음 서브쿼리를 Tavily로 검색하라. 서브쿼리 목록: {sub_queries}. 관점: 비용/운영/DX(개발자 경험) 중심. tavily_search를 search_depth=advanced, max_results=5, include_raw_content=false로 호출하라. 각 결과를 구조화하여 제목, URL, 핵심 내용을 반환하라.:researcher' \
  --timeout 600")
```

### Step 3: 결과 수집 및 교차검증

3개 CLI 결과가 모두 수집되면 다음 기준으로 교차검증하라:

1. 사실 일치: 3개 소스가 동일 사실을 보고하는가
2. 추천 일치: 동일 기술/접근법을 추천하는가
3. 수치 일치: 벤치마크, 가격, 성능 수치가 일치하는가
4. 리스크 일치: 동일 위험을 식별하는가

소스 신뢰도를 다음 가중치로 평가하라:
- 공식 문서/벤치마크 → weight 1.0
- 학술 논문 → weight 0.9
- 신뢰 블로그 (engineering blog) → weight 0.7
- 일반 블로그/포럼 → weight 0.5
- 날짜 가중: 6개월 이내 ×1.0, 1년 이내 ×0.8, 2년 이내 ×0.5

### Step 4: 합의 종합 보고서 생성

Claude Opus가 교차검증된 결과를 종합하여 다음 구조로 최종 보고서를 작성하라:

```markdown
# Deep Research Report: {topic}
**Date**: {date} | **Depth**: {depth} | **Consensus Score**: {score}%
**Sources**: {total_sources}개 | **Sub-queries**: {count}개

## Executive Summary
{3-5줄 핵심 요약}

## 핵심 발견사항 (Consensus Items)
### 1. {finding_1} — 합의도: {3/3 또는 2/3}
{상세 내용 + 근거 + 출처}

### 2. {finding_2}
...

## 비교 분석
| 항목 | 옵션A | 옵션B | 옵션C |
|------|-------|-------|-------|
| 성능 | ... | ... | ... |
| 비용 | ... | ... | ... |
| 운영 | ... | ... | ... |

## 미합의 사항 (Disputed Items)
- {항목}: Claude는 X, Codex는 Y, Gemini는 Z — 이유: ...

## 추천
{교차검증된 최종 추천 + 조건부 판단 기준}

## 소스 목록
1. [{title}]({url}) — 신뢰도: {score} — 사용 MCP: {exa|brave|tavily}
...
```

### Step 5: Recursive Depth (deep 모드 전용)

deep 모드에서 Phase 3 교차검증 중 중요 하위 주제가 발견되면 재귀적으로 Step 2-4를 반복하라:

- 최대 3개 하위 주제까지 재귀 실행한다
- 각 재귀 결과를 메인 보고서에 병합한다
- 재귀 실행도 반드시 Agent + Bash 동시 호출 패턴을 사용한다

## ERROR RECOVERY

- Codex 또는 Gemini 결과가 없으면: 해당 CLI 없이 2개 소스로 교차검증을 진행하고 보고서에 누락 CLI를 명시하라
- tfx multi 명령이 실패하면: 오류 메시지를 그대로 출력하고 재시도 1회 후 실패를 사용자에게 보고하라
- Agent 결과가 없으면: Claude Exa 검색 없이 나머지 2개 소스로 진행하라

## TOKEN BUDGET

| 단계 | quick | standard | deep |
|------|-------|----------|------|
| Step 1 (분해) | 1K | 2K | 3K |
| Step 2 (3x검색) | 9K | 18K | 30K |
| Step 3 (교차검증) | 3K | 5K | 8K |
| Step 4 (보고서) | 5K | 10K | 15K |
| Step 5 (재귀) | — | — | 24K |
| **총합** | **~18K** | **~35K** | **~80K** |

## MCP 활용 전략 (Exa/Brave/Tavily 리버스엔지니어링 기반)

### Exa 최적 활용
- `type: "auto"` — neural+keyword 하이브리드
- `category: "research paper"` — 학술 검색 시
- `highlights: true, text.maxCharacters: 300` — 토큰 효율 핵심
- `includeDomains` — 신뢰 도메인 필터링

### Brave 최적 활용
- `brave_news_search` — 최신 동향/뉴스
- `freshness: "pw"` (past week) — 최신성 보장
- `result_filter: "web"` — 불필요한 결과 방지
- 독립 인덱스 → Google/Bing과 다른 결과

### Tavily 최적 활용
- `tavily_search` — 빠른 범용 검색
- `include_raw_content: false` — 토큰 절약
- `max_results: 5` — 적정 결과 수
- `search_depth: "advanced"` — standard 모드 이상

## 사용 예

```
/tfx-deep-research "2026 실시간 데이터 파이프라인 아키텍처 비교"
/tfx-deep-research --depth deep "Claude Code vs Cursor vs Windsurf 멀티에이전트 지원 비교"
/tfx-deep-research --depth quick "pnpm vs bun vs npm 2026 벤치마크"
```
