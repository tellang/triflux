---
globs: **/*.ps1, **/launch-*.sh, **/tfx-route.sh, **/*psmux*, **/*wt-manager*, **/terminal-opener*, **/safety-guard.mjs
---
# tfx-psmux — Windows psmux와 Codex CLI 정책

<!-- TFX_PSMUX_RULES:START -->
> **적용 범위: Windows 환경 한정.** macOS/Linux는 플랫폼 보호기(`hub/team/wt-manager.mjs:199`, `hub/team/headless.mjs:1725`, `tfx-route.sh:86`)가 코드 수준에서 아무 작업도 하지 않게 처리한다. mac 사용자는 이 규칙의 1~3, 5~6, 8번(WT·PowerShell 관련)을 모두 건너뛸 수 있다. 4번(Codex CLI)과 7번(모델 프로파일 정책)만 모든 플랫폼에 적용된다.
> mac 인프라는 `hub/team/terminal-opener.mjs`의 3단계 대체 경로(win32 → wt-manager / tmux 감지 → tmux·psmux / darwin → Terminal.app)와 `hub/team/psmux.mjs`의 플랫폼 분기(`IS_WINDOWS`/`IS_MAC`)로 처리한다. 별도 iTerm2·tmux 관리자는 필요하지 않다.
>
> psmux 명령, launch 스크립트, Codex CLI 호출을 생성하는 모든 흐름은
> 아래 규칙을 반드시 준수해야 한다. 위반 시 생성을 중단하고 수정한다.

## 적용 시점

다음 행위 중 하나라도 수행할 때 이 규칙이 자동 적용된다.
- `psmux send-keys` 명령 생성
- `launch-*.sh` 또는 `launch-*.ps1` 스크립트 생성
- `codex` CLI 호출 인자 조합
- `wt.exe` 탭/패인 명령 생성
- 스웜 세션 정리

## 규칙 1: psmux 기본 셸은 PowerShell

psmux 세션의 기본 셸은 PowerShell이다.

### 금지

```bash
psmux send-keys -t session "cd '/c/Users/...' && codex ..." Enter
psmux send-keys -t session "prompt=\$(cat file.md)" Enter
psmux send-keys -t session "export FOO=bar" Enter
```

### 필수

```bash
BASH_WIN='C:\\Program Files\\Git\\bin\\bash.exe'
psmux send-keys -t session "& '$BASH_WIN' './launch.sh'" Enter

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

## 규칙 2: 경로는 Windows 형식

psmux send-keys로 전달하는 경로는 반드시 Windows 형식이다.

```text
잘못:  /c/Users/SSAFY/Desktop/Projects/...
올바름: C:\Users\SSAFY\Desktop\Projects\...
```

`.sh` 런처 내부에서만 Unix 경로(`/c/...`) 사용 가능.

## 규칙 3: 프롬프트 인자 인용 필수

CLI 인자로 넘기는 프롬프트는 반드시 인용한다. 비인용은 공백 분리·glob 전개를 일으킨다.

```bash
codex exec --profile <profile> -- "$prompt"   # 필수
codex exec --profile <profile> -- $prompt     # 금지
```

PowerShell 은 `$p = (Get-Content 'prompt.md' -Raw)` 로 읽어 같은 규칙을 적용한다.

## 규칙 4: 프로파일 사용, 인자 하드코딩 금지

모델·effort·실행모드는 프로파일로 관리한다. 문서·명령에 모델 ID를 적지 않는다 —
프로파일명이 SSOT (`tfx-skill-authoring.md` §3). 관리는 `tfx-profile` 또는 `~/.codex/config.toml`.

### 4-1. 프로파일 우선

```bash
codex exec --profile <profile> -- "$prompt" < /dev/null    # 필수
codex -c 'model="…"' -c 'model_reasoning_effort="…"'       # 금지 — 하드코딩
```

### 4-2. `config.toml` 중복 플래그 금지

`config.toml`에 있는 값을 CLI로 다시 주면 오류가 난다. 런처를 만들기 전에 확인하고 생략한다.

### 4-3. 프롬프트 전달 = 명령 인자(codex) / 표준 입력(agy)

```bash
"$CLI_CMD" "${codex_args[@]}" -- "$prompt" < /dev/null    # codex
printf '%s' "$prompt" | "$CLI_CMD" "${agy_args[@]}"       # agy
```

`--` 옵션 종료 구분자는 `--`로 시작하는 프롬프트를 플래그로 잘못 인식하지 않게 한다. Codex는 비대화식
하위 프로세스에서 표준 입력을 닫으므로 `codex < prompt.md`는 실패한다. 특수문자 보존은
`printf`/`cat` → 임시 파일 경로가 담당한다. (2026-07-26 `scripts/tfx-route.sh` 실측 — 이전 판의
"항상 표준 입력"은 실제 구현과 반대였다.)

## 규칙 5: WT 패인 정리

WT 1.24의 ConPTY 종료 경쟁 상태 버그 때문에 먼저 연결을 끊는 순서를 반드시 지킨다.

### 필수

```bash
for s in $(psmux list-sessions -F '#{session_name}' 2>/dev/null | grep "$PREFIX"); do
  psmux detach-client -t "$s" 2>/dev/null || true
