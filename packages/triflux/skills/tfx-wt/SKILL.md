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

> 사용자가 이 스킬을 호출하면 요청의 의도를 먼저 action에 매핑한다.

## OS 정책

이 스킬은 **Windows 전용**. macOS/Linux 의 탭/패인 자연어 라우팅은 본 스킬 범위 외다.
frontmatter `platform: [win32]` 때문에 `tfx setup` 은 macOS/Linux 에 이 스킬을 설치하지 않고,
이미 깔린 사본은 지운다.

| OS | 동작 | 라우팅 |
|----|------|--------|
| Windows | `wt.exe` 실제 호출 (wt-manager 경유) | **tfx-wt 가 담당** |
| macOS / Linux | `createWtManager()` 가 stub 반환. 모든 action no-op | **`terminal-opener.mjs` 가 tmux 경로로 담당**. tfx-wt 는 사용자에게 안내만 |

### 구성 요소

| 레이어 | 역할 |
|--------|------|
| `hub/team/wt-manager.mjs` | Windows-only (non-Windows 에서 stub). tfx-wt 가 사용 |
| `hub/team/terminal-opener.mjs` | Cross-platform abstraction. Windows→wt-manager, macOS/Linux→tmux |

macOS 사용자가 "탭 열어"라고 했는데 본 스킬로 들어오면 잘못된 라우팅. 사용자에게 다음을 안내한 뒤 종료:
- "Windows Terminal 은 macOS 에 없습니다."
- "macOS 에서 새 탭/패인 자동 생성이 필요하면 `terminal-opener.mjs` 의 tmux 경로를 사용하세요."
- "대시보드 배치는 자동으로 OS 분기됩니다."

`wt-manager.mjs` 자체가 OS-aware 이므로 스킬 코드에서 platform 분기 불필요.

## 의도 → action 매핑

| 자연어 입력 | action | 예시 |
|------------|--------|------|
| 패인 분할, pane split, 화면 나눠 | `split-pane` | "패인 가로로 분할" |
| 탭 + 여러 개 동시 배치, layout, dashboard | `layout` | "워커 3개 가로로 배치" |
| 탭 목록, 탭 리스트, 열린 탭, 현재 탭 | `list` | "지금 탭 뭐있어" |
| 탭 닫아, 탭 종료, tab close, 탭 정리 | `close` | "worker 탭 닫아" |
| 오래된 탭 정리, stale 탭, idle 탭 정리 | `close-stale` | "1시간 넘은 탭 정리해" |
| 탭 이름 변경, 탭 제목 바꿔, rename | `rename` | "이 탭 이름 backend 로 바꿔" |

## wt + psmux 통합 패턴 (Windows 기본 사용 흐름)

triflux 의 WT `triflux` 프로파일은 `ensureWtProfile`에서 psmux를 commandline으로 설정한다. WT 패인은 컨테이너이고, 그 안에서 psmux가 세션을 유지한다.

| 레이어 | 역할 |
|--------|------|
| wt | 윈도우 / 탭 / 패인 컨테이너 |
| psmux (탭 내부 default 셸) | 세션 호스팅. detach → wt 닫혀도 살아있음 → 재첨부 가능 |

패인 분할 명령의 형태는 `.claude/rules/tfx-psmux.md` 규칙 5-3을 따른다.

```bash
wt.exe -w 0 sp -H -p triflux --title "worker" psmux attach-session -t SESSION
```

이걸 본 스킬에서 호출하려면 `split-pane`의 `command` 에 `psmux attach-session -t <session>` 을 넣는다. 다중 worker 동시 배치는 `layout`.

### 세션 다중 배치 (전형)

```bash
node scripts/wt-cli.mjs layout '[
  {"title":"w1","command":"psmux attach-session -t s1","direction":"H"},
  {"title":"w2","command":"psmux attach-session -t s2","direction":"V"},
  {"title":"w3","command":"psmux attach-session -t s3","direction":"V"}
]'
```

