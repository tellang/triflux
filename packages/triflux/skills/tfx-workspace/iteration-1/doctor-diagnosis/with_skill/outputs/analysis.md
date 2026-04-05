# tfx-doctor Routing Analysis

## User Request

> "HUD가 안 보이고 codex도 안 되는데 어떻게 해?"

---

## Skill Matched

**tfx-doctor** (`skills/tfx-doctor/SKILL.md`)

The request directly matches two of the documented auto-suggestion triggers:
- "HUD가 안 보여" → maps to "HUD가 안 보이고"
- "codex/gemini가 안 돼" → maps to "codex도 안 되는데"

---

## Mode Selected

**Default mode** (`/tfx-doctor` — 진단만, 읽기 전용)

Rationale: The user is reporting symptoms ("안 보이고", "안 되는데") but has not asked for an automatic fix, a reset, or a cache wipe. The skill definition states that the default mode is read-only diagnosis only. `--fix` would be *suggested* after the diagnosis if issues are found, but it would not be applied automatically without user consent. `--reset` is not appropriate here because the user has not said "캐시 초기화", "리셋", or "reset".

---

## Exact Bash Command That Would Be Run

```bash
Bash("triflux doctor")
```

No flags. This is the single command executed in default mode.

---

## Diagnostics Checked

The skill definition lists the following items that `triflux doctor` inspects:

| # | Diagnostic Item | Relevance to this Request |
|---|-----------------|--------------------------|
| 1 | tfx-route.sh 설치 상태 | Baseline routing check |
| 2 | HUD 설치 및 설정 상태 | Directly relevant — HUD가 안 보임 |
| 3 | Codex/Gemini/Claude CLI 경로 (크로스 셸) | Directly relevant — codex 안 됨 |
| 4 | 스킬 설치 상태 | General health |
| 5 | 플러그인 등록 상태 | General health |
| 6 | MCP 인벤토리 캐시 | Could affect HUD/Codex behaviour |
| 7 | CLI 이슈 트래커 | May surface logged errors |
| 8 | 잔존 팀(orphan teams) 감지 (`~/.claude/teams/`) | General health |

Both primary symptoms (HUD invisible, Codex not working) are covered by items 2 and 3.

---

## --fix Suggestion

**Yes — `--fix` would be suggested** after the diagnosis report is returned to the user.

The skill's error-handling table states: "if issues remain after `--fix`, manual installation of Codex/Gemini is guided." This implies the flow is:

1. Run default diagnosis → report findings.
2. If issues are found, offer the user the option to re-run with `--fix`.
3. User decides; skill does not auto-escalate.

---

## --reset Decision

**`--reset` would NOT be used.**

Reasons:
- The user did not request a cache wipe, full reset, or use the words "리셋", "초기화", or "reset".
- `--reset` is a destructive, irreversible operation (deletes all cache files listed in the skill) and must only be triggered by explicit user intent.
- The reported symptoms (HUD invisible, Codex not working) are diagnostic problems, not confirmed cache-corruption problems. A reset would be premature without diagnosis confirming a cache issue.

---

## Expected Report Format

After `triflux doctor` completes, the output is relayed to the user verbatim (per the skill: "결과를 사용자에게 보고합니다"). Based on the diagnostic items, the expected report structure is:

```
[triflux doctor] 진단 결과
─────────────────────────────────
✓ / ✗  tfx-route.sh 설치 상태
✓ / ✗  HUD 설치 및 설정 상태
✓ / ✗  Codex CLI 경로
✓ / ✗  Gemini CLI 경로
✓ / ✗  Claude CLI 경로
✓ / ✗  스킬 설치 상태
✓ / ✗  플러그인 등록 상태
✓ / ✗  MCP 인벤토리 캐시
✓ / ✗  CLI 이슈 트래커
✓ / ✗  잔존 팀(orphan teams)
─────────────────────────────────
N개 이슈 발견. --fix로 자동 수정하려면: /tfx-doctor --fix
```

If `--fix` is subsequently accepted by the user, the report repeats after remediation, showing whether items moved from ✗ to ✓. Any items that `--fix` cannot resolve (e.g., Codex not installed) are surfaced with a manual-installation note.

---

## Summary

| Decision Point | Answer |
|----------------|--------|
| Skill triggered | tfx-doctor |
| Mode | default (진단만) |
| Command run | `triflux doctor` |
| HUD checked | Yes |
| CLI paths checked | Yes (Codex, Gemini, Claude) |
| --fix suggested | Yes, after diagnosis |
| --fix auto-applied | No |
| --reset used | No |
