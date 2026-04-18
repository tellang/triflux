---
name: tfx-remote-spawn
description: >
  legacy thin alias. Phase 4b부터 spawn/list/attach/send/resume/kill/probe 공용 진입점은
  tfx-remote 이다.
triggers:
  - tfx-remote-spawn
argument-hint: "[spawn|list|attach|send|resume|kill|probe] ..."
---

# tfx-remote-spawn — legacy alias

이 스킬은 Phase 4b thin alias다. 새 표면은 `tfx-remote` 명령군이다.

## Alias mapping

- `tfx-remote-spawn <host> [prompt]` → `tfx-remote spawn <host> [prompt]`
- `tfx-remote-spawn --list` → `tfx-remote list`
- `tfx-remote-spawn --attach <session>` → `tfx-remote attach <session>`
- `tfx-remote-spawn --send <session> "<msg>"` → `tfx-remote send <session> "<msg>"`
- `tfx-remote-spawn --probe <host>` → `tfx-remote probe <host>`
- 최근 세션 복귀/호스트 기반 재개 → `tfx-remote resume <session|host|recent>`
- 세션 종료 → `tfx-remote kill <session>`

## Parity note

`capture` / `wait`는 public consolidation 대상이 아니다. 기존 parity가 필요하면
legacy passthrough 또는 내부 debug 표면으로만 유지한다.

새 문서나 사용자 안내에서 `tfx-remote-spawn`을 1급 표면처럼 홍보하지 않는다.
