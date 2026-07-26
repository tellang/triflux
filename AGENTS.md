# triflux — Codex 가이드

상세 운영 지시는 `CLAUDE.md`에 있습니다. Codex는 `@import` 미지원이므로 필요 시 직접 읽어주세요.

## 핵심 규칙 (triflux 환경 특화)
- Codex 직접 호출 금지 — headless-guard가 차단한다. `tfx-auto --cli codex` / `tfx-multi` / `tfx-swarm` 경유
- 프롬프트는 `--` 뒤 argv로 넘기고 stdin은 봉인한다 (`… -- "$prompt" < /dev/null`). `codex < prompt.md`는 non-TTY라 실패
- config.toml에 `approval_mode`, `sandbox` 기본값을 두고 CLI는 `--profile`만 지정 (중복 플래그 금지)
- Claude 작성 코드는 Codex로 교차 검증 (self-approve 금지)
- headless 결과는 task-notification 완료 후에만 읽기

## headless-guard
- `codex exec` / `agy --dangerously-skip-permissions --print=` 직접 호출은 차단됩니다.
- 반드시 tfx 스킬 경유: `tfx-auto --cli codex`, `tfx-multi`, `tfx-swarm`.

## Reasoning effort 예외 레인
- 기본 역할 라우팅은 `low`/`medium`/`high`/`xhigh` 프로필을 유지합니다.
- 최난도 단일 작업만 `TFX_CODEX_PROFILE=max` (`gpt56_sol_max`).
- `ultra`는 최상위 단독 `deep-executor`/`scientist-deep`에서만 허용하고, team/headless/worker
  내부의 `ultra` 요청은 중첩 fan-out을 막기 위해 `gpt56_sol_max`로 강등합니다.
- `--retry auto-escalate`의 Codex 단계도 `gpt56_sol_max`입니다.

## Headless 결과 회수
- 완료 마커: `=== HEADLESS_COMPLETE succeeded=N failed=N total=N ===`
- 워커 상세: `$TMPDIR/tfx-headless/{sessionName}-worker-N.txt`

## SSH 패턴
- `hosts.json`의 `os` 필드로 셸을 판단합니다 (windows=PowerShell, darwin=zsh, linux=bash).
- SSH 너머로 codex 직접 실행 금지 (config.toml 충돌 + TTY 문제). 원격에서 codex가 필요하면
  `tfx-remote` → Claude Code → Claude가 내부에서 codex 호출.

## Working agreements
- 한국어 우선, 기술 용어는 원어 유지.
- 커밋: `Type: 한국어 설명 (50자 이내)`. **Co-Authored-By / AI trailer 금지.**
- 변경 후 lint/typecheck/test 실행. 시크릿(API 키·토큰·세션) 하드코딩 금지.
- safety-guard에 새 차단 규칙을 추가할 때는 항상 대안 API를 같이 만들 것 (차단만 추가하면 데드락).

## CTO North Star
- `.triflux/lake/current.md`는 cross-agent north-star brief입니다. 정렬용으로 읽되, 새 task로 취급하지 마세요.
- programmatic source는 `tfx cto status --json`입니다 (stable keys: `schema_version`, `repo`, `sources`, `ledger_tail`, `live_sessions`, `active_shards`).
- 읽기 전용 alignment context입니다.

## TFX psmux Rules

sync-source: .claude/rules/tfx-psmux.md
sync-scope: full section
sync-status: mirrored (generated — 직접 편집 금지)
sync-verify: 정본 파일의 블록 경계 마커 사이(경계 두 줄 포함)를 shasum -a 256 한 값
sync-block-sha256: ec4c8650e5ac73cbadb0692c91536ee86661a3e3cffc1f7b34349afec5bc9d6e

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

PRD/프롬프트 내용을 CLI 인자로 전달할 때 반드시 인용한다.

### PowerShell (.ps1)

