# triflux 아키텍처

## 목적

이 문서는 triflux 코드가 지금 어떻게 나뉘어 있고 요청이 어느 경로로 실행되는지 설명한다. 결정 근거는 [`docs/adr/`](docs/adr/README.md), 실행 정책의 정본은 [`.claude/rules/`](.claude/rules/)에 있다. 사용법과 전체 그림은 [README.ko.md](README.ko.md)에 있다.

## 패키지 구성

루트가 정본이고 `packages/*`는 배포용 미러다.

| 레이어 | 역할 | 미러 방식 |
| --- | --- | --- |
| 루트 | 모든 런타임 파일의 정본 | 해당 없음 |
| `packages/core` (`@triflux/core`) | 공용 라이브러리(`hub/lib`, `scripts/lib`, `hooks`, `hud`) | 루트와 바이트 동일 |
| `packages/remote` (`@triflux/remote`) | 원격 실행용 부분 집합(`hub`, `scripts`) | import 경로를 `@triflux/core/...`로 바꾼 사본 |
| `packages/triflux` (`triflux`) | 사용자가 설치하는 CLI와 런타임 | npm `files` 기준 바이트 동일 |

미러 규칙과 점검 절차는 [`.claude/rules/tfx-mirror-policy.md`](.claude/rules/tfx-mirror-policy.md), 검사기는 `scripts/release/check-packages-mirror.mjs`다.

## 디렉터리

| 디렉터리 | 역할 | 대표 파일 |
| --- | --- | --- |
| `bin/` | 실행 파일 | `triflux.mjs`(`tfx`), `tfx-live.mjs`, `tfx-peer.mjs`, `tfx-setup.mjs`, `tfx-doctor.mjs` |
| `scripts/` | 라우팅 실행기, 설치, 릴리스 | `tfx-route.sh`, `setup.mjs`, `remote-spawn.mjs`, `release/` |
| `scripts/lib/` | 라우팅 정책과 공용 함수 | `vendor-priority-policy.mjs`, `agent-route-policy.mjs`, `quota-snapshot.mjs`, `model-family-resolver.mjs`, `machine-profile.mjs`, `native-peer-permissions.mjs` |
| `hub/` | bridge CLI와 CLI 어댑터 | `bridge.mjs`, `cli-adapter-base.mjs` |
| `hub/team/` | 세션, 팀, 피어 전송 | `headless.mjs`, `results-index.mjs`, `agents-row.mjs`, `retry-state-machine.mjs`, `native-peer.mjs`, `ssh-peer.mjs`, `codex-queue.mjs`, `claude-daemon-control.mjs`, `lead-launch.mjs` |
| `hub/lib/` | 공용 런타임 함수 | `jev-addon.mjs`, `hosts-compat.mjs`, `codex-session-registry.mjs`, `lead-marker.mjs` |
| `hub/workers/` | Claude CLI 워커 | `claude-worker.mjs` |
| `mods/triflux/` | Claude Code mods 플러그인(`triflux-mods`) | `hooks/register.ts`와 모듈 9개 |
| `hud/` | statusline과 tmux HUD | `hud-qos-status.mjs`, `tmux-status.mjs`, `providers/` |
| `hooks/` | Codex 세션 훅 | `codex-session-hook.mjs` |
| `adapters/` | Codex, agy용 스킬 사본과 agy 플러그인 | `codex/`, `agy/` |
| `skills/` | 스킬 정의 | `tfx-auto`, `tfx-live`, `tfx-lead`, `tfx-comm` 외 |
| `config/` | MCP 레지스트리 | `mcp-registry.json` |

## 작업 실행 경로