done

sleep 2

for s in $(psmux list-sessions -F '#{session_name}' 2>/dev/null | grep "$PREFIX"); do
  psmux kill-session -t "$s" 2>/dev/null || true
done
```

> 참고: `detach-client`는 `|| true`로 감싸므로 **지원하지 않는 구버전 psmux(≤3.3.x)에서는 아무 작업도 하지 않고** 종료로 진행한다. 먼저 연결을 끊는 순서는 버전과 관계없이 안전하다. `scripts/lib/psmux-info.mjs`가 `detach-client`를 `OPTIONAL`로 두는 것과 맞으며, `docs/codex-conventions.md`의 옛 `exit`→5초 대기 안내는 이 규칙으로 넘기고 폐기했다.

### 금지

```bash
psmux kill-session -t "$s"

psmux send-keys -t "$s" "exit" Enter
```

## 규칙 5-1: psmux 경로 탐색

탐색 우선순위:
1. `$PSMUX_BIN` 환경변수
2. `PATH`의 `psmux`
3. `%LOCALAPPDATA%\psmux\psmux.exe`
4. `%APPDATA%\npm\psmux.cmd`
5. `~\scoop\shims\psmux.exe`

## 규칙 5-2: 설치·업데이트 사전 점검

Triflux는 아래 기능을 전제로 한다.
- `new-session`
- `attach-session`
- `kill-session`
- `capture-pane`
- `detach-client`

설치/업데이트가 의심될 때는 먼저:

```bash
tfx doctor --json
```

설치·업데이트는 `winget` / `scoop` / `choco` / `cargo install psmux` 중 하나를 쓴다
(업그레이드는 각 관리자의 업그레이드·업데이트 명령을 쓰고 cargo는 `--force`를 사용한다.)

문서/스크립트에서 `npm install -g psmux`를 표준 설치 경로처럼 안내하지 않는다.

## 규칙 5-3: WT 명령 형태

에이전트는 `wt.exe` 를 직접 호출하지 않는다(RULE 6, safety-guard 차단). 실제 명령 조립은
`hub/team/wt-manager.mjs`가 담당하며 그 구현이 명령 형태의 정본이다. 관리자를 고칠 때만 코드를 본다.
필수 인자는 `-w 0`(현재 창), `-p triflux`(프로파일), 분할은 `sp -H|-V`, 새 탭(`nt`)은 금지.

## 규칙 6: WT 탭·창은 `wt-manager` 경유 필수

safety-guard 가 `wt.exe` / `wt new-tab` / `wt split-pane` / `Start-Process wt` 를 차단한다.
`hub/team/wt-manager.mjs` API 를 쓴다.

| 용도 | API |
|------|-----|
| 새 탭 | `createTab({ title, command, profile, cwd })` |
| 패인 분할 | `splitPane({ direction: 'H'\|'V', title, command })` |
| 다중 배치 | `applySplitLayout([{ title, command, direction }])` |
| 탭 정리 | `closeTab(title)` / `closeStale({ olderThanMs, titlePattern })` |

가공하지 않은 `psmux kill-session`도 차단되므로 `hub/team/psmux.mjs`를 거친다.

| 용도 | API / 래퍼 |
|------|------------|
| 세션 조회 | `listSessions({ filterTitle?, olderThanMs? })` |
| 제목 접두사·정규식으로 종료 | `killSessionByTitle(titlePattern)` |
| 오래된 유휴 세션 정리 | `pruneStale({ olderThanMs, dryRun })` |
| Bash 훅 우회 래퍼 | `node hub/team/psmux.mjs --internal kill-by-title <prefix\|/regex/>` |

차단과 대안은 항상 쌍으로 만든다. 차단만 추가하면 데드락이다.

## 규칙 7: 현재 모델 프로파일 우선

라우팅 기본값은 `gpt56_sol_xhigh`, `gpt56_terra_high`, `gpt56_terra_med`, `gpt56_luna_low` 프로파일을 사용한다.
구형 `spark53_*`, `codex53_*`, `gpt54_*`, `mini54_*` 프로파일을 새 라우팅 기본값으로 되살리지 않는다.

## 규칙 8: WT 배치 선택 필수

WT에 패인을 배치하기 전에 반드시 사용자에게 레이아웃을 확인한다.
새 탭(`nt`)은 금지이며 분할과 대시보드가 기본이다.

선택지: 새 창에서 분할 / 현재 창에서 분할 / 대시보드 / 연결하지 않음

## 위반 감지 시 행동

1. 생성한 명령/스크립트가 위 규칙을 위반하면 즉시 수정한다.
2. 수정 불가능하면 생성을 중단하고 사용자에게 알린다.
3. 다른 스킬이 이 규칙을 무시하고 명령을 생성하면 경고를 출력한다.
<!-- TFX_PSMUX_RULES:END -->
