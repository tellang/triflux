---
name: tfx-wt
description: >
  Windows Terminal 탭/패인 자연어 조작. 사용자가 "새 탭 열어줘", "패인 분할",
  "탭 목록", "탭 닫아" 같은 한국어/영어 표현을 쓰면 wt-cli.mjs 경유로 wt-manager API 호출.
  safety-guard가 wt.exe 직접 호출을 차단하므로 이 스킬이 유일한 경로다.
  Use when: 새 탭, tab open, 패인, pane split, 탭 목록, 탭 닫아, wt 탭, wt 패인
triggers:
  - tfx-wt
  - wt-tab-route
  - wt-tab-rename
  - wt-tab-list
  - wt-tab-close
argument-hint: "<create-tab|split-pane|layout|list|close|close-stale|rename> [json-opts]"
---

# tfx-wt — Windows Terminal 자연어 조작

> **ARGUMENTS 처리**: 이 스킬이 `ARGUMENTS: <값>`과 함께 호출되면, 해당 값을 사용자 입력으로 취급한다.
> ARGUMENTS가 비어있거나 없으면 사용자에게 의도 확인 후 적절한 action 으로 라우팅한다.

> **인프라**: keyword-rules.json 의 `wt-tab-*` 4 규칙이 이 스킬로 라우팅한다.
> 사용자는 보통 자연어로 호출 ("탭 열어줘") 하므로 의도 → action 매핑이 첫 단계.

## OS 정책

이 스킬은 **Windows 전용**. macOS/Linux 의 탭/패인 자연어 라우팅은 본 스킬 범위 외다.

