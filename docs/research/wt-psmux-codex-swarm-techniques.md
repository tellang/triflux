---
title: Windows Terminal + psmux + Codex 통합 기법
description: WT 멀티탭, psmux 세션 관리, Codex YOLO 모드, git worktree 병렬 격리를 활용한 대규모 에이전트 스웜 오케스트레이션
date: 2026-03-30
type: research
status: verified
---

# Windows Terminal + psmux + Codex 스웜 기법 가이드

이 문서는 triflux v8에서 구현된 고급 에이전트 조율 기법을 다룬다. Windows Terminal 네이티브 멀티탭, psmux 세션 격리, Codex의 YOLO 모드를 조합하여 대규모 병렬 작업 스웜을 효율적으로 구성한다.

---

## 1. psmux 세션 관리

### 1.1 핵심 명령어

psmux는 tmux 기반의 세션 관리자다. triflux와의 통합을 위해 다음 명령 체인을 사용한다.

#### 세션 생성 및 명령 실행

```bash
# 세션 생성 (detached 모드 — 즉시 백그라운드 실행)
psmux new-session -s mywork -d

# 세션 내 첫 팬에 명령 전송
psmux send-keys -t mywork:0 'bash script.sh' Enter

# 명령 출력 캡처 (현재 팬 콘텐츠)
psmux capture-pane -t mywork:0 -p

# 타겟 팬 지정 (세션:윈도우.팬 인덱싱)
psmux send-keys -t mywork:1.2 'echo hello' Enter
```

#### 세션 제어 및 정리

```bash
# 세션 목록 조회
psmux list-sessions

# 특정 세션에 연결된 클라이언트 수
psmux list-clients -t mywork

# 세션 종료 (모든 팬 클로즈)
psmux kill-session -t mywork

# 전체 서버 종료
psmux kill-server
```

### 1.2 PowerShell → bash 명령 전달

Windows에서 PowerShell이 기본 셸일 때 bash 스크립트 실행:

```powershell
# 방법 1: Git Bash 전체 경로 + 호출 연산자 (&)
& 'C:\Program Files\Git\bin\bash.exe' -c 'echo "Hello from bash"'

# 방법 2: psmux와 조합 (세션 내 bash 명령)
psmux send-keys -t work:0 "& 'C:\Program Files\Git\bin\bash.exe' -c 'cd /path && npm run build'" Enter

# 방법 3: 쉘 이스케이프 (큰따옴표 내부에서 JSON 형식)
$cmd = @"
`"C:\Program Files\Git\bin\bash.exe`" -c `"cd /c/project && ls -la`"
"@
psmux send-keys -t work:0 $cmd Enter
```

### 1.3 완료 마커 폴링

psmux에서 명령 완료를 감지하려면 exit code를 획득해야 한다:

```bash
# 전략 1: 파이프 토큰 주입 (특수 문자열 마킹)
TOKEN="__TRIFLUX_DONE__:$(date +%s%N)"
psmux send-keys -t work:0 "npm run build && echo '$TOKEN' \$?" Enter

# 전략 2: 타이틀 변경으로 상태 표시
psmux send-keys -t work:0 "npm run build; psmux select-window -t work:0 -T '[DONE]'" Enter