각 패인이 미리 띄워둔 psmux session (s1/s2/s3) 에 attach. wt 패인 닫혀도 psmux session 은 살아있어 재시작 후 reattach 가능.

## 실행

`scripts/wt-cli.mjs` 가 `wt-manager` 의 thin wrapper. json-opts 는 단일 인자로 전달.

```bash
node scripts/wt-cli.mjs <action> '<json-opts>'
```

### split-pane: 패인 분할

```bash
node scripts/wt-cli.mjs split-pane '{"direction":"H","title":"logs","command":"tail -f log"}'
```

| 옵션 | 값 | 의미 |
|------|-----|------|
| `direction` | `"H"` / `"V"` | 가로 / 세로 |
| `title` | string | 패인 제목 |
| `command` | string | 실행할 명령 |

### layout: 다중 패인 배치

```bash
node scripts/wt-cli.mjs layout '[{"title":"w1","command":"...","direction":"H"},{"title":"w2","command":"...","direction":"V"}]'
```

또는 객체 형태: `'{"panes":[...]}'`. 대시보드와 여러 세션 배치에 사용.

### list: 탭 목록

```bash
node scripts/wt-cli.mjs list
```

반환: `[{ title, id, ... }]`. macOS/Linux 에서는 `[]`.

### close: 탭 닫기

```bash
node scripts/wt-cli.mjs close '{"title":"worker-1"}'
```

`title`은 정확히 일치하는 탭 하나를 닫는다.

### close-stale: 오래된 탭 정리

```bash
node scripts/wt-cli.mjs close-stale '{"olderThanMs":3600000,"titlePattern":"worker-"}'
```

| 옵션 | 의미 |
|------|------|
| `olderThanMs` | 생성 시각에서 이 시간이 지난 탭 |
| `titlePattern` | 문자열이 포함된 제목만 선택 |

반환: `{ success: true, closed: <닫은 탭 수> }`

### rename: 탭 이름 변경

```bash
node scripts/wt-cli.mjs rename '{"oldTitle":"old","newTitle":"backend"}'
```

## CLAUDE.md 규칙

실행 규칙은 `.claude/rules/tfx-psmux.md`의 규칙 6과 8을 따른다.

| 차단되는 직접 호출 | 이 스킬 경유 |
|-------------------|-------------|
| `wt.exe new-tab ...` | 새 탭 생성 대신 `split-pane` 또는 `layout` |
| `wt.exe split-pane ...` | `split-pane` |
| `wt.exe -w 0 sp -H ...` | `layout` (다중) 또는 `split-pane` (단일) |
| `Start-Process wt.exe ...` (PowerShell) | `split-pane` 또는 `layout` |

Windows Terminal 요청은 `tfx-wt`에서 `wt-cli.mjs`를 경유해 실행한다.

## 안티패턴

| 패턴 | 문제 | 대체 |
|------|------|------|
| `Bash("wt.exe new-tab ...")` | 규칙 8의 새 탭 금지 | `node scripts/wt-cli.mjs split-pane '{...}'` |
| macOS 에서 "탭 열어" 받고 강제 실행 시도 | wt-manager stub 반환 → 효과 없음 + 혼란 | "Windows Terminal 미설치 환경: no-op" 명시 후 종료 |
| 다중 패인을 개별 생성 | 여러 번 배치해야 함 | `layout` 한 번 호출 |

## 관련

- `scripts/wt-cli.mjs`: CLI wrapper (이 스킬이 호출)
- `hub/team/wt-manager.mjs`: 실제 구현체 (`splitPane`, `applySplitLayout`, `closeTab`, `closeStale`, `renameTab`, `listTabs`)
- CLAUDE.md `psmux-wt` 섹션: wt-manager API 가이드
- `.claude/rules/tfx-psmux.md`: psmux/WT 정책 규칙 5, 6, 8
