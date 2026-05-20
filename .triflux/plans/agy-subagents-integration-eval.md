# PRD: agy subagents framework 통합 평가

## 문서 목적

이 문서는 triflux 의 기존 hub/team/headless 병렬 실행 인프라와 Antigravity CLI 1.0.0 의 subagents framework 를 어떤 관계로 둘지 평가한다.

결론부터 쓰면, 현재 근거만으로 agy subagents 를 triflux 의 backend 로 흡수하는 것은 이르다.

단기 권장은 **시나리오 B: 병렬 유지**다.

중기 권장은 **시나리오 C: 책임 분리**를 PoC 로 검증하는 것이다.

시나리오 A, 즉 triflux 가 agy subagents framework 를 직접 backend 로 호출하는 방식은 agy 의 외부 API, task channel, lifecycle 제어면이 확인되기 전까지 보류한다.

## 범위

- 신규/수정 파일: `.triflux/plans/agy-subagents-integration-eval.md`
- 언어: 한국어 Markdown
- 성격: 구현 PRD 가 아니라 통합 평가 PRD
- 근거: user-provided 공식 docs verbatim + repo-local `git grep`/파일 확인
- 추정 표기: agy 내부 구현 또는 외부 API 가 확인되지 않은 항목은 반드시 "추정" 또는 "조사 필요"로 표기

## 비범위

- agy CLI 설치/업데이트 절차 변경
- `scripts/tfx-route.sh` 의 agy wrapper 구현 수정
- `hub/team/backend.mjs` 에 AntigravityBackend 추가
- AccountBroker 의 agy account lane 구현
- 실제 agy `/agents` 또는 `/tasks` TUI 자동 조작 구현
- 제품 결정 확정

## 1차 agy 근거

사용자 제공 공식 docs verbatim 기준으로만 확정한다.

- agy CLI 는 asynchronous subagents framework 를 제공한다.
- main agent 는 parallel work, background research, system tests 를 active conversation blocking 없이 위임할 수 있다.
- `/tasks` 는 active background tasks 의 monitor, log view, terminate 를 제공한다.
- `/agents` panel 은 running subagents 를 view/manage/approve 하는 interactive UI 이다.
- subagents 는 code search, file editing, terminal commands, web searches 를 수행할 수 있다.
- main agent 가 subagents 의 tools/permissions 를 결정한다.
- `/agents` panel 에서 conversation log 전체를 확인할 수 있다.
- `ctrl+j` 는 다음 subagent detail view 로 이동한다.
- Fast Path Alerts 는 `ctrl+k` 로 prompt box 위에서 직접 approve 할 수 있다.

## repo-local triflux 근거

triflux 쪽 근거는 현재 worktree 에서 확인했다.

