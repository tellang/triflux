---
id: 0022
title: CTO 트레이를 패키지에서 제거한다
status: accepted
date: 2026-10-04
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0010, 0018]
pr: null
---

# ADR-0022: CTO 트레이를 패키지에서 제거한다

## 컨텍스트와 문제

[ADR-0018](../_archive/adr/0018-cto-auto-behaviors-opt-in.md)로 허브의 트레이 자동 기동은 `TFX_HUB_AUTO_TRAY=1`일 때만 돌게 바뀌었고, 수동 `tfx tray` 명령만 남았다. 이후에도 트레이를 쓴 흔적은 없었다. 옛 버전은 세션마다 고아 트레이 프로세스(`node hub/tray.mjs`와 그 자식 `swift hub/mac-tray.swift`)를 남겼다. 그런데도 트레이 코드는 허브 HTTP 라우트, 허브→cto status import, `systray2` 의존성, 3계층 미러로 계속 유지 비용을 냈다. ADR-0018은 제거 여부를 후속 단계로 미뤄 두었다.

## 결정

우리는 CTO 트레이를 패키지에서 완전히 제거한다.

- `hub/tray*.mjs`, `hub/mac-tray.swift`, `hub/public/tray.html`, 트레이 아이콘, 트레이 포커스용 `hub/mac-focus.mjs`와 packages 미러 사본을 지운다.
- 허브의 트레이 자동 기동, `/tray.html` 서빙, `/api/tray-state`·`/api/focus-session` 라우트, `tfx tray` 명령, `systray2` 의존성을 지운다.
- `TFX_HUB_AUTO_TRAY`는 코드에서 읽지 않는다. 사용자가 설정해 두어도 무시된다.
- 업그레이드 setup은 이전 버전이 띄운 트레이 프로세스를 한 번 SIGTERM으로 정리한다. 트레이는 시작 프로그램, 작업 스케줄러, LaunchAgent에 등록된 적이 없으므로 따로 지울 등록 항목은 없다.
- 트레이와 공유하던 기능(hub roles와 CTO succession, `tfx cto` lake·status, HUD)은 그대로 둔다.

## 검토한 대안

- **opt-in 유지(ADR-0018 현상)**: 켜고 싶은 사용자에게 길을 남긴다. 하지만 쓰는 사람이 없는데도 라우트, 의존성, 미러 비용이 계속 들고, 옛 고아 프로세스 문제의 원인 코드도 남는다.
- **트레이 UI만 지우고 `/api/tray-state` 유지**: 다른 소비자가 없는 payload라 유지할 이유가 없다. 같은 정보는 `tfx cto status --json`과 허브 `/status`가 이미 준다.
- **완전 제거(채택)**: 유지 비용과 고아 프로세스의 근원을 함께 없앤다. 필요해지면 git 이력에서 되살릴 수 있다.

## 결과

- 허브가 `cto/status.mjs`와 MCP registry 점검 모듈을 더는 import하지 않는다. [ADR-0010](../_archive/adr/0010-cto-lake-hub-role-boundary.md)의 트레이 payload 소비 표면 계약은 대상이 없어진다.
- `@triflux/remote`와 `triflux` 패키지에서 `systray2`와 그 전이 의존성(`fs-extra` 등)이 빠진다.
- 트레이 설계 문서는 `docs/_archive/`로 옮겼다([ADR-0012](0012-orphaned-design-doc-deprecation.md) 규칙).
- 되돌릴 조건: 상태바나 시스템 트레이 표면이 다시 필요해지면, 이 ADR을 대체하는 새 ADR로 범위와 수명주기(싱글턴, 정리 책임)부터 정한다.
