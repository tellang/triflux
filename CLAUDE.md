# triflux — Claude Code 운영 가이드

<core-systems>
## 핵심 스킬 시스템 (항상 인지)

이 프로젝트는 3개의 스킬 시스템을 동시에 사용한다. 어떤 작업이든 해당 시스템의 스킬이 있는지 먼저 확인한다.

| 시스템 | 접두사 | 용도 | 스킬 수 |
|--------|--------|------|---------|
| **triflux** | `/tfx-*` | CLI 라우팅, 멀티모델 오케스트레이션, 스웜, 원격 실행 | ~40개 |
| **gstack** | `/` (접두사 없음) | QA, ship, investigate, design, review, checkpoint | ~35개 |
| **omc** | `/oh-my-claudecode:*` | autopilot, ralph, team, ultrawork, ccg | ~25개 |

스킬을 모르면 자연어 라우팅(아래)으로 자동 매핑된다.
세션 종료 전 메모리 파일이 3개+ 변경됐으면 `/memory-hygiene` 제안을 검토한다.
</core-systems>

<routing>
## 자연어 → 스킬 라우팅

사용자가 스킬명을 모르더라도 자연어로 요청하면 아래 규칙에 따라 적절한 스킬을 호출한다.

### 행동 유형 → 스킬 매핑

| 의도 | 자연어 신호 | 스킬 |
|------|-----------|------|
| 구현/수정 | 만들어, 고쳐, 구현해, 짜줘, 수정해, 바꿔 | tfx-auto |
| 리뷰 | 봐줘, 리뷰해, 검토해, 괜찮아? | tfx-review |
| 분석 | 분석해, 어떻게 돌아가?, 구조가 뭐야 | tfx-analysis |
| 계획 | 계획, 어떻게 하지, 설계해 | tfx-plan |
| 검색 | 찾아, 어디있어, 파일 찾아 | tfx-find |
| 리서치 (빠른) | 검색해줘, 찾아봐, 공식문서, 이거 뭐야 | tfx-research |
| 리서치 (자율) | 자율 리서치, 검색하고 정리해, research and plan | tfx-autoresearch |
| 테스트 | 테스트, 검증, 돌려봐, QA | tfx-qa |
| 정리 | 정리해, 슬롭 제거, 클린업 | tfx-prune |
| 토론 | 뭐가 나을까, 비교해, A vs B | tfx-debate |

### 깊이 수정자

| 수정자 | 신호 | 효과 |
|--------|------|------|
| 기본 | (없음), 빠르게, 간단히 | Light 스킬 |
| 깊이 | 제대로, 꼼꼼히, 철저히 | Deep 스킬 (tfx-deep-*). 예외: tfx-deep-interview는 Gemini 단독 |
| 합의 | 3자, 교차, 다각도 | consensus 프로토콜 |
| 반복 | 끝까지, 멈추지마, ralph | persist 모드 |
| 자율 | 알아서, 자동으로, autopilot | autopilot 모드 |

### CLI 라우팅

headless-guard가 `codex exec` / `gemini -y -p` 직접 호출을 차단한다. tfx 스킬 경유 필수.

**Layer 1 — Light** (tfx-route.sh → 단일 CLI)

| 스킬 | CLI | 용도 |
|------|-----|------|
| tfx-auto | 자동 | 통합 진입점 |
| tfx-codex | Codex | Codex 전용 |
| tfx-gemini | Gemini | Gemini 전용 |
| tfx-autopilot | Codex→검증 | 단일 파일, 5분 이내 |
| tfx-autoroute | 자동 승격 | 실패→더 강한 모델 |

**Layer 2 — Deep** (headless 3-CLI 합의)

tfx-deep-review, tfx-deep-qa, tfx-deep-plan, tfx-deep-research, tfx-consensus, tfx-debate, tfx-panel, tfx-fullcycle, tfx-persist

**Layer 3 — Remote/병렬**

| 스킬 | 용도 |
|------|------|
| tfx-multi | 2+개 태스크 headless 병렬 |
| tfx-codex-swarm | PRD별 worktree + Codex 다중 (로컬 전용) |
| tfx-remote-spawn | Claude Code 원격 세션 (SSH, setup 필수) |

**Claude 네이티브** (CLI 불필요): tfx-find, tfx-forge, tfx-prune, tfx-index, tfx-setup, tfx-doctor, tfx-hooks, tfx-hub

