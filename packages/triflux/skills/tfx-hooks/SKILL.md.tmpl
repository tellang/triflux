---
name: tfx-hooks
description: >
  Claude Code 훅 우선순위 관리자. AskUserQuestion 기반 인터랙티브 UI로
  훅 스캔, 우선순위 조정, 오케스트레이터 적용/복원, 개별 훅 토글을 수행합니다.
  사용자가 훅, hooks, 훅 관리, hook priority, 훅 우선순위, 오케스트레이터,
  orchestrator, 훅 설정, hook 설정, 훅 순서, hook order를 언급할 때마다
  반드시 이 스킬을 사용하세요.
  Use when: hooks, 훅, hook priority, 훅 관리, orchestrator, 오케스트레이터, 훅 설정, 훅 순서
triggers:
  - tfx-hooks
argument-hint: "[scan|apply|restore]"
---

# tfx-hooks — 훅 우선순위 관리자

> Claude Code 훅의 실행 순서를 관리합니다. triflux 훅이 항상 최우선 실행되도록 보장합니다.

## 핵심 개념

Claude Code는 같은 이벤트에 매칭된 훅을 **병렬 실행**합니다. 순서 보장이 불가능합니다.
triflux의 **hook-orchestrator**는 이벤트당 하나의 진입점을 두고, 내부에서 **우선순위대로 순차 실행**합니다.

```
settings.json → hook-orchestrator.mjs (단일 진입점)
                    ↓ hook-registry.json 읽기
                    ↓ priority 순 정렬
                    1. triflux 훅 (priority=0)
                    2. OMC 훅 (priority=50)
                    3. 외부 훅 (priority=100)
```

## 워크플로우

### Step 1: 현재 상태 확인

```bash
Bash("node hooks/hook-manager.mjs status")
```

결과 JSON에서 `orchestrated` 필드로 적용 여부를 판단한다.

### Step 2: 메인 메뉴 (AskUserQuestion)

```
question: "훅 관리 — 어떤 작업을 수행하시겠습니까?"
header: "Hook Manager"
options:
  - label: "현재 상태 보기"
    description: "settings.json 훅 스캔 + 오케스트레이터 적용 상태"
  - label: "오케스트레이터 적용"
    description: "모든 훅을 통합 — triflux 최우선 실행 보장"
  - label: "변경점 미리보기 (diff)"
    description: "적용 시 어떻게 바뀌는지 확인"
  - label: "원래대로 복원"
    description: "오케스트레이터 제거, 원래 settings.json 훅으로 복원"
  - label: "개별 훅 관리"
    description: "특정 훅 활성/비활성, 우선순위 변경"
```

### Step 3: 선택에 따른 분기

#### "현재 상태 보기"

```bash
Bash("node hooks/hook-manager.mjs scan")
```

결과 JSON을 파싱하여 테이블로 표시:

```markdown
## 현재 훅 상태

| 이벤트 | 훅 수 | 소스 |
|--------|-------|------|
| SessionStart | 4 | triflux(3), session-vault(1) |
| PreToolUse | 3 | triflux(1), omc(2) |
| ...    | ...   | ... |

오케스트레이터: ❌ 미적용 / ✅ 적용됨 (N개 이벤트)
```

#### "오케스트레이터 적용"

먼저 diff를 보여준 후 확인:

```bash
Bash("node hooks/hook-manager.mjs diff")
```

결과를 표시한 뒤 AskUserQuestion:
```
question: "위 변경을 적용하시겠습니까?"
header: "확인"
options:
  - label: "적용"
    description: "settings.json 백업 후 오케스트레이터 적용"
  - label: "취소"
    description: "변경 없이 돌아가기"
```

"적용" 선택 시:
```bash
Bash("node hooks/hook-manager.mjs apply")
```

적용 결과 표시:
```
✅ 오케스트레이터 적용 완료
   N개 이벤트 → 1개 오케스트레이터로 통합
   실행 순서: triflux(0) → OMC(50) → external(100)
   복원: /tfx-hooks → 원래대로 복원
   또는: triflux hooks restore
```

