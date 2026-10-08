# 구식 기능 잔재와 AI 슬롭 전수 조사 (2026-10)

## 목적

ADR-0023 이 걷어내기로 한 command hook, 키워드 라우팅, MCP gateway, synapse, 허브 바깥에서
여전히 남아 있는 구식 잔재와 AI 슬롭을 찾아 분류한다. 이 문서는 1단계 산출물이며 코드를 바꾸지
않는다. 2단계는 사용자가 승인한 묶음만 PR 하나씩 제거한다.

찾는 대상은 다음 중 하나에 해당하는 코드, 스크립트, 스킬, 규칙 문서, 설정, 테스트다.

- 예전 모델이나 예전 CLI 한계를 메우려고 만들었는데 지금(조사 시점 기준 Claude Code 2.1.292, Codex 0.160.1, agy 1.3.1, gemini CLI 미설치, psmux 와 wt 미설치)은 필요 없는 것
- Claude Code, Codex, agy 에 네이티브 기능이 있는 것
- 이미 잘 동작하는 것을 감싸기만 하는 래퍼
- 의도와 다르게 동작하는 것, 문서와 코드가 다른 것
- 하위 호환 분기, 별칭, 폐기 예정 경로
- 중복 구현, 만들다 만 것, 호출자 없는 것, 항상 no-op 인 것
- 비효율(매번 프로세스 생성, 같은 파일 반복 읽기)
- 과장된 주석, 장황한 주석, 과잉 테스트, 상투구

플랫폼 기준은 사용자가 확정하였다. wt(Windows Terminal)와 psmux 는 Windows 전용, tmux 와 iTerm2 는 Mac 전용이다. 코드는 Linux 에도 tmux 를 쓰므로 Linux 지원 범위는 별도 결정이다.

제외 구역은 인프라 축소 세션(`.worktrees/infra-slim`)과 오케스트레이션 개선 세션(`.worktrees/live-ops`)이 맡는다. 거기서 발견한 것은 "넘길 항목"에만 적는다.

## 방법과 한계

### 조사 방법

| 단계 | 방법 | 산출물 |
|---|---|---|
| 1 | Claude transcript 743개 파일(최근 90일, 46개 프로젝트 디렉터리)에서 Skill 호출, slash 명령, `tfx <sub>`, `tfx-route.sh <role>`, `tfx-live <sub>`, MCP tfx-hub 도구 호출을 `tool_use.id` 로 중복 제거해 집계 | usage-evidence.md |
| 2 | Codex 세션 로그 3830개 파일(최근 90일)에서 같은 문자열 빈도 집계. 중복 제거 없음, 산문 적중 포함, 참고용 | codex-usage.md |
| 3 | knip 정적 분석(`npx knip@latest`, 저장소 knip.json). unused files, unused exports, duplicates | knip-summary.md |
| 4 | 모듈별 basename 참조 수를 비테스트 코드, 테스트, sh·md·json 세 종류로 집계 | importers.tsv |
| 5 | 파일별 마지막 커밋 날짜와 최초 추가 날짜 | file-last-commit.tsv, file-first-commit.tsv |
| 6 | 영역 10개를 sonnet 서브에이전트가 병렬 탐색(effort medium). 후보마다 파일을 끝까지 읽고 소비자를 rg 로 재확인. 장황 주석, 장황 코드, 과잉 테스트를 추가 지시 뒤 갱신판 제출 | findings-*.md(항목 493개) |
| 7 | packages 미러는 리드가 직접 판정(pack.mjs, 세 package.json, check-packages-mirror 실행) | P 절 |
| 8 | 네이티브 대체 주장 15건을 Codex document-specialist 가 공식 문서와 대조(URL 포함) | native-replacement-check.md |
| 9 | 분류가 나뉘거나 근거가 약한 묶음 12개를 opus 서브에이전트가 재판정(effort high). 1차 24행을 뒤집었고 PR 의존 순서를 제안 | second-pass.md |
| 10 | 즉시 제거 파일 후보 66개를 agy(Gemini 3.8 Flash)가 독립 재확인. 이견은 전부 "package.json 스크립트, pack.mjs 목록, 문서 링크를 같이 고쳐야 한다"는 조건부였고 항목표가 이미 담고 있었다. 새로 찾은 소비자 1건(`bin/tfx-profile.mjs`)을 A47 에 반영 | agy-crosscheck.md |
| 11 | 리드가 즉시 제거 후보의 파일을 직접 읽어 확인하고, 설치본 버전·`claude --help`·`better-sqlite3` 로드·async 잡 실사용·HUD 락 파일 시각을 실측 | 이 문서, lead-notes.md |

### 읽음 열

항목마다 리드가 직접 읽은 범위를 적었다. `전체` 는 파일을 끝까지 읽은 것, `함수` 는 해당 범위와 호출자만 읽은 것, `집계` 는 export 소비자 수와 rg 결과만 본 것이다. 문서 항목은 해당 줄을 읽었다. 2차 판정자가 전체를 읽고 리드는 핵심 함수만 다시 읽은 행은 그렇게 적었다. 리드가 읽지 않은 서브에이전트 후보는 항목표에 올리지 않고 부록 "리드 미확인 후보"에 두었다.

### 한계

- transcript 집계는 이 기기의 Claude 세션만 본다. 다른 호스트, agy 세션, 훅이 유도한 호출과 자연 호출의 구분이 없다. 사람이 터미널에서 직접 친 `tfx` 명령은 집계에 없다. 파일 mtime 으로 1차 선별하므로 90일 전에 끝난 세션은 빠진다. 정규식 추출이라 산문 적중이 섞여 있어 표의 수치는 상한이다.
- Codex 로그 집계는 중복 제거를 하지 않았다. 순위 비교에만 쓴다.
- knip 은 정적 import 그래프만 본다. bash 에서 `node scripts/x.mjs` 로 실행하는 파일, package.json `bin`, 스킬 문서가 안내하는 명령, 동적 import 는 "사용"으로 잡지 못한다(K 절의 mcp-health 가 그 예). knip.json 의 project 패턴에 `cto/`, `mesh/`, `tui/` 가 없어 그 디렉터리는 분석 밖이다.
- importers.tsv 는 basename 매칭이라 같은 이름의 파일이 여럿이면 과대 집계한다(A16 routing.mjs).
- "안 쓰인다" 는 모두 위 집계의 범위 안에서만 성립한다. Windows 와 원격 경로는 이 기기에서 안 쓰였다는 이유로 제거 후보에 올리지 않았다. 올린 것은 결함이나 미연결이 근거다.
- 미사용과 대체 완료는 다른 사실이다. 네이티브 대체를 주장하는 항목에는 공식 문서를 붙였고, 대체가 불완전하면 "대체 후 제거"로 분류하였다.
- 실행으로 확인하지 않은 추정은 그렇게 적었다(in-process 멈춤, HUD `tput cols` 셸 기동).

### 분류 기준

| 분류 | 뜻 |
|---|---|
| 즉시 제거 | 소비자가 없고 잃는 것이 없다. 파일 삭제와 참조 정리로 끝난다. 괄호의 "수정"은 지우는 대신 틀린 줄을 고치는 것 |
| 대체 후 제거 | 기능은 남겨야 하지만 지금 구현은 걷어낸다. 대체 구현이나 문서 갱신이 먼저다 |
| 사용자 결정 | 기술적으로는 제거할 수 있으나 잃는 것이 있다. 사용자가 그 손실을 받아들일지 정한다 |
| 유지 | 의심하였으나 읽어 보니 쓰이거나 필요하다. 괄호의 "수정"은 남기되 결함을 고치는 것 |

제거 난이도: 하(파일 삭제와 참조 정리) / 중(호출자와 테스트 수정, 미러 3곳 동기화) / 상(대체 구현 필요, 여러 영역에 걸침).

### 테스트 정리 원칙

남기는 테스트는 세 조건을 모두 만족해야 한다.

1. 운영 코드의 실제 함수나 실제 명령을 실행한다. 복제한 함수, 소스 문자열, 문서 문구를 검사하는 테스트는 남기지 않는다.
2. 단언이 깨지면 사용자가 겪는 결과가 달라진다. 라우팅 대상, 데이터 손실, 보안 경계, 프로세스 정리, 외부 형식 파싱이 여기에 든다. 상수 값, getter, 스냅샷 전체, 줄 순서는 들지 않는다.
3. 같은 실패를 잡는 다른 테스트가 없다. 입력만 바꿔 같은 경로를 반복하면 표 하나로 합친다.

죽은 모듈의 테스트는 모듈과 같은 PR 에서 지운다. 실제 HOME 이나 실행 중인 허브를 건드리는 테스트는 임시 HOME 으로 격리하거나 지운다. 복제 함수 테스트는 원본을 export 나 의존 주입으로 부를 수 있고 둘째 조건을 만족할 때만 원본 대상으로 다시 쓰고, 아니면 지운다. 이 기기에서는 `better-sqlite3` 가 로드되어 `SQLITE_SKIP` 조건 테스트 16개 파일이 실제로 돈다.

## 요약

| 분류 | 행 수 |
|---|---|
| 즉시 제거 | 149 |
| 대체 후 제거 | 26 |
| 사용자 결정 | 53 |
| 유지(수정 포함, 항목표 안) | 9 |
| 유지로 돌린 것(K 절) | 16 |

항목표의 행 하나가 파일 여러 개를 묶은 경우가 많다. 2차 판정이 1차 분류를 뒤집은 행은 24개이고 근거는 해당 행에 적었다. 결정이 먼저 필요한 것은 "결정이 필요한 항목" 절의 여섯 가지다.

## 항목표

열 설명. 분류는 즉시 제거 / 대체 후 제거 / 사용자 결정 / 유지. 읽음은 리드가 직접 확인한 범위다: `전체`(파일을 끝까지 읽음), `함수`(해당 범위와 호출자만), `집계`(export 소비자 수와 rg 만, 문서 항목은 해당 줄). 리드가 읽지 않은 서브에이전트 후보는 이 표에 올리지 않고 부록 "리드 미확인 후보"에 두었다. 근거의 "소비자 0" 은 packages 미러, 테스트, CHANGELOG, docs 를 뺀 저장소에서 import, 경로 실행, 심볼 참조가 없다는 뜻이다. 미러는 root 와 packages/{core,remote,triflux} 사본을 뜻한다.

### A. 소비자 없는 모듈 (파일 단위 삭제)

| # | 영역 | 대상 | 분류 | 읽음 | 근거 | 잃는 것 | 난이도 |
|---|---|---|---|---|---|---|---|
| A1 | scripts/lib | `cli-gemini.mjs`(37) | 즉시 제거 | 전체 | legacy Gemini alias. 소비자는 테스트 1개. tfx-route.mjs 의 ADAPTERS 는 agy 어댑터를 직접 쓴다 | 없음 | 하 |
| A2 | scripts/lib | `skill-state.mjs`(220) | 즉시 제거 | 전체 | 소비자 0. 보관 PRD 가 약속한 setup 의 `pruneOrphanSkillStates` 호출이 없다. 2026-04-08 이후 소비자가 생긴 적 없음 | 없음. `.tfx/state/*-active.json` 을 쓰는 코드가 없다 | 하 |
| A3 | scripts/lib | `agent-json.mjs`(27), `pid.mjs`(63), `quota.mjs`(47), `team.mjs`(75), `timeout.mjs`(66) | 즉시 제거 | 전체 | 각각 테스트 1개뿐. bash 가 같은 일을 한다(agent JSON 은 printf, 타임아웃은 gtimeout, quota 패턴은 tfx-route.sh:1144 에 같은 12개). pid.mjs 를 지우면 `tree-kill` 의존도 빠진다 | 없음 | 하 |
| A4 | scripts | `cache-buildup.mjs`(30) | 즉시 제거 | 전체 | 스스로 "legacy wrapper for cache-warmup". 소비자는 테스트 1개 | 없음 | 하 |
| A5 | scripts | `cli-route.sh`(3) | 즉시 제거 | 전체 | `exec tfx-route.sh` 한 줄. 참조는 이력 주석 2줄 | 옛 이름 직접 호출 | 하 |
| A6 | scripts | `preinstall.mjs`(128) + package.json `preinstall` | 즉시 제거 | 전체 | `stopHub()` 호출이 주석 처리돼 항상 no-op. npm install 마다 프로세스만 뜬다 | 없음 | 하 |
| A7 | scripts | `tfx-batch-stats.mjs`(117) | 즉시 제거 | 전체 | 소비자는 setup.mjs SYNC_MAP(복사)뿐. AIMD 계산은 hub/server.mjs 에 또 있다 | 수동 통계 CLI | 중(SYNC_MAP 한 줄은 인프라 세션 조율) |
| A8 | scripts | `test-tfx-route-no-claude-native.mjs`(63) + package.json `test:route-smoke` | 즉시 제거 | 전체 | tests/integration/tfx-route-smoke.test.mjs 가 재구성. `npm test` 글롭 밖. HOME 격리 없이 실제 tfx-route.sh 를 돌리는 비밀폐 | auto 모드 explore→codex 치환 케이스 1개(smoke 로 옮기면 유지) | 하 |
| A9 | scripts | `gen-skill-manifest.mjs`(87), `skills/*/skill.json` 15개, package.json `gen:skill-manifest`, CONTRIBUTING.md:72, `scripts/lib/skill-template.mjs` 의 `loadSkillManifest`·`parseFrontmatterWithManifest` | 즉시 제거 | 전체 | skill.json 을 읽는 런타임 코드는 skill-template.mjs:344 하나이고 그 함수의 비테스트 호출자 0. tfx-skill-authoring §5 가 manifest 를 영구 보류. 공식 skills 문서에 skill.json 없음 | 없음(SKILL.md frontmatter 가 정본) | 중(미러 skills 15개, 테스트 2개) |
| A10 | scripts | `session-spawn-helper.mjs` | 즉시 제거 | 함수(88~104) | `claude --prompt '...'` 를 보내는데 Claude Code 2.1.292 에 `--prompt` 옵션이 없다(-p/--print 만). 소비자는 테스트 1개. psmux 헬퍼 4개는 hub/team/psmux.mjs 와 중복 | Windows psmux 격리 세션 CLI(현재 고장) | 하 |
| A11 | hub/team | `interactive-native-launcher.mjs`(119), `daemon-pty-tmux-bridge.mjs`(146), `interactive-native-worker.mjs`(80), `headless-bridge-session.mjs`(17) | 즉시 제거 | 전체 | 소비자: launcher 는 experiments probe 1개, bridge 는 launcher 뿐, worker 와 session 은 0. PRD native-bridge-daemon-adoption 이 facade 경로를 실패로 기록 | 테스트 7개, experiments probe 1개 | 중(미러 remote, triflux) |
| A12 | hub/team | `interactive-tui-transport.mjs`(479) | 즉시 제거 | 집계 | 소비자는 A11 모듈과 `registerSwarmShard` 의 interactive 분기뿐. 그 분기를 켜는 설정은 계획서에만 있다. A11 제거 뒤 소비자 0 | swarm interactive shard 기능(미구현 상태) | 중 |
| A13 | hub/team | `runtime-strategy.mjs`(200) | 즉시 제거 | 전체 | 소비자 0(tfx-wt SKILL.md 한 줄과 docs). `createRuntime("native"\|"wt")` 는 throw | 테스트 1개 | 중 |
| A14 | hub/team | `process-cleanup.mjs`(386) | 즉시 제거 | 전체 | 소비자 0. Unix 고아 판정이 거꾸로다: `parentPid <= 1` 을 "부모 살아 있음"으로 제외해 PID 1 로 재부모화된 진짜 고아를 못 찾는다(:267) | 테스트 2개 | 중 |
| A15 | hub/team | `worker-signal.mjs`(263), `worker-signal.types.d.ts`(52) | 즉시 제거 | 전체 | 소비자 0. PRD worker-signaling-consolidation(draft)의 shard-1 산출물이 연결되지 않음. PRD 에 폐기 표시 필요 | 테스트 1개 | 중 |
| A16 | hub/team | `routing.mjs`(249) | 즉시 제거 | 전체 | 소비자 0(importers.tsv 의 2 는 hub/routing 과 basename 충돌). 테스트 2개 | 테스트 2개 | 중 |
| A17 | hub/team | `consensus-meta.mjs`(176) | 즉시 제거 | 전체 | 소비자 0. tfx-auto/SKILL.md:358 이 "공통 유틸"로 적지만 실행 코드가 없다 | golden 테스트 1개 | 하 |
| A18 | hub/team | `swarm-reconciler.mjs`(242) + pack.mjs:272 배럴 | 즉시 제거 | 전체 | hypervisor 는 import 하지 않고 `finalizeRedundantWin` 으로 직접 구현. 판정 키도 다르다(reconciler 는 `shard.critical`, hypervisor 는 `shard.redundancy`). 소비자는 pack.mjs 재수출뿐 | @triflux/remote 배럴 export 3개 | 중 |
| A19 | hub/team | `remote-probe.mjs`(292) | 즉시 제거 | 전체 | 소비자 0. conductor 원격 세션은 psmux 없이 ssh 자식을 띄우므로 capture-pane 전제 probe 가 들어갈 곳이 없다. `_PROMPT_IDLE_RE` 미사용. 원격 경로지만 "연결되지 않음"이 근거 | 테스트 1개 | 하 |
| A20 | hub/team | `wt-templates.json`(43) | 즉시 제거 | 전체 | 참조 0(코드, 테스트, 문서, package.json) | 없음 | 하 |
| A21 | hub/team | `session-sync.mjs`(316), `lead-control.mjs:151~191` `publishHeadlessControl`, hub-client.mjs:241~264 래퍼 2개 | 즉시 제거 | 전체(session-sync 는 export 와 소비자), 함수 | session-sync export 3개의 소비자는 hub-client 래퍼 2개뿐이고 그 래퍼의 호출자 0. publishHeadlessControl 호출자 0. 두 파일이 유틸 8개를 복사 | 테스트 1개. `publishLeadControl` 은 `tfx multi control` 이 쓰므로 남긴다 | 중 |
| A22 | hub/team | `dashboard.mjs`(322) | 대체 후 제거 | 집계 | 소비자 0. 결함 3종: exited→completed, `--interval` 없으면 NaN 으로 1ms 루프(재현됨), 허브 응답에 없는 키(uptime, queue_depth). 대체는 `tfx multi status`(90일 16회) | 수동 텍스트 대시보드 | 중 |
| A23 | hub/team | `conductor-mesh-bridge.mjs`(122) + conductor.mjs:1514~1524, swarm-hypervisor.mjs:54~62·104~139·2190 | 즉시 제거 | 전체 | `createConductorMeshBridge(conductor, registry)` 가 onMessage 없이 호출돼 메시지를 전부 버린다. 레지스트리 register/unregister 만 일어나고 읽는 비테스트 코드 0(`getMeshRegistry` 호출자는 테스트뿐). hypervisor 의 동적 import 폴백과 noop 레지스트리는 같은 저장소 파일 대상이라 실패할 수 없는 방어 | `getMeshRegistry()` 공개 메서드와 테스트 | 중 |
| A24 | mesh | `mesh/` 7개 전부(720): index, protocol, registry, router, queue, heartbeat, budget | 즉시 제거 | 전체 | 소비자는 A23 브리지와 conductor.mjs:21, hypervisor 동적 import 뿐. router, queue, heartbeat, budget, `loadSkillsForAgent` 는 소비자 0. budget 은 context-monitor 의 임계값을 "의존을 피하려고" 복제. 보관 PRD 가 "프로덕션에서 한 번도 호출되지 않음"이라 기록 | 테스트 4개(약 540줄), ARCHITECTURE.md 한 줄, packages/core 의 `./mesh/*` 공개 export | 중 |
| A25 | hub | `lib/mcp-response-cache.mjs`(239) | 즉시 제거 | 전체 | 소비자 0. 최초 2026-04-06 이후 연결된 적 없음 | 없음 | 하 |
| A26 | hub | `lib/path-utils.mjs`(165) | 즉시 제거 | 전체 | 소비자 0. 같은 일을 platform.mjs `normalizePath`, lib/bash-path.mjs 가 한다 | 테스트 41개(사소한 변환에 과다) | 하 |
| A27 | hub | `lib/timeline-adapter.mjs`(190) | 즉시 제거 | 전체 | 소비자 0. `~/.gstack/projects/<slug>/timeline.jsonl` 에 직접 쓴다(stack-coexistence 의 "triflux 는 gstack 에 의존하지 않는다" 위반) | 없음 | 하 |
| A28 | hub | `role-control-events.mjs`(113) | 즉시 제거 | 전체 | 소비자는 pack.mjs 목록뿐. 이벤트를 내보내는 곳 0. 2026-09-24 동결된 role 시스템의 선행물 | 없음 | 하(pack.mjs 두 목록) |
| A29 | hub | `codex-compat.mjs`(12) | 즉시 제거 | 전체 | cli-adapter-base 재수출 파사드. 주석 "@experimental 런타임 미연결". 소비자는 pack.mjs 뿐 | 없음 | 하 |
| A30 | hub | `fullcycle.mjs`(113) + paths.mjs 의 `TFX_FULLCYCLE_DIR`, `TFX_HANDOFFS_DIR`, `TFX_LOGS_DIR` | 즉시 제거 | 전체 | 소비자 0(phase-manager 는 경로 문자열을 따로 조립). tfx-fullcycle 스킬은 폐기됨 | 없음 | 중 |
| A31 | hub | `token-mode.mjs`(228) | 즉시 제거 | 전체 | "@experimental 런타임 미연결". 소비자는 pack.mjs 뿐. 치환이 단어 부분에도 걸리고 복원이 손실적 | 없음 | 하 |
| A32 | hub | `research.mjs`(155) | 즉시 제거 | 전체 | "@experimental 런타임 미연결". 소비자 0. tfx-research 스킬이 정식 진입점(90일 10회) | 없음 | 하 |
| A33 | hub | `quality/deslop.mjs`(274) + pipeline/index.mjs:349 재수출 | 즉시 제거 | 전체 | 재수출의 소비자 0. 정규식 7개로 줄 단위 삭제하는 `autoFixSlop` 은 오탐 삭제 위험. 호스트에 ai-slop-cleaner 스킬이 있다(90일 4회) | 없음 | 하 |
| A34 | hub | `intent.mjs`(321) + pipeline/index.mjs `triageWithIntent` | 즉시 제거 | 전체 | 소비자는 `triageWithIntent`(호출자 0)뿐. `_tryCodexClassify` 가 `codex exec` 를 execFileSync 로 직접 부른다(tfx-routing.md 금지, 최대 8초 동기 대기). `refineClassification` 은 `void` 두 줄 | 없음 | 하 |
| A35 | hub | `pipeline/gates/` 4개(310) + pipeline/index.mjs 의 `runConfidenceGate`, `runDeslopGate`, `runSelfCheckGate`, `benchmarkStart`, `benchmarkEnd` | 즉시 제거 | 전체 | 게이트 3종과 benchmark 의 비테스트 호출자 0(허브가 쓰는 pipeline API 는 advance, canAdvance, getState 뿐). `evaluateConsensus`, `STAGE_THRESHOLDS`, env `TRIFLUX_CONSENSUS_THRESHOLD` 소비자 0. benchmarkEnd 는 `~/.omc/state/cx-auto-tokens/diffs` 에 쓴다 | 없음 | 중(테스트 5개) |
| A36 | hub | `pipeline/transitions.mjs:77`, `:82` | 즉시 제거 | 함수 | 빈 if 블록과 이미 `failed` 인 값을 다시 대입하는 블록 | 없음 | 하 |
| A37 | hub | `routing/` 3개(778): index, q-learning, complexity | 즉시 제거 | 전체 | 소비자 0(dynamic-routing-engine 의 `createDynamicRouter` 는 별개 구현). 같은 env `TRIFLUX_DYNAMIC_ROUTING` 을 쓰는 두 번째 동적 라우팅. 액션 목록 `codex, antigravity, claude, haiku, sonnet` 고정 | 테스트 1개 | 하 |
| A38 | hub | `gemini-adapter.mjs`(174) | 즉시 제거 | 전체 | 머리말 "legacy Gemini adapter compatibility layer". 소비자는 pack.mjs 배럴뿐. 실행은 agy 이고 같은 호출을 tfx-route.sh 가 한다 | @triflux/core 배럴 export 3개 | 중 |
| A39 | hub | `workers/gemini-worker.mjs`(217) | 즉시 제거 | 전체 | "Deprecated compatibility surface". 소비자 0(factory 의 gemini 케이스는 AntigravityRouteWorker 를 만든다). `toStringList`, `createWorkerError` 는 worker-utils 복사 | 테스트 3개 | 하 |
| A40 | hub | `workers/antigravity-route-worker.mjs`(179) + factory.mjs 의 gemini/antigravity/agy 케이스 | 즉시 제거 | 전체 | 소비자는 factory 뿐이고 factory 의 비테스트 호출자는 tfx-route-worker.mjs, 그 러너는 tfx-route.sh 가 `run_stream_worker "gemini"`(도달 불가)와 `"claude"` 로만 부른다. `bash tfx-route.sh` 를 다시 spawn 하는 재귀 구조 | 없음 | 중(tfx-route.sh gemini 분기 G1 과 함께) |
| A41 | hub | `workers/codex-mcp.mjs`(853) + cli-adapter-base 의 `CODEX_MCP_*` 상수 | 대체 후 제거 | 함수(1~60, 420~450, 690~853) | 기본 인자 `["mcp-server"]`. 공식 문서: `codex mcp-server` 는 0.154 에서 제거. tfx-route.sh 3469 가 transport 를 항상 exec 로 고정하고 `run_codex_mcp` 호출자 0. 남은 소비자 `workers/delegator-mcp.mjs:18,397`(허브 구역)과 factory 기본 codex 케이스(도달 불가) | 없음(exec 가 기본) | 상(delegator 는 인프라 세션 묶음 3 과 함께) |
| A42 | cto | `steward.mjs`(362) + `tfx cto steward` | 즉시 제거 | 전체 | 소비자는 cto/index 분기와 bin usage 문자열. `lake/stewards/` 가 2026-07-06 이후 비어 있고 ledger 1278건이 `collect`(487)과 `session_started`(791)뿐이라 watch 루프를 돌린 흔적이 없다. 2026-09-24 "조회만" 결정과 반대 | 주기 수집 루프 | 하 |
| A43 | cto | `events.mjs` 의 CLI 부분(`EVENT_PRESETS`, `OPTION_KEYS`, `parseEventArgs`, `runEvent`) + `tfx cto event` | 즉시 제거 | 함수 | 프리셋이 가리키는 래퍼("gstack context-save -> tfx cto event", "gh pr create -> ...")가 존재하지 않는다. `checkpoint_*`, `pr_*` 이벤트 0건. `appendCtoEvent`, `normalizeCtoEvent` 는 hygiene 과 hook 이 쓰므로 남긴다 | 외부 래퍼용 CLI(래퍼 없음) | 중 |
| A44 | cto | `hygiene-actions.mjs`(355) + hygiene.mjs 의 apply 경로(`acquireCtoHygieneStewardLock`, `applyHygieneRows`, `--apply`) | 즉시 제거 | 함수 | 입력 이벤트(`task_claimed`, `worktree_*`, `checkpoint_*`)를 쓰는 곳이 없어 행은 synapse overlay 에서만 나온다. `hygiene_applied` 0건. 파일을 옮기는 동작이라 "조회만" 결정과 반대 | `tfx cto hygiene --apply`(실행 흔적 없음) | 중(tfx-live 의 cto/hygiene import 가 선행 조건. live-ops 세션) |
| A45 | cto | `dashboard.mjs` `renderHygiene`(212) 와 호출부(388) | 즉시 제거 | 함수 | `current.hygiene` 은 collect 가 만들지 않고 validateCurrent 가 거부한다. 테스트가 fixture 로 끼워 넣어야만 그려진다 | 없음 | 하 |
| A46 | cto | `collect.mjs` 수집원 `session_vault`, `agy`, `gbrain` + schema required | 즉시 제거 | 함수 | 프로브 대상 파일(`.triflux/session-vault.json`, `.agy/state.json`, `.gbrain/refs.json`)을 쓰는 곳이 저장소에 없다. current.json 에서 셋 다 `available:false` | 없음(분모 11 이 8 로) | 중 |
| A47 | tui | `codex-profile.mjs`(421), `gemini-profile.mjs`(286) + `bin/tfx-profile.mjs`(7) 와 package.json bin `tfx-profile` | 즉시 제거 | 전체(tui 두 파일), 함수(bin 7줄) | 소비자는 tfx-profile SKILL.md 두 줄과 `bin/tfx-profile.mjs`(agy 교차 검증이 찾았고 리드가 확인). 그 스킬은 인프라 세션이 지운다. 스킬 호출은 90일 1회(2026-09-23). `KNOWN_MODELS` 에 모델 ID 하드코딩(skill-authoring §3 위반). `~/.gemini/triflux-profiles.json` 은 저장된 적 없음 | 대화형 프로필 편집기와 `tfx-profile` 명령 | 중(bin 항목 삭제를 인프라 세션의 스킬 삭제와 같은 시점에) |
| A48 | tui | `core.mjs`(266) | 대체 후 제거 | 전체 | 소비자는 A47 두 파일과 tui/doctor, tui/setup(제외 구역). A47 과 T2(인프라 세션) 뒤 소비자 0 | 없음 | 하 |
| A49 | experiments | `codex-app-server-uds-probe.mjs`(383) | 즉시 제거 | 함수(1~40, 함수 목록) | 스파이크 결론이 `hub/workers/lib/jsonrpc-ws-uds.mjs` 로 승격됨. 손으로 짠 RFC 6455 클라이언트 중복. 머리 주석의 headless-guard 는 2026-09-07 제거된 훅 | 없음 | 하 |
| A50 | experiments | `claude-codex-uds-orchestration-smoke.mjs`(144) | 즉시 제거 | 함수(1~30, 120~144) | `runUdsOrchestration` 을 그대로 부르는 스크립트. `tfx-live orchestrate` 가 같은 호출 | 없음 | 하 |
| A51 | experiments | `claude-daemon-dispatch-poc.mjs`(384), `claude-uds-local-dev-smoke.mjs`(270) | 즉시 제거 | 함수(머리와 export) | `deriveDaemonPaths`, `sendControlRequest`, `readJsonLine` 이 프로덕션 claude-daemon-control.mjs 와 폴더 안 worker-protocol.mjs 에 각각 또 있다(3벌). 소비자 0 | 테스트 2개 | 하 |
| A52 | references | `cli-parameter-reference.md`(240) | 즉시 제거 | 전체(주장 줄) | 2026-04-16 기준. `--full-auto`(0.147 제거), `codex mcp-server`(제거), inline `profiles.*`(0.134 거부), `gpt-5.4`, `gemini-2.5-pro`, Claude effort 에 xhigh 없음. 소비자 0, npm files 밖 | 없음(공식 문서가 대체) | 하 |
| A53 | docs | `docs/release-checklist.md`(31) + CONTRIBUTING.md:81 링크 | 즉시 제거 | 전체 | "next release after v10.25.0". `publish.mjs --execute` 를 정상 경로처럼 쓰나 현재 발행은 OIDC CI. 점검 목록은 CONTRIBUTING 과 중복 | 없음 | 하 |

