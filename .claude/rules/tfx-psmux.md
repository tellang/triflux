# tfx-psmux — always-on psmux + Codex CLI policy

sync-role: source
sync-mirror: AGENTS.md 의 `TFX psmux Rules` 섹션 (단방향 생성)
sync-note: |
  2026-07-26 양방향 sync-source 순환 선언 해소. 이전에는 이 파일이 AGENTS.md 를,
  AGENTS.md 가 이 파일을 서로 sync-source 로 지목해 정본이 없었고, 양쪽이 주장하던
  hash 는 실제 블록과도 달랐다. 이제 이 파일만 편집하고 AGENTS.md 는 생성한다.
  근거: .claude/rules/ = auto-load 실행 SSOT (tfx-doc-governance.md).

<!-- TFX_PSMUX_RULES:START -->
> **적용 범위: Windows 환경 한정.** macOS/Linux는 platform guard(`hub/team/wt-manager.mjs:199`, `hub/team/headless.mjs:1725`, `tfx-route.sh:86`)로 코드 레벨 no-op 처리된다. mac 사용자는 이 룰셋의 RULE 1~3, 5~6, 8 (WT/PowerShell 관련) 전체를 skip해도 됨. RULE 4 (Codex CLI), RULE 7 (gpt55 프로파일 정책)만 cross-platform.
> mac 인프라는 `hub/team/terminal-opener.mjs` 3단계 fallback (win32 → wt-manager / tmux 감지 시 → tmux/psmux / darwin → Terminal.app) + `hub/team/psmux.mjs` cross-platform (`IS_WINDOWS`/`IS_MAC` 분기) 으로 처리되며, 별도 iTerm2/tmux 매니저는 불필요.
>
> 이 문서는 선택형 스킬이 아니라 항상 적용되는 정책이다.
> psmux 명령, launch 스크립트, Codex CLI 호출을 생성하는 모든 흐름은
> 아래 규칙을 반드시 준수해야 한다. 위반 시 생성을 중단하고 수정한다.

## 적용 시점

다음 행위 중 하나라도 수행할 때 이 규칙이 자동 적용된다.
- `psmux send-keys` 명령 생성
- `launch-*.sh` 또는 `launch-*.ps1` 스크립트 생성
- `codex` CLI 호출 인자 조합
- `wt.exe` 탭/패인 명령 생성
- 스웜 세션 정리

## RULE 1: psmux 기본 셸 = PowerShell

psmux 세션의 기본 셸은 PowerShell이다.

### MUST NOT

```bash
psmux send-keys -t session "cd '/c/Users/...' && codex ..." Enter
psmux send-keys -t session "prompt=\$(cat file.md)" Enter
psmux send-keys -t session "export FOO=bar" Enter
```

### MUST

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

## RULE 2: 경로는 Windows 형식

psmux send-keys로 전달하는 경로는 반드시 Windows 형식이다.

```text
WRONG:  /c/Users/SSAFY/Desktop/Projects/...
RIGHT:  C:\Users\SSAFY\Desktop\Projects\...
```

`.sh` 런처 내부에서만 Unix 경로(`/c/...`) 사용 가능.

## RULE 3: 프롬프트 인자 인용 필수

CLI 인자로 넘기는 프롬프트는 반드시 인용한다. 비인용은 공백 분리·glob 전개를 일으킨다.

```bash
codex exec --profile <profile> -- "$prompt"   # MUST
codex exec --profile <profile> -- $prompt     # MUST NOT
```

PowerShell 은 `$p = (Get-Content 'prompt.md' -Raw)` 로 읽어 같은 규칙을 적용한다.

## RULE 4: 프로파일 사용, 인자 하드코딩 금지

모델·effort·실행모드는 프로파일로 관리한다. 문서·명령에 모델 ID를 적지 않는다 —
프로파일명이 SSOT (`tfx-skill-authoring.md` §3). 관리는 `tfx-profile` 또는 `~/.codex/config.toml`.

### 4-1. 프로파일 우선

```bash
codex exec --profile <profile> -- "$prompt" < /dev/null    # MUST
codex -c 'model="…"' -c 'model_reasoning_effort="…"'       # MUST NOT — 하드코딩
```

### 4-2. config.toml 중복 플래그 금지

config.toml 에 있는 값을 CLI 로 다시 주면 에러다. 런처 생성 전 확인하고 생략한다.

### 4-3. 프롬프트 전달 = argv (codex) / stdin (agy)

