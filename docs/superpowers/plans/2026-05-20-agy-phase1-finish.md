# Agy Phase 1 Finish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the Antigravity Phase 1 branch without deleting already-merged work from other sessions, and verify the branch on the current host.

**Architecture:** Keep the branch as a small additive patch on top of `origin/main`. Preserve the merged Tier 2 wrapper/test/docs work from PRs #296, #297, and #301, then layer only the readiness gate, HUD `a` lane behavior, fake `agy` fixture, and targeted regression tests.

**Tech Stack:** Git worktree, Node.js native test runner, shell route wrapper, Biome, `better-sqlite3` native binding, Triflux mirror checks.

---

### Task 1: Rebase Without Deleting Other Sessions' Work

Status: completed. Branch was rebased onto `origin/main` after PRs #296/#297/#301 were already merged, preserving those files and eliminating the stale reverse-deletes.

**Files:**
- Modify only through git conflict resolution if needed: `scripts/tfx-route.sh`, `packages/triflux/scripts/tfx-route.sh`, `tests/integration/agy-stdout-pipe.test.mjs`, `.claude/rules/tfx-update-logic.md`
- Preserve: `.triflux/plans/agy-subagents-integration-eval.md`, `.triflux/plans/node-cli-single-entry-migration.md`, `.gitignore`

- [x] **Step 1: Verify branch divergence**

Run:

```bash
git fetch origin
git rev-list --left-right --count HEAD...origin/main
git log --oneline --decorate --left-right --cherry-pick --max-count=10 HEAD...origin/main
```

Expected: branch has one local commit and `origin/main` has the merged #296/#297/#301 commits.

- [x] **Step 2: Rebase the local patch onto latest main**

Run:

```bash
git rebase origin/main
```

Expected: either clean rebase or conflicts only in the Antigravity route/test/doc surfaces.

- [x] **Step 3: Resolve conflicts by preserving main plus local safety gates**

If conflicts occur, keep the `origin/main` docs/plans and merged `agy` behavior, then re-apply only these local additions:

```text
preflight-cache: antigravity readiness requires agy exists, --print support, --dangerously-skip-permissions support, and auth file.
tfx-route: quota auto-reroute may choose antigravity only when TFX_ANTIGRAVITY_OK=1 and agy_supports_headless passes.
HUD: when Antigravity readiness is true, render the Gemini-family lane as marker a and do not render marker g.
tests: keep fake agy fixture and targeted readiness/HUD/reroute regression tests.
```

- [x] **Step 4: Confirm no reverse-deletions remain**

Run:

```bash
git diff --name-status origin/main..HEAD
```

Expected: no `D .triflux/plans/...` lines and no unrelated `.gitignore` reversal.

### Task 2: Repair better-sqlite3 Host Verification

Status: completed for the current Node 26 host by upgrading `better-sqlite3` from `12.6.2` to `12.10.0`, the current npm version whose engine range includes Node 26.

**Files:**
- `package.json`
- `package-lock.json`
- Native artifact expected under `node_modules/better-sqlite3/build/Release/better_sqlite3.node`.

- [x] **Step 1: Probe the native binding**

Run:

```bash
node -e "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.exec('select 1'); db.close(); console.log('better-sqlite3-ok')"
```

Observed before repair: `new Database(':memory:')` failed because no Node 26 native binding existed for locked `better-sqlite3@12.6.2`.

- [x] **Step 2: Upgrade and rebuild if the binding is still missing**

Run:

```bash
npm view better-sqlite3@latest version engines
npm install --ignore-scripts better-sqlite3@^12.10.0
npm rebuild better-sqlite3
```

Expected: latest engine range includes Node 26 and rebuild exits `0`.

- [x] **Step 3: Re-run the native binding probe**

Run:

```bash
node -e "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.exec('select 1'); db.close(); console.log('better-sqlite3-ok')"
```

Expected: `better-sqlite3-ok`.

### Task 3: Re-run Focused and Full Verification

Status: completed. Focused route/HUD/preflight tests passed after rebase. The full suite initially failed on the missing SQLite binding and backend registry gap, then passed after upgrading `better-sqlite3` and registering the Antigravity backend.

**Files:**
- No source changes expected after this point unless a test exposes a real branch issue.

- [x] **Step 1: Run focused branch tests**

Run:

```bash
node scripts/test-lock.mjs --test tests/hud/hud-qos-status.test.mjs
node scripts/test-lock.mjs --test tests/unit/routing-qa.test.mjs
node scripts/test-lock.mjs --test tests/unit/preflight-cache-antigravity.test.mjs
node scripts/test-lock.mjs --test tests/integration/agy-stdout-pipe.test.mjs
node scripts/test-lock.mjs --test tests/integration/tfx-route-quota.test.mjs
node scripts/test-lock.mjs --test tests/unit/cache-buildup.test.mjs
```

Expected: all focused tests pass.

- [x] **Step 2: Run static and mirror checks**

Run:

```bash
npx biome check hud packages/triflux/hud packages/core/hud tests/hud/hud-qos-status.test.mjs scripts/preflight-cache.mjs packages/triflux/scripts/preflight-cache.mjs tests/unit/preflight-cache-antigravity.test.mjs tests/integration/agy-stdout-pipe.test.mjs tests/integration/tfx-route-quota.test.mjs
bash -n scripts/tfx-route.sh
bash -n packages/triflux/scripts/tfx-route.sh
cmp -s scripts/tfx-route.sh packages/triflux/scripts/tfx-route.sh && echo tfx-route-mirror-ok
cmp -s scripts/preflight-cache.mjs packages/triflux/scripts/preflight-cache.mjs && echo preflight-mirror-ok
node scripts/release/check-packages-mirror.mjs
node scripts/release/check-sync.mjs
git diff --check
```

Expected: all checks pass.

- [x] **Step 3: Run full suite after native binding is available**

Run:

```bash
npm test
```

Observed: `npm test` passed with 3634 tests, 3622 pass, 12 skip, 0 fail.

### Task 4: Commit Final Rebased Result

Status: completed. Final verification is complete and the single local Lore commit is ready to amend.

**Files:**
- Commit only intentional branch files and this plan if it remains useful.

- [x] **Step 1: Review final diff**

Run:

```bash
git diff --stat origin/main..HEAD
git diff --name-status origin/main..HEAD
git status --short
```

Expected: diff contains only the final branch additions, and worktree is clean after commit.

- [x] **Step 2: Amend or create the final Lore commit**

Run:

```bash
git add <intentional files>
git commit --amend
```

Expected: one clean local commit on top of `origin/main` with Lore trailers updated to include the latest full-suite evidence.