- `hub/team/conductor.mjs:175` 는 Conductor 생성 함수이며, session map, state transition, restart, kill, broker lease 를 소유한다.
- `hub/team/conductor.mjs:228` 는 session state transition 을 event log, emitter, Synapse registry 에 반영한다.
- `hub/team/conductor.mjs:523` 은 child process 를 spawn 하고 stdout/stderr log, completion payload, restart 를 관리한다.
- `hub/team/conductor.mjs:1036` 은 `spawnSession(config)` 로 worker session lifecycle 을 만든다.
- `hub/team/conductor.mjs:1087` 은 AccountBroker lease 를 적용하고, `:1105` 이후 CODEX_HOME/auth env 를 session config 에 병합한다.
- `hub/team/conductor.mjs:1189` 은 `killSession(id, reason)` 을 제공한다.
- `hub/team/headless.mjs:87` 은 headless worker 를 hub bridge 에 register 한다.
- `hub/team/headless.mjs:102` 은 headless result 를 `/bridge/publish` 로 publish 한다.
- `hub/team/headless.mjs:596` 은 progressive psmux pane spawn 경로다.
- `hub/team/headless.mjs:711` 은 batch dispatch 를 `Promise.all` 로 실행한다.
- `hub/team/headless.mjs:792` 는 모든 pane completion 을 병렬 대기한다.
- `hub/team/headless.mjs:1012` 는 `runHeadless(sessionName, assignments, opts)` 의 주 진입점이다.
- `hub/server.mjs:971` 은 Delegator MCP resident service 를 초기화한다.
- `hub/server.mjs:981` 은 Synapse registry, swarm locks, git preflight 를 초기화한다.
- `hub/server.mjs:1075` 은 `tfx-hub` MCP server 를 생성하고 tools/list, tools/call 을 처리한다.
- `hub/server.mjs:1425` 이후 `/bridge/register` 를 처리한다.
- `hub/server.mjs:1527` 이후 `/bridge/publish` 를 처리한다.
- `hub/server.mjs:1612` 이후 `/bridge/assign/async` 를 처리한다.
- `hub/server.mjs:1718` 이후 `/bridge/team/task-list`, `/bridge/team/task-update`, `/bridge/team/send-message` 를 처리한다.
- `hub/server.mjs:1775` 이후 `/bridge/delegator/*` endpoint 를 처리한다.
- `hub/server.mjs:1857` 이후 `/mcp` Streamable HTTP MCP endpoint 를 처리한다.
- `scripts/tfx-route.sh:952` 이후 agent routing table 이 CLI_TYPE, CLI_CMD, CLI_ARGS, effort, timeout 을 결정한다.
- `scripts/tfx-route.sh:994` 는 `antigravity` CLI_TYPE 을 `agy` command 로 매핑한다.
- `scripts/tfx-route.sh:1050` 이후 antigravity lane 은 `--print --dangerously-skip-permissions` 를 사용한다.
- `scripts/tfx-route.sh:2018` 이후 codex exec path 는 prompt 를 argv 로 넘기고 tier fallback 을 수행한다.
- `scripts/tfx-route.sh:2166` 이후 runtime route resolution, hub ensure, CLI execution, post-processing 이 실행된다.
- `scripts/headless-guard.mjs:229` 이후 psmux send-keys/split-window 안의 `agy --print/--prompt` 직접 호출을 차단한다.
- `scripts/headless-guard.mjs:336` 이후 direct tfx-route.sh 호출을 headless dispatch 로 auto-route 한다.
- `scripts/headless-guard.mjs:396` 이후 Agent 래핑과 direct CLI wrapping 을 gate/nudge/deny 한다.
- `hub/account-broker.mjs:258` 은 AccountBroker 가 codex/gemini account pool, lease, cooldown, circuit breaker 를 관리한다고 명시한다.
- `hub/account-broker.mjs:843` 은 lease 를 선택하고, `:987` 은 release 를 처리한다.
- `hub/team/agent-map.json:27` 은 `antigravity`, `:28` 은 `agy` 를 `antigravity` CLI_TYPE 으로 매핑한다.
- `hub/team/backend.mjs:83` 의 backend registry 는 현재 `codex`, `gemini`, `claude` 만 포함한다. `antigravity` backend 는 없다.
- `hub/workers/factory.mjs:83` 의 worker factory 도 `gemini`, `claude`, `codex`, `codex-app-server`, `delegator` 만 지원한다. `antigravity` worker type 은 없다.

## 현재 전제

triflux 는 이미 "외부 CLI 를 worker 로 실행하고 관측/통제하는 orchestrator" 이다.

agy 는 "단일 CLI 내부에서 main agent 가 subagents 를 실행하고 관측/승인하는 runtime" 으로 보인다.

두 시스템은 모두 병렬 작업, background task, permission, log visibility, termination 을 다룬다.

다만 triflux 는 repo-local code 로 관측 가능한 API/bridge/state machine 을 갖고 있고, agy subagents 는 현재 docs verbatim 이외의 외부 machine-readable API 가 확인되지 않았다.

따라서 이 PRD 는 agy 를 "잠재 backend" 로만 보며, 확정된 통합 대상으로 보지 않는다.

## 성공 기준

- 책임 매트릭스가 15개 이상 책임 영역을 비교한다.
- agy 쪽 미확인 항목은 조사 필요로 남긴다.
- 통합 시나리오 A/B/C 의 장단점과 일정 추정이 있다.
- 권장 path 가 보수적이고 실행 가능한 다음 PR scope 로 이어진다.
- 신규 PRD 외 파일은 변경하지 않는다.

---

# 1. 책임 매트릭스: triflux vs agy