# 전략 3: 로그 파일 감시
psmux send-keys -t work:0 "npm run build > /tmp/work.log 2>&1; touch /tmp/work.done" Enter
```

---

## 2. Windows Terminal 프로파일 통합

### 2.1 triflux WT 프로필 설정

`%LOCALAPPDATA%\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json`:

```json
{
    "profiles": {
        "defaults": {
            "fontFace": "Cascadia Mono",
            "fontSize": 11
        },
        "list": [
            {
                "name": "triflux",
                "guid": "{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}",
                "commandline": "C:\\Program Files\\Git\\bin\\bash.exe",
                "startingDirectory": "C:\\Users\\SSAFY\\Desktop\\Projects\\cli\\triflux",
                "icon": "⚡",
                "opacity": 95,
                "useAcrylic": true,
                "cursorShape": "bar",
                "colorScheme": "One Half Dark",
                "environment": {
                    "SHELL": "/usr/bin/bash",
                    "PATH": "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
                }
            },
            {
                "name": "pwsh",
                "guid": "{574E775E-4F2A-5B93-B3D0-E3E0A8000001}",
                "commandline": "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
                "startingDirectory": "%USERPROFILE%"
            }
        ]
    }
}
```

### 2.2 CLI에서 멀티탭 열기

#### 단일 탭 (기본)

```bash
wt.exe -p triflux --title "Issue #24"
```

#### 복합 레이아웃 (여러 탭 + 분할)

```bash
wt.exe -w new \
  -p triflux --title "Issue #24" \; \
  new-tab -p triflux --title "Issue #25" \; \
  new-tab -p pwsh --title "Logs" \; \
  split-pane -H -p triflux --title "Issue #26"
```

#### PowerShell에서 실행 (백틱 이스케이프)

```powershell
$wt = "C:\Program Files\WindowsApps\Microsoft.WindowsTerminal_*\wt.exe"
& $wt -w new `
  -p triflux --title "Issue #24" `; `
  new-tab -p triflux --title "Issue #25" `; `
  split-pane -H -p triflux --title "Issue #26"
```

### 2.3 프로필 자동 생성 (ensureWtProfile)

triflux는 실행 시 필요한 프로필을 자동 생성/갱신한다:

```javascript
// hub/team/headless.mjs 사용 예
import { ensureWtProfile } from './headless.mjs';

// 워커 수에 따라 동적 폰트/분할 비율 설정
const workerCount = 6;
await ensureWtProfile(workerCount);

// 생성되는 프로필:
// - 폰트: max(6, parentFont - 1 - floor(workerCount/2))
// - 분할 크기: min(0.6, 0.2 + workerCount * 0.05)
// - Opacity: 40 (포커스) / 20 (비포커스)
```

---

## 3. Codex YOLO 모드

### 3.1 플래그 설명

Codex CLI는 승인 및 샌드박스 제어를 위한 플래그를 제공한다:

| 플래그 | 효과 | 사용처 |
|-------|------|-------|
| `--full-auto` | 샌드박스 자동 승인 (기본 보안 유지) | 일반 작업 |
| `--dangerously-bypass-approvals-and-sandbox` | 승인 + 샌드박스 **완전 해제** | YOLO 스웜 (대규모 병렬) |
| `--skip-git-repo-check` | git 저장소 확인 스킵 | codex exec 전용 |

### 3.2 YOLO 모드 실행

```bash
# 프로필 지정 + YOLO 모드
codex -p codex53_high --dangerously-bypass-approvals-and-sandbox \
  "구현 프롬프트를 여기에"

# 다중 워커 스웜
for i in {1..6}; do
  codex -p codex53_high --dangerously-bypass-approvals-and-sandbox \
    "워커 #$i 작업: $(cat prompts/task-$i.md)" &
done
wait
```

### 3.3 프로필 및 모델/effort 라우팅

v9 프로필 시스템은 모델과 effort를 함께 관리한다:

```bash
# codex53 (GPT-5.3 Codex)
codex -p codex53_high       # model=gpt-5.3-codex, effort=high
codex -p codex53_xhigh      # model=gpt-5.3-codex, effort=xhigh

# gpt54 (GPT-5.4 — 분석용)
codex -p gpt54_high         # model=gpt-5.4, effort=high
codex -p gpt54_xhigh        # model=gpt-5.4, effort=xhigh

# spark53 (경량)
codex -p spark53_low        # model=gpt-5.3-codex-spark, effort=low
```

### 3.4 프롬프트에서 OMC 스킬 호출

**주의:** `$skill` 트리거는 **대화식 모드(interactive)에서만 동작한다.**