자원 우선순위: remote-spawn > codex-swarm > multi > Light > 로컬 단독

### 충돌 해소

- ralph = persist alias
- "auto" 단독 → tfx-auto. "알아서 해" → tfx-autopilot
- "코드에서 찾아" → tfx-find. "알아봐" → tfx-research
- 복합 의도: "구현하고 리뷰까지" → tfx-auto → cross-review hook
</routing>

<session-context>
## 맥락 이탈 판단

현재 세션 맥락과 무관한 요청이 감지되면 psmux 격리를 제안한다.

| 확신도 | 신호 | 행동 |
|--------|------|------|
| 확실 | "새 탭", "별도로", "새 세션" | 바로 psmux spawn |
| 높음 | 다른 프로젝트/스택 언급 | 분리 제안 |
| 중간 | 작업 유형 전환 | 분리 제안 + 현재 세션 옵션 |
| 낮음 | 현재 작업 연장 | 세션 유지 |
</session-context>

<psmux-wt>
## psmux/WT 규칙

psmux 세션·WT 패인을 생성/조작/정리할 때 `tfx-psmux-rules` 스킬을 참조한다.
WT 프리징 방지: exit → sleep 2 → kill 순서. 바로 kill하지 않는다.

### wt.exe → wt-manager 경유

safety-guard가 `wt.exe`, `wt new-tab`, `wt split-pane`, `Start-Process wt`를 차단한다.
`hub/team/wt-manager.mjs`의 API를 사용한다.

| 용도 | API |
|------|-----|
| 새 탭 | `createTab({ title, command, profile, cwd })` |
| 패인 분할 | `splitPane({ direction: 'H'\|'V', title, command })` |
| 다중 배치 | `applySplitLayout([{ title, command, direction }])` |
| 탭 정리 | `closeTab(title)` / `closeStale({ olderThanMs, titlePattern })` |

차단과 대안은 항상 쌍으로 존재해야 한다. 차단만 추가하고 대안을 안 만들면 데드락.

### psmux에서 Codex 실행

| 방식 | 동작 | 이유 |
|------|------|------|
| `codex` (interactive) | 불가 | psmux에서 TTY를 못 잡음 |
| `codex < prompt.md` | 불가 | "stdin is not a terminal" |
| `codex exec "$(cat prompt.md)" -s danger-full-access --dangerously-bypass-approvals-and-sandbox` | 사용 | 유일한 안전 경로 |

`codex exec`는 config.toml `approval_mode`를 무시하므로 `--dangerously-bypass-approvals-and-sandbox` 필수.
`-s` 유효값: read-only, workspace-write, danger-full-access.
</psmux-wt>

<codex-config>
## Codex config.toml

config.toml에 이미 설정된 값은 CLI 플래그로 중복 지정하지 않는다.

| config.toml에 있으면 | CLI에서 생략 |
|---------------------|-------------|
| `sandbox = "elevated"` | `--full-auto` |
| `approval_mode = "full-auto"` | `--full-auto` |

안전 패턴: config.toml에 기본값을 두고, CLI에서는 `--profile` 선택만 한다.
</codex-config>

<remote>
## 원격 실행

### 스킬 구분

| 스킬 | 대상 | 방식 |
|------|------|------|
| tfx-codex-swarm | 로컬 전용 | 로컬 worktree + psmux |
| tfx-remote-spawn | Claude Code 원격 | SSH → Claude Code 세션 → 내부 tfx 라우팅 |

codex를 SSH 너머로 직접 실행하지 않는다. config.toml 충돌 + TTY 문제.
원격에서 codex가 필요하면: remote-spawn → Claude Code → Claude가 내부에서 codex 호출.

### SSH 패턴

- 인라인 쿼팅 대신 scp + `pwsh -File` 패턴 사용
- SSH 전송 중 `$var` 전개 주의, PowerShell 변수는 인라인 불가
- `~` → `$HOME` 변환 필수, 원격 기본 셸 = PowerShell
</remote>

<cross-review>
## 교차 검증

- Claude 작성 코드 → Codex 리뷰
- Codex 작성 코드 → Claude 리뷰
- 동일 모델 self-approve 하지 않는다
- git commit 전 미검증 파일 감지 시 nudge
</cross-review>
