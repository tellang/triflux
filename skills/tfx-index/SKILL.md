---
name: tfx-index
description: "프로젝트 구조를 빠르게 파악하거나 토큰을 절약할 때 사용한다. '인덱싱', '프로젝트 구조', '인덱스 만들어', '코드베이스 맵', '프로젝트 개요' 같은 요청에 사용. 새 프로젝트 온보딩, 세션 시작 시 컨텍스트 효율화에 적극 활용."
triggers:
  - 인덱싱
  - 프로젝트 인덱스
  - 인덱스
  - tfx-index
argument-hint: "[--update] [경로]"
---

# tfx-index — Project Indexing (94% Token Reduction)

> **ARGUMENTS 처리**: 이 스킬이 `ARGUMENTS: <값>`과 함께 호출되면, 해당 값을 사용자 입력으로 취급하여
> 워크플로우의 첫 단계 입력으로 사용한다. ARGUMENTS가 비어있거나 없으면 기존 절차대로 사용자에게 입력을 요청한다.


> SuperClaude index-repo 오마주. 1회 2K 토큰으로 인덱스 생성, 이후 세션마다 55K 토큰 절감.

> **Gemini 위임**: 스캔 + 인덱스 생성 작업은 Gemini CLI에 위임한다. Claude는 모드 선택(Step 0)과 파일 쓰기만 담당. Claude 토큰 소비 ~500 tokens으로 줄어든다.

## 원리

매 세션마다 프로젝트 구조를 파악하려면 수십 개 파일을 읽어야 한다 (~58K tokens).
인덱스를 한 번 생성하면 3K 토큰짜리 PROJECT_INDEX.md만 읽으면 된다.

**ROI**: 1회 투자 2K → 세션당 55K 절감 → 10세션이면 550K 절감

## 워크플로우

### Step 0: 인덱싱 모드 선택

인자 없이 호출되거나 모드가 불명확한 경우, AskUserQuestion으로 모드를 선택받는다:

```
AskUserQuestion:
  "인덱싱 모드를 선택하세요:"
  1. 전체 인덱스 생성 (처음 또는 재생성)
  2. 증분 업데이트 (변경분만)
  3. 특정 디렉토리만
```

- 1번 선택 → Step 1부터 전체 실행
- 2번 선택 → `--update` 모드로 전환 (기존 인덱스 필요, 없으면 1번으로 fallback)
- 3번 선택 → 추가 AskUserQuestion으로 대상 디렉토리 경로 입력받음

`--update` 플래그나 경로 인자가 이미 제공된 경우 이 단계를 건너뛴다.

### Step 1: Gemini에 스캔 + 인덱스 생성 위임

Claude는 프로젝트 경로와 모드를 Gemini에 전달하고, Gemini가 파일 트리 스캔·메타데이터 추출·인덱스 생성을 모두 수행한다.

```
Bash("bash scripts/tfx-route.sh gemini exec 'Scan the project at {path}. For each source file, extract: exports, imports, line count, file type. Exclude node_modules/, .git/, dist/, build/, coverage/, *.lock, *.log, *.map. Generate both PROJECT_INDEX.md and PROJECT_INDEX.json following this format:

PROJECT_INDEX.md:
# PROJECT_INDEX.md
Generated: {date} | Files: {count} | Lines: {total_lines}
## Architecture
{1-2 line summary}
## Directory Map
{tree with inline comments}
## Key Files
| File | Lines | Exports | Role |
## Dependencies
| Package | Version | Purpose |
## Entry Points
- {entry}: {role}

PROJECT_INDEX.json:
{
  "generated": "{date}",
  "stats": { "files": N, "lines": N },
  "files": { "{path}": { "lines": N, "exports": [], "imports": [], "type": "" } },
  "graph": { "{path}": ["{dep}", ...] }
}

Return the full content of both files separated by the delimiter: ===PROJECT_INDEX_JSON_START===
Mode: {mode}
'")
```

Gemini 출력을 받은 후 Claude가 파일로 기록한다:

```
Write("PROJECT_INDEX.md", <md_section>)
Write("PROJECT_INDEX.json", <json_section>)
```

#### Fallback: Gemini 실패 시

Gemini 위임이 실패하거나 `tfx-route.sh`가 없는 경우, Claude가 직접 원래 워크플로우로 폴백한다:

```
1. 병렬 Glob으로 파일 트리 수집 (**/*.{ts,js,mjs,tsx,jsx,...})
2. Grep으로 export/import 문 추출 (파일당 ~20줄)
3. PROJECT_INDEX.md + PROJECT_INDEX.json 직접 생성
```

### Step 2: 검증 (Claude 담당)

```
생성된 인덱스 빠른 검증:
  - 파일 수 일치 확인 (stats.files vs 실제)
  - 주요 진입점 포함 확인
  - 인덱스 크기 < 5KB 확인
  - PROJECT_INDEX.json 파싱 가능 여부 확인
```

## --update 모드

기존 인덱스가 있으면 git diff 기반 증분 업데이트:

```
변경된 파일만 재스캔 → 인덱스 부분 갱신
신규 파일 추가, 삭제된 파일 제거
전체 재생성 대비 ~80% 시간 절감
```

## 출력 위치

```
{project_root}/
  PROJECT_INDEX.md    ← 사람용 (3KB)
  PROJECT_INDEX.json  ← 기계용 (10KB)
```

## 토큰 예산

| 작업 | Claude | Gemini |
|------|--------|--------|
| 모드 선택 (Step 0) | ~100 | — |
| 스캔 + 메타데이터 추출 | — | Gemini 부담 |
| 인덱스 생성 (MD + JSON) | — | Gemini 부담 |
| 파일 쓰기 (Write) | ~300 | — |
| 검증 (Step 2) | ~100 | — |
| **Claude 총합** | **~500** | — |
| **세션당 절감** | **~55K** | — |

## 사용 예

```
/tfx-index                    # 전체 인덱스 생성
/tfx-index --update           # 증분 업데이트
/tfx-index src/hub            # 특정 디렉토리만
```