### B. 함수 단위 정리 (파일은 남기고 범위만)

| # | 영역 | 대상 | 분류 | 읽음 | 근거 | 잃는 것 | 난이도 |
|---|---|---|---|---|---|---|---|
| B1 | hub/team | `headless.mjs` stall 감지 경로: `STALL_DEFAULTS`, `StallError`, `createStallMonitor`, `waitForCompletionWithStallDetect`, awaitAll 의 `stallOpts?.enabled` 분기(537~612, 727~955, 1378~1443) | 즉시 제거 | 함수 | `opts.stallDetect` 를 넘기는 호출자 0(start-headless, delegator-mcp 모두). `createStallMonitor`, `StallError` 는 파일 안에서만. psmux.mjs:1664 주석의 "주 채널은 waitForCompletionWithStallDetect" 는 실제와 반대 | 테스트 2개, 약 400줄 | 중 |
| B2 | hub/team | `headless.mjs` `claude-wrapper` 모드(1826~1830) + parse-args 허용 목록 | 즉시 제거 | 함수 | 선택하면 "reserved and not implemented yet" throw | 없음 | 하 |
| B3 | hub/team | `headless.mjs` 죽은 심볼: `_ANSI_RESET`, `_ANSI_DIM`, `void IS_WINDOWS`, `_getWtDefaultFontSize`, `_atomicWriteSync`, 대상 없는 JSDoc(2236~2241), 머리 주석 "의존성: psmux.mjs (Node.js 내장 모듈만 사용)" | 즉시 제거 | 함수 | 정의만 있고 참조 0. 같은 기능이 wt-manager.mjs 에 살아 있다. 머리 주석은 실제 import 20여 개와 다르다 | 없음 | 하 |
| B4 | hub/team | `headless.mjs` `runHeadless` 의 `nativeBridgeMode` 기본값 "roster" 와 start-headless.mjs:83 의 `\|\| "roster"` | 대체 후 제거 | 함수 | CLI 기본값은 "agents"(parse-args:87). 세 곳이 어긋난다. 32KB `contextFile` 절단 주석 "UTF-8 안전" 도 다바이트 중간을 자른다(재현됨) | 없음 | 하 |
| B5 | hub/team | `psmux.mjs:34~72` `PSMUX_BIN` 즉시 실행 함수의 mac/linux 분기 | 즉시 제거 | 함수 | `tmux -V` 를 동기 실행하고 성공해도 실패해도 `"tmux"` 를 반환. import 하는 모든 프로세스가 시작할 때 프로세스를 하나 더 띄운다 | 없음 | 하 |
| B6 | hub/team | `psmux.mjs` 워커 CLI(`spawnWorker`, `getWorkerStatus`, `killWorker`, `captureWorkerOutput`, CLI spawn/status/kill/output/capture-start/dispatch/wait-pattern/wait-completion, 1729~1928, 1995~2060) | 즉시 제거 | 함수 | 소비자 0. 안내하는 곳은 native.mjs 의 `buildHybridWrapperPrompt`(그 자체가 소비자 0, T1) | 테스트 1개 | 중 |
| B7 | hub/team | `psmux.mjs` 중복: `escapeRegex`=`escapeRegExp`, `sendLiteralToPane`=`sendKeysToPane`, `hasPsmux`=`hasMultiplexer` 별칭 | 즉시 제거 | 함수 | 본문이 같다. hasPsmux 소비자는 remote-spawn.mjs(제외 구역, 3곳)와 session-spawn-helper(A10) | 없음 | 하(remote-spawn 수정은 live-ops 세션 뒤) |
| B8 | hub/team | `cli/commands/start/parse-args.mjs:10~29` `KNOWN_ROLES` | 즉시 제거 | 함수 | agent-map.json 역할 28개 중 10개 누락(build-fixer, cleanup, deslop, deep-executor, quality-reviewer, scientist-deep, document-specialist, spark, explore, qa-tester). `--assign "codex:do:deep-executor"` 가 role 빈 값으로 파싱된다(재현됨). agent-map.json 을 읽으면 된다 | 없음 | 하 |
| B9 | hub/team | `backend.mjs:76~91` `ClaudeBackend.buildArgs` | 즉시 제거 | 함수 | `claude --print ${prompt}` 로 인용 없이 합친다. 단어 분리와 명령 치환이 일어난다(재현됨) | claude 워커 headless 실행(애초에 깨짐) | 하 |
| B10 | hub/team | `backend.mjs` 의 `CodexBackend`, `AntigravityBackend`, `GeminiBackend`, `getBackendForAgent`, `listBackends`, `launcher-template.mjs` 의 `buildAntigravityArgs` 중복 | 대체 후 제거 | 집계 | headless 는 codex, antigravity 를 tfx-route.sh 로만 실행하므로 테스트만 쓴다. agy 명령 조립이 세 곳 | 테스트 1개 | 중 |
| B11 | hub/team | `execution-mode.mjs` `selectExecutionMode`, `MODES.INTERACTIVE`, `MODES.AUTO`, 파일 끝 이력 주석(318~324) | 즉시 제거 | 함수 | `selectExecutionMode` 비테스트 소비자 0. `buildSpawnSpecForMode` 는 유지 | 테스트 일부 | 하 |
| B12 | hub/team | `extract-completion-payload.mjs:20~51` 의 `isLineEdgeChar`, marker 탐색 함수 | 즉시 제거 | 함수 | `isLineEdgeChar` 가 sentinel-capture.mjs:25 와 동일. `ajv` 가 루트 dependencies 에 없고 전이 의존으로 들어온다(knip unlisted) | 없음 | 하 |
| B13 | hub/team | `handoff.mjs:3`(없는 설계 문서 `docs/design/handoff-schema-v7.md`), `HANDOFF_INSTRUCTION` 긴 판(테스트만), 내부 전용 함수 export | 즉시 제거 | 함수 | 문서 없음(ls 확인). headless 는 `HANDOFF_INSTRUCTION_SHORT` 만 쓴다 | 테스트 1개 | 하 |
| B14 | hub/team | `ansi.mjs:443~478` `animatedProgressBar`, `loadingDots`; `CLI_ICON`, `moveDown`(테스트만) | 즉시 제거 | 함수 | 소비자 0 | 테스트 일부 | 하 |
| B15 | hub/team | `wt-manager.mjs:234~239` `_waitTimeoutMs` | 즉시 제거(수정) | 함수 | 계산만 하고 `waitTabReady` 는 `DEFAULT_WAIT_TIMEOUT_MS` 를 쓴다. `opts.waitTimeoutMs` 와 `WTM_WAIT_TIMEOUT_MS` 가 무시된다(Windows 경로, 코드 결함) | 없음 | 하 |
| B16 | hub/team | `session.mjs:405~421` `configureTeammateKeybindings` 의 동일 분기, 머리 주석 "의존성: child_process만" | 즉시 제거 | 함수 | if/else 양쪽이 같은 명령 두 줄. 실제 import 는 lib 모듈 3개 | 없음 | 하 |
| B17 | hub/team | `pane.mjs:56~75` Codex 소스 줄 번호 주석 30줄, `buildCliCommand` 의 `trustMode`(호출자 안 넘김), gemini 분기 | 즉시 제거 | 함수 | 한 줄 함수에 썩는 줄 번호 주석. trustMode 는 pane.mjs 안에서만 | 테스트 1개 | 하 |
| B18 | hub/team | `cli/commands/start/start-headless.mjs:79` `_startedAt`, `:225~229` saveTeamState 직후 clearTeamState | 즉시 제거(수정) | 함수 | 변수 미사용. headless 는 끝난 뒤 상태를 쓰고 바로 지워 실행 중 `tfx multi status` 가 못 찾는다 | 없음 | 하 |
| B19 | hub/team | `cli/commands/stop.mjs`(인자 무시), `cli/help.mjs`, `cli/manifest.mjs` TEAM_COMMANDS 의 usage/desc, parse-args 의 `--auto-attach`/`--dashboard`(기본과 같음) | 즉시 제거(수정) | 함수 | `teamStop()` 이 인자를 안 받아 `tfx multi stop --help` 가 팀을 끈다(2026-09-27 transcript 에 그 호출). 도움말에 주 플래그(`--assign`, `--timeout`, `--cwd`, `--model`, `--native-bridge*`)가 없다. TEAM_COMMANDS 의 usage/desc 소비자 0 | 없음 | 하 |
| B20 | hub/team | `start/index.mjs:99~101, 153~206` tmux 모드에서 `--assign` 무시 | 사용자 결정(수정 권장) | 집계 | task 가 `assigns` 의 프롬프트를 " + " 로 잇고 decomposeTask 가 `[+,\n]` 로 쪼갠다. 2026-10-07 team-state 에서 프롬프트가 쉼표에서 잘려 다른 워커로 간 실제 사례 | 없음(수정 대상) | 중 |
| B21 | hub/team | `worker-completion-validator.mjs:37~40`, `schemas/worker-completion.json:10`, `build-worker-prompt.mjs:67~70` 계약 불일치 | 사용자 결정(수정 권장) | 집계 | 부록은 no-op shard 에 `status:ok` + 빈 commits 허용, 검증기는 `empty_commits_made` 거부. 스키마 `skipped` 는 검증기 허용 목록에 없음(재현됨) | 없음(수정 대상) | 하 |
| B22 | hub/team | `conductor.mjs:206` `const publicApi = null` → `conductor-registry` 항상 빈 상태 | 사용자 결정(수정 또는 제거) | 함수 | register 가 `!conductor` 면 false. 허브 send_input 도구가 실제 세션에 항상 실패. 고치면 INPUT_WAIT 원격 응답 복구, 지우면 레지스트리와 허브 도구 함께 | 복구 가능한 기능 | 하(수정) |
| B23 | hub/team | `conductor.mjs:432~449` `handleProbeResult` 의 remote 분기 | 즉시 제거 | 함수 | 호출자는 respawnSession 의 로컬 probe 뿐(:911). 원격 세션은 자체 setInterval 감시 | 없음 | 하 |
| B24 | hub/team | `swarm-cli.mjs:97` `Number(args[++i]) \|\| 2` | 즉시 제거(수정) | 함수 | `--max-restarts 0` 이 2 가 된다 | 없음 | 하 |
| B25 | hub/team | 소규모 미사용: `swarm-locks.mjs` `check()`, `SWARM_STATES.VALIDATING`, `recovery-store.mjs` `RECOVERY_DEFAULTS`·`readManifest`, hypervisor `_outPath`, 중복 블록 936~952 와 1023~1039 | 즉시 제거 | 함수 | 각각 정의와 phase 매핑뿐, 소비자 0. 중복 블록은 글자 단위 동일 | 없음 | 하 |
| B26 | hub/team | `worktree-lifecycle.mjs` `pruneWorktree`(도달 불가 폴백), `pruneOrphanWorktrees`(테스트만), `EXPECTED_WORKTREE_DELETIONS`(빈 배열) | 즉시 제거 | 함수 | `cleanupWorktree \|\| pruneWorktree` 에서 앞이 항상 참. 빈 상수라 삭제 허용 필터가 항상 no-op | 고아 워크트리 정리 수단(CLI 연결 없음) | 하 |
| B27 | hub/team | `tui.mjs` 죽은 함수: `_TIER1_ROWS`, `_resolveRailWidth`, `_autoColumnCount`, `_flashFadeBorderColor`, `_wrapText`, `_joinColumns`, `renderConductorTier`, `createTui` 별칭, `tokenTracker`(기록만), `getViewportColumns/Rows`(tui-core 복사) | 즉시 제거 | 함수 | 각각 파일 안 정의 1회, 다른 파일 0 | 없음 | 하 |
| B28 | hub/team | `tui-lite.mjs`(469) | 사용자 결정 | 집계 | 호출자는 tui-viewer 가 `--layout lite` 일 때뿐(기본값은 `single`, tui-viewer.mjs:27, 64). tui.mjs 와 키 처리, 렌더 루프, 탭 순환이 같은 구조 | lite 레이아웃 옵션 | 중 |
| B29 | hub/team | 슬롭 주석: `worktree-lifecycle.mjs:2`(없는 스킬 tfx-codex-swarm), `:301~303`(rebase 라 쓰고 cherry-pick), `conductor.mjs:2~5`(native-supervisor 래핑한다지만 import 없음), `shared.mjs:2`(없는 cli.mjs), `swarm-planner.mjs:8`(antigravity 빠짐), `codex-review.mjs:13~16`(세션 번호 서사), `intervention.mjs:1~2`(원문자 표기), `swarm-hypervisor.mjs:8`(없는 broker 호출) | 즉시 제거 | 함수 | 코드와 다른 설명 | 없음 | 하 |
| B30 | hub | `codex-preflight.mjs` `checkApprovalMode`, `detectWorkdirDrift` 의 키, `runPreflight` 경고(88~96, 164~199, 218~226) | 즉시 제거(수정) | 함수 | `approval_mode`, `sandbox` 키를 읽는데 현행 키는 `approval_policy`, `sandbox_mode`. 그래서 매번 "approval_mode is 'unset'" 경고. `MIN_RECOMMENDED_MINOR = 118` 도 낡음. 소비자 conductor.mjs:30 | 없음 | 하 |
| B31 | hub | `cli-adapter-base.mjs` 버전 게이트 `getCodexVersion`, `FEATURES`, `gte`, `buildExecCommand` else 분기(82, 119~136, 218~223) | 대체 후 제거 | 함수 | 임계 110/117/120 은 0.160 에서 전부 참. `FEATURES.pluginSystem` 소비자 0. 없을 때 117 로 가정하는 분기와 `TFX_CODEX_VERSION_MINOR` 는 테스트 전용. `codex-preflight.mjs:46` 의 같은 이름 함수는 폴백값이 0 으로 달라 중복 | 없음 | 중(한쪽으로 통일, 테스트) |
| B32 | hub | knip duplicates 이중 export: adaptive 3개와 session-fingerprint(인프라 세션 묶음 3), `workers/lib/jsonrpc-ws-uds.mjs:479` default, `log-retention.mjs:726` 별칭, `role-contract.mjs:219` 별칭 | 즉시 제거 | 집계 | default 와 named 가 같은 함수. 소비자는 named 만 | 없음 | 하 |
| B33 | hub | `lib/spawn-trace.mjs:160` `reload()` 가 `MAX_SPAWN_PER_SEC` 를 30 으로 되돌림 | 유지(수정) | 집계 | 초기값 100 은 2026-05-15 mac 회귀 수정인데 `/spawn-trace/reload` 한 번이면 30 으로 돌아간다 | 해당 없음 | 하 |
| B34 | scripts/lib | `skill-template.mjs` 템플릿 엔진 부분(`renderSkillTemplate`, `loadTemplatePartials`, `buildSkillTemplateContext`, 내부 렌더 함수, 약 280줄), `skills/_templates/*`, `skills/shared/telemetry-segment.md` | 즉시 제거 | 집계 | `.tmpl` 파일 0개, skill-authoring §4 가 deprecated 선언. 비테스트 소비자는 `parseFrontmatter` 뿐(setup, lint-skills, gen-skill-manifest). `parseFrontmatter` 는 phase-manager.mjs:278 과도 중복 | 없음 | 중(테스트 2개) |
| B35 | scripts/lib | `claudemd-scanner.mjs` 의 `writeSection`, `migrateClaudeMd`, `resolveTemplate`, `LEGACY_PATTERNS`, `TFX_START/END/OMC_END`(약 170줄) + `scripts/claudemd-sync.mjs` `ensureTfxCrown` | 즉시 제거 | 함수(claudemd-sync 145~186) | `ensureTfxCrown` 호출자 0. 기본 템플릿 경로 `scripts/templates/claudemd-tfx-section.md` 가 저장소에 없다. `findAllClaudeMdPaths` 는 handoff.mjs 가 쓰므로 남긴다 | 없음 | 중 |
| B36 | scripts/lib | 과잉 export(knip unused exports 중 파일 밖 소비자 0): machine-profile 3, gemini-profiles 2, agent-route-policy 3(`describeCodexAgentPolicy` 는 함수 삭제), mcp-server-catalog 2, context 2, env-probe 2, psmux-info 17, mcp-filter 7, mcp-health `readMcpServers` | 즉시 제거 | 집계 | 표는 findings-scripts-lib.md "과잉 export 세부". export 키워드만 지우면 된다 | 없음 | 하 |
| B37 | scripts/lib | `psmux-info.mjs` 의 `PSMUX_INSTALL_COMMANDS_DARWIN`(`brew install psmux`), `*_LINUX`, `PSMUX_FALLBACK_NOTE_*`, `getPsmux*For`, `probePrimaryMultiplexerSupport` | 즉시 제거 | 전체(1~60) | 사용자 기준: psmux 는 Windows 전용. `brew info psmux` 결과 formula 없음. 이 안내가 mac 에서 뜨는 곳(tui-viewer.mjs:52, psmux.mjs:239, session-spawn-helper:228)은 "tmux 없음"에 psmux 설치법을 낸다 | mac 사용자가 올바른 `brew install tmux` 안내를 받는 이득 | 하 |
| B38 | scripts | `release/lib.mjs` export 7개 중 외부 소비자 0 인 5개, `release/prepare.mjs:189~193` 동일 분기, `release/bump-version.mjs` CLI 도달 불가 분기(38~52, 80) | 즉시 제거 | 함수 | prepare 의 if/else 가 같은 출력. bump-version 은 `--write` 없으면 일찍 끝나 미리보기 분기와 "Planned" 삼항이 CLI 에서 도달 불가. tfx-ship SKILL.md:144 가 그 부작용 경고를 따로 둔다 | 없음 | 하 |
| B39 | .github | `release.yml:75~76`, `npm-publish.yml:53~54` "Verify npm 11.5.1+" | 즉시 제거(수정) | 함수 | `npm --version` 출력뿐, 검증 없음. release.yml 은 발행을 안 한다 | 로그 한 줄 | 하 |
| B40 | bin | `triflux.mjs:127,130,138` `_BRAND`, `_DOT`, `_EXIT_SUCCESS` | 즉시 제거 | 함수 | 각 1회(정의) | 없음 | 하 |
| B41 | bin | `tfx list` 의 "호환 alias" 절(`readPackagedSkillMetadata`, `listDeprecatedPackagedSkillAliases`, 5892~5903) | 즉시 제거 | 함수 | `SKILL_ALIASES = []`(setup.mjs:859), `deprecated: true` 스킬 0개. 항상 빈 절과 빈 JSON 필드 | 없음 | 중(테스트 1곳) |
| B42 | bin | `tfx why`(스키마 470~485, case 7761~7769) + `hub/team/synapse-cli.mjs:385~458` + `hub/team/swarm-intent.mjs` 생성 함수 | 즉시 제거 | 함수 | X-Intent 트레일러를 쓰는 커밋이 전체 이력에 0건(`git log --all --grep`), 생성 함수 `formatIntentTrailer` 호출자 0. 실행하면 항상 "(no X-Intent trailer)". 파서는 A18 reconciler(소비자 0)와 synapse-cli(제외 구역)만 | 항상 빈 명령 하나 | 중(synapse-cli 부분은 인프라 세션) |
| B43 | hub/team | `session.mjs:153` `findGitBashExe()` 호출 | 유지(수정) | 함수(138~160, import 목록) | 정의도 import 도 없다(저장소 전체 rg 1건, 이 호출뿐). `detectMultiplexer()` 가 `git-bash-tmux` 를 돌려주는 Windows Git Bash 환경에서 ReferenceError. 4행이 import 한 `resolveGitBashExecutable`(bash-path.mjs)이 들어갈 함수로 보인다 | 없음(지금은 그 분기가 항상 예외) | 하 |
| B44 | hub/team | `terminal-opener.mjs:58~63` `isTmuxLikeMux` 의 `platform !== "win32" && mux === "psmux"` 분기와 주석, `buildAttachCommand`(94~104) 의 비Windows psmux attach | 즉시 제거(B37 과 같은 PR) | 함수(55~105) | 사용자 기준: psmux 는 Windows 전용. 주석이 "비Windows 에서 psmux 가 tmux 호환 명령을 받아준다"고 적어 mac, linux 의 psmux 를 정식 경로로 둔다. 머신 프로필 규칙(darwin, linux 는 tmux)과도 어긋난다 | 없음 | 하 |
| B45 | hub/team | `--dangerously-bypass-approvals-and-sandbox` 하드코딩 5곳: `execution-mode.mjs:189`, `pane.mjs:65`, `conductor.mjs:955`(원격 샤드), `codex-review.mjs:218`(D2), `interactive-tui-transport.mjs:17`(A12) | 대체 후 제거 | 함수(pane, conductor, codex-review), 집계(execution-mode, interactive-tui-transport) | CLAUDE.md codex-config 절과 psmux 규칙 4-2 가 "config.toml 에 있는 값을 CLI 로 중복 지정하지 않는다"고 정하는데 다섯 곳이 각자 붙인다. D2, A12 가 사라지면 세 곳. 남는 세 곳은 한 곳(agent-route-policy 나 execution-mode)으로 모은다 | 없음 | 하~중 |

