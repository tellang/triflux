---
id: 0023
title: command hook, 키워드 라우팅, MCP gateway, synapse, 허브를 걷어내고 Claude Code mods 로 옮긴다
status: proposed
date: 2026-10-08
deciders: [tellang]
supersedes: [0010, 0018, 0021]
superseded_by: null
relates: [0007, 0010, 0013, 0018, 0020, 0022]
pr: null
---

# ADR-0023: command hook, 키워드 라우팅, MCP gateway, synapse, 허브를 걷어내고 Claude Code mods 로 옮긴다

## 컨텍스트와 문제 (Context)

triflux 는 Claude Code 에 기능을 붙이려고 바깥 장치를 여럿 쌓았다. settings.json 의 command hook 11개를 `hooks/hook-orchestrator.mjs` 하나로 모아 순서를 통제했고, 프롬프트마다 키워드를 읽어 스킬 호출을 주입했다. MCP 서버는 gateway 데몬으로 공유했고, 세션 생존은 synapse 레지스트리에, 에이전트 사이 메시지는 허브 데몬(`hub/server.mjs`, `tfx-hub` MCP)에 맡겼다.

2026-10-07 에 이 장치들이 지금 무엇을 하는지 다시 확인했다.

- 이 기기의 Claude 세션과 Claude daemon 워커는 auto 권한 모드로 돈다. 그래서 permission-safe-allow 가 붙는 PermissionRequest 는 거의 생기지 않고, safety-guard 의 위험 명령 차단은 auto 분류기와 겹친다. Codex 와 agy 에는 Claude hook 이 적용되지 않는다.
- registry 의 일부 항목은 고장 나 있었다. `exit 0` 항목은 셸 없이 실행돼 매번 실패했고, cross-review tracker 와 gate 는 서로 다른 상태 파일을 썼고, subagent-verifier 와 adaptive-collector 는 표준 입력에 없는 필드를 읽었다.
- gateway 를 거치는 MCP 는 이 기기에서 brave-search 하나였다.
- synapse 를 읽는 쪽은 조회만 남은 CTO, 이미 지운 트레이의 엔드포인트, TUI, 파일명이 맞지 않아 읽지 못하는 `swarm status` 였다.
- 허브의 메시지 버스는 최근 기록이 headless 워커의 결과 발행뿐이고, assign 작업은 7월 이후 없었다. 허브에 쌓이는 행 대부분은 hook 이 넣는 세션 자동 등록이었다.
- `tfx update` 는 hook 무결성 검사와 `hook-manager apply` 를 매번 돌렸다. 후자는 다른 플러그인의 hook 을 지울 수 있는 명령이다.

같은 시기 Claude Code 2.1.287 이 mods 를 내놓았다. 프로세스 안의 TypeScript 함수 hook 으로 도구 호출, 프롬프트, 턴, 서브에이전트 생성에 개입하고 상태를 유지하며 프롬프트 위 band 와 pane 을 그린다. 2.1.292 에서 `claude -p --plugin-dir` 로 실측한 결과 `agent.spawn` 에서 서브에이전트 model 을, `turn.step` 에서 서브에이전트 요청의 effort 를 바꾸면 API 까지 반영됐다.

## 결정 (Decision)

우리는 다음을 걷어낸다.

1. `hooks/hook-orchestrator.mjs`, `hooks/hook-registry.json`, `hooks/hook-manager.mjs` 와 setup 이 settings.json 에 설치하는 triflux command hook 전부. safety-guard 와 Windows 호스트로 가는 SSH 명령의 bash 문법 검사도 함께 뺀다.
2. 키워드 라우팅(`scripts/keyword-detector.mjs`, `hooks/keyword-rules.json`). ADR-0021 을 대체한다.
3. MCP gateway 데몬과 그에 딸린 config watcher, safety guard, 자동 시작 등록. gateway 로 붙던 MCP 는 직접 연결로 되돌린다.
4. synapse 레지스트리, HTTP, CLI, TUI.
5. 허브 데몬, `tfx-hub` MCP, 메시지 버스. 실행 엔진, AccountBroker, Claude daemon 제어, retry, pipeline 은 `hub/` 아래에 있어도 지우지 않고 분리한다.
6. 90일 동안 호출되지 않은 스킬 plan, interview, profile, merge-worktree, star-prompt.

AI trailer 차단은 cross-review gate 대신 git `commit-msg` hook 으로 옮긴다. 워커 결과는 허브 대신 실행 엔진이 워커마다 남기는 작은 결과 파일로 조회한다.

그리고 Claude Code mods 로 다음을 새로 만든다. HUD 의 Claude 행(`$.session.usage()`), 역할별 서브에이전트 model 과 effort 강제, 턴별 토큰 기록, Codex 위임 네이티브 도구, 워커 관전 pane.

순서는 네 묶음이다. 확정 제거와 설치 이주, 최소 결과 기록, 허브와 synapse 제거, mods 순이다. 이미 설치된 환경이 업데이트 뒤 죽은 hook 을 호출하지 않도록 한 릴리스 동안 옛 진입점 자리에 자기 정리 stub 을 둔다.

## 검토한 대안 (Considered Options)

- **A안: 고장 난 핸들러만 고치고 orchestrator 는 유지.** 변경이 작다. 하지만 남는 핸들러 대부분이 auto 모드와 Claude Code 기본 기능과 겹쳐 유지 비용만 남는다.
- **B안: 남길 hook 을 전부 mods 로 이식.** 프로세스 생성이 사라진다. 하지만 이식할 가치가 있는 핸들러가 적고, mods 는 early access 라 기존 기능을 그대로 옮기면 의존만 커진다.
- **C안: 허브는 mailbox 로 남기고 축소(2026-09-24 결정).** 공개 버스 기능이 유지된다. 하지만 버스를 쓰는 소비자가 사실상 없어서 축소된 데몬도 setup, doctor, update, 워커 프롬프트 계약에 계속 비용을 남긴다.
- **D안(채택): 제거하고, 새로 필요한 표시와 정책만 mods 로 만든다.** 표면이 크게 준다. 대가는 아래 결과에 적는다.

## 결과 (Consequences)

- 잃는 것: safety-guard 의 저장소 고유 차단 규칙, Windows 호스트 SSH 문법 검사, cross-review 미검증 경고, 키워드로 유도하던 스킬 호출, 허브의 질의응답과 fanout 과 대기 중 제어 명령, triflux 가 시작하지 않은 세션의 presence 관측.
- mods 의존 위험: mods 는 샌드박스 없이 사용자 권한으로 돌고, 설치형 mod 는 worker 하나를 공유해 원인 불명 crash 가 세 번이면 사용자 mod 가 모두 꺼진다. `--safe-mode`, `disableAllHooks`, 데스크톱 WSL 세션에서는 돌지 않는다. 그래서 mods 로 만든 기능마다 꺼졌을 때 CLI 로 같은 정보를 얻는 경로를 둔다.
- 서브에이전트 effort 는 2.1.292 의 Agent 도구 `effort` 인자로도 줄 수 있다. 모델이 인자를 빠뜨려도 적용되도록 mod 로 강제하기로 했다. fork 와 workflow agent 는 model 을 바꿀 수 없다.
- 이 ADR 이 구현되면 ADR-0007, 0010, 0013, 0018 을 각 구현 PR 에서 superseded 또는 deprecated 로 바꾼다.
- 되돌릴 조건: mods API 가 깨져 HUD 와 effort 정책을 유지할 수 없으면 statusLine stdin 의 `rate_limits` 와 Agent 도구 `effort` 인자로 물러난다.
