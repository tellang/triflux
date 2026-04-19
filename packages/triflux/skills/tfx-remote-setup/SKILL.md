---
name: tfx-remote-setup
description: >
  legacy thin alias. Phase 4b부터 setup 관련 공용 진입점은 tfx-remote setup 이다.
triggers:
  - tfx-remote-setup
argument-hint: "[--add|--edit|--probe-all|--diagnose]"
---

# tfx-remote-setup — legacy alias

이 스킬은 Phase 4b thin alias다. 새 표면은 `tfx-remote setup` 하나다.

## Alias mapping

- `tfx-remote-setup`
- `tfx-remote setup`
- `tfx-remote setup --add`
- `tfx-remote setup --edit`
- `tfx-remote setup --probe-all`
- `tfx-remote setup --diagnose`

## Dispatch rule

기존 Add/Edit/Probe All/Diagnose 워크플로우는 유지하되, 사용자-facing 안내와
후속 문맥에서는 항상 `tfx-remote setup` 명령군을 기준으로 말한다.

새 문서를 작성하거나 사용 예시를 제시할 때 `tfx-remote-setup`을 신규 표면처럼
소개하지 않는다.