### G. Gemini CLI 잔재 묶음 (한 PR, 순서 중요)

| # | 영역 | 대상 | 분류 | 읽음 | 근거 | 잃는 것 | 난이도 |
|---|---|---|---|---|---|---|---|
| G1 | route | `tfx-route.sh` gemini 분기 일괄: 3523~3589(main), 1456/1525~1528, 1678~1689/1756~1764, 1802, 1218/1232/1253~1254, 2156, 3281, 510~516(`GEMINI_BIN`, `*_ARGS_JSON`, `TFX_GEMINI_EXTENSIONS/FLAGS`), 1320~1409 `resolve_gemini_profile`(gemini-profiles.mjs 중복), 1589 `TFX_GEMINI_OK` export | 즉시 제거 | 함수 | CLI_TYPE 은 agent-map.json 조회로만 정해지고 값에 gemini 가 없다(1436~1451). 그래서 gemini 분기는 도달 불가. gemini 바이너리 없음. `TFX_GEMINI_OK` 읽는 코드 0. tfx-routing.md 의 "agy 없으면 legacy gemini fallback" 은 코드와 다르다 | 약 130줄. 환경변수로 gemini CLI 를 되살리는 길(이미 막힘) | 중(테스트 3개, 문서 1곳) |
| G2 | route | `TFX_CLI_MODE=gemini` 별칭(1705~1733) + 호출자 delegator-mcp:932, headless.mjs:208, native.mjs:77 | 대체 후 제거 | 함수 | 스스로 "deprecated alias, Phase 5 cleanup 까지 유지". 호출자가 gemini 를 넘기는지 확인 뒤 삭제 | 없음 | 중 |
| G3 | route | `run_codex_exec` 안 `CLI_TYPE == antigravity` stdin 분기(3106~3114) | 즉시 제거 | 함수 | run_codex_exec 호출은 codex 분기 한 곳(3517). agy 1.1.27 부터 stdin 프롬프트 거부(같은 파일 1513 이 적음) | 없음 | 하 |
| G4 | scripts/lib | `mcp-filter.mjs` gemini 출력(`getGeminiAllowedServers`, `toDelimited` 4번째 필드, `toShellExports`, `shell` 모드, `buildInventoryIndex` gemini), `gemini-profiles.mjs` 1회 마이그레이션(`LEGACY_*`, ensureGeminiProfiles 루프) | 대체 후 제거 | 집계 | `GEMINI_ALLOWED_SERVERS` 소비자는 G1 의 도달 불가 분기뿐. agy 1.3.1 에 `--allowed-mcp-server-name` 없음. 마이그레이션은 bin/triflux.mjs:2314(setup 계열)만 호출, 이 기기 프로필은 이미 3.8 Flash | 다른 호스트의 옛 gemini 프로필 자동 정리 | 중 |
| G5 | hub | A38 gemini-adapter, A39 gemini-worker, A40 antigravity-route-worker, factory gemini 케이스, `tfx-route-worker.mjs` gemini 정규화(131~134), `tfx-route-post.mjs` gemini 분기(60~99, 259~262, 316~319, 450~453) | 즉시 제거 | 전체/함수 | 위 A 항목 참조 | 없음 | 중 |
| G6 | hub/team | `pane.mjs` gemini 분기, `backend.mjs` GeminiBackend, `tui-core.mjs:197~202`·`ansi.mjs:50,470` gemini 색과 아이콘(antigravity 미표시), `tui-viewer.mjs:359~364`, `conductor.mjs:140~148`(.gemini 인증 복사), `remote-session.mjs:83,127`(gemini 경로 프로브), `mcp-selector.mjs`(CLI_TYPES codex, gemini 뿐, `--allowed-mcp-server-names` 옛 플래그) | 대체 후 제거 | 집계 | headless.mjs:112 가 gemini 를 antigravity 로 바꿔 넘기는데 UI 는 gemini 만 구분해 agy 워커를 codex 로 표시 | agy 워커가 올바른 색과 이름으로 표시 | 하~중 |
| G7 | scripts | `preflight-cache.mjs:321` gemini 프로브와 캐시, `cache-warmup.mjs:232~292`, `snapshot-gemini-state.mjs` + package.json `snapshot:gemini` + `hub/lib/state-snapshot.mjs` GEMINI_* (hub-ensure 호출부는 인프라 세션), `mcp-check.mjs` gemini 키, `token-snapshot.mjs` gemini(H8 와 함께), `claude-login-detect.mjs:39` gemini 캐시 삭제, `sync-hub-mcp-settings.mjs:13~17`(인프라) | 대체 후 제거 | 집계 | 존재하지 않는 바이너리를 매 preflight 마다 프로브. gemini 스냅샷은 전역 설치본 `references/gemini-snapshots` 에 325M, 복원 코드 없음 | gemini CLI 전용 기기의 폴백(정책상 없음) | 중 |
| G8 | hud | `providers/gemini.mjs` 세션 스캔(637~743, H3), RPM 잔재(H4), 레거시 경로 마이그레이션(H5), 옛 모델 약어표(H6) | 즉시 제거 | 전체(630~745, 44~60, 515~530), 집계 | H3: 캐시 파일이 없고 스캔이 null 이면 캐시를 안 써서 매 렌더 `shouldRefresh:true`, 30초 락 간격으로 detached node 를 계속 띄운다(락 파일 시각 01:34 로 지금도 진행 중). H4: 소비자 0, tracker 파일 없음. H5: `~/.omc/state` 에 레거시 파일 없음. H6: Claude Sonnet 4.6, GPT-OSS, Gemini 3.1 Pro 등 정책 밖 모델 | 없음(Gemini CLI 세션 토큰 행은 정책상 안 씀) | 중 |
| G9 | tests | `tests/integration/gemini.test.mjs`(482), `gemini-worker-spawn.test.mjs`, retry/workers/backend 의 Gemini 구간, `tests/fixtures/fake-gemini-cli.mjs`, `fixtures/bin/gemini` | 대체 후 제거 | 집계 | 대상이 G1~G6 | 별칭 동작 회귀 가드(별칭을 남기면 1~2개 유지) | 중 |
| G10 | docs | `.claude/rules/tfx-routing.md` Layer 1 의 "legacy gemini fallback", `hooks/keyword-rules.json` gemini(인프라), `CONTRIBUTING.md:94~96` gemini 스냅샷 안내, `GEMINI.md:27~28` Gemini CLI EISDIR | 즉시 제거 | 해당 줄 | 코드에 없는 폴백을 문서가 약속 | 없음 | 하 |

### R. tfx-route.sh 정리 (G 와 별개)

| # | 영역 | 대상 | 분류 | 읽음 | 근거 | 잃는 것 | 난이도 |
|---|---|---|---|---|---|---|---|
| R1 | route | Codex MCP 전송 잔재: `run_codex_mcp`(3170~3260), `resolve_codex_mcp_script`, `TFX_CODEX_TRANSPORT` 파싱(1541, 1636~1642, 3426, 3466~3469, 3495~3501), `TFX_CODEX_MCP_ACTIVITY_FILE`, `codex_transport_effective`, tfx-route-worker.mjs exit 70 주석 | 즉시 제거 | 함수 | main 이 3469 에서 transport 를 항상 exec 로 덮어쓴다. `run_codex_mcp` 호출 0. `codex --help`(0.160.1)에 mcp-server 없음 | `TFX_CODEX_TRANSPORT=mcp` 안내 한 줄. 약 120줄 | 중(테스트 약 10개) |
| R2 | route | `approval_mode = "approve"` → `"full-auto"` sed(274~282), `_CODEX_HAS_SANDBOX` awk(261~269), 주석 290~291 | 즉시 제거 | 함수 | (a) macOS BSD sed 에서 `sed -i 's/…/…/g'` 는 실패하고 `set -euo pipefail` 때문에 스크립트가 죽을 수 있다. (b) `full-auto` 는 공식 `approval_mode` 허용값(auto, prompt, writes, approve)에 없다. (c) `_CODEX_HAS_SANDBOX` 는 주석이 "현재 미사용" 인정. 이 기기 config 에 해당 줄 0개라 아직 발동 안 함 | ISSUE-4 "OMX 업데이트가 approve 복원하면 stall" 방어(주장 미검증) | 하 |
| R3 | scripts/lib | `toml.mjs`(132) `patchMcpApprovalMode`, `patchCodexConfigFile`, 폴백 파서 | 사용자 결정(N1 에 종속) | 집계 | R2 와 같은 무효값 치환을 JS 로 한 번 더. `@iarna/toml` 재직렬화가 주석을 지우고, 폴백 파서는 문자열 값만 보존해 불리언·숫자·배열이 유실될 수 있다. 소비자는 tfx-route.mjs(opt-in 레인)뿐 | `@iarna/toml` 의존을 뺄 수 있다 | 중 |
| R4 | route | `apply_plan_guard`(1839~1860) | 즉시 제거 | 함수 | 호출 시점의 CLI_EFFORT 는 route_agent 가 검증한 정식 프로필 5개뿐(1478 이 그 밖은 exit). case 가 맞을 일이 없다 | 없음 | 하 |
| R5 | route | `normalize_codex_profile_name`(1544~1563) + `scripts/lib/codex-profile-config.mjs:34~48` `LEGACY_CANONICAL_PROFILE_ALIASES` | 대체 후 제거 | 함수, 집계 | 같은 별칭표가 JS 와 bash 두 곳. 살아 있는 경로는 사용자가 `TFX_CODEX_PROFILE=gpt56_*` 를 주거나 옛 retry 스냅샷을 읽을 때뿐. 기존 설치의 `~/.codex` 에 옛 프로필 파일이 남을 수 있다(setup 정리 목록에 없음, 인프라 세션) | 옛 이름 환경변수와 옛 스냅샷이 오류로 바뀜. 다른 기기 환경 미확인 | 중 |
| R6 | route | `apply_dynamic_routing_override`(2139~2186) | 즉시 제거 | 함수 | `${REPO_ROOT:-}/scripts/lib/dynamic-route-cli.mjs` 의 REPO_ROOT 는 이 파일에서 대입도 export 도 없다(저장소 전체 0). 결과 경로 `/scripts/lib/…` 가 없어 항상 return. 켜도 `TRIFLUX_DYNAMIC_ROUTING=1` 필요. 분기 안에 `agy_v1`, `--print --dangerously-skip-permissions` 하드코딩 중복 | 없음 | 하 |
| R7 | route | `apply_codex_concrete_effort_guard`(1993~2036) 의 `-c model="gpt-6-astra"` 하드코딩 | 대체 후 제거 | 함수 | 규칙(skill-authoring §3, psmux 규칙 4-1)이 모델 ID 하드코딩과 `codex -c 'model=…'` 을 금지. 프로필 파일이 같은 값을 갖는다 | ultra 가 새는 경우의 최후 방어(새는 경로 못 찾음) | 하~중 |
| R8 | route | 역할 규칙 중복: `apply_cli_mode` codex 모드(1695~1702), `apply_no_claude_native_mode`(1879~1906), `MIN_TIMEOUT`(3288~3294), `estimate_expected_duration_sec`(549~555) | 대체 후 제거 | 함수 | agent-route-policy.mjs 가 역할별 프로필·타임아웃·모드를 소유하고 route_agent 가 조회하는데 다섯 곳이 bash 에 다시 적는다. 이미 어긋남: designer 타임아웃 bash 3600, 정책 900 | 없음 | 중 |
| R9 | route | 소비자 없는 것: `codex_gte`(1291), `get_codex_version` 표시용 호출(1422, 모든 역할에서 `codex --version` 실행), `TFX_GEMINI_OK` export, `TFX_CODEX_PLAN` 검증(1626~1635, 사용처 0), `AGENT_MCP_HINT`(1487 대입만) | 즉시 제거 | 함수 | rg 로 정의와 대입만 확인 | 실행 시 "Codex 버전" 안내 한 줄 | 하 |
| R10 | route | `agy_supports_headless`(1159~1170) 가 호출마다 `agy --help` 실행 | 대체 후 제거 | 함수 | antigravity 한 번 실행에서 3회(실측 회당 0.32초). 결과는 실행 안에서 변하지 않으므로 변수로 한 번만 | 없음(약 0.64초 절약) | 하 |
| R11 | route | 한 실행의 node 기동 횟수: executor 10회, writer 10회, explore 4회(실측). `json_escape` 를 검증된 토큰에 두 번, `get_cached_servers` 가 읽은 인벤토리를 mcp-filter 가 다시 읽음, agent-map·policy·gemini 프로필 조회가 각각 node | 대체 후 제거 | 함수 | node 기동 5회 0.34초(실측)라 호출당 약 0.7초 | 없음 | 중 |
| R12 | route | 머리말 2~12(변경 이력, 없는 기능 "Gemini health check 지수 백오프"), 503 지원 프로필 목록의 `full`(mcp-filter 가 모름), `estimate_expected_duration_sec` 의 `full` | 즉시 제거(수정) | 함수 | rg 로 백오프 코드 0. `full` 을 주면 "알 수 없는 프로필" 경고 | 없음 | 하 |
| R13 | route | 후처리 폴백 렌더러(3773~3814) | 대체 후 제거 | 함수 | tfx-route-post.mjs 가 같은 형식을 출력하고 setup 이 post 를 항상 같이 복사한다. 폴백 안 `TFX_CLEAN_TUI` 기본값 불일치(`1` 대 `true`) | post 가 없는 설치의 최소 출력 | 하 |
| R14 | route | 4번째 인자 timeout 과 `MIN_TIMEOUT` 경고, `RUN_MODE`, `OPUS_OVERSIGHT` 라벨, `TFX_TIMEOUT_MODE=wallclock` | 사용자 결정 | 함수 | 타임아웃은 "advisory"(주석 3311)이고 실제 종료는 hard ceiling 만. 최소값 경고(3302)는 아무것도 강제하지 않는다. RUN_MODE 와 OPUS_OVERSIGHT 는 로그 값일 뿐 읽고 동작하는 코드 0 | 인자를 없애면 호출 규약이 바뀜(스킬이 `auto 1440` 처럼 넘김) | 중(경고와 라벨만 정리하는 안) |
| R15 | route | `result_file`(3816~3832) | 사용자 결정 | 함수 | stderr 출력 외에 읽는 코드 0. run 마다 TMPDIR 에 파일이 쌓인다 | 백그라운드 출력 유실 시 수동 복구 단서 | 하 |
| R16 | route | `--async`, `--job-status`, `--job-result`, `--job-wait`(295~472, 3837~3860) | 유지 | 함수, 집계 | 리드 실측: 90일 Bash tool_use(중복 제거)에서 `--async` 20, `--job-status` 33, `--job-result` 16, `--job-wait` 1, 세션 파일 7개, 마지막 2026-10-07. Claude 세션이 직접 치는 명령이다. 네이티브 `run_in_background` 가 같은 목적을 하지만 Codex 쪽 호출자와 멀티 호스트는 아니다 | 해당 없음 | 해당 없음 |
| R17 | route | `.claude/agents/slim-wrapper.md`(23) + `hub/team/native.mjs` 의 테스트 전용 600줄(`SCOUT_ROLE_CONFIG`, `buildSlimWrapperAgent/Prompt`, `buildScoutDispatchPrompt`, `buildHybridWrapperPrompt`, `pollTeamResults`, `formatPollReport`, `deduplicateFindings`, `compressScoutReport`, `weightedConsensus`, `generateTeamName`) | 즉시 제거 | 전체(native.mjs), 집계 | export 13개 중 비테스트 소비자가 있는 것은 `verifySlimWrapperRouteExecution`(native-supervisor) 하나. 머리 주석의 `tfx multi --native` 플래그는 저장소에 없다. slim-wrapper 서브에이전트 호출 90일 0건. setup.mjs:2420 이 `~/.claude/agents` 로 배포해 모든 세션의 Agent 도구 설명에 올라간다 | 테스트 3개, 서브에이전트 정의 1개 | 중(setup 배포 줄은 인프라 세션) |

### H. HUD 와 토큰 집계