#### "변경점 미리보기 (diff)"

```bash
Bash("node hooks/hook-manager.mjs diff")
```

결과를 테이블로 표시:
```markdown
| 이벤트 | 현재 | 적용 후 | 변경 |
|--------|------|---------|------|
| PreToolUse | 2개 개별 | 1개 오케스트레이터 (내부 4개) | 교체 |
| PostToolUse | 없음 | 1개 오케스트레이터 (내부 1개) | 신규 |
| ... | ... | ... | ... |
```

#### "원래대로 복원"

```bash
Bash("node hooks/hook-manager.mjs restore")
```

결과에서 status를 확인:
- `"restored"` → "✅ 원래 훅 설정이 복원되었습니다."
- `"no_backup"` → "⚠️ 백업이 없습니다. 오케스트레이터를 적용한 적이 없습니다."

#### "개별 훅 관리"

레지스트리에서 전체 훅 목록을 읽어 표시:

```bash
Bash("node -e \"const r=JSON.parse(require('fs').readFileSync('hooks/hook-registry.json','utf8')); const all=[]; for(const [e,hs] of Object.entries(r.events)) hs.forEach(h=>all.push({event:e,...h})); console.log(JSON.stringify(all))\"")
```

결과를 테이블로 표시 후 AskUserQuestion:
```
question: "어떤 훅을 관리하시겠습니까?"
header: "훅 선택"
options:
  (레지스트리의 각 훅을 옵션으로 나열)
  - label: "tfx-safety-guard"
    description: "[PreToolUse:Bash] 위험 명령 차단 — priority:0, 활성"
  - label: "tfx-agent-route-guard"
    description: "[PreToolUse:Agent] 에이전트 라우팅 — priority:0, 활성"
  - label: "omc-headless-guard"
    description: "[PreToolUse:Bash|Agent] headless 가드 — priority:50, 활성"
  ...
```

훅 선택 후 AskUserQuestion:
```
question: "{hookId} — 어떤 조작을 하시겠습니까?"
header: "훅 조작"
options:
  - label: "활성/비활성 토글"
    description: "현재: 활성 → 비활성으로 전환"
  - label: "우선순위 변경"
    description: "현재: 0 — 숫자가 낮을수록 먼저 실행"
  - label: "뒤로"
    description: "훅 목록으로 돌아가기"
```

"활성/비활성 토글":
```bash
Bash("node hooks/hook-manager.mjs toggle {hookId}")
```

"우선순위 변경":
AskUserQuestion으로 새 우선순위 입력:
```
question: "새 우선순위를 입력하세요 (0=최우선, 50=중간, 100=후순위)"
header: "Priority"
```
```bash
Bash("node hooks/hook-manager.mjs set-priority {hookId} {newPriority}")
```

변경 후 오케스트레이터가 적용된 상태라면 재적용 안내:
```
💡 레지스트리가 변경되었습니다. 오케스트레이터는 실시간으로 레지스트리를 읽으므로 재적용 불필요합니다.
```

## CLI 대응

| 스킬 UI | CLI 명령 |
|---------|---------|
| 현재 상태 보기 | `triflux hooks scan` |
| 오케스트레이터 적용 | `triflux hooks apply` |
| 변경점 미리보기 | `triflux hooks diff` |
| 원래대로 복원 | `triflux hooks restore` |
| 상태 확인 | `triflux hooks status` |
| 훅 토글 | `triflux hooks toggle <hookId>` |
| 우선순위 변경 | `triflux hooks set-priority <hookId> <priority>` |

## 에러 처리

| 상황 | 처리 |
|------|------|
| hook-registry.json 없음 | "레지스트리가 없습니다. triflux hooks 디렉토리를 확인하세요." |
| settings.json 파싱 실패 | "settings.json이 손상되었습니다. 수동 확인이 필요합니다." |
| 백업 없이 복원 시도 | "오케스트레이터를 적용한 적이 없어 복원할 수 없습니다." |
| hook-manager.mjs 실행 실패 | "hook-manager를 실행할 수 없습니다. node hooks/hook-manager.mjs를 직접 실행해 보세요." |
