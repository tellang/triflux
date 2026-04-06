---
internal: true
name: tfx-find
description: >
  코드베이스에서 파일, 함수, 클래스, 문자열을 빠르게 찾을 때 사용한다.
  '코드 검색', 'find in code', '어디에 있어?', '이 함수 어디서 쓰여?',
  '파일 찾아줘', '코드베이스 탐색' 같은 요청에 반드시 사용.
  파일 위치, 심볼 사용처, 패턴 검색이 필요한 모든 상황에 적극 활용.
triggers:
  - 코드 검색
  - codebase search
  - find in code
  - 코드에서 찾기
  - 코드베이스 검색
argument-hint: "<검색 패턴 또는 질문>"
---

# tfx-find — Fast Codebase Explorer

> **ARGUMENTS 처리**: 이 스킬이 `ARGUMENTS: <값>`과 함께 호출되면, 해당 값을 사용자 입력으로 취급하여
> 워크플로우의 첫 단계 입력으로 사용한다. ARGUMENTS가 비어있거나 없으면 기존 절차대로 사용자에게 입력을 요청한다.

> **Telemetry**
>
> - Skill: `tfx-find`
> - Description: `코드베이스에서 파일, 함수, 클래스, 문자열을 빠르게 찾을 때 사용한다. '코드 검색', 'find in code', '어디에 있어?', '이 함수 어디서 쓰여?', '파일 찾아줘', '코드베이스 탐색' 같은 요청에 반드시 사용. 파일 위치, 심볼 사용처, 패턴 검색이 필요한 모든 상황에 적극 활용.`
> - Session: 요청별 식별자를 유지해 단계별 실행 로그를 추적한다.
> - Errors: 실패 시 원인/복구/재시도 여부를 구조화해 기록한다.


> OMC explore agent 오마주. Haiku의 속도 + Glob/Grep/Read의 정밀도.
> "찾는 건 빠르게, 읽는 건 정확하게."

## 용도

- 파일 위치를 모를 때 빠르게 찾기
- 특정 함수/클래스/변수가 어디서 사용되는지 추적
- 문자열 패턴으로 코드 검색
- 프로젝트 구조 빠르게 파악
- 설정 파일, 진입점, 테스트 파일 탐색

## 워크플로우

### Step 1: 검색 의도 파싱

사용자 입력에서 검색 유형을 판별한다:

```
검색 유형:
  file_pattern  — "*.test.ts 파일 찾아" → Glob
  symbol        — "createBridge 함수 어디?" → Grep (정규식)
  string        — "TODO 주석 찾아" → Grep (리터럴)
  structure     — "프로젝트 구조 보여줘" → Glob + tree
  usage         — "Router 클래스 사용처" → Grep (import/require + 참조)
  definition    — "handleAuth 정의 찾아" → Grep (function/class/const 패턴)
```

### Step 2: 검색 실행

검색 유형에 따라 최적 도구 조합을 선택한다:

```
file_pattern:
  Glob("**/{pattern}") → 매칭 파일 목록

symbol:
  Grep(pattern="{symbol}", type="{lang}") → 파일 목록
  → 상위 5개 파일 Read (정의부 중심, 각 ±10줄)

string:
  Grep(pattern="{string}", output_mode="content", context=2) → 매칭 라인 + 컨텍스트

structure:
  Glob("**/*.{ts,js,mjs,py,go}") → 파일 트리 구성
  → 디렉토리별 파일 수 + 역할 요약

usage:
  Grep(pattern="import.*{symbol}|require.*{symbol}", output_mode="content") → import 위치
  Grep(pattern="{symbol}", output_mode="content") → 실제 사용 위치
  → 중복 제거 후 사용처 목록

definition:
  Grep(pattern="(function|class|const|let|var|export)\\s+{symbol}", output_mode="content")
  → 정의 위치 + 파일 경로
```

### Step 3: 결과 정리

검색 결과를 구조화하여 보고한다:

```markdown
## 검색 결과: {query}

### 매칭 파일 ({count}개)
| # | 파일 | 라인 | 컨텍스트 |
|---|------|------|---------|
| 1 | src/hub/bridge.mjs | 42 | export function createBridge(...) |
| 2 | src/hub/router.mjs | 15 | import { createBridge } from './bridge' |

### 코드 스니펫
{핵심 코드 (필요 시)}

### 관련 파일
- src/hub/bridge.test.mjs (테스트)
- src/hub/index.mjs (re-export)
```

## 검색 최적화 규칙

1. **Glob 먼저, Grep 나중**: 파일 위치를 알면 Glob, 내용 검색은 Grep.
2. **type 필터 사용**: `type: "js"` 등으로 불필요 파일 제외.
3. **head_limit 사용**: 결과가 많을 때 상위 N개만 반환.
4. **병렬 검색**: 독립적인 검색은 동시에 실행.
5. **점진적 확장**: 좁은 범위 → 넓은 범위. `src/` → `**/*`.

## 동작 규칙

1. 결과가 0개이면 패턴을 완화하여 재검색한다 (대소문자 무시, 부분 매칭).
2. 결과가 50개 초과이면 가장 관련성 높은 10개만 보여주고 필터 제안.
3. 파일 내용은 필요한 부분만 Read한다 (전체 파일 읽기 금지).
4. 검색 패턴에 정규식 특수문자가 있으면 자동 이스케이프.

## 토큰 예산

| 단계 | 토큰 |
|------|------|
| 의도 파싱 | ~200 |
| 검색 실행 | ~1.5K |
| 결과 정리 | ~1K |
| **총합** | **~3K** |

## 사용 예

```
/tfx-find "createBridge 함수 정의와 사용처"
/코드 검색 "*.test.mjs 파일 목록"
/find in code "TODO|FIXME|HACK 주석"
/코드에서 찾기 "환경변수 사용하는 파일"
```
