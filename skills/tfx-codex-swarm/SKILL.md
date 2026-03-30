---
name: tfx-codex-swarm
description: OMX 스킬을 활용하는 Codex 다중 세션 스폰 오케스트레이터. PRD/태스크 파일을 스캔하여 각각 독립 git worktree + psmux 세션���로 Codex를 full-auto 실행한다. 'codex swarm', 'codex 다중', '코덱스 스웜', '코덱스 다중 실행', 'PRD 일괄 실행', 'codex spawn', '코덱스 스폰', '다중 코덱스', 'swarm codex', 'omx swarm' 같은 요청에 반드시 사용. PRD가 여러 개이거나 병렬 Codex 실행이 필요한 모든 상황에 적극 활용.
---

# tfx-codex-swarm — Codex 다중 세션 스폰 오케스트레이터

> PRD/태스크 파일 N개를 각각 독립 worktree + psmux 세션으로 Codex full-auto 실행.
> AskUserQuestion 기반 인터랙티브 설정. 미지정 시 하네스가 자동 판단.

## 전제 조건

- `codex` CLI 설치됨
- `psmux` 설치됨 (세션 관리)
- `git` (worktree 생성)
- Windows Terminal (탭 기반 attach)
- triflux WT 프로파일 등록됨 (`wt.exe` settings.json에 `"name": "triflux"` 프로파일)
  - 미등록 시 Step 8 fallback으로 자동 전환 (프로파일 없이 기본 셸로 attach)

## 워크플로우

### Step 1: 태스크 파일 스캔

아래 경로를 순서대로 스캔하여 PRD/태스크 파일을 수집한다:

```
.omx/plans/*.md
.omc/plans/*.md
docs/prd/*.md
```

사용자가 경로를 명시했으면 해당 경로만 스캔.
파일이 0개면 → "태스크 파일을 찾을 수 없습니다" 보고 후 종료.

### Step 2: 태스크 선택

**사용자가 명시적��로 파일을 지정한 경우** → 바로 Step 3.

**미지정인 경우** → AskUserQuestion:

```
question: "어떤 태스크를 실행하시겠습니까?"
header: "태스크 선택"
options:
  - label: "전체 실행 ({N}개)"
    description: "스캔된 모든 태스크를 병렬 실행"
  - label: "선택 실행"
    description: "실행할 태스크를 하나��� 선택"
  - label: "최근 변경된 것만"
    description: "최근 24시간 내 수정된 태스���만 실행"
```

"선택 실행" 선택 시 → 파일 목록을 AskUserQuestion으로 하나씩 표시:

```
question: "이 태스크를 포함하시겠습니까?"
header: "{filename}"
options:
  - label: "포함"
  - label: "제외"
  - label: "나머지 전부 포함"
  - label: "나머��� 전부 제외"
```

### Step 3: 태스크 분류 및 Codex 스킬 매핑

#### 3-1. 설치된 스킬 캐시 참조

`tfx setup` 또는 `tfx update` 실행 시 Codex 설치 스킬을 스캔하여 캐시에 저장한다.
스웜 스킬은 매번 스캔하지 않고 **캐시 파일만 읽는다**.

```
캐시 경로: .omc/cache/codex-skills.json
생성 시점: tfx setup / tfx update
```

캐시 구조:
```json
{
  "scanned_at": "2026-03-30T16:00:00Z",
  "skills": [
    {"name": "autopilot", "role": "auto", "description": "Full autonomous execution..."},
    {"name": "ralph", "role": "persist", "description": "Persistent loop until..."},
    {"name": "plan", "role": "plan", "description": "Strategic planning..."}
  ]
}
```

캐시 미존재 시 → fallback으로 OMX 기본 매핑 사용 (하위 호환).

역할 매핑 기준 (tfx setup이 스캔 시 description에서 추출):

| 역할 | description 키워드 매칭 | 예시 |
|------|------------------------|------|
| 계획 (plan) | "plan", "계획", "decompos" | `$plan` |
| 자율 실행 (auto) | "autonomous", "자율", "auto-execute" | `$autopilot` |
| 반복 완료 (persist) | "loop", "반복", "completion", "persist" | `$ralph` |
| 조사 (investigate) | "investigate", "research", "조사" | `$plan` (단독) |
| 코드 리뷰 (review) | "review", "리뷰" | `$code-review` |

**스킬 0개인 경우** → 스킬 없이 프롬프트 직접 전달 (codex에 지시만 포함).

#### 3-2. 태스크 유형 분류

각 태스크 파일의 내용을 읽고 자동 분류한다:

| 유형 | 판별 기준 (파일 내용) | 기본 스킬 조합 |
|------|----------------------|---------------|
| 구현 (implement) | "구현", "implement", "추가", "변경", "fix" | plan → auto |
| 조사 (investigate) | "조사", "investigation", "재현", "reproduce" | plan (단독) |
| 리팩터링 (refactor) | "리팩터", "refactor", "정리", "개선" | plan → persist |

유형이 결정되면 3-1에서 발견한 스킬 중 해당 역할에 매칭되는 스킬을 자동 선택.
매칭 실패 시 → 프롬프트에 역할을 텍스트로 직접 기술.

#### 3-3. 사용자 오버라이드

**사용자가 스킬을 명시한 경우** → 해당 스킬 사용.

**미지정이고 자동 분류가 모호한 경우** → AskUserQuestion:

```
question: "어떤 Codex 스킬을 사용하시겠습니까?"
header: "설치된 스킬 ({N}개 발견)"
options:
  # 동적 생성: 발견된 스킬에서 옵션 구성
  - label: "${plan_skill} → ${auto_skill}"
    description: "{plan_skill.description} → {auto_skill.description}"
  - label: "${plan_skill} → ${persist_skill}"
    description: "계획 후 완료까지 반복 실행"
  - label: "${plan_skill} 만"
    description: "계획 수립만 (조사/분석용)"
  - label: "스킬 없이 실행"
    description: "프롬프트만 전달, $skill 미사용"
```

### Step 4: 프로파일 자동 라우팅

각 태스크의 규모와 유형에 따라 최적 Codex 프로파일을 자동 선택한다.
사용자가 프로파일을 명시하면 해당 프로파일로 고정.

#### 4-1. 태스크 규모 산정

PRD 파일을 읽고 아래 시그널에서 규모를 판단한다:

| 시그널 | 측정 방법 |
|--------|----------|
| PRD 길이 | 줄 수 (wc -l) |
| 영향 파일 수 | PRD 내 언급된 파일 경로 개수 |
| 키워드 복잡도 | "아키텍처", "마이그레이션", "리팩터링" 등 고비용 키워드 존재 |
| 의존성 깊이 | 다른 이슈/PRD 참조 여부 |

규모 분류:

| 규모 | PRD 줄 수 | 영향 파일 | 고비용 키워드 |
|------|-----------|----------|-------------|
| XL (대규모) | 80+ 줄 | 6+ 파일 | 2개 이상 |
| L (표준) | 40-80 줄 | 3-5 파일 | 0-1개 |
| M (경량) | 20-40 줄 | 1-2 파일 | 없음 |
| S (사소) | 20줄 미만 | 1 파일 | 없음 |

#### 4-2. 프로파일 라우팅 테이블

태스크 유형(Step 3)과 규모를 조합하여 프로파일을 결정한다:

| 유형 \ 규모 | XL | L | M | S |
|-------------|-----|-----|-----|-----|
| **구현** | `codex53_xhigh` | `codex53_high` | `codex53_med` | `codex53_low` |
| **조사** | `gpt54_high` | `gpt54_high` | `gpt54_low` | `mini54_med` |
| **리팩터링** | `codex53_xhigh` | `codex53_high` | `codex53_med` | `spark53_med` |
| **린트/포맷** | — | — | `spark53_med` | `spark53_low` |

프로파일은 `~/.codex/config.toml`의 v9 체계(`{model}{ver}_{effort}`)를 `-p` 플래그로 직접 참조한다.
`-c` 하드코딩은 사용하지 않는다. (레거시 `fast/normal/high` 프로파일도 사용하지 않는다.)

```bash
# 예시: -p 플래그로 프로파일 지정
codex -p codex53_high --dangerously-bypass-approvals-and-sandbox "prompt"
codex -p gpt54_high --dangerously-bypass-approvals-and-sandbox "prompt"
```

#### 4-3. 라우팅 결과 표시

프로파일 결정 후 테이블로 표시한다:

```
| # | 태스크 | 규모 | 유형 | 프로파일 |
|---|--------|------|------|----------|
| 24 | file-transfer | L | 구현 | codex53_high |
| 25 | resize-blank | L | 조사 | gpt54_high |
| 28 | guard-deadlock | M | 구현 | codex53_med |
| 30 | terminal-minimize | M | 조사 | gpt54_low |
```

사용자가 "프로파일 바꿔", "전부 xhigh로" 등을 언급한 경우에만 AskUserQuestion으로 오버라이드:

```
question: "프로파일 라우팅을 조정하시겠습니까?"
header: "프로파일"
options:
  - label: "자동 라우팅 유지"
    description: "태스크별 최적 프로파일 (위 테이블대로)"
  - label: "전체 고정"
    description: "모든 세션을 동일 프로파일로 실행"
  - label: "개별 조정"
    description: "태스크마다 수동 선택"
  - label: "전부 최고 사양"
    description: "codex53_xhigh 일괄 적용"
```

