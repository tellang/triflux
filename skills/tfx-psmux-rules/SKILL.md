---
name: tfx-psmux-rules
description: >
  psmux + Codex CLI 명령 생성 시 반드시 적용되는 강제 규칙. PowerShell/bash 구분,
  경로 형식, 인자 이스케이프, WT 정리, 프로파일 지정 방식 등을 검증한다.
  이 스킬은 psmux, send-keys, codex exec, codex spawn, 세션 생성, worktree 실행,
  launch 스크립트 생성, WT attach, 패널 스플릿, 스웜 정리 시 자동 트리거된다.
  다른 스킬(tfx-codex-swarm, tfx-multi, tfx-remote-spawn 등)이 psmux 명령을
  생성할 때 이 스킬의 규칙을 위반하면 생성을 중단하고 수정해야 한다.
triggers:
  - tfx-psmux-rules
  - psmux-rules
---

# tfx-psmux-rules — psmux + Codex CLI 강제 규칙

> **이 스킬은 참고 문서가 아니다. 강제 규칙이다.**
> psmux 명령, launch 스크립트, Codex CLI 호출을 생성하는 모든 스킬은
> 아래 규칙을 **반드시** 준수해야 한다. 위반 시 생성을 중단하고 수정한다.

## 적용 시점

다음 행위 중 하나라도 수행할 때 이 규칙이 자동 적용된다:
- `psmux send-keys` 명령 생성
- `launch-*.sh` 또는 `launch-*.ps1` 스크립트 생성
- `codex` CLI 호출 인자 조합
- `wt.exe` 탭/패인 명령 생성
- 스웜 세션 정리

---

## RULE 1: psmux 기본 셸 = PowerShell

psmux 세션의 기본 셸은 **PowerShell**이다.

### MUST NOT (금지)

```bash
# WRONG — bash 문법을 PowerShell 세션에 직접 전달
psmux send-keys -t session "cd '/c/Users/...' && codex ..." Enter
psmux send-keys -t session "prompt=\$(cat file.md)" Enter
psmux send-keys -t session "export FOO=bar" Enter
```

### MUST (필수)

```bash
# CORRECT — PowerShell 구문으로 bash.exe 전체 경로 호출
BASH_WIN='C:\\Program Files\\Git\\bin\\bash.exe'
psmux send-keys -t session "& '$BASH_WIN' './launch.sh'" Enter

# CORRECT — PowerShell 네이티브 명령 사용
psmux send-keys -t session "Set-Location 'C:\\path'" Enter
psmux send-keys -t session "\$p = Get-Content 'file.md' -Raw" Enter
```

### 금지 패턴 체크리스트

| 패턴 | 문제 | 대체 |
|------|------|------|
| `cd '/c/...'` | PS가 `/c/`를 상대경로로 해석 → `C:\c\...` | `Set-Location 'C:\...'` |
| `$(cat file)` | bash 명령 치환, PS에서 `Get-Content` 호출됨 | `$p = Get-Content file -Raw` |
| `&&` | PS7에서 작동하지만 앞 명령 실패 시 의미 다름 | `;` 또는 별도 send-keys |
| `export VAR=val` | bash 전용 | `$env:VAR = 'val'` |
| `grep`, `awk`, `sed` | bash 유틸리티 | PS cmdlet 또는 bash.exe 경유 |

---

## RULE 2: 경로는 Windows 형식

psmux send-keys로 전달하는 경로는 반드시 **Windows 형식**이다.

```
WRONG:  /c/Users/SSAFY/Desktop/Projects/...
RIGHT:  C:\Users\SSAFY\Desktop\Projects\...
```

`.sh` 런처 내부에서만 Unix 경로(`/c/...`) 사용 가능.

---

## RULE 3: 프롬프트 인자 인용 필수

PRD/프롬프트 내용을 CLI 인자로 전달할 때 **반드시 인용**한다.

### PowerShell (.ps1)

```powershell
$p = (Get-Content 'prompt.md' -Raw) -replace "`r`n"," " -replace "`n"," "