| 책임 | triflux 위치 | agy 위치 | 중복도 | 충돌 |
|------|------------|---------|--------|------|
| parallel worker spawn | `hub/team/conductor.mjs`, `hub/team/headless.mjs`, `scripts/tfx-route.sh`, `hub/team/cli/commands/start/*` | `/tasks` framework, `/agents` panel, async subagents | 높음 | 둘 다 worker/subagent spawn 주체가 되면 중복 spawn, 중복 timeout, 중복 kill 발생 가능 |
| background task monitoring | `hub/team/headless.mjs` progress events, `hub/team/cli/commands/status.mjs`, `hub/team/cli/commands/tasks.mjs`, task-notification 운영 규칙 | `/tasks` panel | 높음 | 사용자가 어떤 panel 의 상태를 신뢰해야 하는지 혼란 가능 |
| inter-agent message bus | `hub/server.mjs` bridge endpoints, `hub/bridge.mjs`, `hub/team-bridge.mjs`, `hub/team/conductor-mesh-bridge.mjs` | 조사 필요. docs 는 `/agents` conversation log UI 만 명시 | 중간 | agy subagent messages 가 외부 bridge 로 export 되지 않으면 triflux lead 가 상태를 모름 |
| permission gate | `scripts/headless-guard.mjs`, hooks/safety gate, `hub/account-broker.mjs`, `tfx-route.sh` bypass flags | `/permissions`, Fast Path Alert, main agent tool permission decision | 높음 | 승인 정책이 두 곳에서 동시에 bypass/deny 되면 보안 모델이 불명확 |
| file edit dispatch | `scripts/tfx-route.sh`, Codex/Gemini/Claude worker wrappers, headless result/handoff | agy subagents direct file edit | 높음 | triflux 는 worker ownership/worktree 를 가정하지만 agy 내부 subagents 는 같은 cwd 를 공유할 수 있음 |
| CLI routing/model selection | `hub/team/agent-map.json`, `scripts/tfx-route.sh:952-1086`, profile/effort routing | agy 내부 `/model`, settings, main agent subagent tool decision | 중간 | triflux 가 model/role 을 지정해도 agy 내부 subagent model/permission 은 별도일 수 있음 |
| account/auth lease | `hub/account-broker.mjs`, `conductor.mjs` lease/env/CODEX_HOME 적용 | 조사 필요. 현재 근거는 agy 가 Gemini OAuth creds 를 재사용한다는 운영 메모 수준 | 높음 | 다중 계정 lease 없이 agy 내부 subagents 가 같은 OAuth/account 를 동시 사용하면 quota/race 가능 |
| session registry | Synapse registry in `hub/server.mjs`, `hub/team/headless.mjs` register/heartbeat | `/tasks` active task registry 로 추정 | 중간 | registry ID, heartbeat, stale cleanup semantics 가 다르면 상태 동기화가 깨짐 |
| task lifecycle | `spawnSession`, state transition, `killSession`, `completed/dead` events | `/tasks` terminate, `/agents` manage 로 추정 | 높음 | start/pause/resume/kill semantics 미확인. 특히 pause/resume 은 triflux 에 직접 대응 없음 |
| result handoff | sentinel completion payload, `extract-completion-payload.mjs`, `publishHeadlessResult()` | `/agents` conversation log, `/tasks` logs | 중간 | agy log 는 사람이 볼 수 있어도 machine-readable handoff 인지 미확인 |
| log capture | psmux capture, result files under tmp, out/err logs in conductor | `/tasks` view logs, `/agents` conversation log | 높음 | 두 log source 가 불일치하면 debugging 비용 상승 |
| health/stall detection | `hub/team/health-probe.mjs`, `headless.mjs` completion/stall timeout, Conductor restart | 조사 필요 | 중간 | agy 내부 stall 판단을 triflux 가 관측 못하면 parent timeout 만 남음 |
| termination | `killSession`, psmux kill, runHeadless cleanup, stale cleanup | `/tasks` terminate | 높음 | triflux 가 parent agy 를 kill 해도 agy subagents 정리가 보장되는지 미확인 |
| operator UI | triflux TUI/dashboard/status/notifications | `/tasks`, `/agents`, Fast Path Alerts | 높음 | 두 UI 가 서로 다른 truth 를 보여줄 수 있음 |
| MCP exposure | `hub/server.mjs` Streamable HTTP `/mcp`, `DelegatorService`, `tfx-hub` tools | agy `/mcp`, `mcp_config.json` 로 추정 | 중간 | agy 가 tfx-hub MCP 를 client 로 쓸 수는 있어도 agy subagents task API 를 server 로 expose 하는지는 미확인 |
| web search/research delegation | triflux 는 role/profile 로 외부 CLI capabilities 에 위임 | agy subagents 에 web searches capability 있음 | 중간 | researcher lane 을 agy 내부로 숨기면 triflux provenance 가 약해짐 |
| workspace isolation | worktree, worker sandbox env, branch guard, psmux pane/session isolation | 조사 필요. 같은 agy conversation 내부 subagents 는 같은 workspace 를 공유할 가능성 있음(추정) | 높음 | 파일 edit race, branch guard 우회, dirty tree ownership 충돌 가능 |
| prompt/profile config | `tfx-route.sh` CLI_ARGS, Codex profile, Gemini model flags, MCP profile hints | agy `--print`, `/model`, settings, permissions | 중간 | agy CLI top-level model flag 부재가 확인된 상태라 triflux role별 model forcing 어려움 |
| notification | task-notification 운영 규칙, `hub/team/notify.mjs` bell/toast/webhook | Fast Path Alerts, `/agents` panel alert | 중간 | terminal notification 과 prompt-box approval alert 가 다른 UX 레벨에서 중복 |
| audit/event log | `hub/team/event-log.mjs`, `conductor-events.jsonl`, bridge publish/result | `/agents` conversation log 전체 확인 | 중간 | agy log export format 이 없으면 audit 는 UI-only 가 됨 |
| remote/terminal control | psmux, WT manager, tmux/macOS boundary, remote watcher | agy TUI 내부 panels | 낮음-중간 | agy TUI 를 psmux pane 안에서 돌릴 수는 있어도 panel navigation 자동화는 brittle |
| task decomposition | `tfx-auto`, `tfx-multi`, team PRD/task model | main agent decides subagent work | 높음 | 두 decomposer 가 동시에 task split 을 수행하면 over-delegation 가능 |
| approval provenance | safety hooks, permission-safe allow, bypass flags, Lore/test evidence | `/permissions`, Fast Path Alert approve | 높음 | 승인 주체, 승인 기록, replayability 가 분리됨 |
| package/release mirror | root/package mirror checks, release gates | agy plugin/import surface 로 추정 | 낮음 | 직접 충돌은 적지만 agy plugin import 결과가 triflux package mirror 와 별개 |