| OS | 동작 | 라우팅 |
|----|------|--------|
| Windows | `wt.exe` 실제 호출 (wt-manager 경유). safety-guard 차단 우회 | **tfx-wt 가 담당** |
| macOS / Linux | `createWtManager()` 가 stub 반환 (PR #241). 모든 action no-op | **`terminal-opener.mjs` 가 tmux 경로로 담당** (PR #236). tfx-wt 는 사용자에게 안내만 |

### 분리 정신 (PR #236, #241)

| 레이어 | 역할 |
|--------|------|
| `hub/team/wt-manager.mjs` | Windows-only (non-Windows 에서 stub). tfx-wt 가 사용 |
| `hub/team/terminal-opener.mjs` | Cross-platform abstraction. Windows→wt-manager, macOS/Linux→tmux |
| `hub/team/runtime-strategy.mjs` | `psmux` (Windows) 와 `tmux` (macOS/Linux) runtime identity 분리 유지 |

macOS 사용자가 "탭 열어"라고 했는데 본 스킬로 들어오면 잘못된 라우팅. 사용자에게 다음을 안내한 뒤 종료:
- "Windows Terminal 은 macOS 에 없습니다."
- "macOS 에서 새 탭/패인 자동 생성이 필요하면 `terminal-opener.mjs` 의 tmux 경로를 사용하세요."
- "오케스트레이션 (swarm worker 배치, dashboard) 은 자동으로 OS 분기됩니다."

`wt-manager.mjs` 자체가 OS-aware 이므로 스킬 코드에서 platform 분기 불필요.

## 의도 → action 매핑

| 자연어 입력 | action | 예시 |
|------------|--------|------|
| 새 탭, tab open, 탭 추가/생성/열어/띄워, 터미널 탭 | `create-tab` | "새 탭 열어줘" |
| 패인 분할, pane split, 화면 나눠 | `split-pane` | "패인 가로로 분할" |
| 탭 + 여러 개 동시 배치, layout, dashboard | `layout` | "워커 3개 가로로 배치" |
| 탭 목록, 탭 리스트, 열린 탭, 현재 탭 | `list` | "지금 탭 뭐있어" |
| 탭 닫아, 탭 종료, tab close, 탭 정리 | `close` | "worker 탭 닫아" |
| 오래된 탭 정리, stale 탭, idle 탭 정리 | `close-stale` | "1시간 넘은 탭 정리해" |
| 탭 이름 변경, 탭 제목 바꿔, rename | `rename` | "이 탭 이름 backend 로 바꿔" |

## wt + psmux 통합 패턴 (Windows 기본 사용 흐름)

triflux 의 WT `triflux` 프로파일은 **commandline = psmux** (wt-manager:319 의 `ensureWtProfile`). 즉 wt 의 새 탭/패인 = wt 가 컨테이너, **그 안에서 psmux 가 멀티플렉서로 도는 구조**. swarm worker, dashboard, 장기 세션 모두 이 형태.

| 레이어 | 역할 |
|--------|------|
| wt | 윈도우 / 탭 / 패인 컨테이너 |
| psmux (탭 내부 default 셸) | 세션 호스팅. detach → wt 닫혀도 살아있음 → 재첨부 가능 |

전형적인 `wt sp` 한 줄 (`.claude/rules/tfx-psmux.md` RULE 5-3 인용):

```bash
wt.exe -w 0 sp -H -p triflux --title "worker" psmux attach-session -t SESSION
```

이걸 본 스킬에서 호출하려면 `split-pane` 또는 `create-tab` 의 `command` 에 `psmux attach-session -t <session>` 을 넣는다. 다중 worker 동시 배치는 `layout`.

### Swarm worker 다중 배치 (전형)

```bash
node scripts/wt-cli.mjs layout '[
  {"title":"w1","command":"psmux attach-session -t s1","direction":"H"},
  {"title":"w2","command":"psmux attach-session -t s2","direction":"V"},
  {"title":"w3","command":"psmux attach-session -t s3","direction":"V"}
]'
```

각 패인이 미리 띄워둔 psmux session (s1/s2/s3) 에 attach. wt 패인 닫혀도 psmux session 은 살아있어 재시작 후 reattach 가능.

### 일반 명령 실행 (psmux 통합 불필요한 경우)

장기 세션이 아니고 단발 명령이면 psmux 우회 가능:

```bash
node scripts/wt-cli.mjs create-tab '{"title":"build","command":"npm run build","profile":"triflux"}'
```

`profile: "triflux"` 가 자동으로 psmux 를 셸로 띄우긴 하지만, `command` 가 즉시 종료되면 `closeOnExit: "always"` (wt-manager:331) 로 패인도 닫힘.

## 실행

`scripts/wt-cli.mjs` 가 `wt-manager` 의 thin wrapper. json-opts 는 단일 인자로 전달.

```bash
node scripts/wt-cli.mjs <action> '<json-opts>'
```

### create-tab — 새 탭 생성

```bash
node scripts/wt-cli.mjs create-tab '{"title":"backend","command":"npm run dev","profile":"triflux","cwd":"C:\\path"}'
```

| 옵션 | 필수 | 기본 |
|------|------|------|
| `title` | 권장 | 자동 |
| `command` | 권장 | shell |
| `profile` | 선택 | "triflux" |
| `cwd` | 선택 | 현재 |

반환: `{ success, title, id? }`

### split-pane — 패인 분할

```bash
node scripts/wt-cli.mjs split-pane '{"direction":"H","title":"logs","command":"tail -f log"}'
```

| 옵션 | 값 | 의미 |
|------|-----|------|
| `direction` | `"H"` / `"V"` | 가로 / 세로 |
| `title` | string | 패인 제목 |
| `command` | string | 실행할 명령 |

### layout — 다중 패인 배치

```bash
node scripts/wt-cli.mjs layout '[{"title":"w1","command":"...","direction":"H"},{"title":"w2","command":"...","direction":"V"}]'
```

또는 객체 형태: `'{"panes":[...]}'`. dashboard / swarm worker 배치에 사용.

### list — 탭 목록

```bash
node scripts/wt-cli.mjs list
```

반환: `[{ title, id, ... }]`. macOS/Linux 에서는 `[]`.

### close — 탭 닫기

```bash
node scripts/wt-cli.mjs close '{"title":"worker-1"}'
```

`title` 은 정확 일치 또는 prefix. **단일 탭** 닫기.

### close-stale — 오래된 탭 정리

```bash
node scripts/wt-cli.mjs close-stale '{"olderThanMs":3600000,"titlePattern":"worker-"}'
```

| 옵션 | 의미 |
|------|------|
| `olderThanMs` | 이 ms 이상 idle 탭만 |
| `titlePattern` | title prefix 또는 regex 매칭만 |
| `dryRun` | true 시 닫을 후보만 반환 |

반환: `{ success, closed: ["title-1", ...] }`

### rename — 탭 이름 변경

```bash
node scripts/wt-cli.mjs rename '{"title":"old","newTitle":"backend"}'
```

## CLAUDE.md 규칙 준수

CLAUDE.md `psmux-wt > wt.exe → wt-manager 경유` 섹션:

| 차단되는 직접 호출 | 이 스킬 경유 |
|-------------------|-------------|
| `wt.exe new-tab ...` | `create-tab` |
| `wt.exe split-pane ...` | `split-pane` |
| `wt.exe -w 0 sp -H ...` | `layout` (다중) 또는 `split-pane` (단일) |
| `Start-Process wt.exe ...` (PowerShell) | `create-tab` |

safety-guard 가 위 4 패턴을 모두 차단하므로 자연어 라우팅 → `tfx-wt` → `wt-cli.mjs` 가 유일한 안전 경로.

## 안티패턴

| 패턴 | 문제 | 대체 |
|------|------|------|
| `Bash("wt.exe new-tab ...")` | safety-guard 차단 | `node scripts/wt-cli.mjs create-tab '{...}'` |
| macOS 에서 "탭 열어" 받고 강제 실행 시도 | wt-manager stub 반환 → 효과 없음 + 혼란 | "Windows Terminal 미설치 환경 — no-op" 명시 후 종료 |
| `wt.exe -w 0 nt` (새 창) | CLAUDE.md tfx-psmux.md RULE 5-3 금지 | `sp -H` / `sp -V` (split) 사용 |
| 다중 패인을 `create-tab` N회 호출 | 새 창 N개 띄우기 | `layout` 한 번 호출 |

## 관련

- `scripts/wt-cli.mjs` — CLI wrapper (이 스킬이 호출)
- `hub/team/wt-manager.mjs` — 실제 구현체 (`createTab`, `splitPane`, `applySplitLayout`, `closeTab`, `closeStale`, `renameTab`, `listTabs`)
- CLAUDE.md `psmux-wt` 섹션 — wt-manager API 가이드
- `.claude/rules/tfx-psmux.md` — psmux/WT 정책 RULE 5/6
- `hooks/keyword-rules.json` `wt-tab-*` 4 규칙 — 자연어 라우팅 진입점

## 메모

- PR #241 (5/8) 이후 macOS/Linux 에서도 안전. wt-manager 가 stub 반환하므로 crash 없이 no-op.
- 4/11 b313c648 커밋이 keyword-rules + wt-cli.mjs 만 추가하고 SKILL.md 를 빠뜨려 한 달간 dead 라우팅. issue #248 로 발견 후 본 스킬 추가.
