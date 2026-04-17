<!-- prompt-hygiene:ignore line_count_warning -->
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
| `approval_mode = "auto"` | `-a`, `--full-auto` |
| `sandbox = "workspace-write"` | `-s`, `--full-auto` |

안전 패턴: config.toml에 기본값을 두고, CLI에서는 `--profile` 선택만 한다.
</codex-config>

<account-broker>
## AccountBroker (계정 브로커)

conductor, headless, swarm-hypervisor가 하나의 AccountBroker 싱글턴을 공유한다.

| 항목 | 설명 |
|------|------|
| 계정별 CircuitBreaker | 장애 격리 — 한 계정 오류가 다른 계정에 전파되지 않음 |
| busy 플래그 | 동일 계정 이중 임대(double-lease) 방지 |
| `/broker/reload` | 장시간 세션 중 accounts.json 핫리로드 |
| EventEmitter 이벤트 | `lease`, `release`, `cooldown`, `tierFallback`, `circuitOpen`, `circuitClose`, `noAvailableAccounts` — HUD 연동용 |
</account-broker>

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

hosts.json `os` 필드로 대상 셸을 판단한다. safety-guard도 이 필드를 참조.

| 대상 OS | 셸 | 패턴 |
|---------|-----|------|
| windows | PowerShell | scp + `pwsh -File` 필수. `$var` → `$env:VAR`, `2>/dev/null` → `2>$null` |
| darwin | zsh | 인라인 가능. brew PATH 주의 (`/opt/homebrew/bin`) |
| linux | bash | 인라인 가능. 표준 POSIX |

- `~` → `$HOME` 변환은 모든 OS 공통
</remote>

<headless-retrieval>
## Headless 결과 회수

background로 실행한 headless 결과는 **반드시 task-notification 완료 후** 읽는다.

| 패턴 | 올바름 | 이유 |
|------|--------|------|
| task-notification 후 output 파일 읽기 | YES | 프로세스 종료 = 워커 전부 완료 |
| task-notification 전 output 파일 tail | NO | 시작 메시지만 보이고 "실패"로 오진 |
| psmux capture-pane으로 중간 체크 | NO | 워커 진행 중이면 빈 화면일 수 있음 |

완료 마커: `=== HEADLESS_COMPLETE succeeded=N failed=N total=N ===`
워커 상세: `$TMPDIR/tfx-headless/{sessionName}-worker-N.txt`
</headless-retrieval>

<cross-review>
## 교차 검증

- Claude 작성 코드 → Codex 리뷰
- Codex 작성 코드 → Claude 리뷰
- 동일 모델 self-approve 하지 않는다
- git commit 전 미검증 파일 감지 시 nudge
</cross-review>

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
| tfx-swarm | PRD별 worktree + 다중 모델(Codex/Gemini/Claude) + 다중 기기(로컬+원격) |
| tfx-remote-spawn | Claude Code 원격 세션 (SSH, setup 필수) |

**Claude 네이티브** (CLI 불필요): tfx-find, tfx-forge, tfx-prune, tfx-index, tfx-setup, tfx-doctor, tfx-hooks, tfx-hub

자원 우선순위: remote-spawn > swarm > multi > Light > 로컬 단독

### 충돌 해소

- ralph = persist alias
- "auto" 단독 → tfx-auto. "알아서 해" → tfx-autopilot
- "코드에서 찾아" → tfx-find. "알아봐" → tfx-research
- 복합 의도: "구현하고 리뷰까지" → tfx-auto → cross-review hook

### Q-Learning 동적 라우팅 (실험적)

- `TRIFLUX_DYNAMIC_ROUTING=true` 또는 `1` 설정 시 Q-Learning 기반 동적 스킬 라우팅 활성화
- `routing-weights.json` + Q-table로 스킬 선택 최적화
- 기본 비활성
</routing>

<execution-skill-map>
## 실행 스킬 맵 — tfx-auto 중심

### 멘탈 모델

사용자는 `tfx-auto`만 알아도 된다. auto가 내부에서 multi/swarm을 자동 선택한다. 명시 오버라이드는 magic keyword: "스웜", "멀티".

### 내부 라우팅 (auto가 판정)

| 입력 특성 | auto가 dispatch할 엔진 |
|-----------|---------------------|
| 1 태스크 + 작음 (S) | 직접 실행 (fire-and-forget) |
| 1 태스크 + 큼 (M+) | pipeline (plan → PRD → exec → verify) |
| 2+ 태스크 + 코드 변경 **없음** | **tfx-multi** (로컬 headless 병렬) |
| 2+ 태스크 + 코드 변경 **포함** | **tfx-swarm** (worktree 격리 필수) |
| 원격 + 코드 변경 | **tfx-swarm** (shard `host:`) |
| 원격 + 탐색/대화형 | **tfx-remote-spawn** (세션 관리 + resume) |