## 매트릭스 판정

중복도가 높은 영역은 `parallel worker spawn`, `background task monitoring`, `permission gate`, `file edit dispatch`, `task lifecycle`, `operator UI` 다.

중복도가 높으면서 agy 쪽 machine-readable API 가 미확인인 영역은 즉시 통합하면 안 된다.

triflux 가 이미 구현한 책임은 대부분 "외부 worker 를 관측 가능한 프로세스/bridge/task 상태로 만들기"에 집중되어 있다.

agy subagents 는 "한 CLI 대화 안에서 내부 subagent 를 돌리기"에 집중된 것으로 보인다.

따라서 두 시스템을 같은 orchestration layer 로 겹치면 책임 충돌이 크다.

---

# 2. 통합 시나리오 3가지

## 시나리오 A: triflux 가 agy subagents API 호출

### 개념

triflux hub/team_mode 가 worker 를 직접 spawn 하지 않고 agy 의 subagents framework 를 backend 로 호출한다.

triflux 는 task decomposition, scheduling, AccountBroker, final reporting 을 유지한다.

agy 는 실제 subagent spawn, `/tasks`, `/agents`, approval UI, logs 를 담당한다.

### 필요 조건

- agy subagents 를 외부에서 생성하는 API 또는 CLI command 가 있어야 한다.
- subagent ID, status, logs, termination 을 machine-readable 로 조회할 수 있어야 한다.
- agy task completion 을 JSON/event stream 으로 받을 수 있어야 한다.
- agy permission approval 상태를 외부에서 관측하거나 callback 받을 수 있어야 한다.
- agy subagents 의 cwd, allowed tools, file edit boundaries, auth account 를 지정할 수 있어야 한다.
- agy 내부 task 가 `tfx-hub` MCP 또는 별도 bridge 로 publish 할 수 있어야 한다.

### 장점

- triflux 의 psmux/headless pane orchestration 일부를 줄일 수 있다.
- agy `/agents` panel 의 conversation log, Fast Path Alerts, approval UI 를 활용할 수 있다.
- background research/system tests 는 agy 가 native capability 로 처리할 수 있다.
- agy 의 subagent UX 가 충분히 안정적이면 terminal/pane 구현 부담이 줄 수 있다.

### 단점

- agy 가 black-box 가 된다.
- agy subagents lifecycle 이 UI 중심이면 자동화가 fragile 하다.
- agy 내부 logs/export 가 machine-readable 이 아니면 triflux debugging 품질이 떨어진다.
- vendor lock-in 이 크다.
- triflux AccountBroker, worker sandbox, branch guard, completion payload 와 충돌한다.
- agy permission 승인과 triflux permission gate 의 single source of truth 가 깨질 수 있다.
- agy subagents 가 direct file edit 를 하면 worker ownership/worktree 격리가 약해질 수 있다.

### 일정 추정

- 외부 API 존재 여부 조사: 3-5일
- 최소 PoC: 1-2주
- task/log/kill/status adapter: 2-4주
- permission/auth/workspace isolation hardening: 2-4주
- production quality 전환: 총 4-8주 이상
- 외부 API 가 없고 TUI 조작만 가능하면: production integration 은 비권장

### 주요 리스크

- `/agents` panel 이 interactive UI 로만 제공되면 bridge integration 이 불가능하거나 brittle 하다.
- agy 가 subagent task 를 외부 hub 에 publish 할 수 없다면 triflux 는 parent process exit 밖에 볼 수 없다.
- agy 내부 subagents 가 같은 cwd 를 공유하면 race 방지의 핵심 가치가 사라진다.
- approval UX 는 좋아질 수 있지만 auditability 는 나빠질 수 있다.

### 판정

현재는 보류한다.

단, agy 가 task channel API 또는 MCP server 역할을 공식 제공한다는 근거가 나오면 재평가한다.

## 시나리오 B: 병렬 유지

### 개념

triflux hub/team/headless 는 그대로 유지한다.

agy CLI 는 단일 worker lane 으로만 취급한다.

agy 내부 subagents framework 는 agy worker 가 자체적으로 사용할 수 있지만, triflux 는 그 내부를 orchestration target 으로 삼지 않는다.

