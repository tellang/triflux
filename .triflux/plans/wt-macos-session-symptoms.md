# WT(Windows Terminal) 룰이 macOS 환경에 새는 증상 — 본 세션 관찰

수집 시각: 2026-05-21
세션 컨텍스트: macOS arm64 (Darwin 25.4.0, M5), Claude Code, triflux v10.25.0+
관찰자 지적: 사용자가 "wt는 windows 한정인데 여긴 mac이다?" 라고 직접 지적

## 한 줄 요약

triflux 의 `psmux/WT` 정책 묶음이 platform 분기 없이 macOS 세션의 prompt 컨텍스트에 그대로 inject 된다. 런타임 코드는 `platform guard` 가 있어 안전하지만, 문서/룰/AI 출력 레벨에서 죽은 표현이 토큰을 소모하고 macOS 사용자에게 인지 부담을 준다.

## 환경

| 항목 | 값 |
|------|-----|
| OS | Darwin 25.4.0 (`uname -a` 출력: `arm64 T8142`) |
| Shell | zsh |
| Terminal | iTerm2 / Terminal.app / Ghostty 등 (WT 아님) |
| `WT_SESSION` env | 없음 |
| `wt.exe` PATH | 없음 |

## 증상 카탈로그

### S1. `CLAUDE.md` `<psmux-wt>` 섹션 unconditional inject (line 18~60)

출처: `/Users/tellang/Projects/tools/triflux/CLAUDE.md`

verbatim 일부:

```
<psmux-wt>
## psmux/WT 규칙

psmux 세션·WT 패인을 생성/조작/정리할 때 `tfx-psmux-rules` 스킬을 참조한다.
WT 프리징 방지: exit → sleep 2 → kill 순서. 바로 kill하지 않는다.

### wt.exe → wt-manager 경유

safety-guard가 `wt.exe`, `wt new-tab`, `wt split-pane`, `Start-Process wt`를 차단한다.
`hub/team/wt-manager.mjs`의 API를 사용한다.
...
</psmux-wt>
```

- macOS 세션에서 항상 prompt 로 들어옴 (Claude Code 가 cwd 의 CLAUDE.md 를 100% inject)
- "WT 프리징 방지", "wt.exe → wt-manager 경유" 표현이 macOS 환경에서는 의미 없음
- 같은 파일 line 112~113 표만 `windows | PowerShell` vs `darwin | zsh` 로 platform 구분. 다른 섹션은 단일 톤

### S2. `.claude/rules/tfx-psmux.md` RULE 1~8 macOS 분기 부재

출처: `/Users/tellang/Projects/tools/triflux/.claude/rules/tfx-psmux.md`

| 룰 | 내용 | macOS 의미 |
|----|------|-----------|
| RULE 1 | psmux 기본 셸 = PowerShell | macOS 에서는 zsh, 적용 불가 |
| RULE 2 | 경로는 Windows 형식 (`C:\...`) | macOS 는 POSIX (`/Users/...`), 무관 |
| RULE 3 | PowerShell `.ps1` 런처 인용 | macOS 는 `.sh`, 무관 |
| RULE 4-1/4-2/4-3 | Codex CLI 인자/stdin | 일부 cross-platform 의미 있음 |
| RULE 5 | WT 1.24 ConPTY close race detach-first | macOS 에 WT 없음 |
| RULE 5-1 | psmux 경로 탐색 (Windows scoop/npm/cargo) | macOS PATH (`/opt/homebrew/...`) 와 별개 |
| RULE 5-2 | winget/scoop/choco preflight | macOS 는 brew/cargo, 무관 |
| RULE 5-3 | WT 패인 분할 치트시트 (`wt.exe -w 0 sp -H ...`) | macOS 에 wt.exe 없음 |
| RULE 6 | WT 탭/창은 wt-manager 경유 | macOS 무관 |
| RULE 7 | spark53 프로파일 Pro 전용 | platform-agnostic, OK |
| RULE 8 | WT 레이아웃 선택 필수 (split + dashboard) | macOS 무관 |

→ **8개 룰 중 6개가 macOS dead text.** 단 헤더에 "Windows 환경 한정" 표기 없음.

### S3. `skills/tfx-auto/SKILL.md` 의 "WT 자동 팝업" 표현 (line 801)

```
| 2개+ + quick | **headless 직접 실행** (WT 자동 팝업) | headless.mjs |
```

- 사용자 dirty 변경분에도 같은 표현 유지됨 (Native Bridge row 추가 시)
- macOS 에서는 "WT 자동 팝업" 동작 없음 (psmux 세션만 spawn, 어떤 outer 윈도우도 안 뜸)
- AI 가 이 표현 그대로 답변에 인용할 위험

### S4. `hooks/safety-guard.mjs:89` Windows-specific 메시지

```javascript
"[safety-guard] wt.exe 직접 호출 차단됨.\n"
```

- macOS 에서는 trigger 불가 (`wt.exe` 가 PATH 에 없음)
- 무해 (dormant code) 지만 매뉴얼/디버깅 시 macOS 사용자가 무관 메시지 검색하게 됨

### S5. session-start hook 이 platform 무시하고 inject

