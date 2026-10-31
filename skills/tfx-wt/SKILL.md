---
name: tfx-wt
description: >
  Windows Terminal 패인과 탭 상태 조작. 사용자가 "패인 분할",
  "탭 목록", "탭 닫아" 같은 한국어/영어 표현을 쓰면 wt-cli.mjs 경유로 wt-manager API 호출.
  Windows Terminal 명령은 이 스킬에서 관리 API를 경유한다.
  Use when: 패인, pane split, 탭 목록, 탭 닫아, wt 탭, wt 패인
argument-hint: "<split-pane|layout|list|close|close-stale|rename> [json-opts]"
platform:
  - win32
---

# tfx-wt Windows Terminal 조작

> **ARGUMENTS 처리**: 이 스킬이 `ARGUMENTS: <값>`과 함께 호출되면, 해당 값을 사용자 입력으로 취급한다.
> ARGUMENTS가 비어있거나 없으면 사용자에게 의도 확인 후 적절한 action 으로 라우팅한다.

## OS 정책

Windows 전용이다. frontmatter `platform: [win32]` 때문에 `tfx setup` 은 macOS/Linux 에 이 스킬을 설치하지 않고, 이미 깔린 사본은 지운다.

| OS | 동작 | 담당 |
|----|------|------|
| Windows | `wt.exe` 실제 호출(`hub/team/wt-manager.mjs`) | tfx-wt |
| macOS / Linux | `createWtManager()` 가 stub 을 반환해 모든 action 이 no-op | `hub/team/terminal-opener.mjs` 의 tmux 경로 |

macOS/Linux 에서 "탭 열어" 요청으로 들어오면 실행하지 말고 "Windows Terminal 은 macOS/Linux 에 없다. 새 탭/패인 자동 생성은 `terminal-opener.mjs` 의 tmux 경로가 맡는다"고 안내한 뒤 끝낸다.

## 시작 전 확인

1. `Get-Command wt.exe, node` 로 둘 다 있는지 본다. 없으면 실행하지 말고 무엇이 없는지 알린다.
2. `psmux` 는 패인 안에서 세션을 유지할 때만 필요하다. `Get-Command psmux` 로 확인하고, 없으면 `command` 에 직접 실행할 명령을 넣거나 사용자에게 설치를 알린다.
3. 패인을 배치하기 전에 사용자에게 레이아웃을 확인한다(새 창에서 분할 / 현재 창에서 분할 / 대시보드 / 연결하지 않음). 새 탭(`nt`)은 쓰지 않는다.

## 실행

`scripts/wt-cli.mjs` 는 `wt-manager` 의 얇은 래퍼다. 인자는 `<action> '<json-opts>'` 하나다. `~/.claude/scripts` 에는 설치되지 않으므로 아래 순서로 찾는다.

1. 현재 디렉터리가 triflux clone 이면 `node scripts/wt-cli.mjs`.
2. 아니면 패키지 루트에서 실행한다. 루트 경로는 `~/.claude/scripts/.tfx-pkg-root` 에 적혀 있다.

```powershell
$root = (Get-Content "$env:USERPROFILE\.claude\scripts\.tfx-pkg-root" -Raw).Trim()
node "$root\scripts\wt-cli.mjs" <action> '<json-opts>'
```

둘 다 없으면 `tfx setup` 을 다시 실행하도록 알린다. 아래 예시는 `node scripts/wt-cli.mjs` 로 줄여 쓴다.

### split-pane: 패인 분할

```bash
node scripts/wt-cli.mjs split-pane '{"direction":"H","title":"logs","command":"Get-Content app.log -Wait"}'
```

| 옵션 | 값 | 의미 |
|------|-----|------|
| `direction` | `"H"` / `"V"` | 상하 / 좌우. 기본 `V` |
| `title` | string | 패인 제목 |
| `command` | string | 패인에서 실행할 **PowerShell 스크립트**(`-EncodedCommand` 로 전달) |
| `profile`, `size`, `cwd` | string, 백분율 숫자, 경로 | 프로파일, 분할 크기, 시작 디렉터리 |