#### 4-4. 기타 설정 기본값

| 설정 | 기본값 | 설명 |
|------|--------|------|
| 실행 모드 | `--dangerously-bypass-approvals-and-sandbox --skip-git-repo-check` | YOLO (승인+샌드박스 완전 해제) |
| worktree | 활성화 | 세션당 독립 worktree |
| psmux | 활성화 | 세션 관리 |

### Step 5: Worktree 생성

각 태스크마다 독립 git worktree를 생성한다:

```bash
# 브랜치 + worktree 생성
git worktree add .codex-swarm/wt-issue-{N} -b codex/issue-{N} 2>/dev/null || \
git worktree add .codex-swarm/wt-issue-{N} codex/issue-{N}
```

워크트리 경로 규칙:
- `.codex-swarm/wt-issue-{N}` — 이슈 번호 기반
- `.codex-swarm/wt-{slug}` — 파일명 기반 (이슈 번호 없을 때)

### Step 6: 프롬프트 생성

각 태스크에 대해 프롬프트 파일을 생성한다:

```
.codex-swarm/prompts/prompt-{id}.md
```

프롬프트 구조:
```markdown
{PROJECT_NAME} 프로젝트의 태스크를 {유형}해야 합니다.

태스크 파일을 먼저 읽으세요: {원본_PRD_경로}

작업 순서:
1. 태스크 파일을 읽고 요구사항을 파악하세요
2. {OMX_스킬_지시}
3. {후속_지시}

프로젝트 정보:
- {PROJECT_NAME}: {PROJECT_DESC}
- 언어: {PROJECT_LANG}, 테스트: {PROJECT_TEST_CMD}
```

`{PROJECT_NAME}`, `{PROJECT_DESC}`, `{PROJECT_LANG}`, `{PROJECT_TEST_CMD}` 변수는 실행 시점에 자동 결정한다:

| 변수 | 결정 방법 |
|------|----------|
| `PROJECT_NAME` | `basename $(git rev-parse --show-toplevel)` |
| `PROJECT_DESC` | `package.json` → `description` 필드 (없으면 빈 문자열) |
| `PROJECT_LANG` | 루트에 `package.json` 있으면 "JavaScript/ESM (Node.js)", `*.py` 있으면 "Python", 그 외 자동 감지 |
| `PROJECT_TEST_CMD` | `package.json` → `scripts.test` 필드 (없으면 "테스트 없음") |

태스크 파일은 원본 경로를 참조하되, worktree에도 복사한다:
```bash
cp {PRD_PATH} .codex-swarm/wt-issue-{N}/{PRD_PATH}
```

### Step 7: psmux 세션 생성 + Codex 실행

각 태스크에 대해 psmux 세션을 생성하고 Codex를 실행한다:

```bash
# 세션 생성 (-s: 세션명, -d: detached 백그라운드)
# psmux 기본 셸이 PowerShell이므로, bash 런처 스크립트를 PowerShell에서 호출
psmux new-session -s "codex-swarm-{id}" -d

# bash 런처를 PowerShell 구문으로 실행 (경로는 Windows 형식)
BASH_WIN='C:\\Program Files\\Git\\bin\\bash.exe'
LAUNCH_DIR='C:\\path\\to\\.codex-swarm'
psmux send-keys -t "codex-swarm-{id}" \
  "& '$BASH_WIN' '$LAUNCH_DIR\\launch-{id}.sh'" Enter

# launch-{id}.sh 내용:
#   #!/bin/bash
#   cd /c/path/.codex-swarm/wt-issue-{N} || exit 1
#   prompt=$(cat /c/path/.codex-swarm/prompts/prompt-{id}.md)
#   exec codex -p {PROFILE} --dangerously-bypass-approvals-and-sandbox "$prompt"
#
# {PROFILE}은 Step 4 라우팅 결과: codex53_high, gpt54_high 등 (v9 체계)
# --dangerously-bypass-approvals-and-sandbox: 진짜 YOLO (승인+샌드박스 완전 해제)
# --skip-git-repo-check: codex exec 전용이므로 대화식 모드에서 사용 불가
```

### Step 8: WT 탭 일괄 attach

모든 세션을 하나의 WT 윈도우에 탭으로 attach한다:

```bash
# triflux WT 프로파일(-p triflux)로 모든 세션을 하나의 윈도우에 탭으로 attach
BASH_EXE='C:\Program Files\Git\bin\bash.exe'
wt.exe -w new \
  -p triflux --title "{title1}" "$BASH_EXE" -c "psmux attach-session -t codex-swarm-{id1}" \; \
  new-tab -p triflux --title "{title2}" "$BASH_EXE" -c "psmux attach-session -t codex-swarm-{id2}" \; \
  ...
```

