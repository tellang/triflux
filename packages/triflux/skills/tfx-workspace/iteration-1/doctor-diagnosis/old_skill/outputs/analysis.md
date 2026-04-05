# tfx-doctor Routing Analysis

## User Request
"HUD가 안 보이고 codex도 안 되는데 어떻게 해?"

---

## 1. Mode Selection

**Mode used: default (진단만)**

Rationale:
- The user is reporting two symptoms: HUD not visible and Codex not working.
- The request does not contain any explicit repair intent ("--fix"), cache reset request ("캐시 초기화", "리셋", "reset"), or destructive intent.
- The skill's auto-suggest trigger list includes both "HUD가 안 보여" and "codex/gemini가 안 돼", which directly match the user's message.
- Because no `--fix` or `--reset` flag is implied, the skill begins in read-only diagnostic mode.
- After the diagnostic report is shown, `--fix` would be **suggested** to the user as a next step.

---

## 2. Exact Bash Command That Would Be Run

```bash
Bash("triflux doctor")
```

No additional flags. This is the read-only diagnostic path.

---

## 3. Diagnostics Checked

The `triflux doctor` command (default mode) checks all of the following:

| Diagnostic Item | Relevance to This Request |
|----------------|--------------------------|
| tfx-route.sh 설치 상태 | General health baseline |
| HUD 설치 및 설정 상태 | **Directly relevant** — user reports HUD not visible |
| Codex/Gemini/Claude CLI 경로 (크로스 셸) | **Directly relevant** — user reports Codex not working |
| 스킬 설치 상태 | General health |
| 플러그인 등록 상태 | General health |
| MCP 인벤토리 캐시 | Could affect HUD and CLI display |
| CLI 이슈 트래커 | May log the Codex failure |
| 잔존 팀(orphan teams) 감지 (`~/.claude/teams/`) | General health |

All eight diagnostic areas are checked in default mode — none are skipped.

---

## 4. Whether --fix Would Be Suggested

**Yes.** After the diagnostic report is displayed, `--fix` would be recommended to the user as the next step if any issues are found (e.g., HUD misconfiguration, missing Codex CLI path, corrupted cache). The skill definition explicitly states:

> 수정 모드 (`/tfx-doctor --fix`): 진단 전에 자동 수정을 시도합니다.

The agent would prompt: "문제가 발견되었습니다. `/tfx-doctor --fix`를 실행하여 자동 수정을 시도하시겠습니까?"

---

## 5. Whether --reset Would Be Used (and Why/Why Not)

**No. `--reset` would NOT be used.**

Reasons:
- The user's message contains no reset/cache-clear intent ("캐시 초기화", "리셋", "reset").
- `--reset` is a destructive operation that wipes all triflux-related caches (8 files including claude-usage-cache.json, mcp-inventory.json, etc.).
- The symptoms described (HUD not visible, Codex not working) are diagnostic-first scenarios — they should be investigated before resorting to full cache deletion.
- Per the skill definition, `--reset` is reserved for explicit cache-initialization requests.
- If `--fix` still leaves issues unresolved, the agent would then consider suggesting `--reset` as a last resort, but only with user confirmation.

---

## 6. Expected Report Format

After `triflux doctor` runs, the agent reports results in this structure:

```
## triflux doctor 진단 결과

| 항목 | 상태 | 비고 |
|------|------|------|
| tfx-route.sh | ✓ / ✗ | ... |
| HUD | ✓ / ✗ | 설치됨/설치 안됨/설정 오류 |
| Codex CLI 경로 | ✓ / ✗ | 경로 발견/미발견 |
| Gemini CLI 경로 | ✓ / ✗ | ... |
| Claude CLI 경로 | ✓ / ✗ | ... |
| 스킬 설치 상태 | ✓ / ✗ | ... |
| 플러그인 등록 | ✓ / ✗ | ... |
| MCP 인벤토리 캐시 | ✓ / ✗ | ... |
| CLI 이슈 트래커 | ✓ / ✗ | ... |
| orphan teams | ✓ / ✗ | ... |

이슈가 발견되었습니다. `/tfx-doctor --fix`로 자동 수정을 시도할 수 있습니다.
```

If no issues are found:
```
모든 진단 항목이 정상입니다.
```

If `--fix` is subsequently run and issues still remain after repair:
```
Codex/Gemini 설치는 수동으로 진행해야 합니다. (설치 안내 링크 또는 명령어 제공)
```

---

## Summary

| Decision Point | Result |
|----------------|--------|
| Skill triggered | tfx-doctor |
| Mode | default (read-only diagnostic) |
| Command | `Bash("triflux doctor")` |
| HUD diagnosed | Yes |
| Codex CLI path diagnosed | Yes |
| --fix suggested after report | Yes (if issues found) |
| --reset used | No |
| --reset trigger condition | Only if user explicitly requests cache reset |
