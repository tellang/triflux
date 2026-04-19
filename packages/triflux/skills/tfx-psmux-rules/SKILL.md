---
name: tfx-psmux-rules
description: >
  legacy alias. Phase 4b부터 psmux 규칙의 source of truth는 skill이 아니라
  .claude/rules/tfx-psmux.md 와 AGENTS.md 의 always-on policy 이다.
triggers:
  - tfx-psmux-rules
  - psmux-rules
---

# tfx-psmux-rules — legacy alias

이 항목은 더 이상 기능 스킬이 아니다.
Phase 4b부터 psmux 규칙의 source of truth는 아래 두 문서다.

- `.claude/rules/tfx-psmux.md`
- `AGENTS.md` 의 `TFX psmux Rules` 섹션

## Alias behavior

- 이전 `tfx-psmux-rules` 호출은 항상-on rule 문서 참조로 안내한다.
- 새로운 명령 표면이나 워크플로우는 이 이름 아래 추가하지 않는다.
- 실제 enforcement source는 문서가 아니라 hook/util/preflight 코드다.

## Operator note

이 alias는 Phase 4 thin compatibility stub이다. Phase 5에서 repo-wide reference zero가
만족되면 삭제 후보가 된다.
