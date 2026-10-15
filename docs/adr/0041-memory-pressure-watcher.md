---
id: 0041
title: 메모리 압박 감시기는 launchd 상주 Node 가 상태 파일을 쓰고 triflux mod 가 리드를 깨운다
status: accepted
date: 2026-10-15
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0040]
pr: null
---

# ADR-0041: 메모리 압박 감시기는 launchd 상주 Node 가 상태 파일을 쓰고 triflux mod 가 리드를 깨운다

## 컨텍스트와 문제 (Context)

ADR-0040 으로 워커 실행 위치 판단은 리드 몫이 됐지만, 측정 시점이 "디스패치 직전" 한 번이라 리드가 작업 중일 때 압박이 2(warn) 나 4(critical) 로 올라가도 알지 못한다. 사용자는 Stats 앱이 보여 주는 것과 같은 커널 값 `kern.memorystatus_vm_pressure_level` 을 리드 밖 상주 감시기가 1초마다 읽고, 단계가 바뀔 때만 리드에게 알리는 방식을 골랐다. Codex 가 Stats 3.0.21 을 역분석한 결과 Stats 도 이 sysctl 을 1초 폴링하며 압박 이벤트는 구독하지 않는다.

전달 수단으로 처음 제시된 것은 리드 세션의 inbox 소켓(`/tmp/cc-socks/<pid>.sock`)이었다. 공식 문서는 소켓 경로와 인증 줄까지만 공개하고 메시지 본문 형식은 공개하지 않는다. 리드 세션 자신의 소켓에 평문 한 줄과 JSON 한 줄을 넣어 봤지만 어느 쪽도 도착하지 않았다. 외부 데몬은 세션의 자식이 아니라서 리드가 bypassPermissions 모드면 승인 대기에 걸리고, 리드 소켓 경로가 세션마다 바뀌어 감시기가 리드를 찾는 방법도 따로 필요했다.

## 결정 (Decision)

- 감시기는 triflux 저장소의 Node 스크립트로 만들고 `~/Library/LaunchAgents` 의 LaunchAgent(`KeepAlive`)로 상주시킨다. 1초마다 `sysctl -n kern.memorystatus_vm_pressure_level` 을 읽어 1, 2, 4 만 유효로 본다. 다른 단계가 새 표본 두 번 연속 같을 때 확정하고, 확정된 전이만 상태 파일에 쓴다. 같은 단계 지속은 쓰지 않되 30초마다 heartbeat 시각은 갱신한다. 표본 간격이 5초를 넘으면(수면, 멈춤) 후보를 버리고 새 두 표본으로 다시 확정한다.
- 상태 파일은 `~/.local/state/triflux/memory-pressure.json` 하나다. 임시 파일에 쓰고 rename 한다. 내용은 현재 단계, 이전 단계, 확정 시각, 마지막 표본 시각, 전이 일련번호, 감시기 pid 다.
- 리드를 깨우는 것은 triflux mods(`mods/triflux`) 안의 훅 모듈이다. `session.start` 에서 `$.clock.every` 로 상태 파일을 2초마다 읽고, 전이 일련번호가 바뀌었을 때 그 세션이 리드로 등록돼 있으면 `$.prompt.submit` 으로 전이와 대응 규칙을 담은 턴을 연다. 리드 등록은 세션 안에서 `/tfx-lead on|off` 슬래시 명령으로 하며 `$.store` 에 세션 ID 로 남긴다. 리드가 아닌 세션은 전이 때 `$.ui.toast` 한 줄만 본다. 상태 파일의 표본 시각이 60초 넘게 멈추면 감시기가 죽은 것으로 보고 한 번 알린다.
- 설치와 제거는 `tfx pressure install|uninstall|status` 로 한다. macOS 만 지원하고 다른 OS 는 안내만 한다. `tfx setup` 은 감시기를 자동 설치하지 않는다.
- 단계별 대응 규칙은 `skills/tfx-lead/SKILL.md` 의 "압박 변화 대응" 절이 정본이다. 기준값은 `.claude/rules/tfx-routing.md` 그대로다.

## 검토한 대안 (Considered Options)

- **inbox 소켓 직접 전송**: 데몬이 리드 소켓에 한 줄을 쓴다. 본문 형식이 비공개라 바이너리 조사가 필요하고 Claude Code 업데이트마다 깨질 수 있다. 외부 송신자는 bypass 리드에서 승인 대기에 걸리고, 리드 소켓을 찾는 레지스트리가 또 필요하다. 기각.
- **Channels(MCP)**: 공식 푸시 경로지만 research preview 이고 claude.ai 또는 API 키 인증과 `--channels` 플래그가 필요하다. 감시기 하나를 위해 세션 시작 방식을 바꾸게 된다. 기각, 안정화되면 재검토.
- **리드 안 타이머만(설치 없음)**: mod 가 직접 sysctl 을 돌린다. 설치가 없어 단순하지만 리드가 없을 때는 아무도 측정하지 않고, 세션마다 1초 폴링이 중복된다. 사용자가 상주 감시기를 골랐으므로 기각. 다만 mod 의 파일 폴링은 이 안의 장점(공개 API 만 사용)을 가져온 것이다.
- **Swift 바이너리**: Codex 권고. 메모리 발자국은 작지만 빌드 도구와 서명이 필요하고 저장소의 Node 테스트 체계 밖이다. 1초에 한 번 sysctl 프로세스를 띄우는 Node 상주(수십 MB)로 시작하고, CPU 나 전력이 문제로 실측되면 바꾼다.

## 결과 (Consequences)

- 리드는 작업 중에도 단계 전이를 턴으로 받는다. 상태 파일은 어떤 프로세스든 읽을 수 있어 HUD 표시나 `tfx-route.sh` 의 사전 점검에도 쓸 수 있다.
- 비공개 소켓 프로토콜과 권한 승인 문제를 피한다. 전달 지연은 확정 2초 + mod 폴링 최대 2초다.
- 감시기가 죽으면 상태 파일이 멈추고 mod 가 한 번 알린다. launchd `KeepAlive` 가 다시 띄운다.
- 리드가 둘 이상 등록돼 있으면 둘 다 깨어난다. 리드 교대 때 `/tfx-lead off` 를 빠뜨리면 옛 리드도 깨어나므로 점검표에 넣는다.
- 되돌릴 조건: Claude Code 가 외부 프로세스용 inbox 쓰기 형식이나 안정된 Channels 를 공개하면 전달 경로를 바꾼다. 측정과 상태 파일은 그대로 둔다.