- triflux 프로젝트 cwd 에 진입 시 `CLAUDE.md` 가 100% inject (Claude Code 표준 동작)
- 그 안의 `<psmux-wt>` 섹션도 함께 들어옴
- `process.platform === "darwin"` 분기 안 함
- 본 세션 prompt 헤더에 `Platform: darwin` 명시되어 있음에도 룰은 그대로

### S6. 사용자가 인지 부담을 직접 지적

본 세션 사용자 메시지: "여담으로 wt는 window 한정인데 여긴 mac이다?"

→ 룰 inject 가 사용자 인지 흐름에 noise 발생. 사용자가 prompt 읽다가 "이게 왜 mac 에 있지?" 의문 발생.

## 코드 레벨 안전성 검증 (런타임 OK)

세 곳에 `platform guard` 가 정상 작동:

| 위치 | guard |
|------|-------|
| `hub/team/wt-manager.mjs:199` | `if (platform() !== "win32") { return ... }` |
| `hub/team/headless.mjs:1725` | `if (process.platform !== "win32") return false;` |
| `hub/team/headless.mjs:1726` | `if (!process.env.WT_SESSION) return false;` |

→ macOS 에서 wt 코드 path 는 호출돼도 early return. **dead text 는 있어도 dead code 실행은 없다.**

`tfx-route.sh:86, 1662, 1681` 에는 `case "$(uname -s)"` 분기 있어 shell layer 도 안전.

`hub/team/wt-manager.mjs` 자체는 import 시점에 `osPlatform()` 만 호출하고 함수 호출 전까지는 부작용 없음. macOS 에서 import 해도 안전.

## 코드 ≠ 문서 drift

요약:
- 코드: platform 분기 정상 (Windows 외 무시)
- 문서/룰: platform 분기 없음 (Windows 룰을 macOS 사용자에게도 노출)
- safety-guard 메시지: Windows-specific 텍스트, macOS 무해

drift 의 결과:
- 토큰: `CLAUDE.md <psmux-wt>` 약 42 줄 + `tfx-psmux.md` 약 200+ 줄이 매 세션 inject (~5KB)
- 인지: 사용자/AI 둘 다 dead text 읽음
- AI 출력: `WT 자동 팝업`, `wt-manager 경유` 등 macOS 무관 표현 인용 위험

## 권장 fix (우선순위 순)

| 우선순위 | 위치 | 변경 | 효과 |
|---------|------|------|------|
| P1 | `CLAUDE.md` `<psmux-wt>` 시작부 | 1줄 추가: `> **이 섹션은 Windows 환경 한정. macOS/Linux 는 건너뛴다.**` | 사용자/AI 모두 빠른 skip |
| P1 | `.claude/rules/tfx-psmux.md` 헤더 | 1줄 추가: `# tfx-psmux — Windows-only policy` + sync-block 갱신 | 룰 적용 범위 명확화 |
| P2 | `skills/tfx-auto/SKILL.md:801` | `(WT 자동 팝업)` → `(Windows: WT 자동 팝업 / macOS: psmux 단독)` | 표현 정확성 |
| P2 | `hooks/safety-guard.mjs:87~95` | wt.exe 차단 메시지 출력 전 `if (process.platform === "win32")` | macOS 차단 logic skip |
| P3 | `CLAUDE.md:18~60` | 섹션 전체를 platform-aware include 로 (예: `<psmux-wt platform="win32">`) | Claude Code 가 platform-tagged section 지원하면 (현재 미지원이라 P3) |
| P3 | session-start hook | `process.platform === "darwin"` 시 psmux/WT 룰 inject 자체 skip | hook 레이어 분기 — Claude Code 의 CLAUDE.md auto-inject 자체는 못 막아서 hook 으로 후처리 |

P1 만으로도 사용자 인지 부담 대부분 해소. P2 는 1줄~5줄 수준의 소형 PR. P3 는 hook/Claude Code 기능 확장 필요.

## 후속 액션 후보

- [ ] P1 fix 묶어서 단일 PR (`docs(rules): mark psmux/WT rules as Windows-only`)
- [ ] P2 의 SKILL.md 표현 수정은 사용자 다른 세션 (`v10.25.0-core-remote-catchup`) 의 native-bridge UI 작업과 합쳐서 처리 가능
- [ ] safety-guard 평가 — Windows-specific 메시지 외에 다른 platform-aware 차단 룰 점검

## 본 세션에서 관찰된 평행 증거

- 사용자 직접 지적: "wt는 windows 한정인데 여긴 mac이다?"
- `git status` 의 dirty 파일 `skills/tfx-auto/SKILL.md` 변경분에 WT 표현 그대로 유지 (S3 의 PR 머지 전 누락)
- 본 응답 작성자 (Claude) 가 워크플로우 진행 중 "WT 자동 팝업" 표현을 직접 인용한 적 없음 (방어적으로 우회) — 다만 룰 자체는 prompt 에서 읽음
- `Platform: darwin` 가 session prompt 헤더에 명시돼 있음에도 WT 룰 inject 됨 → platform 정보가 룰 inject 결정에 사용 안 됨
