# Session Recovery Report (2026-04-10 ~ 2026-04-17)

## 스캔 요약
- 전체 JSONL: 1401개
- mtime 필터 통과: 451개
- 실제 스캔: 77개 (크기 상위 50 ∪ 최신 30)
- 패턴 hit 세션: 49개
- 보고서 채택: 5개 (type 분포: intent 5, omission 4, bug 2, context 1, loss 1)

## 발견 항목

### [S1] Codex auth.json ↔ Hub 캐시 자동 동기화 부재 — type: `intent`+`bug`+`omission`
- 세션: `51316549-2a89-4434-bfe5-6e5d64446db3`, 시각: `2026-04-17T06:50:49Z`
- **맥락(context)**: "전부 자동이어야 하는데 현재 수동" / "auth.json 상태: 아직 Apr 5 ... 12일 전 그대로"
- **의도(intent)**: 인터랙티브 Codex 로그인과 Hub 캐시 auth 파일이 양방향으로 자동 동기화돼 `refresh_token_reused` 401을 막는 것.
- **실제 결과**: 같은 세션에서 Issue #78만 생성. 현재도 `gh issue view 78`은 OPEN이고, 코드 검색상 자동 sync 구현 증거가 없다.
- **유실 메커니즘**: 당장 수동 복구로 세션을 넘기면서 버그가 이슈로만 격리됐다.
- **권장 액션**: **PR** — 이미 #78로 문제정의가 끝났고 영향 파일도 명시돼 있어 구현 착수 가치가 높다.

### [S2] Hub MCP URL sync가 Codex TOML을 빼고 닫힘 — type: `intent`+`omission`
- 세션: `51316549-2a89-4434-bfe5-6e5d64446db3`, 시각: `2026-04-17T06:50:58Z`
- **맥락(context)**: Issue 생성문에 "**Codex config.toml TOML 동기화는 이번 PRD에서 누락**"이 박혀 있다.
- **의도(intent)**: `~/.gemini/settings.json`, `~/.claude/settings.json`, `~/.codex/config.toml` 모두의 `tfx-hub` URL을 현재 Hub 주소로 맞추는 것.
- **실제 결과**: Issue #79는 CLOSED지만 `scripts/sync-hub-mcp-settings.mjs`는 `.gemini/.claude/.claude/settings.local.json`만 다루고 `.codex/config.toml`은 건드리지 않는다.
- **유실 메커니즘**: JSON 설정 동기화만 먼저 구현된 뒤 이슈가 닫혀 follow-up이 가려졌다.
- **권장 액션**: **PR** — 이미 재현/범위가 좁다. TOML 파싱/쓰기만 보완하면 된다.

### [S3] 실패 shard worktree 자동 정리 누락 — type: `intent`+`bug`+`omission`
- 세션: `51316549-2a89-4434-bfe5-6e5d64446db3`, 시각: `2026-04-17T06:51:14Z`
- **맥락(context)**: "`wt-hub-port-lock` ... stale worktree 남아 있음" / "실패 shard: 자동 `git worktree remove --force`"
- **의도(intent)**: F1/F2/F3 실패 shard는 종료 시 자동 prune하고, 성공 shard만 남기는 것.
- **실제 결과**: Issue #80이 OPEN 상태로 남아 있고, 현 코드 검색에서도 실패 shard cleanup 구현 흔적은 문서 외에 보이지 않는다.
- **유실 메커니즘**: 기존 고아 worktree 정리(#34/#37)는 해결됐지만, hypervisor 실패 경로 cleanup은 별도 과제로 미뤄졌다.
- **권장 액션**: **PR** — stale worktree 누적은 운영 피로를 바로 만든다. `swarm-hypervisor.mjs` shutdown 경로를 우선 점검.

### [S4] PR #73 macOS 심층 호환성 검증이 보류된 채 남음 — type: `context`+`intent`+`omission`
- 세션: `51316549-2a89-4434-bfe5-6e5d64446db3`, 시각: `2026-04-17T06:29:21Z`
- **맥락(context)**: "#73은 플랫폼 회귀 smoke test 필요 → 보류" / 이후 요약도 "#73 보류".
- **의도(intent)**: macOS deep compat PR을 merge 전에 회귀 smoke test로 검증하는 것.
- **실제 결과**: 세션의 초점이 #72/#75와 Gemini 재현으로 이동했고, 현재 `gh pr view 73`도 여전히 OPEN + mergeability UNKNOWN이다.
- **유실 메커니즘**: 더 긴급한 merge/재현 작업이 끼어들며 검증 체크리스트가 실행되지 않았다.
- **권장 액션**: **PR** — 새 브랜치보다 기존 PR #73에서 smoke test evidence를 추가하는 게 맞다.

### [S5] Synapse Layer 4 Hub 통합은 한 번 유실됐지만 후속 커밋으로 회수됨 — type: `intent`+`loss`
- 세션: `f68045d8-91c5-43c0-8bf3-ce0d7930ede7`, 시각: `2026-04-11T06:46:52Z`
- **맥락(context)**: "Hub 통합 TODO (아직 안 함)" / "`hub/server.mjs`를 건드리면 충돌"
- **의도(intent)**: `createSynapseRegistry` + `createGitPreflight`를 Hub에 배선하는 Layer 4 마무리.
- **실제 결과**: 해당 세션에서는 병렬 충돌 때문에 보류됐지만, 후속 커밋 `fbcd63e`/`6c73f2a`가 Layer 4 배선 구현으로 회수했다.
- **유실 메커니즘**: 세션 단위로는 중단됐지만, 별도 후속 세션/커밋이 맥락을 인수했다.
- **권장 액션**: **skip** — 재작업 대상은 아니고, 나중에 Synapse 회귀를 볼 때 "한 번 보류됐다가 후속 커밋으로 회수됨"이라는 맥락만 참고하면 된다.