### 엔진 역할

| 엔진 | 역할 | 호출 경로 |
|------|------|----------|
| tfx-multi | 로컬 headless 병렬 (cwd 공유, worktree 불필요) | auto 내부 dispatch 또는 `/tfx-multi` |
| tfx-swarm | 격리 + 다기기 + auto merge (로컬/원격) | auto 내부 dispatch 또는 `/tfx-swarm` |
| tfx-remote-spawn | 단일 세션 관리 (list/attach/send/resume/탐색) | 직접 `/tfx-remote-spawn` |
| tfx-codex-swarm | **DEPRECATED** — tfx-swarm으로 통합됨 | 사용 금지 |

### 핵심 차이 (격리 기준)

| 항목 | tfx-swarm | tfx-remote-spawn | tfx-multi |
|------|-----------|------------------|-----------|
| Working tree 격리 | **YES** (shard별 `.codex-swarm/wt-*`) | NO (cwd 공유) | NO (cwd 공유) |
| 원격 지원 | shard별 `host:` 자동 분배 (격리 유지) | SSH 단일 세션 | 로컬 전용 |
| 자동 merge | YES | NO | NO |
| 입력 | PRD 파일 | 자연어 프롬프트 | `--assign 'cli:prompt:role'` |

### 안티패턴 (실제 사고)

- ❌ PR conflict 해결을 `tfx-remote-spawn`으로 실행 → WT 세션 `git checkout feat/X` → 메인 세션 working tree도 함께 전환 → race (2026-04-17 PR #72 사고)
- ❌ 단일 파일 수정을 `tfx-swarm`으로 → PRD + worktree 오버헤드 과잉 → `tfx-autopilot` 사용
- ❌ `tfx-multi`로 코드 수정 병렬 → cwd 공유 파일 race → `tfx-swarm`

### 핵심 룰

> **코드 변경 = tfx-swarm만** (로컬/원격 동일). remote-spawn은 원격 대화형/탐색 전용. multi는 로컬 headless 병렬 (worktree 불필요 read-only 작업).

### 알려진 한계

현재 `tfx-auto`는 2+ 태스크를 만나면 **multi로만 dispatch**한다. 코드 변경 포함 시 자동 swarm dispatch 로직은 Issue #87 (auto 라우터 강화)에서 추적.
</execution-skill-map>

<update-logic>
## 업데이트 로직

| 도구 | 감지 | 갱신 방법 |
|------|------|----------|
| **triflux (자체)** | `tfx --version` vs `gh release list --repo tellang/triflux` | `npm i -g triflux` 또는 `claude plugin update triflux` |
| **OMC (oh-my-claudecode)** | 세션 시작 훅 `[OMC VERSION DRIFT]` / `[OMC UPDATE AVAILABLE]` | `omc update` — plugin/npm CLI/CLAUDE.md 3곳 동시 동기화 |
| **gstack** | `~/.gstack/last-update-check` 훅 / 세션 시작 배너 | `/gstack-upgrade` 스킬 (git install이면 `git merge --ff-only origin/main` + `./setup` + migrations) |
| **Codex CLI** | `codex --version` / `~/.codex/auth.json` mtime | `npm i -g @openai/codex` / 토큰 만료 시 `codex login` (인터랙티브) + 메시지 한 번 날려 refresh 트리거 |
| **Gemini CLI** | `gemini --version` | `npm i -g @google/gemini-cli` |
| **Hub MCP URL 동기화** | Hub 시작 시 hub.pid의 port vs settings의 tfx-hub.url | PR #82 자동화 (`scripts/sync-hub-mcp-settings.mjs`의 `syncHubMcpSettings({hubUrl})`를 server startup에서 호출) |
| **Codex auth 캐시** (pte1024 등) | 병렬 codex exec 시 `refresh_token_reused` | `cp ~/.codex/auth.json ~/.claude/cache/tfx-hub/codex-auth-<account>.json` 수동 (Issue #78 자동화 대기) |

### 주의

- `git reset --hard`는 safety-guard가 차단 → `git merge --ff-only`로 우회
- OMC drift 감지 시 plugin/npm/CLAUDE.md 3개 컴포넌트를 **반드시 함께** 갱신 (한쪽만 새 버전이면 훅/라우팅 호환성 깨짐)
- gstack 업그레이드 후 `~/.gstack/just-upgraded-from`을 체크해서 CHANGELOG 하이라이트 표시
- 원격 머신 업그레이드 전파는 `tfx-remote-spawn` + SSH scp로 수동 (자동화 예정)
</update-logic>