### layout: 여러 패인 한 번에 배치

```bash
node scripts/wt-cli.mjs layout '[
  {"title":"w1","command":"psmux attach-session -t s1","direction":"H"},
  {"title":"w2","command":"psmux attach-session -t s2","direction":"V"}
]'
```

`'{"panes":[...]}'` 형태도 받는다. 첫 패인은 새 탭으로 만들고 나머지는 그 탭을 분할한다. 각 패인은 미리 띄운 psmux 세션에 attach 한다. WT 패인이 닫혀도 세션이 살아 있어 다시 attach 할 수 있다. triflux WT 프로파일(`ensureWtProfile`)은 commandline 이 `psmux` 다.

### list, close, close-stale, rename

```bash
node scripts/wt-cli.mjs list
node scripts/wt-cli.mjs close '{"title":"worker-1"}'
node scripts/wt-cli.mjs close-stale '{"olderThanMs":3600000,"titlePattern":"worker-"}'
node scripts/wt-cli.mjs rename '{"oldTitle":"old","newTitle":"backend"}'
```

탭 목록(`tabs`)은 `createWtManager()` 를 만든 프로세스의 메모리에만 있다. `wt-cli` 는 호출마다 새 프로세스라서 이전 호출이 만든 탭이 보이지 않는다. 그래서 CLI 로 부르면 `list` 는 `[]`, `close` 는 아무것도 닫지 않고 `{"success":true}`, `close-stale` 은 `{"success":true,"closed":0}`, `rename` 은 `false` 를 낸다. 결과가 이렇게 나와도 성공으로 보고하지 않고 "CLI 에서는 효과 없음"이라고 알린다.

WT 에 붙은 세션을 정리하려면 psmux 에서 한다. 먼저 연결을 끊고 2초 뒤 세션을 지운다(WT 1.24 의 ConPTY 종료 경쟁 회피). `detach-client` 의 `-t` 는 클라이언트 이름이라 세션을 분리하지 못하므로 `-s` 로 세션을 준다.

```powershell
psmux detach-client -s <session>
if ($LASTEXITCODE -ne 0) { Write-Error "detach 실패. psmux list-clients 로 확인한 뒤 다시 실행"; exit 1 }
Start-Sleep -Seconds 2
psmux kill-session -t <session>
```

## 직접 호출 금지

에이전트는 `wt.exe` 를 직접 호출하지 않는다. `wt.exe new-tab`, `wt.exe split-pane`, `wt.exe -w 0 sp ...`, `Start-Process wt.exe` 대신 `split-pane` 또는 `layout` 을 쓴다. 실제 `wt.exe` 인자 조립은 `wt-manager.mjs` 가 정본이다.

## 안티패턴

| 패턴 | 문제 | 대체 |
|------|------|------|
| `Bash("wt.exe new-tab ...")` | 새 탭 금지 | `split-pane` 또는 `layout` |
| macOS/Linux 에서 강제 실행 | stub 이라 효과 없음 | 안내 후 종료 |
| 패인을 하나씩 따로 생성 | 호출 반복 | `layout` 한 번 |
| `split-pane` 의 `command` 에 `tail -f` 같은 Unix 명령 | 패인 셸이 PowerShell | PowerShell 문법 사용 |

## 관련

- `scripts/wt-cli.mjs`: 이 스킬이 호출하는 CLI
- `hub/team/wt-manager.mjs`: 구현체(`splitPane`, `applySplitLayout`, `closeTab`, `closeStale`, `renameTab`, `listTabs`)
- 셸 규약 전문: triflux clone 의 `.claude/rules/tfx-psmux.md`. clone 이 없으면 이 스킬의 `references/tfx-psmux.md`(다른 작업에서 설치본에 복사 중). 둘 다 없어도 위 내용만으로 실행할 수 있다.