```bash
# 대화식: 스킬 호출 가능
codex -p codex53_high << 'EOF'
코드를 구현해주세요.
$autopilot
EOF

# 비대화식 (codex exec): 스킬 호출 불가
codex exec "코드를 구현해주세요. $autopilot" \
  --dangerously-bypass-approvals-and-sandbox
  # ❌ $autopilot이 인식되지 않음
```

**해결책:** 프롬프트에 `$skillname` 키워드를 포함하면 Codex가 인식한다:

```bash
# 프롬프트 파일에 스킬 이름 포함
cat > prompt.md << 'EOF'
구현 태스크입니다.
호출할 스킬: $autopilot

[실제 프롬프트 내용...]
EOF

codex -p codex53_high --dangerously-bypass-approvals-and-sandbox \
  "$(cat prompt.md)"
```

---

## 4. git worktree 병렬 격리

### 4.1 기본 패턴

각 병렬 작업을 독립 worktree에서 실행하면 merge conflict 없이 안전하게 진행할 수 있다:

```bash
# 워크트리 생성
git worktree add .codex-swarm/wt-issue-24 -b codex/issue-24

# 워크트리 내에서 작업
cd .codex-swarm/wt-issue-24
npm install
npm run test

# 작업 완료 후 병합
cd ../..
git merge codex/issue-24
git worktree remove .codex-swarm/wt-issue-24
```

### 4.2 다중 워크트리 생성 (병렬 인덱싱)

```bash
# 6개 워커용 워크트리 자동 생성
for i in {24..29}; do
  git worktree add ".codex-swarm/wt-issue-$i" -b "codex/issue-$i" &
done
wait

# 디렉토리 구조
# .codex-swarm/
# ├── wt-issue-24/  (worker 1)
# ├── wt-issue-25/  (worker 2)
# ├── wt-issue-26/  (worker 3)
# ├── wt-issue-27/  (worker 4)
# ├── wt-issue-28/  (worker 5)
# ├── wt-issue-29/  (worker 6)
# ├── prompts/      (공유 프롬프트)
# └── launch-*.sh   (실행 스크립트)
```

### 4.3 워크트리 내 Codex 실행

각 워크트리는 독립적인 코드베이스를 가지므로 동시 실행 가능:

```bash
# wt-issue-24 내에서
cd .codex-swarm/wt-issue-24
codex -p codex53_high --dangerously-bypass-approvals-and-sandbox \
  "$(cat ../prompts/prompt-24.md)" > result-24.md 2>&1

# wt-issue-25 내에서 (병렬)
cd .codex-swarm/wt-issue-25
codex -p codex53_high --dangerously-bypass-approvals-and-sandbox \
  "$(cat ../prompts/prompt-25.md)" > result-25.md 2>&1
```

### 4.4 정리 (자동화)

```bash
# 모든 워크트리 제거
for dir in .codex-swarm/wt-issue-*; do
  branch=$(basename "$dir" | sed 's/wt-/codex\//')
  git merge "$branch" 2>/dev/null || echo "Skipped merge of $branch"
  git worktree remove "$dir"
  git branch -D "$branch"
done
```

---

## 5. OMC (oh-my-claudecode) 스킬 호출

### 5.1 스킬과 대화식/비대화식 모드

**대화식 모드:** 사용자 입력이 있는 상황 (대화형 프롬프트)
**비대화식 모드:** codex exec 또는 자동화 파이프라인

| 스킬 | 대화식 | 비대화식 | 예시 |
|-----|--------|---------|------|
| `$autopilot` | ✓ | ✗ | 사용자가 대화 중 호출 |
| `$ralph` | ✓ | ✗ | 대화식 자동실행 모드 |
| `$skill` (일반) | ✓ | ✗ | Tier-0 워크플로 |

### 5.2 비대화식 모드에서 스킬 사용

codex exec에서는 직접 스킬을 호출할 수 없으므로, **프롬프트에 지시사항을 통합**한다:

