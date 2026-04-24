---
name: tfx-remote
description: >
  원격 관련 표면을 setup/spawn 계열 하나로 통합한 엔트리포인트.
  setup, spawn, list, attach, send, resume, kill, probe 하위 명령을 기준으로
  기존 tfx-remote-setup/tfx-remote-spawn 흐름을 축소 통합한다.
triggers:
  - tfx-remote
argument-hint: "[setup|spawn|list|attach|send|resume|kill|probe] ..."
---

# tfx-remote — remote consolidated entrypoint

`tfx-remote`는 신규 원격 엔진이 아니라 기존 `tfx-remote-setup` + `tfx-remote-spawn`
표면을 한 명령군으로 축소한 통합 진입점이다.

## Public subcommands

| Subcommand | 역할 | legacy 매핑 |
| --- | --- | --- |
| `setup` | hosts 등록/편집/진단/probe-all | `tfx-remote-setup` |
| `spawn <host> [prompt]` | 원격/로컬 세션 생성 | `tfx-remote-spawn` |
| `list` | 활성 세션 목록 | `tfx-remote-spawn --list` |
| `attach <session>` | 세션 재부착 | `tfx-remote-spawn --attach` |
| `send <session> "<msg>"` | 세션에 후속 프롬프트 전송 | `tfx-remote-spawn --send` |
| `resume <session|host|recent>` | 최근 세션 또는 호스트 기준 재개 | 신규 통합 표면 |
| `kill <session>` | 세션 종료 | legacy kill 동작 공식 승격 |
| `probe <host>` | SSH/Tailscale/Claude 연결 체크 | `tfx-remote-setup` / `tfx-remote-spawn --probe` |

`capture` / `wait`는 Phase 4b public consolidation 대상이 아니다.
필요하면 legacy passthrough로만 유지한다.

## Dispatch contract

### `tfx-remote setup`

기존 `tfx-remote-setup` 플로우를 그대로 사용한다.
- `setup`
- `setup --add`
- `setup --edit`
- `setup --probe-all`
- `setup --diagnose`

`hosts.json` 을 Add/Edit/Diagnose 어떤 경로로든 수정할 때마다 triflux 소스 트리로 fan-out 해야 한다 (`skills/tfx-remote-spawn/references/hosts.json` 및 `packages/triflux/skills/tfx-remote-spawn/references/hosts.json`). 세부 절차는 `tfx-remote-setup` 플로우의 **2-7-b** 단계 참조. 임시 패치이며 근본 해결은 issue #178 (hosts.json 이전) 및 #179 (`tfx setup` user-state skip) 에서 추적.

### `tfx-remote spawn`

기존 `tfx-remote-spawn` 플로우를 사용하되 아래 preflight를 먼저 수행한다.
1. `hosts.json` 존재 확인
2. 호스트명/alias 해석
3. probe TTL 확인
4. SSH 실패 시 `setup diagnose` 또는 `setup edit` 복귀 경로 제시

preflight 실패 시 중단만 하지 말고 아래 중 하나로 복귀시킨다.
- `tfx-remote setup --add`
- `tfx-remote setup --edit`
- `tfx-remote setup --diagnose`
- `tfx-remote probe <host>`

### `tfx-remote resume`

우선순위는 아래와 같다.
1. 세션명이 주어지면 해당 세션 attach/복구
2. 호스트명이 주어지면 해당 호스트의 최근 세션 탐색
3. `recent` 또는 생략이면 최근 세션 우선, 없으면 `default_host` 기준 새 spawn

### `tfx-remote kill`

공식 public subcommand다. 세션 종료 전에 psmux/WT 정리 규칙은
`.claude/rules/tfx-psmux.md`와 `AGENTS.md`의 detach-first 정책을 따른다.

## hosts.json contract

신규 코드는 가능하면 `hub/lib/hosts-compat.mjs`를 기준으로 해석한다.
- v1 legacy 필드 유지: `os`, `ssh_user`, `tailscale.ip`, `tailscale.dns`, `capabilities`
- v2 additive 필드 허용: `ssh.user`, `capabilities_v2`, `last_probe`

`resolveHost(nameOrAlias)` 기준으로 alias, tailscale DNS/IP, `ssh_user@host`를
canonical host로 정규화한다.

## Verification

허용 범위 안에서 Phase 4b가 완료되었는지 확인할 때 최소 검증은 아래와 같다.
- `node hub/lib/hosts-compat.mjs --self-test`
- `Get-FileHash .claude/rules/tfx-psmux.md, AGENTS.md`
- legacy alias 문서가 모두 `tfx-remote` 또는 rule 문서로 위임되는지 확인