### 현재 상태와 부합하는 근거

- `hub/team/agent-map.json` 은 이미 `agy` 와 `antigravity` 를 `antigravity` CLI_TYPE 으로 매핑한다.
- `scripts/tfx-route.sh` 는 `AGY_BIN` 과 `antigravity` lane 을 갖고 있다.
- `scripts/headless-guard.mjs` 는 `agy --print/--prompt` direct call 을 직접 CLI 위험으로 취급한다.
- 반면 `hub/team/backend.mjs` 와 `hub/workers/factory.mjs` 는 아직 antigravity backend/worker 를 지원하지 않는다.

### 장점

- 일정 0에 가깝다.
- 기존 triflux worker lifecycle, AccountBroker, branch guard, handoff, task notification 규칙을 유지한다.
- agy subagents 의 내부 구현 변화가 triflux core 를 흔들지 않는다.
- 사용자는 agy 를 직접 사용할 때 `/tasks`/`/agents` 를 쓰고, triflux 를 쓸 때 `tfx multi/status/tasks` 를 쓰는 식으로 경계가 명확하다.
- 디버깅 시 "triflux parent process" 와 "agy 내부 subagents" 를 분리해서 볼 수 있다.

### 단점

- 사용자 혼란 가능성이 있다.
- agy worker 가 내부 subagents 를 다시 spawn 하면 nested parallelism 이 생긴다.
- CPU, memory, token/quota 리소스 경합을 parent triflux 가 세밀하게 제어하지 못한다.
- agy 내부 subagent failure 는 parent agy exit/log 로만 드러날 수 있다.
- 같은 cwd 에서 triflux worker 병렬 + agy 내부 병렬이 동시에 file edit 하면 race 가능성이 있다.

### 일정 추정

- status quo: 0일
- 문서/guard 보강: 1-3일
- nested parallelism warning, no-op 승격, result parsing 회귀테스트: 2-5일

### 운영 가드

- agy lane 은 "single worker" 로 표시한다.
- agy 내부 subagents 를 triflux task list 에 자동 펼치지 않는다.
- agy parent worker 가 file edit 를 할 수 있는 경우 worktree isolation 을 우선한다.
- agy worker 실행 중 `/agents` panel 내부 상태는 참고 UI 로만 본다.
- triflux 완료 판정은 parent worker output/result/handoff 에 근거한다.

### 판정

단기 권장이다.

현재 근거가 부족한 상태에서 가장 작은 변화로 risk 를 제한한다.

## 시나리오 C: 책임 분리

### 개념

triflux 는 top-level orchestration 을 유지한다.

agy subagents 는 agy single worker 내부 parallelism 으로만 허용한다.

즉 "triflux = multi-CLI orchestration, account/worktree/session/reporting" 이고 "agy = 한 Antigravity CLI process 안의 internal subagents" 로 책임을 나눈다.

### 권장 경계

- triflux 가 task decomposition 과 worker ownership 을 가진다.
- agy 는 `antigravity` role 의 단일 worker 로 실행된다.
- agy 내부 subagents 는 parent agy process 의 implementation detail 로 간주한다.
- triflux 는 agy 내부 subagents 를 직접 kill/status 하지 않는다.
- 단, agy 가 machine-readable task export 를 제공하면 read-only telemetry adapter 를 붙인다.
- agy subagent direct file edit 는 parent agy worker 의 file edit 로 귀속한다.
- completion/handoff 은 agy parent output 에서만 수집한다.

### 장점

- 책임 경계가 명확하다.
- vendor lock-in 을 줄인다.
- agy subagents UX 를 활용하되 triflux core scheduler 를 black-box 로 교체하지 않는다.
- AccountBroker, branch guard, worktree policy, bridge/handoff 를 보존한다.
- 나중에 agy API 가 안정화되면 read-only telemetry 부터 점진 확장할 수 있다.

### 단점

- agy 내부 subagents 의 상세 상태가 triflux UI 에 바로 드러나지 않는다.
- user-facing panel 이 두 개로 남는다.
- nested parallelism resource cap 은 여전히 필요하다.
- parent agy output 이 부실하면 triflux handoff 품질이 낮다.
- agy 내부 approval 이 pending 일 때 triflux 는 "input wait" 를 정확히 판정하기 어렵다.

### 일정 추정

- 문서/UX 경계 명시: 1-2일
- agy single-worker wrapper hardening: 3-5일
- read-only `/tasks` telemetry 가능성 조사: 3-5일
- PoC adapter: 1-2주
- production hardening: 2-4주

### 판정

중기 권장이다.

단기에는 B 로 유지하고, 조사 결과가 충분하면 C 의 read-only telemetry 부터 시작한다.

---

# 3. 핵심 unknowns: 조사 필요

## U1. agy subagents 의 inter-process 통신 mechanism