```bash
"$CLI_CMD" "${codex_args[@]}" -- "$prompt" < /dev/null    # codex
printf '%s' "$prompt" | "$CLI_CMD" "${agy_args[@]}"       # agy
```

`--` end-of-options 가 `--`로 시작하는 프롬프트의 플래그 오인식을 막는다. codex 는 non-TTY
subprocess 라 stdin 을 닫으므로 `codex < prompt.md` 는 실패한다. 특수문자 보존은
`printf`/`cat` → temp file 이 담당한다. (2026-07-26 `scripts/tfx-route.sh` 실측 — 이전 판의
"항상 stdin" 은 실구현과 반대였다.)

## RULE 5: WT 패인 정리

WT 1.24의 ConPTY close race 버그 때문에 detach-first 순서를 반드시 지킨다.

### MUST

```bash
for s in $(psmux list-sessions -F '#{session_name}' 2>/dev/null | grep "$PREFIX"); do
  psmux detach-client -t "$s" 2>/dev/null || true
done

sleep 2

for s in $(psmux list-sessions -F '#{session_name}' 2>/dev/null | grep "$PREFIX"); do
  psmux kill-session -t "$s" 2>/dev/null || true
done
```

> 참고: `detach-client` 는 `|| true` 로 감싸므로 **미지원 구버전 psmux(≤3.3.x)에서는 자동 no-op** 후 kill 로 진행된다(detach-first 순서는 버전 무관 안전). `scripts/lib/psmux-info.mjs` 가 `detach-client` 를 OPTIONAL 로 두는 것과 정합하며, `docs/codex-conventions.md` 의 옛 `exit`→sleep5 안내는 이 RULE 로 위임·폐기됐다.

### MUST NOT

```bash
psmux kill-session -t "$s"

psmux send-keys -t "$s" "exit" Enter
```

## RULE 5-1: psmux 경로 탐색

탐색 우선순위:
1. `$PSMUX_BIN` 환경변수
2. PATH의 `psmux`
3. `%LOCALAPPDATA%\psmux\psmux.exe`
4. `%APPDATA%\npm\psmux.cmd`
5. `~\scoop\shims\psmux.exe`

## RULE 5-2: 설치 / 업데이트 preflight

Triflux는 아래 capability를 전제로 한다.
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
(업그레이드는 각 매니저의 upgrade/update, cargo 는 `--force`).

문서/스크립트에서 `npm install -g psmux`를 표준 설치 경로처럼 안내하지 않는다.

## RULE 5-3: WT 명령 형태

에이전트는 `wt.exe` 를 직접 호출하지 않는다(RULE 6, safety-guard 차단). 실제 명령 조립은
`hub/team/wt-manager.mjs` 가 담당하며 그 구현이 형태의 SSOT 다. 매니저를 고칠 때만 코드를 본다.
필수 인자는 `-w 0`(현재 창), `-p triflux`(프로파일), 분할은 `sp -H|-V`, 새 탭(`nt`)은 금지.

## RULE 6: WT 탭/창은 wt-manager 경유 필수

- `wt.exe new-tab ...` 직접 호출 금지
- `wt.exe split-pane ...` 직접 호출 금지
- `Start-Process wt.exe ...` PowerShell 호출 금지
- 반드시 `wt-manager.mjs`의 `createTab()` / `applyLayout()` 사용

## RULE 7: gpt55 프로파일 우선

라우팅 기본값은 `gpt56_sol_xhigh`, `gpt56_terra_high`, `gpt56_terra_med`, `gpt56_luna_low` 프로파일을 사용한다.
구형 `spark53_*`, `codex53_*`, `gpt54_*`, `mini54_*` 프로파일을 새 라우팅 기본값으로 되살리지 않는다.

## RULE 8: WT 레이아웃 선택 필수

WT에 패인을 배치하기 전에 반드시 사용자에게 레이아웃을 확인한다.
새 탭(`nt`)은 금지이며 split + dashboard가 기본이다.

선택지: 새 창에서 스플릿 / 현재 창에서 스플릿 / dashboard / attach 안 함

## 위반 감지 시 행동

1. 생성한 명령/스크립트가 위 규칙을 위반하면 즉시 수정한다.
2. 수정 불가능하면 생성을 중단하고 사용자에게 알린다.
3. 다른 스킬이 이 규칙을 무시하고 명령을 생성하면 경고를 출력한다.
<!-- TFX_PSMUX_RULES:END -->