```bash
# 패턴 1: 프롬프트에 액션 기술
codex exec "
코드를 구현해주세요.

## 자동화 액션
- 구현 완료 후 테스트 실행
- 테스트 통과 후 PR 작성
" --dangerously-bypass-approvals-and-sandbox

# 패턴 2: 사전 계획 문서 참조
cat > .codex-swarm/task-plan.md << 'EOF'
## 작업 계획 (autopilot 스타일)
1. 코드 구현
2. 테스트 작성
3. 검토 요청
EOF

codex exec \
  "$(cat .codex-swarm/task-plan.md)" \
  --dangerously-bypass-approvals-and-sandbox
```

---

## 6. 프로필 자동 라우팅 매트릭스

### 6.1 작업 유형 × 규모 매트릭스

delegator-mcp.mjs에서 정의된 에이전트별 프로필 매핑:

```javascript
// hub/workers/delegator-mcp.mjs
const AGENT_PROFILE_MAP = {
  // 구현 계열 (codex53)
  executor: 'codex53_high',
  'build-fixer': 'codex53_low',
  'code-reviewer': 'codex53_high',
  'security-reviewer': 'codex53_high',
  'quality-reviewer': 'codex53_high',
  'document-specialist': 'codex53_high',

  // 분석 계열 (gpt54 — 심화 추론)
  'deep-executor': 'gpt54_xhigh',
  architect: 'gpt54_xhigh',
  planner: 'gpt54_xhigh',
  analyst: 'gpt54_xhigh',

  // 경량 (spark53)
  spark: 'spark53_low',
};
```

---

## 7. 통합 예제: 6워커 스웜 실행

### 7.1 구조

```
.codex-swarm/
├── wt-issue-24/  (codex exec, gpt-5.3-codex)
├── wt-issue-25/  (codex exec, gpt-5.4)
├── wt-issue-26/  (codex exec, gpt-5.3-codex)
├── wt-issue-27/  (codex exec, gpt-5.3-codex)
├── wt-issue-28/  (codex exec, gpt-5.3-codex)
├── wt-issue-29/  (codex exec, gpt-5.3-codex)
├── prompts/
│   ├── prompt-24.md
│   ├── prompt-25.md
│   └── ... (6개)
├── launch-24.sh
├── launch-25.sh
└── ... (6개)
```

### 7.2 초기화 스크립트

```bash
#!/usr/bin/env bash
# setup-swarm.sh

set -euo pipefail

SWARM_ROOT=".codex-swarm"
ISSUE_RANGE=(24 25 26 27 28 29)
PROFILES=("codex53_high" "gpt54_high" "codex53_high" "codex53_high" "codex53_high" "codex53_high")

mkdir -p "$SWARM_ROOT/prompts"

# 워크트리 생성
for i in "${!ISSUE_RANGE[@]}"; do
  issue="${ISSUE_RANGE[$i]}"
  git worktree add "$SWARM_ROOT/wt-issue-$issue" -b "codex/issue-$issue" || true
done

# 프롬프트 및 실행 스크립트 생성
for i in "${!ISSUE_RANGE[@]}"; do
  issue="${ISSUE_RANGE[$i]}"
  profile="${PROFILES[$i]}"

  cat > "$SWARM_ROOT/prompts/prompt-$issue.md" << EOF
## 이슈 #$issue
[프롬프트 내용...]
EOF

  cat > "$SWARM_ROOT/launch-$issue.sh" << 'SCRIPT'
#!/usr/bin/env bash
cd "$(dirname "$(readlink -f "$0")")/../wt-issue-$issue" || exit 1
echo "Worktree: $(pwd)"
prompt="\$(cat "../prompts/prompt-$issue.md")"
codex -p $profile --dangerously-bypass-approvals-and-sandbox "\$prompt"
SCRIPT
  chmod +x "$SWARM_ROOT/launch-$issue.sh"
done
```

### 7.3 병렬 실행

