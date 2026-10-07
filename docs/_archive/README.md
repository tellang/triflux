# _archive : 보존 아카이브

Superseded / Deprecated / Rejected / Withdrawn 상태가 된 문서를 **삭제하지 않고** 여기로 옮긴다(추적성 보존).

## 규칙 (근거: [../adr/CONVENTIONS.md](../adr/CONVENTIONS.md) MUST #2)

- **"완료(done)"는 아카이빙 트리거가 아니다.** accepted ADR은 살아있는 정본으로 원위치에 남는다.
- 아카이빙은 **대체/무효화**일 때만: `superseded`(+`superseded_by`), `deprecated`, `rejected`, `withdrawn`.
- 수동 절차는 상태 변경, 보관 경로 이동, 상태보드 링크 갱신 순서로 진행한다.
- 자동화는 `.document-harness.toml`의 `automation_trigger` 충족 시 도입한다.
- 제거된 구현의 문서는 ADR-0012에 따라 폐기 사유와 제거 커밋을 기록한다. 기존 보관 PRD의 위치만 정정할 때는 문서 이력을 기록하며 구현 전체가 제거됐다고 간주하지 않는다.
- 보관 본문은 과거 기록이다. 원래 경로와 코드 인용은 당시 상태를 나타낸다. 현재 구현 지시로 사용하지 않는다.
- JSON 부속 설정은 첫 필드 `_deprecation`에 폐기 표시를 넣어 JSON 형식을 유지한다.

## 이번에 정리한 보관 문서