- 질문: agy subagents 는 IPC, shared memory, local files, embedded goroutine/process, MCP, 또는 internal RPC 중 무엇으로 통신하는가?
- 필요한 근거: 공식 docs, verbose logs, process tree, file watch, network socket, strace/dtruss equivalent
- triflux 영향: bridge adapter 가능 여부를 결정한다.
- 현재 판정: 조사 필요.

## U2. agy 가 외부 hub 와 통신 가능한가?

- 질문: agy main agent 또는 subagent 가 `tfx-hub` MCP client 로 붙어 `/bridge/publish` 같은 event 를 보낼 수 있는가?
- 필요한 근거: agy MCP config format, workspace `.agents/mcp_config.json`, `serverUrl` behavior, subagent tool inheritance
- triflux 영향: 시나리오 C telemetry/handoff 개선 가능 여부를 결정한다.
- 현재 판정: 부분 가능 추정. 단 subagent 별 MCP inheritance 는 조사 필요.

## U3. agy 가 외부 hub 역할을 할 수 있는가?

- 질문: agy `/tasks` channel 을 외부에서 query 하는 MCP server/API 가 있는가?
- 필요한 근거: `agy --help`, docs, hidden commands, local socket/file endpoints
- triflux 영향: 시나리오 A 의 필수 조건이다.
- 현재 판정: 근거 없음. 조사 필요.

## U4. subagents 의 OAuth account sharing

- 질문: agy subagents 가 parent process 와 같은 OAuth/token/keyring 을 공유하는가?
- 질문: 동시 subagent 실행이 quota/account lock/cooldown 을 어떻게 처리하는가?
- 필요한 근거: auth files, keyring access pattern, error logs, parallel smoke test
- triflux 영향: AccountBroker 통합 또는 별도 agy account lane 설계 여부를 결정한다.
- 현재 판정: 조사 필요.

## U5. agy `/agents` panel lifecycle

- 질문: start, pause, resume, kill, approve, reject 가 CLI command 로 가능한가?
- 질문: `ctrl+j`, `ctrl+k` 가 TUI-only 인가?
- 필요한 근거: official docs detail, keybinding config, command palette, inspectable TUI state
- triflux 영향: 시나리오 A 자동화 가능성과 operator UX 를 결정한다.
- 현재 판정: 조사 필요.

## U6. agy `/tasks` lifecycle

- 질문: `/tasks` 는 task list/log/terminate 를 UI 로만 제공하는가, command/API 로도 제공하는가?
- 질문: task ID 가 stable 한가?
- 질문: task completion status 가 exit code 와 연결되는가?
- 필요한 근거: `/tasks` command behavior transcript, logs, CLI flags
- triflux 영향: bridge task-list/task-update 와 호환 가능성 판단.
- 현재 판정: 조사 필요.

## U7. triflux hub bridge 가 agy task channel 과 호환되는가?

- 질문: agy task event 를 `register`, `publish`, `result`, `control`, `assign` 으로 normalize 할 수 있는가?
- 필요한 근거: agy task payload schema
- triflux 영향: C telemetry 또는 A backend adapter 의 구현 난이도.
- 현재 판정: 조사 필요.

## U8. agy 내부 subagents 의 cwd/workspace isolation

- 질문: subagents 가 같은 working directory 를 공유하는가?
- 질문: subagent 별 `--add-dir`, sandbox, readonly/edit permission 을 설정할 수 있는가?
- 필요한 근거: parallel edit smoke test, file lock/logs
- triflux 영향: file edit race 와 branch guard.
- 현재 판정: 같은 cwd 공유 가능성이 있다고 추정. 확인 필요.

## U9. agy parent output 과 subagent logs 의 관계

- 질문: parent `agy --print` output 이 subagent 결과를 모두 포함하는가?
- 질문: `/agents` conversation log 를 file/json 으로 export 할 수 있는가?
- 필요한 근거: subagent 실행 transcript, local log files
- triflux 영향: handoff 품질과 completion payload extraction.
- 현재 판정: 조사 필요.

## U10. agy approval pending 상태 감지

- 질문: Fast Path Alert pending 상태가 parent CLI output/log/process status 에 드러나는가?
- 질문: headless `--dangerously-skip-permissions` 에서도 subagents approval 이 완전히 bypass 되는가?
- 필요한 근거: permission-required command smoke test
- triflux 영향: headless stall/input_wait 판정.
- 현재 판정: 조사 필요.

## U11. nested parallelism resource caps

- 질문: agy internal subagents 개수 제한이 있는가?
- 질문: parent agy process 에서 subagent fan-out cap 을 설정할 수 있는가?
- 필요한 근거: docs, settings, stress test
- triflux 영향: tfx multi parallelism 과 중첩될 때 CPU/token/quota 폭증 가능성.
- 현재 판정: 조사 필요.

## U12. AntigravityBackend gap