| # | 영역 | 대상 | 분류 | 읽음 | 근거 | 잃는 것 | 난이도 |
|---|---|---|---|---|---|---|---|
| H1 | hud | `mission-board.mjs`(56), `renderers.mjs` `renderMissionBoard`, hud-qos-status 호출(174) | 즉시 제거 | 전체 | `~/.omc/state/sessions/` 에 json 파일 0개(UUID 하위 디렉터리만)라 항상 null. `dagLevel: 0` TODO 하드코딩 | 없음(그려진 적 없는 행) | 하 |
| H2 | hud, scripts, hub | `renderers.mjs` `readLatestBenchmarkDiff`·`formatTokenSummary`, `utils.mjs` `formatSavings`·`formatTokenCount`, hud-qos-status:320, `scripts/token-snapshot.mjs`(696), A35 의 `benchmarkStart/End`, tfx-auto/SKILL.md:1065 | 즉시 제거 | 전체(renderers 68~90), 집계 | 생산자 0. diffs 디렉터리 비어 있음. `~/.claude/scripts/token-snapshot.mjs` 는 설치되지 않는 경로(SYNC_MAP 에 없음). savings-total.json 의 847건은 테스트가 실제 홈에 쓴 산물로 보임. 가격표도 옛 값. mods 토큰 기록은 새 기능이지 이것의 대체가 아니다 | HUD "ts:" 절약액 행(데이터 없어 현재도 빈 값) | 중(테스트 2개) |
| H3 | hud | `renderers.mjs` `getTeamRow`(112), `constants.mjs` `TEAM_STATE_PATH` | 사용자 결정(수정 권장) | 함수 | 고정 경로 `team-state.json` 을 읽는데 `saveTeamState` 는 항상 `team-state-<sessionId>.json` 으로만 쓴다. 파일 없음 확인. `tfx multi` 가 90일 53회 쓰였으므로 의도된 행이라면 한 번도 안 보인 결함 | 고치면 팀 진행 행 | 하 |
| H4 | hud | `hud-qos-status.mjs:119` `readJson(QOS_PATH)`, `renderers.mjs` `getProviderRow` 의 `qosProfile`·`modelLabel` 인자, `_claudeStr`, `_modelLabelStr`, `_extraRightSection`, `constants.mjs` `QOS_PATH` | 즉시 제거 | 함수 | `qosProfile` 은 받기만 하고 본문에서 안 쓴다. `cli_qos_profile.json` 쓰는 곳 0. modelLabel 은 두 호출처 모두 null | 없음 | 하 |
| H5 | hud | `hud-qos-status.mjs:136` `readClaudeContextSnapshot`, `context-monitor.mjs` `readContextMonitorSnapshot`, `buildContextUsageView` 의 `snapshot` 인자 | 즉시 제거 | 함수 | `snapshot` 인자를 본문에서 안 쓰는데 매 렌더 파일을 읽고(없으면 레거시 경로까지) 전달만 한다 | 없음 | 하 |
| H6 | hud | `context-monitor.mjs` `MODEL_HINT_1M_PREFIXES`, `isMillionContextModel`, `resolveModelLimit`, `deriveContextLimit` | 즉시 제거 | 함수 | statusLine stdin 이 `context_window_size` 를 주고 `getStdinContextUsage` 가 한도 0 이면 null 을 돌려 모델 ID 추정은 HUD 경로에서 도달 안 함. `deriveContextLimit` 소비자는 테스트 8곳뿐. 주석 "Codex GPT-5.6 family" | 모델 ID 한도 표 테스트 | 하 |
| H7 | hud | 죽은 export: `colors.mjs`(`colorCooldown`, `colorParallel`, `GAUGE_BLOCKS`), `terminal.mjs`(`getTerminalRows`, `tierInfBar`, `_resetTerminalCache`, `selectTier` 미사용 인자 2개), `utils.mjs`(`formatDuration`, `calcCooldownLeftSeconds`), `constants.mjs`(`ROWS_BUDGET_*` 4, `REMOTE_ENV_CACHE_*` 2) | 즉시 제거 | 집계 | `rg -w` 로 hud 밖 비테스트 소비자 0 | 테스트 일부 | 하 |
| H8 | hud | `providers/cto.mjs`(76), hud-qos-status:293~304, constants:39~45 | 즉시 제거 | 집계 | `TFX_CTO_AUTO_COLLECT=1` 이 아니면 null. 켜도 current.md 가 3주 전이라 stale. 이 import 가 2026-09-24 설치본 HUD 를 죽인 P1 의 원인(cto-env 결합) | 환경변수를 켠 경우의 한 줄 | 하 |
| H9 | hud | `providers/gemini.mjs` 쿼터 조회(`fetchGeminiQuota`, `buildGeminiAuthContext`, `getAntigravityTokenFromKeychain`, `scheduleGeminiQuotaRefresh`), hud-qos-status 의 agy/gemini 행 | 사용자 결정 | 집계 | 지금 데이터를 못 가져온다: `gemini-quota-cache.json` 이 `errorType:auth`(2026-10-07), 옛 OAuth 자격증명 파일은 이미 치워졌고, agy keychain 토큰으로 `cloudcode-pa.googleapis.com` 호출이 거부. 그래서 agy 행은 `8h --%` | agy 쿼터 행(현재도 `--%`) | 상(공식 사용량 표면 확인 필요) |
| H10 | hud | `renderers.mjs` `getProviderRow`(약 290줄, tier 4개에 같은 계산 반복), `getMicroLine` 중복 파싱, 501행 import 없는 `GREEN`(도달 불가), `hud-qos-status.mjs` `main().catch` 의 녹색 `0%` 폴백, `main` 260줄 지역 변수 54개, `constants.mjs` `join(homedir(),".claude","cache",…)` 블록 34개 | 대체 후 제거 | 집계 | 장황코드. 다른 코드는 "가짜 0% 방지"로 `--%` 를 쓴다. H1~H8 정리 뒤 다시 재는 편이 낫다 | 없음 | 중 |
| H11 | hud | `terminal.mjs` `getTerminalColumns`(매 렌더 `tput cols` 셸), `detectCompactMode`·`detectMinimalMode`·`selectTier` 가 `hud.json` 을 세 번 읽음 | 사용자 결정 | 집계 | statusLine 은 파이프 실행이라 columns 가 비어 셸이 뜰 가능성. 실행 측정은 하지 않음 | 터미널 폭 자동 감지 | 하 |
| H12 | hud | `providers/claude.mjs` 날짜 붙은 실측 주석(119~123, 173~175, 376~379), `gemini.mjs:185`, `constants.mjs:205` | 대체 후 제거 | 집계 | 변경 이력과 측정 기록이 코드 주석에. git 과 memory 의 일 | 측정 근거 일부(memory, PR #499 에 있음) | 하 |
| H13 | hud | `providers/codex.mjs`, `codex-probe.mjs`(`getCodexRateLimits` 599ms, rollout 91M+127M 전체 읽기, 30초 캐시) | 유지 | 집계 | 2026-09-23 주간 창 수정과 프로브 병합이 의존하고 결과가 정확. 바꾸려면 `isReplacedWindowGroup` 재검증 | 해당 없음 | 해당 없음 |

### C. CTO (조회만 남기기)

A42~A46 외 추가.

| # | 영역 | 대상 | 분류 | 읽음 | 근거 | 잃는 것 | 난이도 |
|---|---|---|---|---|---|---|---|
| C1 | cto | `hygiene-notify.mjs`(170), `bin/tfx-live.mjs` cto-hygiene-notify, hygiene dry-run 투영, `status.mjs` `hygiene` 필드 | 즉시 제거(live-ops PR 머지 뒤) | 집계 | 호출은 테스트 2개뿐. 알림 입력은 hub synapse 뿐이라 synapse 제거(인프라 묶음 3) 뒤에는 항상 빈 결과. status 안정 키(AGENTS.md:40)에 hygiene 없음. 2차 판정: 9-24 결정이 조회를 `tfx cto status` 하나로 정하였다 | 알림(알릴 대상도 synapse 와 함께 사라짐) | 중(live-ops 가 `bin/tfx-live.mjs:16~17` import 와 하위 명령을 먼저 지우고 main 머지를 확인한 뒤에만) |
| C2 | cto | `dashboard.mjs` 전체(474) + `tfx cto dashboard` | 즉시 제거 | 함수 | 소비자는 index 분기뿐. `lake/dashboard.html` 마지막 생성 2026-06-02. 90일 호출 0. 2차 판정: 9-24 결정이 조회를 status 하나로 정하였다 | 정적 HTML 요약(조회는 status 로 가능) | 하 |
| C3 | cto | 중복: `collect.mjs` `appendLedgerEvent` 와 `events.mjs` `appendCtoEvent`(락 로직 글자 단위 동일), `readSynapseWithRegistry`·`normalizeLiveSession`·`firstExisting`·`toIsoTime` 2곳, `readJsonLines` 3곳(collect, hygiene, log-retention), `shortHash` 3곳, `pathLabel` 2곳, `writeAtomic` 2곳 | 대체 후 제거 | 집계 | 같은 함수가 2~3곳 | 없음 | 중 |
| C4 | cto | `status.mjs` 사람용 출력에 `generated_at` 없음, `index.mjs:66` `SUBCOMMANDS` export 소비자 0 | 즉시 제거(수정) | 집계 | auto-collect 가 꺼진 뒤 current.json 은 2026-09-24 에 멈춰 있는데 경과 시간을 안 보여줘 3주 전 스냅샷이 현재처럼 읽힌다 | 없음 | 하 |
| C5 | cto, hub | `hub/log-retention.mjs`(726) + `hub/lib/cto-env.mjs` 의 `getCtoMode`, `getCtoMaxTokens`, `isCtoManagerEnabled` | 즉시 제거 | 집계 | 소비자 0(테스트만). 활성화 조건 `TFX_CTO_RETENTION=1` 을 켜는 호출자 없음. resident-cto-manager 계획은 2026-09-24 동결. `applyLogRetention` 은 `runLogRetention` 별칭 | 로그 회전(동작한 적 없음) | 하 |
| C6 | cto | `collect.mjs` 손 검증기 8개(약 130줄)와 `current.schema.json` 의 required 만 쓰는 구조, 수집 함수 4개의 같은 오류 처리 반복 | 사용자 결정 | 집계 | ajv 가 의존성에 없어 손 검증이 의도일 수 있음 | 스키마 엄밀성 | 중 |

### S. 스킬, 규칙, 문서

| # | 영역 | 대상 | 분류 | 읽음 | 근거 | 잃는 것 | 난이도 |
|---|---|---|---|---|---|---|---|
| S1 | skills | `tfx-auto/SKILL.md:16~33, 64~67` Step 0 routing-weights 선호도 | 즉시 제거 | 해당 줄 | 가중치 파일의 mode_bias 키는 스킬 이름(harness, auto, ship…)이라 "모드"가 아니다. 최고값 auto 를 모드로 읽어 항상 무의미한 질문. 호출마다 `node -e` 1회(90일 217회). 이 워크트리에는 파일이 없어 no-op | 선호도 제안 한 줄(무의미) | 하 |
| S2 | skills | `tfx-auto/SKILL.md:85, 736` `codex exec --full-auto` 트리아지 | 즉시 제거 | 해당 줄 | `--full-auto` 는 0.147 에서 제거(CLAUDE.md:77). 직접 호출 안내는 tfx-routing.md 금지 | 없음 | 하 |
| S3 | skills | `tfx-auto/SKILL.md:46` vs `:139, :183, :225` ralph 서술 상충, 상태 파일 이름 `ralph-<sid>` vs 규칙 `retry-<sid>` | 즉시 제거(정정) | 해당 줄 | 한 문서 안에서 "Phase 2 미구현" 과 "Phase 3 true state machine" 이 같이 있다. 코드는 파일 이름을 정하지 않는다. tests/unit/skill-drift.test.mjs:242 가 틀린 이름을 고정 | 없음 | 하 |
| S4 | skills | `tfx-auto/SKILL.md:683~731` 커맨드 숏컷 표 18개 | 즉시 제거 | 해당 줄 | 슬래시 명령으로 등록하는 코드 0(commands/ 없음, plugin.json 은 skills 와 hooks 만). 90일 slash 집계에 없음 | 없음 | 하 |
| S5 | skills | `tfx-auto/SKILL.md` 삭제된 스킬 이름(:38, 71, 75, 100, 104, 146, 244, 255, 259, 260, 649, 785), 끊어진 계획 문서 참조(:192 decision-skill-passing, :681 phase2-tfx-run-design), 예시 JSON 의 끝난 프로젝트 주제(:410~470, 584~645) | 즉시 제거 | 해당 줄 | tfx-multi, tfx-swarm, tfx-auto-codex, tfx-codex, tfx-fullcycle 스킬은 3ecb33b5 에서 삭제. 계획 파일은 `.triflux/plans` 에 없음 | 없음 | 하 |
| S6 | skills | `tfx-auto/SKILL.md` 1096줄 전체 | 대체 후 제거(분리) | 전체 길이 | 공식 skills 문서 "Keep SKILL.md under 500 lines". 가장 자주 로드되는 스킬(90일 217회). consensus 스키마 약 380줄, tmux 관전 약 120줄은 보조 파일로 | 없음(필요할 때만 로드) | 중 |
| S7 | skills | `tfx-auto/SKILL.md:106~150` 플래그 표, README 양쪽 표 vs `hub/lib/tfx-route-args.mjs` 파서 | 사용자 결정 | 집계 | 파서가 모르는 플래그 11개를 문서가 안내. 파서가 아는 플래그도 유일한 호출자 bin 이 버린다. 실제 처리는 Claude 의 산문 해석 | `tfx auto --json` 미리보기(90일 사용 0) | 중 |
| S8 | skills | `tfx-auto/SKILL.md:822~833` 와 규칙 문서의 swarm 자동 승격 서술 vs `tfx-route-args.mjs` `decideDispatchMode` | 사용자 결정 | 집계 | 세 문서가 서로 다르고 코드는 bin 이 task 문자열만 넘겨 `auto-escalate-code-change` 분기에 도달 불가 | Issue #281 약속 기능(이미 안 돌아감) | 중 |
| S9 | skills | `tfx-research/SKILL.md:131` 상대 경로 `node scripts/lib/stealth-fetch.mjs`, `:74` `:researcher` 역할 접미사(KNOWN_ROLES 밖), `:44~48` vs `:108` 토큰 표 불일치, `:12,71` agy 1.0.x 시대 "5분 행" 주장, `:12` 영어 슬로건 | 즉시 제거(정정) | 해당 줄 | 사용자 프로젝트 cwd 에서는 파일이 없다. `tfx stealth-fetch <url>` 이 설치본에서 동작하는 진입점 | 없음 | 하 |
| S10 | skills | `tfx-review/SKILL.md:30`("87% 감소" 출처 없음), `:179`(`tfx status` 는 없는 명령), `:128`(`:reviewer` 접미사), `:27` 영어 슬로건 | 즉시 제거(정정) | 해당 줄 | rg 로 출처 0. 역할 접미사가 role 빈 값으로 파싱됨 | 없음 | 하 |
| S11 | skills | `tfx-ship/SKILL.md:18, 40, 348` 개인 memory 파일 참조(배포 스킬이 사용자 개인 경로), `:61` 일회성 관측, `:182` 틀린 줄 인용 | 즉시 제거(정정) | 해당 줄 | 참조한 memory 파일이 실제로 없음 | 없음 | 하 |
| S12 | skills | `tfx-ship/SKILL.md:24~38, 89~303, 263~275` 로컬 수동 플로우 215줄과 pypi 플레이스홀더 | 사용자 결정 | 해당 줄 | pypi 는 스스로 "플레이스홀더". 수동 플로우는 CI 경로와 중복이고 Step 0 "main 이 아니면 STOP" 은 CONTRIBUTING 과 충돌 | 비상 폴백 절차 | 중 |
| S13 | skills | `tfx-remote/SKILL.md` 전체 | 사용자 결정(재작성) | 해당 줄 | 삭제된 tfx-remote-setup, tfx-remote-spawn 의 "플로우를 그대로 사용"하라 지시. 하위 명령 8개 중 setup, resume 은 구현 없음. `Get-FileHash` 는 PowerShell 전용 | 없음(재작성하면 유지) | 하 |
| S14 | skills | `tfx-wt/SKILL.md:61, 96, 196, 207~210` | 즉시 제거(정정) | 해당 줄 | 줄 번호 어긋남, `nt`(새 탭)는 규칙 8 금지, 변경 이력 서술 | 없음 | 하 |
| S15 | rules | `tfx-execution-skill-map.md:5, 13~15, 22~23, 28, 39~41, 46`, `tfx-routing.md:162~163`, `tfx-stack-coexistence.md:52, 70, 74, 104`, `CLAUDE.md:105`, `GEMINI.md:24, 32` | 즉시 제거(정정) | 해당 줄 | tfx-multi, tfx-swarm 을 스킬로 서술. 실제는 `tfx multi`, `tfx swarm` CLI. tfx-psmux-rules 스킬도 삭제됨 | 없음 | 하 |
| S16 | rules | `tfx-stack-coexistence.md:61, 87~88, 92` `sc:brainstorm`, `sc:pm`, `sc:document`, `/writer`, `/checkpoint` | 즉시 제거(정정) | 해당 줄 | 이 기기 스킬 145개와 세션 목록 어디에도 없음. gstack 이름은 `gstack-context-save` 평면 이름 | 없음 | 하 |
| S17 | rules | `tfx-routing.md:24, 60` `/superpowers:review`, `:48~52` designer/writer 레인 vs policy 주석과 SKILL.md:1026 | 즉시 제거(정정) | 해당 줄 | superpowers 에 review 스킬 없음(requesting/receiving-code-review 만). designer/writer 는 policy 가 "직접 Codex 지정 전용" | 없음 | 하 |
| S18 | rules | `tfx-psmux.md:98~102` 규칙 4-3(agy stdin), `:163` "RULE 6" 표기, `docs/codex-conventions.md:56`, `tfx-setup/SKILL.md:26`(제외) | 즉시 제거(정정) | 해당 줄 | tfx-route.sh:1512~1514 "agy 1.1.27 부터 stdin 불가, --print 값". docs/DECISIONS.md 2026-09-21 이 이 수정을 "남은 것"으로 명시 | 없음 | 하 |
| S19 | rules | `.claude/rules/*.md` 12개(1157줄) 무조건 로드 | 사용자 결정 | 집계 | 공식 memory 문서: `paths:` 가 있으면 해당 파일을 읽을 때만 로드. Windows 전용 tfx-psmux.md(207줄), mirror-policy(121), cto-hub-boundary(91), machine-profile(106)이 모든 세션에 실린다. 단 tfx-psmux.md:2 는 `globs:` 를 쓰고 있어(공식 필드 아님) 현재 로드 조건 확인 필요 | 로드 누락 위험 | 하 |
| S20 | rules | `tfx-autoplan-principles.md`(79) | 사용자 결정 | 집계 | 소비자는 CLAUDE.md 색인 한 줄과 계획 문서 인용 한 곳. 스스로 "참조용" | gstack autoplan 원칙 요약 | 하 |
| S21 | rules | `tfx-cto-hub-boundary.md:28~30` "잔존 위반" | 유지 | 해당 줄 | 1차는 "이미 해소"라 하였으나 hud 영역이 `cto/status.mjs:197`, `cto/hygiene.mjs:104` 의 synapse-registry 동적 import 를 확인. 서술이 아직 사실 | 해당 없음 | 해당 없음 |
| S22 | rules | `tfx-skill-authoring.md` §4(.tmpl 0개인데 "별도 gate"), §5(manifest 보류인데 생성 스크립트 방치), §1(description 한국어인데 tfx-live 는 영어, lint 미검사) | 즉시 제거(정정) | 해당 줄 | A9, B34 와 연동 | 없음 | 하 |
| S23 | root docs | `CLAUDE.md:10~12`(스킬 "~40개", 실제 13), `:15`(없는 `/memory-hygiene`), `:178~186`(규칙 색인 12개 중 6개만), `:189~195`(자기 이력), 줄 번호 참조 5곳 어긋남(terminal-opener 124~149 → 실제 150~192, headless 1725 → 2594, tfx-route.sh 86/1662/1681 → 47/192/1183/2589/2608, notify 221~234 → 240~253. env-detect 96 은 맞음) | 즉시 제거(정정) | 해당 줄 | 리드가 rg 로 재확인 | 없음 | 하 |
| S24 | root docs | `AGENTS.md:8` `approval_mode`/`sandbox`(CLAUDE.md 는 `approval_policy`/`sandbox_mode`), headless-guard 제거 문장 3회 반복, 완료 마커 3회 반복 | 즉시 제거(정정) | 해당 줄 | Codex 용 문서에 옛 키 이름 | 없음 | 하 |
| S25 | root docs | `CLAUDE.md:74` vs `docs/codex-conventions.md:33` vs `tfx-route.sh:285~290` bypass 플래그 중복 지정 여부 | 사용자 결정 | 해당 줄 | 세 문서가 서로 다르다. Codex 0.160 동작 확인 필요 | 없음 | 하 |
| S26 | root docs | `ROADMAP.md`(231) | 즉시 제거 | 전체(상태) | 스스로 "stale", 마지막 기록 2026-05-01(v10.18, 현재 10.49). 링크한 계획 3개 없음 | 2026-04~05 기록(CHANGELOG 와 git 에 있음) | 하 |
| S27 | root docs | `TODOS.md`(59) | 사용자 결정 | 전체 | 4개 전부 2026-04 기록이고 허브, synapse, gateway 제거 결정(10-07)이 확정되면 의미가 없다. 없는 계획 문서 인용 | 미래 작업 메모 | 하 |
| S28 | root docs | `ARCHITECTURE.md:35~46`(tui, config, adapters, experiments, references 누락), `:55`(risk-tier 정규화 서술 거짓), `:87`(`/checkpoint`) | 즉시 제거(정정) | 해당 줄 | S16, S29 와 연동 | 없음 | 하 |
| S29 | hub | `hub/lib/risk-tier.mjs`(53) + `--risk-tier` 문서(README 2곳, tfx-auto SKILL 3곳, ARCHITECTURE:55) | 사용자 결정 | 집계 | `classifyRiskTier` 호출자 0. 파서에 `risk` 문자열 없음. 문서가 약속한 "변경 파일로 검증 강도 자동 결정"이 코드로 연결 안 됨 | 문서가 약속한 기능 | 하(삭제) 또는 중(연결) |
| S30 | root docs | `GEMINI.md:24, 32`(삭제된 스킬), `:25`(`tfx-route.sh --cli antigravity` 는 틀린 인자 형태), `:27~28`(Gemini CLI 규칙), `:44~71`(gstack 자동 삽입 블록, 콜론 이름) | 즉시 제거(정정) | 해당 줄 | agy 가 GEMINI.md 를 읽는지는 공식 확인 못 함(제3자 문서는 읽는다고 함) | 없음 | 하 |
| S31 | root docs | `CONTRIBUTING.md:72`(gen:skill-manifest), `:94~96`(gemini 스냅샷), `:101`(chore/ 접두사 없음) | 즉시 제거(정정) | 해당 줄 | A9, G7 과 연동 | 없음 | 하 |
| S32 | docs | `docs/README.md` 인덱스 미등재: codex-conventions.md, demo.tape, demo-light.tape, superpowers/plans/2026-05-20-agy-phase1-finish.md, .obsidian 3개, .wiki-harness/refs/architecture.json. "LOCAL" 이라 적은 두 경로가 추적 중 | 즉시 제거(정정) | 해당 줄 | 거버넌스 "미등재 = 존재 부정". 리드가 4개 샘플 재확인(0건) | 없음 | 하 |
| S33 | docs | `docs/DECISIONS.md`(순서, 미이행 "남은 것", 한자 표기), `docs/codex-conventions.md`(§4 중복 번호, 규칙 사본, exec 형태 불일치) | 즉시 제거(정정) | 집계 | 문서끼리 어긋남 | 없음 | 하 |
| S34 | docs | `.triflux/plans/*.md` 28개 중 끝남 23개 | 즉시 제거 | 집계(판정표) | 거버넌스가 plans 를 "폐기성"으로 분류. 판정표는 findings-skills-docs.md "계획 문서 판정표". 외부 참조 7곳 정리 필요 | 설계 서사(ADR, PRD, CHANGELOG 에 대부분 있음) | 하 |
| S35 | docs | `.triflux/plans` 폐기 3개(0011-active-cto-lead-role-system, 0011a-c6a-contracts 1289줄, agy-subagents-integration-eval 627줄), 진행중·불명 2개(node-cli-single-entry-migration, resident-cto-manager) | 사용자 결정 | 집계 | 폐기 3개는 9-24, 10-07 결정과 모순. 나머지 2개는 N1, C 묶음 결정에 종속 | 없음 | 하 |
| S36 | docs | `docs/prd/archived/` 42개(폐기 표시 0개, 규정 위치 `docs/_archive/` 아님), 비보관 PRD 중 구현 삭제된 것(phase2-step-b-thin-aliases 570줄), 6개월 "In Progress"(prd-multi-startup-cache), draft(worker-signaling-consolidation), 약속 산출물 없는 release-governance/02, 03 | 사용자 결정 | 집계(머리) | ADR-0012 와 doc-governance 규정과 다름 | 없음 | 중(이동 + 표시 42개) |
| S37 | docs | `docs/adr/` 상태: 구현 끝난 Proposed 4개(0014, 0020, 0021, 0022), superseded 후보(0011), 불명 3개(0013, 0015, 0018). `tfx-cto-hub-boundary.md` 가 Proposed 0010 을 확정 근거로 인용 | 사용자 결정 | 집계 | 상태보드와 실제가 다름 | 없음 | 하 |
| S38 | docs | `docs/architecture.reading.md`(126, ARCHITECTURE.md 의 옵시디언 각주 파생본, 두 달 뒤처짐), `.wiki-harness/refs/architecture.json`, `.obsidian/*` 3개 | 사용자 결정 | 집계 | 소비자는 색인 한 줄. wiki-harness 산출물은 개발자 문체 규칙이 피하는 각주 형태 | 옵시디언 노트 | 하 |
| S39 | docs | `docs/recovery/*` 3개(2026-04 일회성, memory.md 에 Windows 절대 경로), `docs/research/*` 9개, `docs/design/*` 8개(Draft 상태 2개 포함) | 사용자 결정 | 집계(머리) | 본문 미독. ADR-0012 는 구현 제거된 recovery 를 `docs/_archive/` 로 | 조사 근거 | 하 |
| S40 | docs | `docs/superpowers/plans/2026-05-20-agy-phase1-finish.md`, `.triflux/reports/main-lint-source.md` | 즉시 제거 | 집계 | docs/README 가 "LOCAL" 이라 적은 경로인데 추적 중. 일회성 | 없음 | 하 |
| S41 | docs | `docs/demo.tape`, `demo-light.tape`, `scripts/demo.mjs`(197, psmux 에 미리 정한 echo 를 보내는 가짜 데모), `docs/assets/demo-dark.gif`, `demo-light.gif`, `demo-psmux.gif`(1.46MB), `consensus-flow.svg`, `deep-vs-light.svg`(v8.4 푸터) | 사용자 결정 | 집계 | README 는 demo-multi.gif 만 참조. 전부 npm `files` 의 `docs/assets` 로 배포됨. 외부 링크 여부 미확인 | 데모 재생성 원본 | 하 |

### F. 설정 파일

| # | 영역 | 대상 | 분류 | 읽음 | 근거 | 잃는 것 | 난이도 |
|---|---|---|---|---|---|---|---|
| F1 | config | `knip.json` | 즉시 제거(정정) | 전체 | `ignore: research/**` 의 디렉터리 없음. entry/project 에 `cto/`, `mesh/`, `tui/` 없음(이번 조사에서 이 세 곳의 unused 가 knip 에 안 잡힌 이유) | 없음 | 하 |
| F2 | config | `biome.json` `!**/research`, `!**/public`, package.json `lint` 경로에 `tui`, `experiments` 누락, `jsconfig.json`(checkJs=false, 소비자 0, include 누락) | 즉시 제거(정정) | 전체 | 없는 경로 제외와 배포 대상 미검사 | 없음 | 하 |
| F3 | config | `.npmignore`(`**/failure-reports/`) | 즉시 제거 | 전체 | npm 공식: 루트 `.npmignore` 는 `files` 필드를 덮지 못한다. 같은 규칙이 `files` 에 이미 있다 | 없음 | 하 |
| F4 | config | `.env.example` | 즉시 제거(정정) | 전체 | "Logging (Logify)" 는 외부 서비스가 아니라 pino 설정. `NPM_TOKEN # npm publish용` 은 OIDC 전용 정책과 모순 | 없음 | 하 |
| F5 | config | `.claudeignore`, `.codexignore`(각 802바이트, .geminiignore 와 동일) | 대체 후 제거 | 전체 | Claude Code 는 `.claudeignore` 를 읽지 않는다(이슈 56997, 공식 수단은 `permissions.deny`). Codex 는 ignore 파일 미지원(이슈 2847). ADR-0002 가 이것을 방어선으로 서술 | `.env` 등을 가린다는 착각(실효 없음) | 하(settings `permissions.deny` 로 대체, ADR 문구 정정) |
| F6 | config | `.geminiignore` | 사용자 결정 | 전체 | Gemini CLI 공식 기능이나 gemini 미설치. agy 가 읽는지 미확인 | agy 가 읽는다면 비밀 파일 차단 | 하 |
| F7 | config | `config/routing-policy.json`(124) | 즉시 제거(D1 과 함께) | 집계 | 소비자는 dynamic-routing-engine 과 dynamic-route-cli(D1). `fallback.default_model: "gpt-6.1-sol"` 하드코딩(skill-authoring §3) | 없음(D1 참조) | 하 |
| F8 | config | `package.json:9` `tfl` bin 별칭 | 사용자 결정 | 집계 | 참조 0. 이름이 tfx-live 를 연상시키지만 triflux.mjs | 셸 명령 하나 | 하 |

### P. packages 미러 (리드 직접 판정)

| # | 영역 | 대상 | 분류 | 읽음 | 근거 | 잃는 것 | 난이도 |
|---|---|---|---|---|---|---|---|
| P1 | packages | `scripts/pack.mjs` 가 `scripts/lib` 43개 전체를 core 와 remote 에 복사 | 대체 후 제거(복사 목록 축소) | 전체(pack.mjs) | packCore 주석 "shared scripts/lib for logger, context", packRemote 주석 "needed by delegator-mcp.mjs (dynamic resolve)". knip 기준 remote 에서 import 되지 않는 사본 35개. gateway, hook-utils, keyword-rules, cli-gemini, stealth-fetch 까지 두 라이브러리 패키지에 실려 나간다. core 는 knip project 밖이라 미측정이나 같은 구조 | 없음(실제 import 되는 몇 개만 남김) | 중 |
| P2 | packages | `pack.mjs` CORE_FILES 의 `hub/role-contract.mjs`, `hub/role-control-events.mjs` 중복 등재(31~32, 37~38) | 즉시 제거 | 전체 | 복붙 | 없음 | 하 |
| P3 | packages | `packages/triflux` files 의 `scripts` 통째 포함: `release/check-packages-mirror.mjs`, `check-sync.mjs` 같은 저장소 개발 도구가 npm 사용자에게 배포 | 사용자 결정 | 전체 | knip packages unused 2개 | 없음 | 하 |
| P4 | packages | `pack.mjs` CORE_INDEX 배럴이 A29, A30, A31, A32, A34, A38 과 adaptive 계열을 `@triflux/core` 공개 API 로 재수출 | 사용자 결정(릴리스 노트) | 전체 | 저장소 안에 `@triflux/core` 루트를 import 하는 곳 0. 외부 소비자는 정적 검토로 알 수 없다(architect 도 같은 지적) | 공개 npm 표면 축소 | 하(릴리스 노트 명시) |
| P5 | packages | `release/check-packages-mirror.mjs`(루프 4벌 반복, 이력 주석, hub/lib 전체 byte 검사 7개뿐) | 유지(수정) | 집계 | CI 게이트라 유지. memory "Mirror Check Blind Spots" 가 아직 유효 | 해당 없음 | 중 |
| P6 | packages | `tfx-mirror-policy.md`("remote 는 cp 금지, Edit 로 개별 수정") vs `pack.mjs`(일괄 복사 뒤 import 재작성) vs `check-packages-mirror.mjs:385`("npm run pack:remote 로 재생성") | 사용자 결정(정본 선택) | 전체 | 세 곳이 다른 절차를 말한다 | 없음 | 하 |

### X. 테스트

| # | 영역 | 대상 | 분류 | 읽음 | 근거 | 잃는 것 | 난이도 |
|---|---|---|---|---|---|---|---|
| X1 | tests | `tests/unit/headless-read-result.test.mjs`(복제 `readResultLike` 검증), `tui-viewer.test.mjs`(함수 7개 미러 복제 검증, 411줄 47 tests) | 즉시 제거 | 집계 | 원본이 아니라 테스트 파일 안 복제본을 검증한다. 복제본에는 원본의 `.partial` 분기가 없어 이미 다르다. 원본 readResult 는 headless-118-timeout-partial 이 검증 | 원본 로직은 처음부터 미검증이라 잃는 신호 없음 | 하 |
| X2 | tests | `json-escape.test.mjs`(20 tests, bash `json_escape` 대신 JS 복제 비교) | 즉시 제거 | 집계 | 복제본끼리 비교. 대상 `json_escape` 는 검증된 토큰 둘(`AGENT_TYPE`, `CLI_TYPE`)에만 쓰이고 그 기록의 소비자는 `tfx monitor`(90일 0회). 다시 쓸 가치 없음 | 없음 | 하 |
| X2b | tests | `psmux-routing.test.mjs:41~212`(복제 `normalizeTeammateMode` 17 tests, 죽은 `_multiSkillPath`, 소스와 SKILL 문구 grep 16개) | 대체 후 제거 | 집계 | 원본은 export 돼 deps 주입으로 직접 호출 가능(runtime-mode.mjs:8). 헤더의 "side effect 때문에 import 못 한다"는 지금 사실과 다름. 플랫폼별 팀 모드 결정이라 지킬 가치가 있다 | 원본 대상 표 테스트 5개(auto+TMUX, darwin tmux 없음, win32 psmux, 비win32 의 wt, inline 별칭)로 다시 쓴다. grep 16개는 삭제 | 중 |
| X3 | tests | `critical-fixes.test.mjs`(semverGte 복제, progressBar 는 ansi.test 중복, 소스 grep 10개, mirror 정규식은 CI `release:check-mirror` 중복), `high-fixes.test.mjs`(truncate 4개는 ansi.test 중복, token-mode 는 A31 과 함께, 보안 헤더 grep, 버전 일치는 `release:check-sync`) | 즉시 제거 | 집계 | 실행 테스트 전부 다른 파일과 중복이고 나머지는 소스 문구 검사. 이름이 "수정 라운드"라 무엇을 지키는지 말하지 않음. keyword 5개는 인프라 세션이 keyword-rules 와 함께 지움 | 없음 | 하 |
| X4 | tests | `integration/dynamic-routing-integration.test.mjs` 9 tests 전부 skip(`skip: !importOk` 가 등록 시점에 평가, `importOk` 는 before 에서야 true) | 즉시 제거(D1 과 함께) | 집계 | 단독 실행 pass 0 skipped 9. fake policy 에 `gpt-5.6-terra`. 대상이 D1 로 사라진다 | 없음 | 하 |
| X5 | tests | `autoresearch.test.mjs`(research.test 와 중복, 레포 루트 `.tfx-test-tmp` 에 씀), `claudemd-manager.test.mjs`(claudemd-sync.test 와 같은 5 케이스), `packages-sync.test.mjs`(release:check-mirror 의 부분집합), `scripts/__tests__/smoke.test.mjs`·`tests/unit/shared.test.mjs`(typeof 만 확인) | 즉시 제거 | 집계 | 상위 집합이 따로 있다 | 빈 입력 케이스 1개(옮기면 유지) | 하 |
| X6 | tests | `tui.test.mjs:260`, `tui-remote-adapter.test.mjs:129` assert 없는 test | 즉시 제거 | 집계 | 예외 안 나면 통과 | 없음 | 하 |
| X7 | tests | 소스 문구 정규식 검사 묶음: conductor-probe-default, conductor-probe-l2-default, tfx-route-codex-recovery, tfx-route-hard-ceiling, tfx-auto-default-native-bridge, pack-remote, legacy-surface-routing-docs, skill-surface | 즉시 제거(1파일은 다시 쓰기) | 집계 | 실행 없이 구현 문장을 고정해 리팩터링을 막는다(테스트 원칙 첫째 조건 위반). 7파일 삭제. `pack-remote` 의 "삭제된 tray 를 싣지 않는다"는 pack.mjs 목록 상수를 import 해 단언하는 1개로 다시 쓴다 | hard-ceiling 환경변수 기본값 방향 가드(필요하면 실행 기반으로 다시 쓴다) | 하 |
| X8 | tests | `tests/helpers/eval-store.mjs`(807), `eval-store.test.mjs`(515), `session-runner.mjs`(449), `session-runner.test.mjs`(150) | 즉시 제거 | 집계 | 소비자 0(헤더가 말하는 eval:compare CLI 없음). `runSkillTest` 는 실제 `claude -p` 를 띄우고 기본 모델 `claude-sonnet-4-6`, 결과를 실제 `~/.claude/cache/tfx-eval` 에 씀. `npm test` 글롭에 잡혀 매번 돈다 | skill E2E 하네스 가능성(호출자 0) | 하 |
| X9 | tests | `native-wrapper.test.mjs`(363), `anti-slop.test.mjs`(255), `slim-wrapper-bypass.test.mjs`(156) | 즉시 제거(R17 과 함께) | 집계 | 대상 native.mjs export 12개 소비자 0. native-wrapper:157 은 실제 `~/.claude/tfx-results` 에 씀 | 없음 | 중 |
| X10 | tests | 삭제 모듈의 테스트: path-utils(41 tests), log-retention, process-cleanup 2개, remote-probe(26), timeline-adapter, tui-remote-adapter(728줄 26), worker-signal, native-bridge-tui 일부, native-bridge-interactive-attach 2개, cache-buildup, demo, skill-state, remote-spawn-transfer, skill-template 2파일(parseFrontmatter 8개 안팎은 살림) | 즉시 제거(모듈과 함께) | 집계 | A 묶음에 종속 | 없음 | 하 |
| X11 | tests | `scripts/__tests__/tfx-route-node-entry.test.mjs`(44), `tfx-route-bash-node-parity.test.mjs`(13), `tfx-route-phase1-modules.test.mjs`(12) | 사용자 결정(N1) | 집계 | Node 레인 결정에 종속 | 포팅 PRD 의 검증 근거 | 상 |
| X12 | tests | 실제 홈에 쓰는 테스트: `integration/nativeProxy.test.mjs:26`, `hub-server.test.mjs:31`(`~/.claude/teams`, `tasks`), `native-wrapper.test.mjs:157`, `token-benchmark.test.mjs`(`~/.omc/state/cx-auto-tokens`), `account-broker.test.mjs` 추정(broker-state.json 의 `test-gemini`) | 유지(수정) | 집계 | 같은 계열 hub-auth-endpoints.test.mjs 는 임시 HOME 으로 격리해 가능함을 보여준다. 메모리 "Non-Hermetic Runtime-State Tests" 유형 | 없음(HOME 격리) | 중 |
| X13 | tests | 고정 이름 임시 경로: headless-stall(`tfx-stall-test`), headless-118-timeout-partial, adaptive-diagnostic-fallback, memory-doctor, claude-daemon-control(`claude-control-test`) | 유지(수정) | 집계 | `npm test` 동시성 8 에서 서로의 파일을 지울 수 있다 | 없음 | 하 |
| X14 | tests | HUD 과잉: `hud-cli-policy-gate.test.mjs:212~265`(소스 텍스트 indexOf 로 줄 순서 고정), `opus-duplicate-status.test.mjs`(fixture 가 항상 1M 이라 모델 무관한데 7개 반복), `context-monitor.test.mjs:77~222` deriveContextLimit 11개(H6 대상), `hud-context-view.test.mjs`(같은 단언 3번째) | 즉시 제거 | 집계 | 동작이 아니라 코드 모양을 고정 | 없음 | 하 |
| X15 | tests | `tests/cto/status.test.mjs`(268) + `tests/unit/cto-status.test.mjs`(278) 같은 모듈 분산, `hud-qos-status.test.mjs` 스냅샷 7개, `monitor.test.mjs`·`monitor-data.test.mjs`(의존 전부 목, darwin 결함을 가림), `hud-codex-bucket.test.mjs` classifyBucket 8개와 렌더링 4개 | 대체 후 제거 | 집계 | 스냅샷은 파일이 없으면 써 놓고 통과(144)해 회귀를 못 막고, 한 글자 변경마다 7개를 다시 써야 하며 fixture 가 제거된 sv 세그먼트와 옛 모델명을 가리킨다. bucket 은 같은 경로 반복과 렌더 내부 고정 | cto status 는 한 파일 3개(overlay 우선, snapshot 폴백, cwd 비노출)로, HUD 스냅샷은 동작 단언 2개(정책으로 codex 행 숨김, agy 행 표시 조건)로, bucket 은 표 1개와 주간 창 선택 테스트만 남긴다. monitor 는 U13 의 `tfx monitor` 처분을 따른다 | 하~중 |
| X16 | tests | `contract/codex-behavior.test.mjs`(기본 skip, C2 "Always passes", 옛 키 `approval_mode`), `manual/verify-encoding.mjs`(`gemini -y -p` 직접 실행), opt-in E2E 제목 "real codex 0.119.0" | 사용자 결정 | 집계 | 기본 환경에서 신호 없음 | 사전 경보 | 하 |
| X17 | tests | 위치와 이름: `tests/remote-watcher.test.mjs`, `tests/notify.test.mjs`, `tests/pipeline/*`, `tests/regression/mcp-*`(unit 과 같은 모듈), `v24-functions.test.mjs`("1.", "1-1." 번호), psmux-routing 의 "Test 13/14/15" 주석, `deep-interview.test.mjs:57` "올바르어야", `token-snapshot-pricing.test.mjs:10` "Opus 4.7" | 유지(정리) | 집계 | 규약 밖 위치와 의미 없는 이름 | 없음 | 하 |

### D. 2차 판정으로 사용자 결정에서 옮긴 묶음

1차는 "잃는 것"이 있다고 보고 사용자 결정에 두었으나, 2차 판정이 그 기능이 어떤 경우에도 동작하지 않거나 대체가 이미 있음을 확인한 것이다.

| # | 영역 | 대상 | 분류 | 읽음 | 근거 | 잃는 것 | 난이도 |
|---|---|---|---|---|---|---|---|
| D1 | hub, scripts, config, bin, tests | 동적 라우팅 패밀리: `hub/dynamic-routing-engine.mjs`(511), `routing-snapshot.mjs`(261), `scripts/lib/dynamic-route-cli.mjs`(107), `config/routing-policy.json`(F7), `scripts/doctor-dynamic-routing.mjs`, bin doctor `--dynamic-routing` 분기, conductor.mjs:1164~1215 와 swarm-hypervisor.mjs:1988 연결부, tfx-route.sh R6, 테스트 X4 | 즉시 제거 | 함수(engine 의 makeFallback·시나리오 결정·S6, conductor 1155~1215, R6), 전체는 2차 판정자 | 1차는 "다계정 소진 임박 계정 우선 소비"를 잃는 것으로 보고 사용자 결정에 뒀다. 리드 확인: 시나리오 S1~S5 의 결정은 전부 `cli: "codex"` 이고 폴백도 `codex-default` 라, `TRIFLUX_DYNAMIC_ROUTING=1` 이면 conductor 가 모든 비원격 세션에 이 결정을 적용해 claude·antigravity 세션도 codex 로 바뀐다. S6 만 계정 provider 를 보지만 conductor 는 결정의 계정을 세션에 넘기지 않는다. 캐시를 채우는 코드가 없고(`tryGetCachedSnapshot` 은 miss 면 폴백), bash 쪽은 `REPO_ROOT` 미설정으로 항상 return. 머리 주석 "no callers yet (dormant)" 는 거짓(conductor 가 호출) | 없음(동작하는 경우가 없다). 다계정 라우팅이 필요하면 새로 설계 | 중(테스트 1, 미러) |
| D2 | bin, hub/team | `tfx review` + `hub/team/codex-review.mjs` + README 안내 | 대체 후 제거 | 함수(213~220, agent-route-policy 97~119) | 1차는 "커밋 범위, 파일 샤딩, VERDICT 파싱"을 네이티브에 없는 것으로 보고 사용자 결정에 뒀다. 2차 판정: 대체가 이미 있다. `agent-route-policy.mjs` 가 code-reviewer, quality-reviewer, security-reviewer 역할을 `subcommand: "review"`(0.160.1 네이티브 `codex exec review`)로 보낸다. 이 파일은 `-s read-only` 와 `--dangerously-bypass-approvals-and-sandbox` 를 같이 줘(213~220) 읽기 전용이 성립하지 않는다. 실행 90일 0회, tfx-review 스킬도 부르지 않는다 | verdict 파싱과 파일별 샤딩(소비자 0) | 하(README 안내를 `tfx-route.sh code-reviewer` 로 교체) |

### U. 사용자 결정 (기능 존치)

2차 판정으로 분류가 확정된 U2(동적 라우팅)와 U12(tfx review)는 D 절로 옮겼다.

| # | 영역 | 대상 | 근거 요약 | 잃는 것 | 2차 판정 |
|---|---|---|---|---|---|
| U1 | scripts | **Node 단일 진입점 레인**: `scripts/tfx-route.mjs`(314)와 그것만 쓰는 `scripts/lib/async.mjs`(174), `env.mjs`(일부), `tmp.mjs`, `hub.mjs`, `toml.mjs`(R3), `cli-agy.mjs`, `cli-codex.mjs` `plan()`, 테스트 3파일(X11), 계획 node-cli-single-entry-migration.md | `TFX_ROUTE_NODE=1` 을 설정하는 곳이 저장소와 이 기기 어디에도 없다. 켜도 bash 로 위임만 한다(`bash lane retained`). 2026-05-20 Phase 0/1 이후 4.5개월 진전 없음 | 이관을 마칠 길 | 2차: 사용자 결정 유지, 권고는 "전환 중단 후 삭제". 삭제 범위 표는 "결정이 필요한 항목" 절 |
| U3 | hub/team | **swarm 실행 엔진**: swarm-hypervisor(2206), conductor(1529), worktree-lifecycle, swarm-planner, swarm-preflight, swarm-locks, swarm-cli, recovery-store, event-log | Claude transcript 90일 `tfx swarm` 1회, Codex 세션의 실제 `cmd` 실행 0. 규칙 문서는 코드 변경 병렬의 기본 경로로 지정. 2026-07 데이터 손실 사고와 복구 이력. 유지하면 수정할 결함 8개: changedFiles 를 출력 텍스트로 추정해 lease 위반 검사가 무력(hypervisor:1790~1847), 원격 fetch 가 브랜치를 지움(worktree-lifecycle:610~640), 원격 종료가 없는 psmux 세션을 지우고 ssh 자식은 안 끔(conductor:325~373), 원격 에이전트가 전부 codex exec bypass 로 실행(conductor:931~956), STALLED→COMPLETED 전이 누락(conductor:79~94), tierFallback 미구독(conductor:1447~1483), F2 폴백 무한 반복(hypervisor:1238~1254), setState runId 매번 새로(hypervisor:292~328, gstack 체크포인트까지 수정) | worktree 격리 병렬 실행 경로 전체 | 2차: 사용자 결정 유지. 존치면 결함 12개 수정(코드로 재확인 7), 퇴역이면 소스 약 8,600줄과 테스트 20파일이 같이 사라진다. 범위는 "결정이 필요한 항목" 절 |
| U4 | hub/team | **tfx multi 의 모드와 하위 명령**: in-process 모드(native-supervisor 460, native-control 145, start-in-process 50, 90일 0건, stdin EOF 미처리 추정), WT 모드의 항상 no-op `focusWtPane`/`closeWtSession`(stop·kill 이 pane 을 안 닫고 성공 출력), 하위 명령 attach·focus·send·interrupt·control·task·tasks·kill·list·debug(90일 0건), roster/interactive-attach 브리지 모드(claude-native-bridge 39~197·523~987, PRD 가 실패 경로로 기록), mux pane headless 경로(Windows·원격의 유일한 경로) | 사람이 터미널에서 직접 친 명령은 집계에 없다 | 대화형 팀 제어 | 2차: roster·interactive-attach·claude-wrapper 모드, stall 죽은 코드, KNOWN_ROLES 사본은 즉시 제거(묶음 M1). in-process 와 WT 팀 모드는 사용자 결정(권고 제거). 하위 명령은 control·debug(허브 의존), send·interrupt·kill 일부(in-process 의존), attach·kill·list(tmux 기본 조작)로 나눠 판단. mux pane 헤드리스는 유지(결함 수정) |
| U5 | hub | `workers/codex-app-server-worker.mjs`(1067) | 소비자 0(factory 의 codex-app-server 케이스만, 도달 불가). 헤더 "AC9 factory integration lands in PRD-3" 미완. 공식 대체재(app-server)를 구현하였지만 연결 안 함. tfx-live 는 별도 클라이언트 사용 | 스트리밍 워커 구현 | 지울지 codex 실행을 이쪽으로 옮길지 설계 판단 |
| U6 | hub | `account-broker.mjs`(1221) | `accounts.json` 없어 `broker` 가 null. broker-state.json 은 2026-05-07 테스트 계정 흔적. `_QUOTA_COOLDOWN_MS` 미참조. 소비자 9곳 | 다계정 Codex 풀과 회로 차단기 | 다기기·다계정 사용 여부는 사용자만 안다 |
| U7 | hub | `reflexion.mjs` 죽은 함수 4개(`lookupSolution`, `learnFromError`, `reportOutcome`, `getActiveAdaptiveRules`), `pickSessionCount`(@deprecated 인데 사용 중), `promote-penalties.mjs` | 비테스트 호출자 0. safety-guard 훅(제외)이 같은 파일을 읽는 별도 루프 | adaptive 계열(인프라 묶음 3)과 함께 가면 전체가 사라짐 | 인프라 묶음 3 에서 adaptive 계열과 함께 처리(인프라 세션 회신). 테스트 전용 죽은 함수 4개는 지금 지워도 된다 |
| U8 | hub | `memory-doctor.mjs` 나머지 약 500줄 | 소비자 setup.mjs 뿐(제외). `.omc/state` 를 옮기고 없는 복구 명령을 안내 | MEMORY.md 고아 색인 보정 | 인프라 세션 |
| U9 | hub | `lib/ssh-command.mjs` 미연결 함수 7개(`suppressStderr`, `validateCommandForOs` 의 `X && X` 빈 블록 등), `lib/hosts-compat.mjs` 의 삭제된 경로와 `--self-test` | 소비자는 4개 함수만. 머리 주석 "모든 SSH 명령 생성 코드에서 사용할 것"과 실제가 다름 | 원격 명령 안전 게이트(미연결) | 원격 경로라 결함과 미연결만 근거 |
| U10 | hub | `lib/phase-manager.mjs` `syncToGstack`(gstack 체크포인트 수정), fullcycle 경로 폴백 | triflux 코어가 gstack 파일을 수정(단방향 규칙 위반). 소비자는 bridge pipeline-init 뒤 best-effort | gstack 체크포인트 phase 표시 | - |
| U11 | bin | `tfx auto` 미리보기 CLI + `hub/lib/tfx-route-args.mjs`, `staged-file-detect.mjs`, S29 risk-tier | 출력만 하는 미리보기. 스킬이 호출하지 않음(90일 0). 규칙 문서는 자동 승격을 구현된 것처럼 서술하나 코드는 도달 불가 | #281 회귀 가드 테스트 | 2차 권고: 네 파일과 `.omc/state/auto-escalation.log` 쓰기, README 2줄, 테스트 4파일 삭제. 규칙 문서의 "auto 가 자동 승격한다(MANDATORY)"는 "스킬이 판정한다"로 정정. 정책 자체(2+ 태스크와 코드 변경이면 격리 실행)는 U3 결정에 따른다 |
| U13 | bin | `tfx handoff`(+`scripts/lib/handoff.mjs`), `tfx codex-team`(+state-store 분기와 예약어), `tfx notion-read`(686, Codex·agy·claude 직접 실행, Notion 공식 `GET /v1/pages/{id}/markdown` 존재), `tfx monitor`(+`tui/monitor*.mjs`, darwin 에서 PowerShell 명령을 셸로 실행하는 결함), `tfx schema` 의 delegator 번들, `tfl` 별칭, `scripts/completions/*` 3개(설치 경로 없음, 서로 다름, `cto`·`stealth-fetch` 누락), `tfx-setup-tui`/`tfx-doctor-tui` 껍데기 | 사용자가 터미널에서 직접 치는 명령은 transcript 에 없다. 사용자에게 묻는 것이 빠르다 | 각 명령 | - |
| U14 | bin | `checkForUpdate`(`tfx`, `tfx help` 가 `npm view` 를 최대 5초 동기 대기, `!==` 비교라 개발 버전에서도 "사용 가능"), `checkHubRunning`(반환값 무시, "Codex(무료)" 낡은 문구, stdout 오염) | 업데이트 감지는 세션 시작 훅과 `tfx update` 소관(규칙 문서) | 도움말 한 줄 | 허브 결정과 함께 |
| U15 | scripts | `snapshot-codex-state.mjs`(하루 1회 `~/.codex` 압축, 전역 설치본 `references/codex-snapshots` 에 899M, 복원 코드 없음, npm 교체 때 사라질 가능성), `cache-warmup.mjs`·`cache-doctor.mjs`(산출물 4개 중 독자 1개, "builtin" 스킬 하드코딩), `sync-codex-auth.mjs`(소비자 0, broker 전용), `doctor-dynamic-routing.mjs`(U2), `notion-read.mjs`(U13), `release/publish.mjs` npm 단계(CI 중복, 비상 폴백), `release/prepare.mjs` 의 `.omx/plans` 경로 | 메모리 "스냅숏 3.5GB 결정 대기"와 같은 건 | 백업 의도 | 위치를 설치 디렉터리 밖으로 옮길지 |
| U16 | scripts/lib | `stealth-fetch.mjs`(176) + `tfx stealth-fetch` + optionalDependencies 2개 + setup 설치 단계 | 90일 Claude 실행 0, Codex 로그 0(패턴 한계 있음). `~/.cloakbrowser` 392MB 최종 수정 2026-06-23. 네이티브 WebFetch 는 안티봇 우회를 하지 않는다 | 안티봇 우회 fetch | - |
| U17 | scripts/lib | `remote-spawn-transfer.mjs`(226) | 소비자 0. 같은 스테이징 함수가 remote-spawn.mjs(제외)와 remote-session.mjs 에 또 있다(3벌) | 없음 | 2차: 호출자 0 이라 remote-spawn 을 바꾸지 않고도 지울 수 있다. remote-spawn 쪽 3중 구현 정리는 live-ops 뒤 |
| U18 | hub/team | `remote-watcher.mjs`(506) + `tui-remote-adapter.mjs`(377) | 어떤 경로에서도 인스턴스가 만들어지지 않음(docs/design/tui-dashboard-v8.md 의 통합이 미연결). notify 이벤트 3종의 유일한 생산자 | 원격 세션 감시 TUI(미연결) | 설계 의도 확인 |
| U19 | hub/team | `swarm-planner.mjs` `buildRemoteSuggestion`(결과 소비자 0, 삭제된 tfx-swarm 스킬이 소비자였음), `cto-pull.mjs`+`logCtoContext`(기본 꺼짐, 읽는 코드 0), `tui-viewer.mjs` 10분 강제 종료(개입 정책은 20분), `worktree-lifecycle` WT race-guard 2초 대기가 mac 에도 적용(샤드 n 개면 2n 초), conductor 가 세션마다 SIGINT 리스너 추가(11개 넘으면 경고) | 각각 결함 또는 미사용 | - | swarm 결함 수정 표("결정이 필요한 항목" 절)에 포함 |
| U20 | hub/team | `uds-orchestrator.mjs` `runUdsOrchestration` 3모드와 `tfx-live orchestrate`(90일 1건) | `askCodexAppServerThread` 등 `tfx-live ask`(94) 경로는 유지 | orchestrate 동사 | live-ops 세션 |
| U21 | experiments | `codex-app-server-dual-client-gating-probe.mjs`(1970, main 1660줄 단일 함수, 테스트는 npm test 글롭 밖, 옛 모델명), `*-report.md`(0.147 기준 "불가능" 판정의 근거 파일이 저장소에 없음), `claude-native-worker-adoption-probe.mjs`+테스트(실제 claude daemon 을 띄우는 유일한 카나리), `interactive-attach-live-probe.mjs`(수동 도구), `codex-app-server-uds-smoke.mjs`(문서 3곳이 인용하는 카나리, 유지) | experiments 디렉터리 보존 정책 | 카나리 2개 | - |
| U22 | docs, skills | S7, S8, S12, S13, S19, S20, S27, S35~S39, S41 | 위 표 참조 | - | - |

### K. 유지로 판정한 것 (의심하였다가 돌린 것, 다음 사람이 반복하지 않게)

| 대상 | 이유 |
|---|---|
| `scripts/lib/mcp-health.mjs` | knip 이 unused file 로 잡았지만 tfx-route.sh 가 경로로 실행한다(2802, 2826). 매 Codex 디스패치마다 돌고 `~/.codex/mcp-health-cache.json` 이 오늘 갱신되었다. 1차의 "파서를 `@iarna/toml` 로 교체" 제안은 U1 로 그 의존을 빼면 성립하지 않아 주석 정리만 남는다. 같은 줄에 있던 `dynamic-route-cli.mjs` 는 D1 로 옮겼다 |
| `tfx-route.sh --async/--job-*`(R16) | 리드 실측 90일 70회 실행 |
| `scripts/lib/codex-recovery.sh` | `--output-last-message` 가 비었을 때만 도는 복구. 0.160.1 stderr 샘플에 복구가 기대하는 표식이 그대로 있다 |
| `scripts/lib/machine-profile.mjs`, `agent-route-policy.mjs`, `codex-profile-config.mjs` sanitize, `mcp-filter.mjs`(gemini 출력 제외), `mcp-server-catalog.mjs`, `cli-claude.mjs`, `handoff.mjs`, `logger.mjs`, `env-probe.mjs` 의 CLI 프로브 | 소비자 확인됨. machine-profile 은 tfx-route.sh allowlist 와 키 9개 일치. agent-route-policy 는 agent-map.json 과 정확히 일치 |
| `hub/team/staleState.mjs` | `~/.claude/teams` 70개를 stale 로 판정하되 살아 있는 리드 세션 2개를 ps 토큰으로 걸러 냈다(읽기 전용 실행 확인). Claude Code 가 안 치우는 디렉터리를 정리 |
| `hub/team/health-probe.mjs`, `worker-sandbox.mjs`, `sentinel-capture.mjs`, `build-worker-prompt.mjs`, `worker-completion-validator.mjs`, `recovery-store.mjs` `preserveWorktreePatch`, `event-log.mjs`, `intervention.mjs`, `retry-state-machine.mjs`, `terminal-opener.mjs`, `wt-manager.mjs`, `shared.mjs`(소비자 17), `lead-control.mjs` `publishLeadControl` | 실행 엔진이 쓴다. retry-state-machine 의 기본 체인은 tfx-escalation-chain.md 와 일치하고 옛 모델명 잔재 0 |
| `hub/team/tui.mjs`, `tui-core.mjs`, `tui-widgets.mjs`, `tui-viewer.mjs`, `dashboard-open/layout/anchor.mjs` | headless 의 TTY 대시보드와 관전 pane 이 쓴다. 죽은 함수만 B27 |
| `hub/lib/uuidv7.mjs`, `ssh-retry.mjs`, `cache-guard.mjs`, `bash-path.mjs`, `env-detect.mjs`, `process-utils.mjs`, `spawn-trace.mjs`, `worker-lifecycle.mjs`, `timeout-defaults.mjs`, `prompt-tmp.mjs`, `codex-session-registry.mjs`, `tfx-route-args.mjs`·`staged-file-detect.mjs`(U11 결정 전까지) | 소비자 확인됨 |
| `hub/platform.mjs`(소비자 21), `codex-adapter.mjs`, `workers/claude-worker.mjs`(tfx-route.sh 의 비TTY 팀 claude 레인), `workers/lib/jsonrpc-*.mjs`(tfx-live 경로) | 소비자 확인됨 |
| `cto/lake-root.mjs`(소비자 9), `cto/collect.mjs` 의 git, tfx_swarm, ultragoal_omx, handoffs 수집원, `cto/status.mjs` 조회 핵심, `cto/brief.mjs` | 2026-09-24 "조회만" 결정의 대상 |
| `hud/providers/codex.mjs`, `codex-probe.mjs`(H13), `hud/cli-policy.mjs`, `colors/utils/terminal` 핵심 함수, `renderers.mjs` `renderAlignedRows`·`getClaudeRows` | 현재 쓰는 렌더러 |
| `scripts/lint-skills.mjs`, `test-lock.mjs`, `check-codex-config-stable.mjs`(허브 포트 점검만 넘김), `release/{check-sync,verify,prepare,resolve-auto-release}`, `wt-cli.mjs`, `mcp-cleanup.ps1`, `claude-login-detect.mjs`(gemini 줄 제외), `tmp-cleanup.mjs`(주석만 정정) | 실제 소비자가 있고 결함 없음 |
| `.github/workflows` 3개 | 죽은 job, 안 쓰는 secret 없음. 수정 사항은 B39 와 release.yml 의 엄격한 `npm ci`(ci.yml 과 다름), resolve-auto-release 의 dispatch 입력 미검증, ci.yml:44 단계 이름 |
| `skills/tfx-harness`, `adapters/codex/skills/tfx-harness`, `skills/tfx-live/SKILL.md`(live-ops), `tfx-wt/SKILL.md` 본문, `.claude/rules/tfx-escalation-chain.md`, `tfx-machine-profile.md`, `tfx-mirror-policy.md`, `tfx-doc-governance.md` | 코드와 일치 |
| `tests/fixtures` 21개, `tests/helpers/{bash-path,codex-config-fixture,sqlite}.mjs`, hub-auth-harness, hud 스냅샷(X15 에서 축소 검토), headless-118-timeout-partial, docs-adr-structure, packages-mirror, check-packages-mirror-core, release-*, test-lock* | 소비자 있음 |
| `experiments/native-bridge-feasibility/codex-app-server-uds-smoke.mjs` | 인증 없이 전송 계층을 점검하는 카나리. 문서 3곳 인용. 주석의 headless-guard 만 정정 |

## 넘길 항목 (제외 구역에서 발견)

이 절의 항목은 이 세션이 고치지 않는다. 담당 세션이 지울 때 같이 처리하라고 근거만 남긴다. 담당은 세 가지다: 인프라 축소 세션(hook, gateway, synapse, 허브, setup/doctor/update, 스킬 5개 삭제, mods), live-ops 세션(tfx-live, claude-daemon-control, bridge daemon 경로, remote-spawn), 그리고 "인프라 축소 세션 처리 예정"으로 그쪽이 먼저 알려 온 것.

### 설치본과 setup (인프라 축소 세션)

| 대상 | 발견 | 근거 |
|---|---|---|
| 전역 설치본 버전 | 이 맥의 전역 설치본은 v10.47.0(2026-09-30 da104316)이다. v10.49.0 은 설치되지 않았다. 그래서 2026-10-04 에 들어간 스킬 frontmatter `platform:` 게이트(70c21569)가 이 기기에서 돌지 않는다 | `npm ls -g triflux`, `~/.claude/scripts/.tfx-installed-from-commit`, 설치본 setup.mjs 에 `readSkillPlatforms` 없음 |
| 세션 시작마다 setup 재실행 | settings.json SessionStart 가 설치본 hook-orchestrator 를 부르고 그 fast-path 가 setup 을 돌려 스킬을 다시 동기화한다. 오늘 00:44 와 00:54 두 번 Windows 전용 `tfx-wt` 가 `~/.claude/skills/` 에 다시 깔렸고 tfx-setup, tfx-interview, tfx-doctor, tfx-review, tfx-auto 의 SKILL.md 도 다시 쓰였다 | `~/.claude/skills/tfx-wt/SKILL.md` mtime 00:54, 설치본 `skills/tfx-wt/SKILL.md` 에 `platform:` 필드 없음 인프라 세션 회신: 묶음 1 릴리스 뒤 전역 설치본 교체로 해소 예정. |
| 삭제된 스킬 사본 잔존 | `~/.claude/skills/` 에 ADR-0020 이 지운 tfx-analysis, tfx-find, tfx-forge, tfx-goal-clarify, tfx-hooks, tfx-hub, tfx-index, tfx-prune, tfx-qa, tfx-ralph 와 merge-worktree, star-prompt 가 2026-05-06 날짜로 남아 있다. 이 세션의 스킬 목록에도 보인다. setup.mjs 의 cleanupStaleSkills 가 DEPRECATED_SKILLS 를 유지 목록에 넣고(:866 주석 "넣지 않는다"), `tfx-` 접두사만 본다 | setup.mjs:957~990, Astra 비평이 같은 지적 인프라 세션 회신: ADR-0020 사본 10개는 검토 때 확인. |
| `scripts/tfx-gate-activate.mjs` | scripts/ 에 있지만 hook-registry 가 부르는 PreToolUse 훅 핸들러다. 감시 대상 스킬 7개 중 6개(tfx-multi, tfx-team, tfx-auto-codex, tfx-codex, tfx-gemini, tfx-autoresearch)가 삭제된 이름이고 만료 검사 블록은 비어 있다. hooks 삭제 범위에 포함해야 한다 | 파일 전체 읽음, setup.mjs:664, 1877~1907, 2654 인프라 세션 회신: 묶음 1 브랜치에서 이미 삭제됨. 확인만 남는다. |
| `scripts/claudemd-sync.mjs` `ensureGlobalClaudeRoutingSection` | 항상 `{action:"unchanged", skipped:true, reason:"global_sync_disabled"}` 만 반환하는데 setup.mjs 3곳, bin/triflux.mjs 3곳이 호출한다. `ensureTfxCrown` 은 호출자가 없다 | 파일 145~186 읽음 |
| `scripts/codex-profile-sanitize.mjs` | setup.mjs SYNC_MAP 에 없어 `~/.claude/scripts` 에 복사되지 않는다. 설치본 tfx-route.sh 는 "sanitizer 없음" 경고만 내고 정화하지 못한다 | findings-scripts-top #25 |
| `scripts/setup.mjs` LEGACY_CODEX_PROFILE_NAMES | gpt56 계열과 gpt6_sol 계열이 목록에 없어 `~/.codex/gpt56_*.config.toml`, `gpt6_sol_*.config.toml` 이 이 기기에 남아 있다 | findings-scripts-lib 넘길 항목 |
| `hub/memory-doctor.mjs` `checkPathsYamlBug`/`fixPathsYamlBug` | Claude Code 공식 memory 문서는 규칙 범위 필드를 `paths:` 로 정의한다. 이 점검은 `paths:` 를 버그로 보고 setup 이 `globs:` 로 고쳐 쓴다(setup.mjs:2299~2323). 방향이 거꾸로다. 이 저장소 `.claude/rules/tfx-psmux.md:2` 가 `globs:` 를 쓰고 있어 조건부 로드가 안 될 가능성이 높다 | https://code.claude.com/docs/en/memory , findings-hub-rest #26 |
| `hub/memory-doctor.mjs` 나머지 | `.omc/state` 의 7일 지난 json 을 `.tfx/archive` 로 옮긴다(다른 도구 상태를 옮김). 복구 명령 `tfx memory-doctor --undo` 는 존재하지 않는다 | findings-hub-rest #27 |
| 설치본 HUD 사본 | setup 이 `hud/**` 를 통째로 복사해 `~/.claude/hud/` 에 mission-board.mjs 등 옛 사본이 남는다 | setup.mjs:481, 635~640 |
| `tui/doctor.mjs`, `tui/setup.mjs`, `bin/tfx-doctor-tui.mjs`, `bin/tfx-setup-tui.mjs` | `tfx doctor --json`, `tfx setup --json` 을 자식 프로세스로 부르는 방향키 메뉴. setup.mjs 의 `stepGeminiProfiles` 가 폐기된 프로필 이름(pro31, flash3)을 필수로 검사해 영구 경고가 난다. setup 끝의 GitHub 별 요청 블록도 들어 있다 | findings-hud-cto-mesh-tui T2~T4 |
| `scripts/tfx-route.sh:238~260` sanitizer 호출, `:3392~3406` hub-ensure 무조건 호출 | 허브와 무관한 codex 실행에서도 매번 node 1회 | findings-route 넘길 항목 |

### hook, 키워드, gateway (인프라 축소 세션)

| 대상 | 발견 |
|---|---|
| `hooks/safety-guard.mjs:73` | 존재하지 않는 `psmux.mjs kill-swarm` 서브커맨드를 안내한다 |
| `hooks/hook-orchestrator.mjs:305~340` routing-weights.json | mode_bias 가 스킬 이름(harness, auto, ship, ...)으로 채워진다. `tfx-auto/SKILL.md:16~33` 이 이것을 모드 선호도로 읽는 Step 0 은 항상 auto 를 내고 의미가 없다(본 표 S3 에서 SKILL 쪽을 지운다. 기록 쪽은 이쪽) |
| `hooks/pre-compact-snapshot.mjs:87` | retry 상태 파일 이름을 `retry-<sessionId>.json` 으로 가정. tfx-auto/SKILL.md:225 는 `ralph-<sessionId>.json`. 코드는 파일 이름을 정하지 않는다 |
| `hooks/hook-adaptive-collector.mjs` | 입력 필드 `event.tool`, `event.exitCode` 를 읽는데 실제 페이로드는 `tool_name`, `error`. 항상 no-op. `hub/adaptive*.mjs` 4개와 `session-fingerprint.mjs`, `hub/lib/known-errors.json` 의 소비자가 이 훅과 `hub/server.mjs:1016~1060` 뿐이므로 허브 묶음에서 같이 지우면 된다. known-errors.json 의 규칙 두 개는 현행 규칙과 모순(bypass 플래그 강제, 제거된 `--full-auto` 언급) 인프라 세션 회신: adaptive 계열, session-fingerprint, known-errors 는 묶음 3 에서 처리. |
| `scripts/lib/keyword-rules.mjs:3` | `VALID_MCP_ROUTES` 에 `gemini` |
| `scripts/keyword-rules-expander.mjs`, `scripts/mcp-gateway-integration-test.mjs`, `scripts/hub-watchdog.mjs`, `scripts/cross-review-tracker.mjs`, `scripts/codex-gateway-preflight.mjs` | 소비자 0 또는 1(주석). 각각 키워드, gateway, 허브, hook 구역 |
| `scripts/run.cjs` | 소비자가 hook-registry.json:157 한 곳. `.tfx-pkg-root` 해석이 hooks/lib/resolve-root.mjs, hooks/hooks.json 과 3중 |
| `scripts/preflight-cache.mjs:321`, `scripts/cache-warmup.mjs:232~292` | 존재하지 않는 gemini 바이너리를 매 preflight 마다 프로브하고 `TFX_GEMINI_OK` 를 내보낸다. 읽는 코드는 없다(본 표 G 묶음과 연결) |
| `scripts/preflight-cache.mjs:95, 332~345` | `result.ok = hub.ok && route.ok` 라 허브 가용성에 묶여 있다 |
| `scripts/sync-hub-mcp-settings.mjs:13~17` | `.gemini/settings.json` 을 tfx-hub URL 동기화 대상에 둔다 |
| `config/mcp-registry.json` | tfx-hub 항목, brave-search gateway-http 포트, `targets` 의 옛 gemini CLI |
| hook 테스트 30개, 키워드 테스트 6개, gateway 테스트 5개와 인접 9개 | 전체 경로 목록은 findings-tests.md "넘길 항목" 절 |

### 허브, synapse, 메시지 버스 (인프라 축소 세션)

| 대상 | 발견 |
|---|---|
| `hub/bridge.mjs` 하위 명령별 허브 의존 | 허브를 쓰는 29개 중 실제 호출자가 있는 것은 `register --session-id`, `result`, `team-task-update`, `team-send-message`, `pipeline-init`(문서 한 줄) 다섯 개. 허브 없이 동작하는 로컬 전용 여섯 개(`daemon-*` 셋, `retry-*` 둘, `intervene-run`)는 분리하면 허브 클라이언트 코드 약 280줄 없이 독립 파일이 된다. 전체 표는 findings-hub-rest.md "추가 확인" 절 인프라 세션 회신: 허브 제거 설계 입력으로 쓴다. |
| `hub/bridge.mjs:1073`, `hub/pipeline/state.mjs`, `hooks/pipeline-stop.mjs:35`, `bin/triflux.mjs:6880` | 옛 DB 경로 `<PROJECT_ROOT>/.tfx/state/state.db` 를 폴백으로 본다. 허브는 `~/.claude/cache/tfx-hub/state.db` 로 옮겼다. 폴백은 거의 항상 `hub_db_not_found` |
| `hub/tools.mjs:723, 771, 820` | `pipeline_advance` 의 phase enum 에 `confidence`, `deslop`, `selfcheck` 가 없어 MCP 로는 `prd` 이후로 못 간다. `pipeline_advance_gated` 는 HITL 요청만 만들고 승인 뒤 전이가 없다 |
| `hub/tools.mjs:896`, `hub/pipe.mjs:365` send_input | `conductor.mjs:206` 의 `const publicApi = null` 을 register 에 넘겨 레지스트리가 항상 비어 있다. 실제 세션에는 항상 CONDUCTOR_SESSION_NOT_FOUND |
| `hub/assign-callbacks.mjs` | Named Pipe 소켓을 열지만 연결하는 클라이언트가 저장소에 없다 |
| `hub/state.mjs:19` | `hub-state.json` 읽기 폴백. 이 기기에 파일 없음 |
| `hub/server.mjs:1016~1060` | 허브 시작마다 adaptive startSession, promotePenalties, decayRules 실행 |
| `hub/store*.mjs`, `lib/memory-store.mjs`, `schema.sql` | `reflexion_entries` 테이블과 함수의 호출자가 테스트용 함수뿐 |
| `hub/team/headless.mjs:222~305, 1850~1879, 1955~2002` | `/bridge/*` 호출과 synapse 이중 등록(`headless-<세션>-<n>` 과 `<세션>-worker-<n>`) |
| `hub/team/cli/services/hub-client.mjs`, `start/index.mjs:106~126`, `commands/control.mjs`, `commands/status.mjs` | 허브 기동, task-list, lead-control 발행. `startHubDaemon` 이 `scripts/hub-ensure.mjs` 와 겹침 |
| `hub/team/nativeProxy.mjs`(759줄) | 허브 tool team_* 본체. `mcp__tfx-hub__*` 는 90일에 status 1건 |
| `hub/team/orchestrator.mjs:52~119` | 워커 프롬프트가 `node hub/bridge.mjs register/context/result` 상대 경로를 안내. repoRoot 를 넘기는 호출자 없음 |
| `hub/team/swarm-hypervisor.mjs:45~52, 1912~1962, 2044~2056` | hub-client 동적 import, 5분 keepalive 와 허브 재시작 |
| `hub/team/conductor.mjs:283~296, 1323, 44, 906~910` | 상태 전이마다 synapse register/heartbeat/unregister, check-mcp-hub 의 `/health` L2 |
| `hub/team/lead-control.mjs:104~130`, `session-sync.mjs:103~170, 257~310` | `/bridge/control`, `/bridge/context` 호출(session-sync 자체는 본 표 T 묶음에서 소비자 0 으로 삭제) |
| `hub/team/tui.mjs:1020~1031, 1473~1478, 1765~1775` | synapse 스트림 연결. `enableSynapse` 를 넘기는 호출자 0 |
| `hub/team/swarm-cli.mjs:385~390` | `swarm list` 가 synapse-cli 로 위임하는데 레지스트리 파일명이 서버와 달라 비어 보인다 |
| `hub/team/cto-auto-collect.mjs`, `hub/team/mcp-selector.mjs` MCP_CATALOG 의 tfx-hub 항목 | 허브 전용 |
| `hud/hud-qos-status.mjs:119~121`, `hud/constants.mjs:9~28`, `hud/providers/codex.mjs:436~450`, `codex-probe.mjs:59~100`, `hud/context-monitor.mjs:317~521` | 허브 계정 브로커 파일과 허브 요청 로거 결합 |
| `cto/status.mjs:187~217`, `cto/hygiene.mjs:92~125` | synapse-registry 동적 import. `.claude/rules/tfx-cto-hub-boundary.md:28~30` 의 "잔존 위반" 서술이 지금도 사실이다 |
| `cto/collect.mjs:41~55, 681~735`, `cto/current.schema.json` | `tfx_hub`, `tfx_synapse`, `tfx_team` 수집원이 schema required |
| `scripts/tfx-route.sh` 허브 연동 11곳 | 줄 번호 목록은 findings-route.md "넘길 항목" 절 |
| `scripts/check-codex-config-stable.mjs:37, 189~194` | tfx-hub URL 점검 |
| `scripts/lib/hub.mjs`, `env-probe.mjs:checkHub`, `scripts/hub-ensure.mjs` | 허브 재시작이 세 곳에 중복. `checkHub` 는 `curl -sf` 를 execSync 로 매번 띄운다 |
| `scripts/lib/context.mjs`, `logger.mjs` | 소비자가 허브와 hook 뿐 |
| `scripts/hub-ensure.mjs:49~66` | 허브 확인마다 codex, gemini 스냅샷 프로세스 두 개를 분리 실행. 산출물이 전역 설치 디렉터리 `references/*-snapshots` 에 899M, 325M 쌓임(본 표 사용자 결정 U 에도 있음) |
| `hub/workers/codex-mcp.mjs` 와 `delegator-mcp.mjs` | `codex mcp-server` 가 0.154 에서 제거돼 Codex 직접 경로가 실패한다. `triflux-delegator` MCP 등록 설정이 어디에도 없다. 허브 서버와 함께 정리 |
| 허브 MCP 동기화(`syncProjectMcpJson` 계열) | claude 를 띄운 임의 cwd 에 `.mcp.json`, `.claude/mcp.json`, `.triflux/subagents/subagents.json` 을 만들고 `.mcp.json` 에 exa/tavily 키가 평문으로 들어간다. 인프라 축소 세션 처리 예정 |
| 허브 테스트 약 45개 | 경로 목록은 findings-tests.md "넘길 항목" 절 |

### tfx-live, claude-daemon-control, bridge daemon 경로, remote-spawn (live-ops 세션)

| 대상 | 발견 |
|---|---|
| `bin/tfx-live.mjs:643~677, 496~552` list-sessions | pane 마다 `ps -ax` 를 새로 실행한다. tmux pane 24개에서 5.6~6.6초, ps 25회. claude 쪽은 0.075초에 1회. 한 번만 실행해 공유하면 된다(효과 가장 큼, 독립적) |
| `bin/tfx-live.mjs:1611~1638` | `TFX_SKIP_HOOKS=1` 을 설정하지만 읽는 코드가 없다. 훅은 `TRIFLUX_SKIP_HOOKS` 를 읽는다. 테스트 5곳이 이 문자열을 기대 |
| `bin/tfx-live.mjs:3727~3764` cto-hygiene-notify | 호출자가 테스트 2개뿐. 이것 때문에 tfx-live 가 `cto/hygiene.mjs`, `cto/hygiene-notify.mjs`, `hub/team/notify.mjs` 를 시작 때마다 import 한다. 지우면 tfx-live 의 cto 의존이 사라진다(본 표 C 묶음의 선행 조건) |
| `bin/tfx-live.mjs:1774~1789, 1813~1817, 1861~1863, 2234~2238, 2589~2593` | `TFX_REPO_ROOT` 는 설정하는 코드가 없고 "no bridge path resolved" 가드 4곳은 도달 불가(번들 경로를 항상 반환) |
| `bin/tfx-live.mjs:2297~2313` | 옛 bridge 바이너리 호환 분기. 번들 bridge 는 항상 target 을 반환 |
| `bin/tfx-live.mjs:2914~2993` converse, goal-driven, `:3671~3721` orchestrate, `:2995~3015` peer 기본 모드 counting | 사용 흔적 0~1, 문서 예시 없음. 처분은 live-ops 판단 |
| `hub/team/claude-daemon-control.mjs` | control.sock 프로토콜 역공학과 `~/.claude/sessions` 가짜 세션 기록. 이 기기 2.1.292 에 `claude --bg` 와 `claude agents --json --all` 은 있고 `--exec` 는 없다. 공식 agent-view 문서와 대조해 대체 범위를 정해야 한다. `terminalCellWidth` 가 ansi.mjs `charWidth` 와 중복 |
| `hub/team/claude-session-projection.mjs`, `claude-agent-session-normalizer.mjs` | `~/.claude/sessions/<pid>.json` 에 `kind:"bg"` 가짜 기록. daemon 이 행을 직접 만들면 불필요 |
| `hub/team/uds-orchestrator.mjs:405~519, 662~757` | `tfx-live orchestrate` 한 곳만 부름. `askCodexAppServerThread` 등은 `tfx-live ask` 94건이 쓰므로 유지 |
| `scripts/remote-spawn.mjs:769` | `remoteHome` 이 null 이면 TypeError. 호출부(1689, 1694)가 await 하지 않아 unhandled rejection |
| `scripts/remote-spawn.mjs:556` | `startsWith(projectRoot)` 가 구분자 없이 접두사만 봐서 `/work/proj-secret/x` 가 통과 |
| `scripts/remote-spawn.mjs:1849~1851, 1885~1886, 1924` | JSDoc 6줄이 `\uXXXX` 이스케이프 문자열 그대로. `:1237` `_wtArgs` 미사용 |
| `scripts/remote-spawn.mjs` 와 `hub/team/remote-session.mjs`, `scripts/lib/remote-spawn-transfer.mjs` | 같은 스테이징 함수가 세 벌. remote-session 의 export 7개 중 5개 소비자 0 |
| `hub/team/intervention.mjs:458~483` | resumeHandler 확인이 프로세스 실행 뒤에 있어 `hub/bridge.mjs` intervene-run 경로는 매번 `codex exec resume --help` 를 띄운 뒤 `no_resume_handler` 로 끝난다 |
| `skills/tfx-live/SKILL.md` | description 이 영어(tfx-skill-authoring §1), 전역 CLAUDE.local.md 가 가리키는 "리드 운영 절" 이 이 브랜치에 없음 |
| `tests/unit/tfx-live-cli.test.mjs`(2993줄) | 위 항목 정리 시 함께 수정 |

### 스킬 5개 삭제 (인프라 축소 세션)

| 대상 | 발견 |
|---|---|
| `skills/tfx-plan/SKILL.md:12` | 모델명 "Opus 4.6" 하드코딩. lint-skills 가 이 형태를 못 잡는다 |
| `skills/tfx-setup/SKILL.md:26, 174~226` | "gpt55 profile policy", `approval_mode`, `--full-auto` 안내 |
| `skills/tfx-profile/SKILL.md:248~249` | `tui/codex-profile.mjs`, `tui/gemini-profile.mjs` 안내(본 표 T 묶음에서 두 파일 삭제) |
| `skills/merge-worktree/SKILL.md:130` | 존재하지 않는 tfx-swarm 스킬이 자동 호출한다고 적음 |
| `README.md:83`, `README.ko.md:82`, `README.md:133, 136` | merge-worktree, star-prompt 번들 안내, `tfx synapse`, `tfx hooks` 행 |
| `bin/triflux.mjs:108~109, 2509~2576` | `STAR_PROMPT_VERSIONS` 와 cmdSetup 의 GitHub 별 요청 블록 |
| `skills/*/skill.json` 5개 | 본 표 S1 의 15개 중 삭제 예정 스킬 5개분 |
| 테스트 | deep-interview.test.mjs, skill-drift.test.mjs:64, 258~312, skill-surface.test.mjs:70~118, lane2-d-routing-contract.test.mjs:186, 238, keyword-routing-verbs.test.mjs:83, 117, 234, psmux-routing.test.mjs:386~388 |

### mods 도입 (인프라 축소 세션)

| 대상 | 발견 |
|---|---|
| `hud/providers/claude.mjs` 사용량 API 경로 | 공식 문서에서 확인되지 않은 `api.anthropic.com/api/oauth/usage` 를 직접 부르고, 성공 시 5초 기준 폴링, 매 갱신마다 Keychain 읽기, 토큰 만료 시 되쓰기. statusLine stdin 의 `rate_limits` 는 읽지 않는다. ADR-0023 이 Claude 행을 mods 로 옮기기로 했으므로 그쪽 결정. 소비자 `scripts/claude-login-detect.mjs:23~27`, `hub/routing-snapshot.mjs:17` 과 테스트 5개가 순서 제약 |
| `scripts/token-snapshot.mjs`, `hub/pipeline/index.mjs:265~330` | 호출자 0, HUD 가 읽는 diffs 디렉터리 비어 있음. mods 토큰 기록과 무관하게 지금 죽어 있어 본 표 H 묶음에서 삭제 |
| `.claude/agents/slim-wrapper.md` | 서브에이전트 정책을 mods 로 강제하면 쓸모가 더 줄어든다. 본 표 T 묶음에서 native.mjs 와 함께 처리하되 mods 결정과 충돌하지 않는다 |
| HUD 테스트 | hud-qos-status 스냅샷 7개, hud-claude-credentials(1068줄) 등 목록은 findings-tests.md |

### 그 밖에 알려 둘 것

| 대상 | 발견 |
|---|---|
| `~/.omc/state/cx-auto-tokens/savings-total.json` 등 | `tests/unit/token-benchmark.test.mjs`, `tests/unit/account-broker.test.mjs` 추정, `tests/integration/nativeProxy.test.mjs:26`, `hub-server.test.mjs:31`, `tests/unit/native-wrapper.test.mjs:157` 이 실제 홈에 쓴다(본 표 X 묶음) |
| ADR-0023 | 이 브랜치에 없다(인프라 세션 worktree 에만 있음). 보고서가 인용하는 번호 |

### 2차 판정과 교차 검증에서 새로 나온 것

| 담당 | 대상 | 내용 |
|---|---|---|
| 인프라 | infra 브랜치 `tfx-route.sh` 1564 부근 | route 진입마다 `preflight-cache.mjs --if-stale` node 프로세스를 하나 더 띄운다. R11 의 "한 실행에 node 10회"에 1회가 더해진다. 캐시가 신선하면 바로 끝나지만 기동 비용(약 0.07초)은 남는다 |
| 인프라 | `scripts/claude-login-detect.mjs` | 묶음 1 머지 뒤 호출자가 없다(테스트만). 같이 지울 후보 |
| 인프라(setup) | `~/.claude/agents/slim-wrapper.md` | setup.mjs:2420 이 배포한 설치본 사본. R17 로 저장소에서 지워도 설치본은 setup 이 지워야 한다 |
| 인프라(setup) | `scripts/setup.mjs:654` SYNC_MAP | A7(`tfx-batch-stats.mjs`) 삭제 시 이 줄도 같이. agy 교차 검증이 지적 |
| 인프라(묶음 3) | `tfx why` 파서 측, `cto/hygiene.mjs` 나머지, `hub/workers/delegator-mcp.mjs` 의 codex-mcp import, 허브·delegator 의 `gemini` enum | synapse-cli, 허브, delegator 를 지울 때 B12(h), A41, A44, G2 의 해당 부분을 같이 처리 |
| live-ops | `bin/tfx-live.mjs:16~17` cto import, `cto-hygiene-notify` 하위 명령(3725~3765, 3794), 도움말 81, `tests/unit/tfx-live-cli.test.mjs:2385` | C1 의 선행 조건. live-ops PR 이 지우고 main 머지를 `git log origin/main -- bin/tfx-live.mjs` 로 확인한 뒤에만 slop 이 `hygiene-notify.mjs` 를 지운다. 그 전에 지우면 tfx-live 가 시작하지 못한다 |
| live-ops | `hub/team/claude-daemon-control.mjs` | 비공식 control.sock 프로토콜 직접 구현(17~516, 1383~1772). 공식 `claude --bg`, `claude agents --json` 으로 대체 검토. 리드 확인: 2.1.292 `claude --help` 에 `--bg` 와 `claude agents --json --all` 은 있고 `--exec` 는 없다. 1차가 근거로 든 "`claude --bg --exec` 로 셸 명령을 agent view 행으로 띄운다"는 이 빌드에서 성립하지 않는다. TUI 화면 정규식 해석(531~1284)은 UI 변경에 취약. 제출 payload 의 `/bin/zsh`, `/tmp` 하드코딩(39~62, 1404~1407)은 zsh 없는 Linux 와 Windows 에서 실패 가능. `terminalCellWidth` 는 `ansi.mjs` `charWidth` 복사본(541~594) |
| live-ops | `scripts/remote-spawn.mjs` 추가 지적 | POSIX 호스트에서 틀어지는 `$env:USERPROFILE` 홈 감지(703~709), cwd 상대 캐시 경로(50), 원격 스테이징 디렉터리 미정리, `parseArgs` 161줄, 미대기 async(1504). `scripts/lib/remote-spawn-transfer.mjs` 자체는 호출자 0 이라 remote-spawn 을 바꾸지 않고도 지울 수 있다(U17) |
| live-ops | `uds-orchestrator.mjs` `runUdsOrchestration` 3모드, `experiments/.../claude-codex-uds-orchestration-smoke.mjs` | `tfx-live orchestrate`(90일 1건)만 쓴다(U20, A50) |

## 결정이 필요한 항목

아래 결정이 PR 묶음의 범위를 정한다. 권고는 2차 판정과 리드 확인을 합친 것이다.

| 번호 | 질문 | 권고 | 근거 요약 | 영향 행 |
|---|---|---|---|---|
| 결정 1 | swarm 실행 엔진을 존치하는가 | 결정 유보 없이 둘 중 하나. 리드 의견은 "존치하되 결함 수정"보다 "퇴역"에 가깝다. 7-17 이후 실행 0, 규칙 문서만 기본 경로로 지정 | 7월 17일 이후 실행 0회(디스크 흔적 3개 저장소, Claude 90일 0회). 데이터 손실 사고(07-16) 뒤로 쓰지 않았다. 네이티브 대체는 부분적(`isolation: worktree` 와 Agent 병렬은 있으나 PRD 샤드 분배, lease, 자동 통합은 없음). 존치면 아래 결함 12개 수정 | U3, U19, A18, A22~A24, D1, 규칙 문서 |
| 결정 2 | Node 단일 진입점 레인을 삭제하는가 | 삭제 | `TFX_ROUTE_NODE=1` 을 설정하는 곳이 없다. 켜도 계획 출력 뒤 bash 재실행뿐이고 그 전에 실제 `~/.codex/config.toml` 을 무효값 `full-auto` 로 패치한다. 계획서는 bash 2,609줄 기준인데 지금 3,862줄, 5월 22일 이후 기능 커밋 없음 | U1, R3, X11, A3 일부 |
| 결정 3 | `tfx multi` 의 in-process 모드와 WT 팀 모드를 삭제하는가 | 삭제(멀티플렉서 없을 때는 설치 안내 오류로) | in-process: codex 멤버 명령이 프롬프트 없는 `codex exec` 라 stdin 을 기다리는데 supervisor 는 stdin 을 닫지 않는다(실행 확인은 안 함). WT: `stop`, `kill` 이 pane 을 하나도 닫지 않고 성공 메시지만 내며 새 탭을 만든다(규칙 8 위반) | U4(M2), R17 의 `verifySlimWrapperRouteExecution` |
| 결정 4 | `tfx auto` 미리보기 CLI 를 지우고 규칙 문서를 "스킬이 판정한다"로 고치는가 | 삭제와 문서 정정 | `countTasks` 가 1 이하라 `auto-escalate-code-change` 분기에 닿을 수 없다. 실행 0회. 실제 판정은 tfx-auto 스킬(90일 217회)이 글로 한다 | U11, S29, 규칙 문서 2개 |
| 결정 5 | HUD agy 쿼터 행을 지우는가 | agy 1.3.1 에 headless 로 쿼터를 얻는 공식 표면이 없으면 삭제 | 지금 데이터를 못 가져온다(`errorType:auth`, 토큰으로 `cloudcode-pa.googleapis.com` 호출 거부). 행은 늘 `8h --%` | H9 |
| 결정 6 | HUD 팀 행을 고치는가 지우는가 | 고친다(파일 이름 한 줄) | 고정 경로 `team-state.json` 을 읽는데 쓰기는 `team-state-<sessionId>.json` 으로만 한다. `tfx multi` 가 90일 53회 쓰였으므로 의도된 행이라면 한 번도 안 보인 결함 | H3 |

그 밖의 사용자 결정 행(U5, U6, U8~U10, U13~U16, U18, U20~U22, P3, P4, P6, F6, F8, S7 등)은 U 절과 각 표에 근거를 두었다. 묶어서 답해도 된다.

### 결정 1 보조 자료: swarm 존치 시 수정할 결함

| 결함 | 위치 | 확인 | 수정 방향 |
|---|---|---|---|
| changedFiles 가 항상 자기 lease 의 부분집합이라 lease 위반을 못 잡음 | `swarm-hypervisor.mjs:1790~1847` | 2차 판정자 읽음 | `git diff --name-only <통합>..<샤드>` 로 교체 |
| 원격 샤드 fetch 뒤 `remote remove` 가 추적 참조를 지워 로컬 브랜치가 없음. 이어지는 커밋 증거 수집이 실패 | `worktree-lifecycle.mjs:610~640`, `swarm-hypervisor.mjs:1418~1470` | 2차 판정자 읽음 | `git fetch <remote> <branch>:<branch>` 로 로컬 참조를 만든다 |
| 원격 세션 종료가 존재하지 않는 psmux 세션을 지우고 로컬 ssh 자식은 남김. 호스트 정보를 폐기된 `references/hosts.json` 에서 읽음 | `conductor.mjs:325~373` | 2차 판정자 읽음 | ssh 자식 종료와 `hosts-compat` 사용 |
| STALLED, INPUT_WAIT 에서 COMPLETED 전이가 없어 exit 0 이 무시되고 상태가 stalled 로 남음 | `conductor.mjs:79~94, 253~263` | 2차 판정자 읽음 | 전이 두 줄 추가 |
| tierFallback 구독이 `opts.broker` 를 넘길 때만 걸리는데 hypervisor 는 넘기지 않음 | `conductor.mjs:1447~1483`, `swarm-hypervisor.mjs:799~806` | 2차 판정자 읽음 | `getActiveBroker()` 로 구독 |
| conductor-registry 에 `publicApi = null` 을 넣어 레지스트리가 늘 빔 | `conductor.mjs:206, 1323` | 리드 읽음 | 허브 `send_input` 도구와 같이 정리(허브 제거 시 레지스트리 자체 삭제) |
| phase 기록 runId 가 상태마다 새로 생기고 gstack 체크포인트를 고침 | `swarm-hypervisor.mjs:292~328` | 1차 | 호출 삭제 |
| 원격 샤드가 에이전트와 무관하게 codex 로 실행되고 gemini 는 옛 CLI | `conductor.mjs:931~956` | 리드 읽음(955) | 에이전트별 분기 수정 |
| F2 폴백이 횟수 제한 없이 반복 | `swarm-hypervisor.mjs:1238~1254` | 1차 | 시도 횟수 표시 |
| `--max-restarts 0` 이 2로 바뀜 | `swarm-cli.mjs:97` | 리드 읽음 | `??` 사용 |
| WT 용 2초 대기가 모든 플랫폼에 적용 | `worktree-lifecycle.mjs:20, 254, 483, 487` | 리드 읽음(18~26, 510~545) | win32 한정 |
| conductor 마다 SIGINT, SIGTERM 리스너 추가 | `conductor.mjs:1489~1490` | 2차 판정자 읽음 | 한 번만 등록 |

### 결정 1 보조 자료: swarm 퇴역 시 같이 사라지는 것

- `hub/team/`: swarm-cli, swarm-hypervisor, swarm-planner, swarm-preflight, swarm-locks, swarm-reconciler(A18), swarm-intent(synapse `tfx why` 삭제 뒤), worktree-lifecycle, conductor, conductor-registry(허브 도구와 같이), conductor-mesh-bridge(A23), recovery-store, event-log, launcher-template, execution-mode, health-probe, check-mcp-hub, cto-pull, mcp-selector, worker-completion-validator, build-worker-prompt, extract-completion-payload, sentinel-capture, `schemas/worker-completion.json`, wt-templates.json(A20), remote-probe(A19), remote-watcher 와 tui-remote-adapter(U18)
- `claude-native-bridge.mjs` 의 `registerSwarmShard` 와 `interactive-tui-transport.mjs`(A12)
- `hub/lib/ssh-command.mjs`(소비자가 swarm 둘과 remote-watcher 뿐)
- `worker-sandbox.mjs` 는 in-process(결정 3)와 delegator(허브)도 같이 사라질 때만
- D1 동적 라우팅, A24 mesh 전체
- `bin/triflux.mjs` 의 swarm 분기, `pack.mjs` 의 remote 배럴 재수출, `cto/collect.mjs` 의 tfx_swarm 수집원
- 규칙과 문서: `tfx-execution-skill-map.md`, `tfx-routing.md` D10 과 ladder 표, `tfx-stack-coexistence.md` 의 Worktree owner, `CLAUDE.md` 원격 실행 표, `skills/tfx-auto/SKILL.md` 의 swarm 절
- 규모: 소스 약 8,577줄, `tests/unit` 의 swarm, conductor, worktree 테스트 20개 파일 약 7,030줄
- 남는 것: `remote-session.mjs`, `ssh-retry.mjs`(tfx-live 가 씀), `retry-state-machine.mjs`, `intervention.mjs`(bridge, headless 가 씀)

### 결정 2 보조 자료: Node 레인 삭제 범위

| 파일 | 처분 | 이유 |
|---|---|---|
| `scripts/tfx-route.mjs`, `scripts/lib/async.mjs`, `env.mjs`, `tmp.mjs`, `toml.mjs`, `cli-agy.mjs`, `cli-gemini.mjs`(A1) | 삭제 | 소비자가 tfx-route.mjs 와 테스트뿐(리드 메모의 "env.mjs, tmp.mjs 에 다른 소비자 있음"은 틀렸다. `rg -F` 로 재확인) |
| `agent-json.mjs`, `hub.mjs`, `pid.mjs`, `quota.mjs`, `team.mjs`, `timeout.mjs`(A3) | 삭제 | 비테스트 소비자 0 |
| `cli-codex.mjs` | 삭제 | `plan()` 은 tfx-route.mjs 만 쓴다. 재수출 `resolveNestedCodexAgentProfile` 를 쓰는 `headless.mjs:23`, `conductor.mjs:22`, `execution-mode.mjs:5` 의 import 를 `agent-route-policy.mjs` 로 바꾼 뒤 지운다 |
| `cli-claude.mjs` | 남김 | `tfx-route.sh:3369` 가 팀 모드 Claude 모델 조회에 쓴다 |
| 의존 `@iarna/toml`, `tree-kill` | package.json 에서 삭제 | 각각 toml.mjs, pid.mjs 만 쓴다 |
| 테스트 `tfx-route-node-entry`(449줄), `tfx-route-bash-node-parity`(223줄), `tfx-route-phase1-modules`(268줄)(X11) | 삭제 | 대상과 같이 |
| `.triflux/plans/node-cli-single-entry-migration.md` | `docs/_archive/` 로 옮기고 첫 줄에 폐기 표시 | 문서 거버넌스 규칙 |
| `tfx-route.sh:30~36` | 삭제 | 진입 분기. 인프라 묶음 1 과 같은 파일이라 그 머지 뒤 |

## 결정 기록 (2026-10-08 사용자 승인)

| 번호 | 결정 | 처리 |
|---|---|---|
| 결정 1 | swarm 퇴역. 정리가 끝나면 네이티브 worktree 격리(Claude `isolation: worktree`)와 tfx-route.sh 위에 얇게 다시 짠다 | S-SWARM-R 한 PR 로 지운다. 재설계는 별도 PRD 로 시작하고 이 문서의 범위 밖이다 |
| 결정 2 | Node 레인 삭제 | S-NODE |
| 결정 3 | in-process 와 WT 팀 모드 삭제 | S5 에 M2 를 합친다 |
| 결정 4 | `tfx auto` 미리보기 삭제와 규칙 문서 정정 | S3 에 넣는다 |
| 결정 5 | HUD agy 쿼터 행: agy 의 공식 headless 사용량 표면이 있으면 그걸로 다시 짜고, 없으면 삭제 | S1 에서 확인 뒤 처리 |
| 결정 6 | HUD 팀 행 수정 | S1 |

같은 날 main 에 들어온 것: INFRA1(#588), mods(#587), HUD 수정(#589), multi assign 수정(#586). 그래서 3단계 묶음(S-G1, S-NODE, S-ROUTE, S-G2)은 바로 진행할 수 있고, S1 은 #587 과 #589 위에서 다시 잰다. LIVE(#590)는 아직 열려 있어 C1 은 대기한다. 항목표의 줄 번호는 1a3d57b9 기준이라 구현 때는 심볼로 다시 찾는다.

## 2단계 결과 기록 (2026-10-08)

승인받은 묶음을 PR 하나씩 머지하였다. 구현은 Codex executor(gpt61_sol_high), 리뷰는 Claude(opus)가 하였고, 리뷰가 지적한 것은 Codex 후속 수정이나 리드가 직접 고친 뒤 머지하였다. 변경 영역 테스트와 미러 검사, lint 를 PR 마다 돌렸고 tfx-route.sh 를 실행하는 통합 테스트는 HOME 과 CODEX_HOME 을 임시 디렉터리로 두고 리드가 따로 돌렸다.

| PR | 묶음 | 파일 | 추가 | 삭제 | 상태 |
|---|---|---|---|---|---|
| #593 | 1단계 보고서 | 1 | 784 | 0 | 머지 |
| #601 | S4 psmux Windows 전용, psmux.mjs 죽은 CLI | 20 | 273 | 1,866 | 머지 |
| #602 | S6 scripts 죽은 파일, Node 레인(결정 2) | 176 | 430 | 14,354 | 머지 |
| #603 | S7 hub 죽은 모듈 20개 | 116 | 35 | 16,437 | 머지 |
| #604 | S2 CTO 조회만(ADR-0024), hygiene-notify | 62 | 1,126 | 8,181 | 머지 |
| #605 | S1 HUD(결정 5, 6) | 63 | 572 | 8,043 | 머지 |
| #607 | S-G1 Gemini CLI 실행 경로 | 48 | 245 | 2,398 | 머지 |
| #609 | S8-A 복제본·소스 문구 테스트 15개 | 21 | 27 | 1,986 | 머지 |
| #610 | S-SWARM-R swarm 퇴역(ADR-0025, 결정 1), 동적 라우팅, mesh | 274 | 372 | 52,511 | 머지 |
| #611 | S3 tfx auto·review 삭제(결정 4), 작은 모듈 | 126 | 430 | 8,165 | 머지 |
| #612 | S-ROUTE tfx-route.sh 정리, gemini 별칭 | 59 | 1,412 | 2,931 | 머지 |
| #613 | S5 tfx multi 죽은 모드, in-process·WT(결정 3) | 175 | 1,522 | 19,830 | 머지 |
| #614 | S-DOCS 스킬·규칙·루트 문서, 끝난 계획 문서 | 60 | 1,180 | 5,416 | 머지 |

수치는 packages 미러 3곳을 포함한다. root 기준 실제 삭제는 그 3분의 1 안팎이다. tfx-route.sh 는 3,862줄에서 2,958줄로, tfx-auto SKILL.md 는 1,096줄에서 483줄로 줄었다. 다른 세션이 같은 날 머지한 것: 인프라 묶음 1(#588), setup 후속(#600), tfx-live(#590, #596), 느린 가드 6개 속도(#597), v10.50.0~v10.50.2 릴리스.

### 리뷰가 되돌리거나 고친 것

- Codex 가 packages/core 와 packages/triflux 의 package.json 을 root 것으로 덮어썼다(#610). 미러 검사와 버전 검사는 못 잡았다. main 판으로 되돌리고 mesh 항목만 뺐다.
- 살아 있는 경로를 검사하던 테스트를 지운 것(#611 의 mcp-filter 18건), 보관 기준(ADR-0012)에 못 미치는 문서를 docs/_archive 로 옮긴 것(#603 4건, #605 4건, #613 4건), accepted ADR 본문을 사후 수정한 것(#612, S-DOCS)을 되돌렸다.
- 회귀 2건을 머지 전에 잡았다. mcp-filter 가 인벤토리 JSON 파싱 오류를 던지게 바뀌어 모든 레인이 멈출 수 있던 것과 `agy --help` 캐시 변수가 초기화 전에 읽히던 것(#612).
- 지시 밖 동작 추가(TFX_CLI_MODE 검증, 퇴역 옵션 exit 코드)와 호출 경로가 깨진 문서 안내(tfx-review 의 상대 경로)를 되돌렸다.

### 사고 기록

- worktree 에서 `node --test` 의 파일 목록이 비어 전체 스위트가 세 번 돌았다(02:50, 04:21, 05:00 무렵). 실행 중인 허브가 worktree 경로로 재바인딩되었고 한 번은 Codex 설정의 MCP 항목이 지워져 인프라 세션이 백업에서 복구하였다. 원인은 zsh 에서 글롭 하나가 안 맞으면 `$(ls a b*)` 전체가 비는 것. 이후 `find` 결과만 쓰고 비어 있으면 실행하지 않게 하였고, 허브는 `tfx hub stop` 과 `ensure` 로 되돌렸다.
- Codex executor 안에서 tfx-route.sh 를 실행하는 테스트를 돌리면 바깥 executor 의 config swap 과 겹쳐 실제 설정이 깨질 수 있다. 지시서에 금지를 넣었다.
- 보관 디렉터리 관례는 `docs/_archive/triflux/plans/` 다. Codex 가 `docs/_archive/plans/`, `docs/_archive/.triflux/plans/` 를 만들어 매번 옮겼다.

### 남은 것

- 사용자 결정으로 남긴 항목: U5 codex-app-server-worker, U6 account-broker, U8 memory-doctor, U9 ssh 안전 게이트, U10 phase-manager 의 gstack 수정, U13 bin 하위 명령 묶음(handoff, codex-team, notion-read, monitor, tfl, completions, *-tui 껍데기), U14 checkForUpdate, U15 스냅샷과 cache-warmup, U16 stealth-fetch, U18 remote-watcher(swarm 퇴역으로 삭제됨), U20 uds orchestrate, U21 experiments 보존 정책, P3·P4·P6 packages, F6 .geminiignore, F8 tfl, S7·S12·S13·S19·S20·S27·S35~S39·S41 문서, H11, X12·X13·X16·X17, B20·B21, C6, R14·R15.
- 인프라 세션 묶음 3(허브·synapse 제거) 뒤에 처리할 것: adaptive 계열, hygiene 나머지와 status 의 hygiene 필드, `tfx why` 파서 측과 bin 분기, codex-mcp.mjs 와 delegator 의존, 허브·delegator 의 gemini enum, snapshot-gemini-state 와 hub-ensure 호출, `~/.gemini/settings.json` 동기화.
- swarm 재설계: 네이티브 worktree 격리(Claude `isolation: worktree`)와 tfx-route.sh 위에 PRD 샤드 분배, 파일 lease, 검증 뒤 통합만 얇게 다시 짠다. 별도 PRD 로 시작한다.
- CI 의 `hub-start-codex-config.test.mjs` "hub already running" 케이스가 간헐적으로 깨진다(허브 구역). 다른 허브 테스트와의 포트 경쟁으로 보인다.

## 제안하는 PR 묶음과 순서

다른 세션의 PR 은 대문자로 적는다. INFRA1 은 인프라 묶음 1(훅, 키워드, 스킬 5개, 설치 이주, 이미 브랜치에 있음), INFRA3 은 허브와 synapse 제거, LIVE 는 live-ops 의 tfx-live PR 이다. 묶음마다 PR 하나, 머지는 사용자가 한다. 모듈을 지우는 PR 은 그 모듈의 테스트와 packages 미러 사본을 같은 PR 에서 지운다. 구현은 Codex executor, 리뷰는 작성 모델과 다른 모델이 한다.

### 1단계: 지금 바로 낼 수 있는 것 (다른 세션과 파일이 겹치지 않음)

| 묶음 | 이름 | 포함 행 | 비고 |
|---|---|---|---|
| S1 | HUD 정리 | H1, H2, H4~H8, H10, H12, G8, X14, X15 의 HUD 부분 | mods HUD 작업보다 먼저. H3, H9 는 결정 5, 6 뒤 |
| S2 | CTO 조회 축소 1단계 | A42~A46, C2, C4, C5, C3 의 `appendLedgerEvent` 교체 | `cto-pull` 은 결정 1 이 존치일 때만 여기서. north star 주입은 S9 로 |
| S3 | 작은 죽은 모듈 | A17, R17+X9(slim-wrapper 와 native.mjs 12 export), D2(tfx review, README 교체), B12(h) 의 swarm-intent 생성 측, B38, A52, A53, F1~F4, S31 의 해당 줄 | 설치본 `~/.claude/agents/slim-wrapper.md` 삭제는 setup 에 넘김 |
| S4 | psmux 를 Windows 전용으로 | B37, B44, B43(결함 수정), session.mjs 의 비win32 `psmux -V` 탐색, 세 호출처를 tmux 설치 안내로, `psmux-info.test.mjs` 2건 교체 | Linux 는 지금처럼 tmux |
| S5 | tfx multi 죽은 모드 제거(M1) | B1~B4, B6, B7, B19, A11, A12, U4 의 즉시 제거 분, `KNOWN_ROLES` 를 agent-map 읽기로 | 결정 1 이 퇴역이면 `registerSwarmShard` 도 여기서 |
| S6 | scripts 와 scripts/lib 죽은 파일 | A1~A10, A47(bin 포함), P2, X5, X8 | A7 의 SYNC_MAP 한 줄과 A47 의 스킬 삭제는 인프라 세션과 같은 시점에 |
| S7 | hub 죽은 모듈 | A25~A37, A39, A48(T2 뒤), X10 해당분 | A41 codex-mcp 는 INFRA3 과 함께 |
| S8 | 테스트 정리 | X1~X4, X6, X7, X12, X13, X16, X17 과 B45 | 모듈 PR 에 딸린 테스트는 제외 |

### 2단계: 결정 1 뒤

- 존치: S-SWARM-A "swarm 미연결 부속 제거"(D1, A18, A22, A23, A24) 다음에 S-SWARM-B "swarm 결함 수정"(결정 1 보조 표). 두 PR 모두 conductor 와 swarm-hypervisor 를 건드리므로 순서를 지킨다.
- 퇴역: S-SWARM-R 한 PR 이 D1, A18, A22~A24, swarm 모듈, 규칙 문서를 같이 지운다. 규칙이 없는 엔진을 가리키는 중간 상태를 만들지 않는다.

### 3단계: INFRA1 머지 뒤 (같은 파일 `tfx-route.sh`, `preflight-cache.mjs` 를 건드림)

| 순서 | 묶음 | 포함 행 | 비고 |
|---|---|---|---|
| 1 | S-G1 Gemini CLI 실행 경로 제거 | G1, G3, G4, G5(A38, A40 포함), G7, G9, G10 | agy 가 쓰는 이름(Keychain 서비스 `gemini`, `~/.gemini/antigravity-cli`, 모델 프로필)은 남긴다 |
| 2 | S-NODE Node 레인 제거 | 결정 2 보조 표, U1, R3, X11 | 결정 2 가 삭제일 때. `tfx-route.sh` 30~36 |
| 3 | S-ROUTE tfx-route.sh 정리 | R1, R2, R4, R6~R13, R16 의 self-test 표면, B9 north star 주입 | 같은 파일 여러 곳이라 S-G1, S-NODE 다음에 하나로 |
| 4 | S-G2 gemini 별칭 제거 | G2, G6 | 허브와 delegator 의 enum 은 INFRA3 에 맡긴다 |

### 4단계: LIVE 머지 뒤

- C1 `hygiene-notify.mjs` 삭제. `git log origin/main -- bin/tfx-live.mjs` 로 live-ops PR 머지를 확인한 뒤에만.

### 5단계: INFRA3 머지 뒤

- U7 adaptive 계열(INFRA3 이 같이 지우면 생략), A44 의 hygiene 나머지와 status 의 `hygiene` 필드, A41 codex-mcp(delegator 와 함께), `tfx why` 파서 측과 bin 분기, G2 의 허브 enum.

### 6단계: 마지막

- S-TEST 남은 테스트 정리(B11 표에서 모듈 PR 에 포함되지 않은 것).

### 릴리스 노트에 모을 공개 표면 변화

- `@triflux/core`: `./mesh/*` export, CORE_INDEX 의 executeGemini, adaptive, reflexion, fingerprint export
- `@triflux/remote`: 배럴의 swarm-reconciler export
- `current.json` 의 `sources` 키 집합(session_vault, agy, gbrain 제거)
- CLI 명령: `tfx review`, `tfx why`, `tfx auto`, `tfx cto steward|dashboard|event`, doctor `--dynamic-routing`, `tfx-profile`
- 에이전트 이름과 `TFX_CLI_MODE` 값 `gemini`
- 환경변수 `TFX_ROUTE_NODE`, `TRIFLUX_DYNAMIC_ROUTING`, `TFX_CODEX_TRANSPORT=mcp`

### 릴리스 조율

릴리스는 `/tfx-ship` 경로로 한다. 시작 전에 `gh pr list` 와 `git log origin/main` 으로 다른 세션이 같은 시점에 릴리스하지 않는지 확인한다. 먼저 머지한 쪽이 릴리스하고 나중 쪽은 main 을 다시 받아 다음 버전으로 올린다. 바꾼 영역의 테스트만 `TFX_DISABLE_CODEX=0 TFX_DISABLE_ANTIGRAVITY=0 node --test <파일>` 로 돌린다. `npm test` 전체는 돌리지 않는다.

## 부록. 리드 미확인 후보

1차 탐색이 올렸으나 리드가 파일을 직접 읽어 확인하지 못한 후보다. 판정이 아니라 다음 조사의 출발점이다. 2단계에서 다루려면 먼저 파일을 끝까지 읽는다.

| 출처 | 대상 | 1차 분류 | 1차 근거 한 줄 |
|---|---|---|---|
| bin #19, scripts-lib #31 | `tests/unit/handoff-serialization.test.mjs` | 사용자 결정 / 대체 후 제거 | 모듈 187줄에 테스트 506줄, 복붙 입력 반복 |
| hub-rest #38 | `hub/hub-lifecycle.mjs`, `middleware/quota-middleware.mjs` 등 9개 파일의 미사용 export | 유지 | export 키워드만 남은 심볼, 파일은 유지 |
| hub-rest #40 | `hub/lib/process-utils.mjs:135~197` `ensureHelperScripts` | 즉시 제거 | 만들어 둔 ps1 을 실행하는 곳이 없다 |
| hub-rest #41 | `hub/lib/process-utils.mjs:968~1054` `cleanupOrphansUnix` | 사용자 결정 | 재부모화된 고아가 항상 보호된다는 추정, 테스트 없음 |
| hub-rest #42 | `hub/workers/claude-worker.mjs:9~23,35~39` 외 워커 4개 | 즉시 제거 | worker-utils 상수 5개 재정의, 오류 분류 4벌 |
| hub-rest #44 | `hub/workers/lib/jsonrpc-stdio.mjs:1~26`, `jsonrpc-core.mjs` 외 | 즉시 제거 | Issue, AC 번호를 적은 변경 이력 주석 |
| hub-rest #45 | `hub/lib/prompt-tmp.mjs:1~17` 외 4개 파일 | 즉시 제거 | 17줄 주석이 10줄 함수를 설명, 버전 일화가 절반 |
| hub-rest #49 | `tests/unit/process-utils.test.mjs:396~520,648~663` | 즉시 제거 | legacy 정리 케이스 4개가 같은 경로를 반복 |
| hub-rest #50 | `tests/unit/cli-adapter-base.test.mjs:187~233` | 즉시 제거 | 상수와 재수출 확인이 섞여 회귀를 못 막음 |
| hub-team-exec #48 | `hub/team/health-probe.mjs`, `sentinel-capture.mjs` 외 6개 파일 | 즉시 제거 | 이슈 번호와 리뷰 라운드 주석은 git 의 일 |
| hub-team-swarm #18 | `hub/team/launcher-template.mjs` 전체, `conductor.mjs:1297~1305` | 즉시 제거 | buildLauncher 결과는 로그 필드뿐, 실제 spawn 은 다른 경로 |
| hub-team-swarm #35 | `hub/team/retry-state-machine.mjs:3,70~98,333~346` | 사용자 결정 | stateFile 경로의 운영 호출자 0, 설계 문서 없음 |
| hub-team-swarm #59 | `tests/unit/conductor.test.mjs:195~242,378~431` | 즉시 제거 | 상수 값과 필드 존재를 하나씩 확인하는 it 18개 |
| hub-team-swarm #61 | `tests/unit/dashboard-layout.test.mjs:47~51` | 즉시 제거 | getter 가 입력을 돌려주는지만 확인 |
| hub-team-swarm #62 | `tests/unit/tui-core.test.mjs:186~191`, `tui-widgets.test.mjs:40~73` | 즉시 제거 | 상수 값 확인과 화면에 안 그려지는 기능 고정 |
| hub-team-swarm #63, tests #39 | `tests/unit/swarm-dirty-filter.test.mjs` | 대체 후 제거 / 즉시 제거 | 허용 목록이 항상 빈 배열이라 8개 중 5개가 같은 동작 |
| hub-team-swarm #64 | `tests/unit/bridge-retry.test.mjs:177~250` | 사용자 결정 | 옛 gpt56 별칭 검증 6개가 두 파일에 반복 |
| hud-cto-mesh-tui #R2 | `references/codex-plugin-cc-analysis.md`, `codex-plugin-cc-code-patterns.md` | 사용자 결정 | 소비자 0, 2026-04 메모이고 전제가 낡음 |
| hud-cto-mesh-tui #V6 | `hud/cli-policy.mjs`, `cto/lake-root.mjs` 머리 주석 | 사용자 결정 | 머리 주석과 JSDoc 이 같은 설명을 두 번 |
| route #39, tests #30 | `tests/unit/tfx-route-skill-inject.test.mjs`, `tfx-route-stall-kill.test.mjs` 외 소스 grep 테스트 | 즉시 제거 / 대체 후 제거 | 소스 문자열을 정규식으로 고정, 동작 회귀를 못 막음 |
| route #40, tests #28 | `tests/unit/tfx-route-duration.test.mjs` | 대체 후 제거 | 키워드마다 상수 하나씩 36개, 3~4개면 충분 |
| route #44 | `tests/integration/agy-stdout-pipe.test.mjs:125~282` | 즉시 제거 | 기본 skip, 검증 대상이 agy 의 flag 흡수 동작 |
| route #45, tests #31 | `tests/integration/tfx-route-quota.test.mjs` | 대체 후 제거 | 25줄 래퍼를 4번 복제, 죽은 gemini 경로 포함 |
| route #46, tests #42 | `tests/unit/remote-spawn-cleanup.test.mjs`, `scripts/__tests__/remote-spawn.test.mjs` | 즉시 제거 / 대체 후 제거 | 문자열 빌더 모양과 argv 인덱스 고정 |
| scripts-lib #15 | `scripts/lib/mcp-manifest.mjs` export 5개 | 대체 후 제거 | 파일 밖 소비자 0, 정상 경로에서 무시됨 |
| scripts-lib #33 | `tests/unit/mcp-health.test.mjs` | 대체 후 제거 | 내부 비교 함수를 필드 단위로 고정, 43케이스 |
| scripts-lib #34 | `tests/unit/mcp-filter.test.mjs:290~307` | 즉시 제거 | truthy 만 보는 케이스 3개 |
| scripts-lib #35 | `tests/unit/psmux-info.test.mjs:34~62` | 대체 후 제거 | darwin 에서 `brew install psmux` 안내를 고정 |
| scripts-top #30 | `.github/ISSUE_TEMPLATE/release.yml` | 사용자 결정 | 필수 체크박스를 지금은 release.yml 이 자동 수행 |
| scripts-top #33 | `scripts/doctor-diagnose.mjs:171~179` | 유지(수정 필요) | 읽는 파일이 없어 버전이 항상 unknown |
| scripts-top #41 | `scripts/doctor-diagnose.mjs:304~323` | 즉시 제거 | 실측상 도달 불가인 renameSync 분기 |
| scripts-top #34 | `scripts/config-audit.mjs:76,82,215~266` | 유지(수정 필요) | 읽지 않는 변수와 의미 잃은 hook-registry 감사 |
| scripts-top #37 | `scripts/tmp-cleanup.mjs:3~6,14~15,59~101` | 유지(수정 필요) | 만드는 곳 없는 SKIP_FILES, 삭제 루프 두 벌 |
| scripts-top #40 | `scripts/test-lock.mjs:29~39,382~392,400~411` | 유지(수정 필요) | 이유는 유효하나 설명이 11줄씩, 이력 표기 |
| scripts-top #42 | `scripts/release/lib.mjs:44~82,117~176`, `version-manifest.json` | 사용자 결정 | 버전 7곳을 맞추는 데 범용 경로 도구 |
| skills-docs #26 | frontmatter `internal: true` (`tfx-harness/SKILL.md:3` 외) | 즉시 제거 | 공식 필드 표에 없고 효과 없음 |
| skills-docs #41 | `README.md:215`, `.claude/rules/tfx-machine-profile.md:11,32` | 사용자 결정 | Linux 를 tmux 지원으로 적어 문서끼리 모순 |
| tests #13 | `tests/unit/headless-wt-attach.test.mjs` | 즉시 제거 | 함수 부재를 문자열로 확인하는 이력 테스트 |
| tests #24 | `tests/unit/headless-tmux-attach.test.mjs` | 대체 후 제거 | fail-open 케이스 12건 반복, argv 전체 고정 |
| tests #26 | `tests/unit/native-bridge-immediate-cleanup.test.mjs:112~151` | 대체 후 제거 | 참조 보존을 검증하지 못하는 둘째 테스트 |
| tests #27 | native bridge 군 테스트 9개 (`tests/unit/native-bridge-*.test.mjs` 등) | 대체 후 제거 | 픽스처 복붙과 같은 PTY 경로 반복 검증 |
| tests #29 | `tests/unit/tfx-route-preflight-all-dead.test.mjs` | 대체 후 제거 | 소스 기반 7건과 이름만 바꾼 반복 5건 |
| tests #33 | `tests/unit/timeout-shim.test.mjs` | 대체 후 제거 | 픽스처 shim 자체를 8건으로 검증 |
| tests #34 | `tests/integration/tfx-auto-routing.test.mjs` | 대체 후 제거 | unit 테스트가 같은 세 케이스를 이미 검증 |
| tests #35 | `tests/unit/escalation-profile-route.test.mjs:233~263` | 대체 후 제거 | 옛 프로필 별칭 11케이스를 루프로 고정 |
| tests #37 | `tests/pipeline/transitions.test.mjs` 외 게이트 테스트 3개 | 대체 후 제거 | 전이를 it 36개로 등록, 8건 중복 |
| tests #38 | `tests/unit/dynamic-router-factory.test.mjs` | 대체 후 제거 | env 값 6건을 개별 등록, typeof 확인 |
| tests #40 | `tests/unit/rebase-branch-safety.test.mjs` 외 3개 | 대체 후 제거 | rebase 를 3파일 11건이 검증, 고유 동작은 6가지 |
| tests #41 | `tests/unit/swarm-locks.test.mjs`, `swarm-locks-v2.test.mjs` | 대체 후 제거 | 같은 모듈을 두 파일이 검증, 하위호환 중복 |
| tests #43 | `tests/unit/ansi.test.mjs`, `tui-core.test.mjs` | 대체 후 제거 | 상수 값 확인 8건, 값을 바꿀 때만 깨짐 |

총 50행

## 참고한 외부 자료

외부 스킬이나 오케스트레이션 알고리즘은 가져다 쓰지 않았다. 네이티브 대체 판단에는 공식 문서와 릴리스 노트만 대조하였다. 날짜는 2026-10-08 확인 기준이다.

### Claude Code

- https://code.claude.com/docs/en/cli-reference (`--bg`, `claude agents`; 이 빌드 2.1.292 에 `--exec` 없음은 `claude --help` 로 실측)
- https://code.claude.com/docs/en/agent-view
- https://code.claude.com/docs/en/agent-teams (experimental)
- https://code.claude.com/docs/en/sub-agents (`isolation: worktree`, `effort`)
- https://code.claude.com/docs/en/cross-session-messaging (2.1.224+)
- https://code.claude.com/docs/en/statusline (`rate_limits`, `context_window`)
- https://code.claude.com/docs/en/memory (rules 의 `paths:` 필드)
- https://code.claude.com/docs/en/hooks-guide
- https://code.claude.com/docs/en/commands, https://code.claude.com/docs/en/workflows (`/loop`, Workflow)
- https://code.claude.com/docs/en/sessions, https://code.claude.com/docs/en/checkpointing, https://code.claude.com/docs/en/interactive-mode, https://code.claude.com/docs/en/terminal-config, https://code.claude.com/docs/en/tools-reference, https://code.claude.com/docs/en/costs, https://code.claude.com/docs/en/code-review
- https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md (`.claudeignore` 미지원은 이슈 56997)

### Codex

- https://developers.openai.com/codex/cli (`codex exec`, `codex review`)
- https://developers.openai.com/codex/config-reference#profiles (프로필은 `$CODEX_HOME/<이름>.config.toml`)
- https://developers.openai.com/codex/config-reference#notify
- https://developers.openai.com/codex/app-server
- https://developers.openai.com/codex/agent-configuration/subagents
- https://developers.openai.com/codex/developer-commands (`#usage`, `#goal`)
- https://developers.openai.com/codex/environments/git-worktrees
- https://github.com/openai/codex/releases/tag/rust-v0.134.0 (inline `[profiles.*]` 폐기)
- https://github.com/openai/codex/releases/tag/rust-v0.147.0 (`--full-auto` 제거)
- https://github.com/openai/codex/releases/tag/rust-v0.154.0 (`codex mcp-server` 제거)
- https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/cli/src/main.rs, `exec/src/cli.rs`, `features/src/lib.rs`, `utils/cli/src/config_override.rs` (0.160.1 플래그와 `approval_mode` 허용값)
- https://github.com/openai/codex/pull/24051, https://github.com/openai/codex/pull/24059 (ignore 파일 미지원은 이슈 2847)

### Antigravity (agy)

- https://antigravity.google/docs/cli/headless/ (`--print`, `--print-timeout`, stream-json)
- https://antigravity.google/docs/cli/reference/, https://antigravity.google/docs/cli/commands/agents/, https://antigravity.google/docs/cli/commands/resume, https://antigravity.google/docs/cli/commands/diff
- https://antigravity.google/docs/cli/settings/, https://antigravity.google/docs/cli/permissions/, https://antigravity.google/docs/cli/subagents/, https://antigravity.google/docs/cli/statusline/, https://antigravity.google/docs/cli/credits/, https://antigravity.google/docs/cli/conversations/, https://antigravity.google/docs/cli/features/, https://antigravity.google/docs/cli/install/, https://antigravity.google/docs/cli/troubleshooting/
- https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md

### 저장소 안 결정 문서

- ADR-0020(스킬 삭제), ADR-0021(키워드 훅), ADR-0022(CTO 트레이 제거), ADR-0023(인프라 축소), 2026-09-24 CTO·허브·synapse 재평가 메모, `.claude/rules/tfx-machine-profile.md`(플랫폼별 멀티플렉서 정책)