| 원래 위치 | 보관 문서 |
|---|---|
| `docs/prd/archived/3cli-profile-unification.md` | [3cli-profile-unification.md](prd/archived/3cli-profile-unification.md) |
| `docs/prd/archived/account-broker-fixes.md` | [account-broker-fixes.md](prd/archived/account-broker-fixes.md) |
| `docs/prd/archived/account-broker-refactor.md` | [account-broker-refactor.md](prd/archived/account-broker-refactor.md) |
| `docs/prd/archived/broker-dashboard-v2.md` | [broker-dashboard-v2.md](prd/archived/broker-dashboard-v2.md) |
| `docs/prd/archived/cache-guard-update-async.md` | [cache-guard-update-async.md](prd/archived/cache-guard-update-async.md) |
| `docs/prd/archived/claudemd-auto-sync.md` | [claudemd-auto-sync.md](prd/archived/claudemd-auto-sync.md) |
| `docs/prd/archived/fix-crlf-and-hook-noise.md` | [fix-crlf-and-hook-noise.md](prd/archived/fix-crlf-and-hook-noise.md) |
| `docs/prd/archived/headless-hub-wireup.md` | [headless-hub-wireup.md](prd/archived/headless-hub-wireup.md) |
| `docs/prd/archived/hitl-bridge-wireup.md` | [hitl-bridge-wireup.md](prd/archived/hitl-bridge-wireup.md) |
| `docs/prd/archived/lake3-mcp-singleton.md` | [lake3-mcp-singleton.md](prd/archived/lake3-mcp-singleton.md) |
| `docs/prd/archived/lake3-remote-handoff.md` | [lake3-remote-handoff.md](prd/archived/lake3-remote-handoff.md) |
| `docs/prd/archived/lake3-session-sync.md` | [lake3-session-sync.md](prd/archived/lake3-session-sync.md) |
| `docs/prd/archived/lake4-context-monitor.md` | [lake4-context-monitor.md](prd/archived/lake4-context-monitor.md) |
| `docs/prd/archived/lake4-token-manifest.md` | [lake4-token-manifest.md](prd/archived/lake4-token-manifest.md) |
| `docs/prd/archived/lake4d-test-hardening.md` | [lake4d-test-hardening.md](prd/archived/lake4d-test-hardening.md) |
| `docs/prd/archived/lake4e-lake5-bridge.md` | [lake4e-lake5-bridge.md](prd/archived/lake4e-lake5-bridge.md) |
| `docs/prd/archived/phase3-infra-20260417.md` | [phase3-infra-20260417.md](prd/archived/phase3-infra-20260417.md) |
| `docs/prd/archived/pipe-handoff-publish-bridge.md` | [pipe-handoff-publish-bridge.md](prd/archived/pipe-handoff-publish-bridge.md) |
| `docs/prd/archived/pr-rebase-fix-20260417.md` | [pr-rebase-fix-20260417.md](prd/archived/pr-rebase-fix-20260417.md) |
| `docs/prd/archived/pr86-p1-blockers-20260417.md` | [pr86-p1-blockers-20260417.md](prd/archived/pr86-p1-blockers-20260417.md) |
| `docs/prd/archived/pr86-p1-fixes-draft-20260417.md` | [pr86-p1-fixes-draft-20260417.md](prd/archived/pr86-p1-fixes-draft-20260417.md) |
| `docs/prd/archived/recovery-1w-20260417.md` | [recovery-1w-20260417.md](prd/archived/recovery-1w-20260417.md) |
| `docs/prd/archived/remaining-issues-batch.md` | [remaining-issues-batch.md](prd/archived/remaining-issues-batch.md) |
| `docs/prd/archived/sendinput-mcp-tool.md` | [sendinput-mcp-tool.md](prd/archived/sendinput-mcp-tool.md) |
| `docs/prd/archived/session-followups-20260417.md` | [session-followups-20260417.md](prd/archived/session-followups-20260417.md) |
| `docs/prd/archived/setup-hud-sync.md` | [setup-hud-sync.md](prd/archived/setup-hud-sync.md) |
| `docs/prd/archived/skill-template-conversion.md` | [skill-template-conversion.md](prd/archived/skill-template-conversion.md) |
| `docs/prd/archived/smart-tfx-auto-router.md` | [smart-tfx-auto-router.md](prd/archived/smart-tfx-auto-router.md) |
| `docs/prd/archived/untracked-cleanup.md` | [untracked-cleanup.md](prd/archived/untracked-cleanup.md) |
| `docs/prd/archived/wt-manager-step2-safety-guard.md` | [wt-manager-step2-safety-guard.md](prd/archived/wt-manager-step2-safety-guard.md) |
| `docs/prd/archived/wt-profile-bugfix-verify.md` | [wt-profile-bugfix-verify.md](prd/archived/wt-profile-bugfix-verify.md) |
| `docs/prd/archived/wt-psmux-phase1.md` | [wt-psmux-phase1.md](prd/archived/wt-psmux-phase1.md) |
| `.triflux/plans/0011-active-cto-lead-role-system.md` | [0011-active-cto-lead-role-system.md](triflux/plans/0011-active-cto-lead-role-system.md) |
| `.triflux/plans/0011a-c6a-contracts.md` | [0011a-c6a-contracts.md](triflux/plans/0011a-c6a-contracts.md) |
| `.triflux/plans/resident-cto-manager.md` | [resident-cto-manager.md](triflux/plans/resident-cto-manager.md) |
| `.triflux/plans/agy-subagents-integration-eval.md` | [agy-subagents-integration-eval.md](triflux/plans/agy-subagents-integration-eval.md) |
| `docs/architecture.reading.md` | [architecture.reading.md](architecture.reading.md) |
| `docs/.obsidian/app.json` | [app.json](.obsidian/app.json) |
| `docs/.obsidian/appearance.json` | [appearance.json](.obsidian/appearance.json) |
| `docs/.obsidian/core-plugins.json` | [core-plugins.json](.obsidian/core-plugins.json) |
| `docs/.wiki-harness/refs/architecture.json` | [architecture.json](.wiki-harness/refs/architecture.json) |
| `docs/design/tui-dashboard-v8.md` | [tui-dashboard-v8.md](design/tui-dashboard-v8.md) |
| `docs/adr/0011-active-role-system-cto-scoped-lead.md` | [ADR-0011](adr/0011-active-role-system-cto-scoped-lead.md), ADR-0024로 대체 |