- 질문: `hub/team/backend.mjs` 와 `hub/workers/factory.mjs` 에 antigravity backend/worker 를 추가해야 하는가?
- 근거: `agent-map.json` 은 agy 를 매핑하지만 backend registry/factory 는 antigravity 를 모른다.
- triflux 영향: headless/team 경로에서 agy lane 이 모든 route 에서 동작하는지 검증 필요.
- 현재 판정: 별도 wrapper Tier 2 PRD/PR 범위로 다루는 것이 맞다.

---

# 4. 권장 path

## 권장 요약

단기: **시나리오 B, 병렬 유지**.

중기: **시나리오 C, 책임 분리 + read-only telemetry PoC**.

보류: **시나리오 A, agy backend 위임**.

## 이유

1. agy subagents 는 공식 docs 상 강력한 병렬/approval/log UX 를 제공하지만, 외부 orchestration API 가 확인되지 않았다.

2. triflux 는 이미 bridge, task model, Conductor state machine, AccountBroker, psmux/headless, MCP server 를 보유한다.

3. 두 시스템의 책임이 가장 많이 겹치는 영역이 permission, lifecycle, file edit, monitoring 이다.

4. 이 네 영역은 잘못 통합하면 사용자 혼란보다 더 큰 correctness/security 문제가 된다.

5. agy 내부 subagents 를 black-box backend 로 쓰면 triflux 의 핵심 장점인 evidence, audit, worktree ownership, retry/kill control 이 약해진다.

6. 반대로 agy 를 single worker 로 두면 현재 구조와 잘 맞고, agy 내부 subagents 는 점진적으로 관측만 추가할 수 있다.

## 정책 문장

agy 는 당분간 triflux worker backend 가 아니라 **Antigravity CLI lane** 이다.

triflux 는 agy 내부 subagents 를 직접 orchestration unit 으로 취급하지 않는다.

triflux 완료/실패 판정은 parent agy process 의 exit, stdout/stderr, handoff, workspace diff 에 근거한다.

agy `/tasks`/`/agents` 는 단기에는 operator debug UI 로만 취급한다.

machine-readable API 가 확인되면 read-only telemetry 부터 붙이고, write/control integration 은 별도 보안 review 후 결정한다.

## 금지할 premature integration

- TUI key sequence 로 `/agents` panel 을 자동 조작하는 통합.
- agy subagent log 를 안정 schema 없이 regex 로 파싱해 task truth 로 삼는 통합.
- agy 내부 subagents 를 triflux task list 에 가짜 worker 로 등록하는 통합.
- agy permission approval 을 triflux permission gate 와 동등하게 간주하는 통합.
- AccountBroker 없이 다중 agy subagents 를 production 병렬 lane 으로 열어두는 통합.

## 허용할 작은 단계

- agy parent worker 실행/종료/log capture 안정화.
- agy `/tasks` output 을 사람이 읽는 debug artifact 로 저장.
- agy 내부 subagents 사용 여부를 parent worker summary 에 표시.
- agy 가 `tfx-hub` MCP 를 client 로 사용할 수 있는지 확인.
- agy subagent logs 가 JSON/event 형태로 export 가능하면 read-only adapter PoC.

---

# 5. 다음 PR scope

## PR 1: agy subagents API surface 정밀 조사

### 목표

agy subagents 가 외부에서 제어/관측 가능한지 확인한다.

### 작업

- `agy --help`, `agy help`, `/tasks`, `/agents`, `/permissions`, `/mcp` command detail 수집
- `/tasks` list/log/terminate 의 machine-readable 출력 가능 여부 확인
- `/agents` lifecycle command 또는 config/keybinding surface 확인
- subagent 실행 중 process tree, local file/log, socket, mcp activity 샘플링
- parent `agy --print` output 과 내부 subagent log 의 관계 확인
- permission pending/approve/reject 상태가 headless 에서 어떻게 보이는지 확인

### 산출물

- `.triflux/plans/agy-subagents-api-surface-research.md`
- transcript snippets
- 가능/불가능 판정표
- "A 가능", "C telemetry 가능", "B 유지" 중 하나의 후속 권장

### Acceptance

- UI-only 와 API-backed 기능을 분리한다.
- 최소 3개 smoke transcript 를 남긴다.
- 조사 불가 항목은 왜 불가인지 기록한다.

## PR 2: triflux hub bridge 의 agy task channel 통합 PoC

### 목표

agy 내부 task 상태를 read-only 로 triflux 에 보여줄 수 있는지 확인한다.

### 전제

PR 1 에서 agy task/log/status 의 안정적인 외부 관측면이 발견된 경우에만 진행한다.

### 작업

- agy parent worker ID 와 agy internal task ID mapping 설계
- `bridge/register` 는 parent agy process 만 등록
- internal task 는 `metadata.agy_tasks` 또는 별도 read-only status 로 표시
- `/bridge/publish` 는 parent worker event 로만 발행
- kill/control 은 parent agy process 에만 허용
- agy internal task terminate 는 PoC 에서 금지