1. `/tfx-auto`가 Bash로 `scripts/tfx-route.sh <역할> "<지시>"`를 실행한다.
2. `tfx-route.sh`가 `agent-route-policy.mjs --format route`를 호출해 CLI, 프로필, 가족, effort, 후보 목록을 받는다.
3. 후보 목록은 `vendor-priority-policy.mjs`가 생성한다. 머신 프로필, 설치 여부, `quota-snapshot.mjs`가 읽은 사용량 캐시로 벤더를 제외하고 순서를 조정한다. 후보가 없으면 `exit 78`이다.
4. 실행기는 CLI별로 나뉜다. Codex는 `codex exec --profile <가족>`, agy는 `agy --print`, Claude는 `tfx-route-worker.mjs`가 `hub/workers/claude-worker.mjs`를 실행한다.
5. `tfx-route-post.mjs`가 출력을 정리한다. 쿼터나 429 오류면 `tfx-route.sh`의 `auto_reroute`가 다음 후보로 자기 자신을 다시 실행한다(최대 2회).

- `tfx multi`의 명령은 `hub/team/cli/`에 있다. headless 실행은 `headless.mjs`의 `runHeadless`가 tmux 방에 pane을 생성한다. 각 pane은 `tfx-route.sh` 또는 `claude --print`를 실행한다.
- 워커 결과는 `results-index.mjs`가 `<세션>.results.json`에 기록한다. 근거는 [ADR-0034](docs/adr/0034-headless-session-results-index.md)다.
- `--retry ralph`, `auto-escalate`는 `bridge.mjs retry-run`이 `retry-state-machine.mjs`를 구동한다.

## 세션 제어와 피어 전송

- `tfx-live`는 tmux 세션을 시작하고 `ask`로 사용자 입력을 보낸다. Codex는 `codex-queue.mjs`의 app-server 큐, Claude 데몬 세션은 `claude-daemon-control.mjs`의 제어 소켓을 쓴다. 그 밖의 세션은 tmux 입력이다. 근거는 [ADR-0027](docs/adr/0027-codex-message-queue-default.md)다.
- `tfx-peer send`는 `native-peer.mjs`로 전달한다. Claude는 세션 메시지 UDS(Windows는 named pipe), Codex는 공유 app-server UDS의 `thread/inject_items`와 `turn/start`, agy는 대화 디렉터리 파일 쓰기다.
- `tfx-peer remote-send`는 `ssh-peer.mjs`가 SSH로 상대 호스트의 `tfx-peer _receive`를 실행한다.
- 세션 찾기는 Claude가 `~/.claude/sessions/`, Codex가 tmux 옵션 `@tfx_codex_thread`와 `codex-session-hook.mjs`가 쓴 레지스트리, agy가 tmux pane과 열린 잠금 파일이다.

## 호스트 연동

- triflux-mods는 `register.ts`가 모듈 9개를 등록한다: HUD band, 서브에이전트 effort, SendMessage 중계, 메모리 압박, 리드 표지, `tfx_control`, 압축 스냅샷, 보고 길이 제한, 유휴 팀원.
- `tfx lead`는 `lead-launch.mjs`가 후보 CLI를 고르고 `tfx-live start`로 세션을 시작한 뒤 리드 표지를 `~/.local/state/triflux/lead-roles/`에 쓴다. mods의 리드 표지 모듈이 이 파일을 읽는다([ADR-0029](docs/adr/0029-lead-session-operating-model.md), [ADR-0032](docs/adr/0032-lead-role-skill-tfx-lead.md)).
- HUD 제공자(`hud/providers/`)가 쓴 `~/.claude/cache/*-cache.json`을 `quota-snapshot.mjs`가 읽는다. HUD와 라우팅은 이 캐시로만 연결된다.

## 스택 공존

triflux는 gstack, superpowers와 레이어를 나눠 공존한다.

| 레이어 | 시스템 | 역할 |
| --- | --- | --- |
| 워크플로 게이트 | gstack | ship, QA, 체크포인트 |
| 작업 방식 | superpowers | 계획 작성, TDD, 리뷰 반영 |
| 오케스트레이션 | triflux | 라우팅, 병렬 워커, 세션 제어, 코드 리뷰 판정(`tfx-review`) |

의존은 gstack과 superpowers가 triflux를 호출하는 방향만 허용한다. 상세는 [`.claude/rules/tfx-stack-coexistence.md`](.claude/rules/tfx-stack-coexistence.md)에 있다.