# MUST — 인용 필수
codex -c 'model="gpt-5.3-codex"' "$p"

# MUST NOT — 미인용 시 & ; | 등이 PS 연산자로 해석됨
codex -c 'model="gpt-5.3-codex"' $p
```

### Bash (.sh)

```bash
prompt=$(cat prompt.md)

# MUST — 더블쿼트 필수
exec codex "$prompt"

# MUST NOT — 워드 스플리팅 + 글로빙 발생
exec codex $prompt
```

---

## RULE 4: 프로파일 사용, 인자 하드코딩 금지

Codex든 Gemini든 **모델·effort·실행모드는 프로파일(config)로 관리**한다.
CLI 인자로 하드코딩하지 않는다.

### 4-1. 프로파일 우선

```bash
# CORRECT — 프로파일에 model/effort/approval_mode 모두 정의해두고 호출
codex < prompt.md
codex --full-auto < prompt.md   # config.toml에 approval_mode 미설정 시만

# WRONG — 인자로 모델·effort 하드코딩
codex -c 'model="gpt-5.3-codex"' -c 'model_reasoning_effort="high"' "prompt"
```

프로파일 관리는 `tfx-profile` 스킬 또는 `~/.codex/config.toml` 직접 편집.

### 4-2. config.toml 중복 플래그 금지

config.toml에 이미 설정된 값을 CLI 플래그로 다시 지정하면 **에러**:
```
error: the argument '--dangerously-bypass-approvals-and-sandbox' cannot be used multiple times
```

**규칙**: 런처 생성 전 config.toml을 확인하고, 이미 있는 항목은 CLI에서 생략.

### 4-3. 프롬프트는 stdin으로 전달

프롬프트를 CLI 인자로 넘기면 `--` 접두사 텍스트가 플래그로 파싱되는 문제 발생.
**항상 stdin(파이프 또는 리다이렉션)으로 전달한다.**

```bash
# bash 런처
exec codex < /c/path/prompts/prompt.md
```

```powershell
# PS1 런처
Get-Content 'C:\path\prompts\prompt.md' -Raw | codex
```

---

## RULE 5: WT 패인 정리 (프리징 방지)

WT 패인이 psmux 세션에 attach된 상태에서 `kill-session`하면 WT가 프리징된다.

### MUST (3단계 정리)

```bash
# 1) graceful exit
for s in $(psmux list-sessions -F '#{session_name}' 2>/dev/null | grep codex-swarm); do
  psmux send-keys -t "$s" "exit" Enter 2>/dev/null || true
done

# 2) WT 패인 종료 대기
sleep 2

# 3) 잔여 세션 강제 종료
for s in $(psmux list-sessions -F '#{session_name}' 2>/dev/null | grep codex-swarm); do
  psmux kill-session -t "$s" 2>/dev/null || true
done
```

### MUST NOT

```bash
# WRONG — WT 프리징 발생
for s in $(psmux list-sessions -F '#{session_name}' 2>/dev/null | grep codex-swarm); do
  psmux kill-session -t "$s"
done
```

---

## RULE 6: spark53 프로파일은 Pro 전용

`spark53_med`, `spark53_low` 등 spark 모델 프로파일은 **Codex Pro 구독 전용**이다.
비-Pro 환경에서는 `codex53_low`로 폴백한다.

---

## RULE 7: WT 레이아웃 선택 필수

WT에 패인을 배치하기 전에 **반드시** 사용자에게 레이아웃을 확인한다.
새 탭(`nt`)은 금지 — split + dashboard가 기본.

선택지: 새 창에서 스플릿 / 현재 창에서 스플릿 / dashboard / attach 안 함

---

## 위반 감지 시 행동

1. 생성한 명령/스크립트가 위 규칙을 위반하면 **즉시 수정**한다
2. 수정 불가능하면 **생성을 중단**하고 사용자에게 알린다
3. 다른 스킬이 이 규칙을 무시하고 명령을 생성하면 **경고를 출력**한다