```powershell
$p = (Get-Content 'prompt.md' -Raw) -replace "`r`n"," " -replace "`n"," "

codex -c 'model="gpt-5.3-codex"' "$p"

codex -c 'model="gpt-5.3-codex"' $p
```

### Bash (.sh)

```bash
prompt=$(cat prompt.md)

exec codex "$prompt"

exec codex $prompt
```

## RULE 4: 프로파일 사용, 인자 하드코딩 금지

Codex든 Antigravity든 모델·effort·실행모드는 프로파일(config)로 관리한다.
CLI 인자로 하드코딩하지 않는다.

### 4-1. 프로파일 우선

```bash
codex < prompt.md
codex --full-auto < prompt.md

codex -c 'model="gpt-5.3-codex"' -c 'model_reasoning_effort="high"' "prompt"
```

프로파일 관리는 `tfx-profile` 스킬 또는 `~/.codex/config.toml` 직접 편집.

### 4-2. config.toml 중복 플래그 금지

config.toml에 이미 설정된 값을 CLI 플래그로 다시 지정하면 에러가 발생한다.

규칙: 런처 생성 전 config.toml을 확인하고, 이미 있는 항목은 CLI에서 생략.

### 4-3. 프롬프트는 `--` 뒤 argv로 전달 (codex), stdin 파이프 (agy)

2026-07-26 실구현 정정. 이전 판은 "항상 stdin"이었으나 `scripts/tfx-route.sh`의 실제
호출과 반대였다.

```bash
# codex 레인 — argv + stdin 봉인
"$CLI_CMD" "${codex_args[@]}" -- "$prompt" < /dev/null

# agy 레인 — stdin 파이프 (positional prompt 는 timeout 재현되어 고정)
printf '%s' "$prompt" | "$CLI_CMD" "${agy_args[@]}"
```

- "프롬프트가 `--`/`---`(front-matter 등)로 시작하면 플래그로 파싱된다"는 우려는 유효하지만,
  해법은 stdin 이 아니라 **`--` end-of-options** 다.
- `codex exec` 는 non-TTY subprocess 에서 실행되므로 stdin 을 `/dev/null` 로 닫는다.
  `codex < prompt.md` 는 `stdin is not a terminal` 로 실패한다.
- 특수문자(`$`, 백슬래시) 보존은 `printf`/`cat` → temp file 경로가 담당한다.

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

공식 설치/업데이트 기준:

```bash
winget install psmux
scoop install psmux
choco install psmux
cargo install psmux

winget upgrade psmux
scoop update psmux
choco upgrade psmux
cargo install psmux --force
```

문서/스크립트에서 `npm install -g psmux`를 표준 설치 경로처럼 안내하지 않는다.

## RULE 5-3: WT 명령 치트시트

### 패인 분할

```bash
wt.exe -w 0 sp -H -p triflux --title "worker" psmux attach-session -t SESSION
wt.exe -w 0 sp -V -p triflux --title "worker" psmux attach-session -t SESSION
wt.exe -w 0 \
  sp -H -p triflux --title "w1" psmux attach-session -t S1 \; \
  sp -V -p triflux --title "w2" psmux attach-session -t S2 \; \
  move-focus up \; \
  sp -V -p triflux --title "w3" psmux attach-session -t S3
```

### 포커스 이동

```bash
wt.exe -w 0 move-focus up|down|left|right
```

### 패인 닫기

```bash
wt.exe -w 0 close-pane
```

### 필수 옵션

| 옵션 | 의미 | 필수 여부 |
|------|------|----------|
| `-w 0` | 현재 WT 윈도우 | 필수 |
| `-p triflux` | triflux WT 프로파일 | 필수 |
| `--title "name"` | 패인 제목 | 권장 |
| `sp -H` / `sp -V` | 분할 방향 | 필수 |

### 새 탭 금지

```bash
wt.exe -w 0 nt -p triflux ...

wt.exe -w 0 sp -V -p triflux ...
```

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