```bash
# WT에서 6개 탭 동시 오픈
wt.exe -w new \
  -p triflux --title "Issue #24" \; \
  new-tab -p triflux --title "Issue #25" \; \
  new-tab -p triflux --title "Issue #26" \; \
  new-tab -p triflux --title "Issue #27" \; \
  new-tab -p triflux --title "Issue #28" \; \
  new-tab -p triflux --title "Issue #29"

# 각 탭에서 순차 실행
cd .codex-swarm
bash launch-24.sh  # 탭 1에서
bash launch-25.sh  # 탭 2에서
# ... (나머지 탭)
```

또는 **배경 작업으로 병렬 실행**:

```bash
for i in {24..29}; do
  bash ".codex-swarm/launch-$i.sh" > ".codex-swarm/result-$i.log" 2>&1 &
done
wait

# 결과 확인
for i in {24..29}; do
  echo "=== Issue #$i ==="
  head -20 ".codex-swarm/result-$i.log"
done
```

---

## 8. 주의사항 및 최적화

### 8.1 psmux 세션 정리

장시간 실행 후 좀비 세션이 남을 수 있다:

```bash
# 모든 세션 나열
psmux list-sessions

# 특정 세션 강제 종료
psmux kill-session -t stale_session

# 서버 재시작 (모든 세션 제거)
psmux kill-server
sleep 1
psmux list-sessions  # 확인
```

### 8.2 git worktree 충돌 회피

여러 워크트리에서 같은 파일을 수정 시 merge conflict 발생:

```bash
# 선제적 rebase (최신 main 반영)
for dir in .codex-swarm/wt-issue-*; do
  (cd "$dir" && git rebase origin/main) || echo "Rebase failed in $dir"
done

# 또는 cherry-pick (선택적 커밋 통합)
git cherry-pick $(git rev-list codex/issue-24...HEAD)
```

### 8.3 Windows Terminal 성능 최적화

많은 탭 동시 실행 시:

```json
{
    "profiles": {
        "defaults": {
            "fontSize": 8,
            "opacity": 85,
            "useAcrylic": false,
            "cursorShape": "box"
        }
    }
}
```

- **fontSize**: 6~8 (화면 적재 감소)
- **useAcrylic**: false (GPU 부하 감소)
- **opacity**: 85% (시각적 폭쓸림 감소)

### 8.4 Codex 타임아웃 관리

대규모 프롬프트는 xhigh effort 필요:

```bash
# 타임아웃 증가
timeout 600 codex -p codex53_xhigh \
  --dangerously-bypass-approvals-and-sandbox \
  "$(cat large_prompt.md)"
```

---

## 9. 검증 체크리스트

문서 작성 기준 (2026-03-30) 검증 결과:

- [x] psmux 명령어 시스템 작동 확인
  - new-session, send-keys, capture-pane, kill-session 테스트됨
  - Windows Git Bash에서 bash 호출 검증됨

- [x] Windows Terminal 프로필 설정 문법 확인
  - settings.json 스키마 (v1.20+) 검증
  - wt.exe 멀티탭 구문 테스트됨

- [x] Codex 플래그 동작 확인
  - `--dangerously-bypass-approvals-and-sandbox` 정상 작동
  - `-p codex53_high` 등 프로필 라우팅 검증됨

- [x] git worktree 격리 검증
  - 병렬 worktree 생성/삭제 테스트됨
  - merge 충돌 회피 전략 입증됨

- [x] OMC 스킬 호출 제약 확인
  - 대화식 vs 비대화식 모드 차이 문서화됨

---

## 참고 자료

- [psmux 공식 문서](https://github.com/tmux/tmux)
- [Windows Terminal CLI 레퍼런스](https://learn.microsoft.com/windows/terminal/command-line-arguments)
- [Codex 공식 문서](https://openai.com/docs/)
- [triflux delegator-mcp.mjs](../../hub/workers/delegator-mcp.mjs)
