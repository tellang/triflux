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

## Deprecation logging (alias 호출 즉시 실행 필수)

canonical 위임 **이전** 에 아래 bash 블록을 한 번 실행한다. Phase 5 (v11) 물리 삭제 게이트는 `.omc/state/alias-usage.log` 의 7일 zero-usage 검증에 의존.

```bash
mkdir -p .omc/state
echo "[deprecated] tfx-remote-setup -> use: tfx-remote setup" >&2
echo "[DEPRECATED] tfx-remote-setup — see tfx-remote setup"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) tfx-remote-setup -> tfx-remote setup" >> .omc/state/alias-usage.log
```

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