triflux WT 프로파일이 없는 환경에서는 직접 실행 fallback:
```bash
BASH_EXE='C:\Program Files\Git\bin\bash.exe'
wt.exe -w new \
  --title "{title1}" "$BASH_EXE" ".codex-swarm/launch-{id1}.sh" \; \
  new-tab --title "{title2}" "$BASH_EXE" ".codex-swarm/launch-{id2}.sh" \; \
  ...
```

### Step 9: 상태 보고

스폰 완료 후 요약 테이블을 표시:

```
| # | 태스크 | 유형 | OMX 스킬 | Worktree | 세션 |
|---|--------|------|----------|----------|------|
| 24 | file-transfer | 구현 | $plan→$autopilot | wt-issue-24 | codex-swarm-24 |
| 25 | resize-blank | 조사 | $plan | wt-issue-25 | codex-swarm-25 |
...
```

### Step 10: 후속 관리 (선택)

스폰 후 AskUserQuestion:

```
question: "세션이 모두 실행 중입니다. 추가 작업이 있습니까?"
header: "다음"
options:
  - label: "상태 확인"
    description: "각 세션의 진행 상태 조회"
  - label: "결과 수집"
    description: "완료된 세션의 변경사항 머지"
  - label: "세션 추가"
    description: "추가 태스크 스폰"
  - label: "완료"
    description: "작업 종료"
```

**상태 확인**:
```bash
for session in codex-swarm-*; do
  psmux capture-pane --session "$session" --lines 5
done
```

**결과 수집** (worktree → main 머지):
```bash
# 각 worktree에서 커밋 확인
cd .codex-swarm/wt-issue-{N}
git log --oneline main..HEAD

# 머지 (사용자 확인 후)
cd ../..
git merge codex/issue-{N}
git worktree remove .codex-swarm/wt-issue-{N}
```

## 에러 핸들링

### Worktree 생성 실패

```bash
git worktree add .codex-swarm/wt-issue-{N} -b codex/issue-{N}
# → fatal: 'codex/issue-{N}' is already checked out at ...
```

- 브랜치가 이미 존재하는 경우: 기존 브랜치를 재사용한다
  ```bash
  git worktree add .codex-swarm/wt-issue-{N} codex/issue-{N} 2>/dev/null || true
  ```
- worktree 경로가 이미 존재하는 경우: 경로 뒤에 `-v{timestamp}` suffix 추가
  ```bash
  git worktree add .codex-swarm/wt-issue-{N}-v$(date +%s) codex/issue-{N}
  ```
- `git worktree` 명령 자체가 실패하면 해당 태스크만 건너뛰고 나머지를 계속 실행한다. 스킵된 태스크는 Step 9 상태 보고에 `SKIP (worktree 실패)` 로 표시한다.

### psmux 세션 이름 충돌

```bash
psmux new-session -s "codex-swarm-{id}"
# → duplicate session: codex-swarm-{id}
```

- 기존 세션을 먼저 확인한다:
  ```bash
  psmux has-session -t "codex-swarm-{id}" 2>/dev/null && \
    psmux kill-session -t "codex-swarm-{id}"
  ```
- kill 실패 시 세션명에 `-v{timestamp}` suffix를 붙여 새 세션을 생성한다.
- 두 방법 모두 실패하면 해당 태스크를 스킵하고 Step 9에 `SKIP (세션 충돌)` 로 표시한다.

### codex 미설치

```bash
command -v codex >/dev/null 2>&1 || {
  echo "ERROR: codex CLI가 설치되어 있지 않습니다."
  echo "설치: npm install -g @openai/codex"
  exit 1
}
```

Step 1 진입 전에 사전 검사한다. 미설치 시 스캔을 시작하기 전에 즉시 중단한다.

### psmux 미설치

```bash
command -v psmux >/dev/null 2>&1 || {
  echo "ERROR: psmux가 설치되어 있지 않습니다."
  echo "설치: npm install -g psmux"
  exit 1
}
```

Step 1 진입 전에 사전 검사한다. 미설치 시 즉시 중단한다.

> 두 사전 검사(codex, psmux)를 하나의 preflight 블록으로 묶어 Step 1 전에 실행하는 것을 권장한다.

```bash
# preflight 검사
for bin in codex psmux git; do
  command -v "$bin" >/dev/null 2>&1 || {
    echo "ERROR: '$bin' 이(가) PATH에 없습니다. 설치 후 재시도하세요."
    exit 1
  }
done
```

## 정리

전체 스웜 종료 시:
```bash
# 세션 종료
for s in $(psmux list-sessions -F '#{session_name}' 2>/dev/null | grep codex-swarm); do
  psmux kill-session -t "$s"
done

# worktree 정리 (머지 완료된 것만)
git worktree prune
rm -rf .codex-swarm/
```