### 산출물

- adapter PoC module
- 샘플 JSON schema
- status rendering screenshot 또는 text fixture
- rollback plan

### Acceptance

- read-only telemetry 가 parent worker truth 를 덮어쓰지 않는다.
- agy 내부 task 가 없어도 기존 worker status 는 정상이다.
- agy API 가 없으면 PR 2 는 cancel 하고 B 유지 문서만 남긴다.

## PR 3: AccountBroker 와 agy 인증 lane 호환성 평가

### 목표

agy subagents 병렬 실행이 현재 account/quota/auth lane 과 충돌하는지 평가한다.

### 작업

- agy CLI 가 쓰는 auth files/keyring path 확인
- Gemini OAuth creds 재사용 여부 재검증
- 다중 subagent 실행 시 quota/rate-limit/error category 수집
- AccountBroker lease 개념을 agy parent process 에만 적용할지, internal subagents 까지 확장할지 비교
- `TFX_DISABLE_ACCOUNT_BROKER`, `TFX_CODEX_HOME` 유사 env 가 agy 에 필요한지 검토

### 산출물

- `.triflux/plans/agy-accountbroker-compat.md`
- auth path matrix
- parallel quota smoke result
- 권장 account policy

### Acceptance

- parent agy process 와 internal subagents 의 auth boundary 를 분리해서 설명한다.
- account lease 를 agy 내부 subagents 단위로 적용할 수 없으면 명확히 "불가/비권장" 으로 표시한다.
- 2026-06-18 Gemini OAuth lane 변화 리스크와 별도 agy enterprise lane 가능성을 분리한다.

## PR 4: agy single-worker wrapper hardening

### 목표

시나리오 B/C 의 기반으로, agy 를 "triflux single worker lane" 으로 안정화한다.

### 작업

- `hub/team/backend.mjs` antigravity backend gap 검증
- `hub/workers/factory.mjs` antigravity worker 필요 여부 검증
- `tfx-route.sh` antigravity lane 의 stdin/argv/flag order 회귀테스트 추가
- no-op success 승격이 agy output 에서 오탐 없는지 확인
- `headless-guard.mjs` direct `agy --print/--prompt` 차단 테스트 추가

### 산출물

- 최소 단위 테스트
- one-shot smoke command transcript
- route/headless 경계 문서

### Acceptance

- agy lane 이 tfx-route 단일 실행에서 성공/실패/no-op 을 구분한다.
- headless/team 경로에서 "지원 안 됨"이면 명확한 error 를 낸다.
- backend/factory 미지원이 있으면 PR 4 에서 수정하거나 명시적으로 unsupported 로 guard 한다.

---

# 결정 기록

## 결정 1: agy 를 즉시 orchestration backend 로 삼지 않는다

근거는 external task API 부재다.

triflux 는 backend 로 삼는 대상에 대해 spawn/status/log/kill/result 를 machine-readable 로 가져야 한다.

현재 agy 공식 docs 근거는 `/tasks`/`/agents` UI 와 subagents capability 설명이지, 외부 API contract 가 아니다.

## 결정 2: 단기에는 agy parent process 만 worker truth 로 본다

triflux task truth 는 parent worker 의 exit/status/result/handoff 이다.

agy 내부 subagent 는 implementation detail 이다.

이 경계는 사용자 혼란과 audit 분산을 줄인다.

## 결정 3: 중기 PoC 는 read-only telemetry 부터 시작한다

write/control/terminate 는 permission, lifecycle, workspace ownership 위험이 크다.

read-only telemetry 는 실패해도 parent worker truth 를 깨지 않는다.

따라서 C 의 첫 단계는 read-only adapter 로 제한한다.

## 결정 4: AccountBroker 호환성은 별도 PRD 로 분리한다

agy 내부 subagents 의 OAuth/account sharing 은 핵심 unknown 이다.

이 문제를 해결하지 않고 production 병렬 lane 으로 열면 quota/rate-limit/cooldown 이 불투명해진다.

따라서 AccountBroker 호환성은 통합 PoC 와 별도 workstream 으로 둔다.

---

# Acceptance checklist

- [ ] 이 PRD 는 신규 파일로 존재한다.
- [ ] 책임 매트릭스가 15행 이상이다.
- [ ] 시나리오 A/B/C 의 장점, 단점, 일정 추정이 있다.
- [ ] 핵심 unknowns 가 조사 방법과 함께 적혀 있다.
- [ ] 권장 path 가 단기/중기/보류로 분리되어 있다.
- [ ] 다음 PR scope 가 조사, PoC, AccountBroker, wrapper hardening 으로 나뉜다.
- [ ] 추정은 추정으로 표시되어 있다.
- [ ] AI co-author footer 가 없다.
