# CTO Per-Project Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Revision 3** — incorporates two engineering-review rounds (critic). R2 addressed F1-F5; R3 fixes the two blockers the R2 decomposition exposed: **NEW-1 (P0)** — `ensureRoleLeader`'s arity change is now migrated across ALL 6 call sites atomically inside Task 3 (Step 9b), so no task strands a caller passing the options object in the scope slot; **NEW-2 (P1)** — `role_scope` is persisted as a dedicated TOP-LEVEL `messages` column (not injected into the user payload), so the `topic:cto` consumer payload contract and existing `deepEqual` payload assertions are unchanged. Task 4 is reduced to `listRoleScopes` + `reelectStaleRoles` (entry-point migration moved into Task 3). Earlier R2 changes retained: register chokepoint, phantom-leader guards, corrected remote mirror matrix.

**Goal:** Make CTO role leadership genuinely per-project so each repo connected to one hub elects, fails over, routes, replays, and displays its own independent CTO leader instead of sharing one hub-global leader.

**Architecture:** Today `hub/router.mjs` keeps a single `roleStates = Map<roleName, state>` keyed by role name only — one CTO per hub process. We re-key it to `Map<"role::scope", state>` where `scope` is the agent's `repoRootHash` (a stable djb2 hash of its git toplevel, the SAME hash `cto/status.mjs` already produces). The hub cannot derive an agent's repo from its own `process.cwd()`, so the agent supplies `cwd`/`repo_root` in the register payload's `metadata`; `router.registerAgent` (the single chokepoint that `hub/pipe.mjs`, `hub/tools.mjs`, and the CLI bridge all funnel through) normalizes that into `metadata.repoRootHash`. Election, succession, `topic:cto` routing, backlog transfer, audit replay, takeover, and status all become scope-aware. The message's resolved scope is persisted in `payload_json` so the audit-replay path stays correct. `getStatus` keeps `data.roles.cto` as the `global`-scope snapshot for backward compatibility and adds `data.role_scopes.cto` (one snapshot per project). The tray reads `role_scopes` and renders each project's CTO inside that project's group.

**Tech Stack:** Node.js ESM (`.mjs`), `node:test` + `node:assert`, better-sqlite3 (audit store), Biome (lint/format), plain HTML/JS tray (`hub/public/tray.html`).

## Global Constraints

- **Mirror policy** (`.claude/rules/tfx-mirror-policy.md` + verified against `scripts/pack.mjs`):
  | Root file | Mirrors to | Note |
  |-----------|-----------|------|
  | `hub/router.mjs` | `packages/core/`, `packages/triflux/` | byte-identical; NOT remote |
  | `hub/bridge.mjs` | `packages/core/`, `packages/triflux/` | byte-identical; NOT remote |
  | `hub/lib/repo-scope.mjs` (new) | `packages/core/`, `packages/triflux/` | byte-identical (CORE_DIRS includes `hub/lib`); NOT a remote file |
  | `cto/status.mjs` | `packages/triflux/`, **`packages/remote/`** | remote copy gets the `../hub/lib/repo-scope.mjs` import rewritten to `@triflux/core/hub/lib/repo-scope.mjs` by `pack.mjs` |
  | `hub/server.mjs` | `packages/triflux/`, **`packages/remote/`** | |
  | `hub/tray-state.mjs` | `packages/triflux/`, **`packages/remote/`** | |
  | `hub/public/tray.html` | `packages/triflux/`, **`packages/remote/`** | (REMOTE_DIRS includes `hub/public`) |
  - Use `node scripts/pack.mjs all` for the sync (handles the remote import rewrite), then verify with `diff -q` for byte-identical targets AND a `grep` that `packages/remote/cto/status.mjs` imports `@triflux/core/hub/lib/repo-scope.mjs` (NOT `../hub/lib`). NEVER hand-`cp` into `packages/remote`. `tests/**` are NOT mirrored.
- **Commit hygiene** (triflux policy): NO `Co-Authored-By`, NO AI attribution trailer in any commit message. Plain conventional-commit subjects only.
- **Scope hash parity:** the scope key MUST equal `shortHash(deriveRepoRootFromCwd(cwd))` — identical to `cto/status.mjs`'s `repoRootHash` — so the tray correlates role scopes with session rows. `deriveRepoRootFromCwd` strips `.worktrees/`, `.claude/worktrees/`, `.codex-swarm/wt-*` suffixes, so two worktrees of the SAME repo share one scope (invariant pinned by a test in Task 10). The `global` sentinel (`DEFAULT_ROLE_SCOPE`) is used only when no repo root is resolvable.
- **Backward compatibility:** agents that register without resolvable scope land in the `global` scope. `getStatus("hub").data.roles.cto` MUST keep returning the `global`-scope snapshot so existing consumers and the existing `tests/integration/router.test.mjs` CTO tests pass unchanged.
- **Lint:** `npm run lint` (Biome `check` = lint + format) must pass before every commit.
- **Test commands:**
  - Router integration only: `node scripts/test-lock.mjs --test --test-force-exit --test-concurrency=8 tests/integration/router.test.mjs`
  - Unit only (single file): `node scripts/test-lock.mjs --test --test-force-exit --test-concurrency=8 tests/unit/repo-scope.test.mjs`
  - Full suite + skill lint: `npm test`
  - Lint: `npm run lint`

---

## File Structure

| File | Responsibility | Action |
|------|---------------|--------|
| `hub/lib/repo-scope.mjs` | Single source for `shortHash`, `deriveRepoRootFromCwd`, `repoScopeHash`, `buildRegisterScopeMetadata`, `DEFAULT_ROLE_SCOPE`. | Create |
| `cto/status.mjs` | Import the shared hash helpers instead of local copies (DRY + parity). | Modify |
| `hub/bridge.mjs` | `cmdRegister` sends `cwd`/`repo_root`/`repoRootHash` in register metadata. | Modify |
| `hub/router.mjs` | Scope-normalize at `registerAgent`; scope-key role state; scope-aware election, succession, routing, backlog, replay, takeover, status. | Modify |
| `hub/store.mjs` | `auditLog`/`insertAuditMessage` persist `role_scope`; `ensureColumn` migration; `SCHEMA_VERSION` bump. | Modify |
| `hub/schema.sql` | Add `role_scope TEXT` to `messages`. | Modify |
| `hub/server.mjs` | `/api/tray-state` forwards `role_scopes`. | Modify |
| `hub/tray-state.mjs` | `normalizeCtoStatus` passes `role_scopes` through. | Modify |
| `hub/public/tray.html` | Render one CTO row per project scope inside its own project group. | Modify |
| `tests/unit/repo-scope.test.mjs` | Unit-test the hash helper + parity + register metadata. | Create |
| `tests/integration/router.test.mjs` | New `describe`: per-project election, failover, routing, replay, takeover, status, scope-churn, chokepoint, worktree invariant. | Modify |
| `tests/unit/tray-state.test.mjs` | Assert `role_scopes` survives `buildTrayStatePayload`. | Create or extend |

---

## Task 1: Shared repo-scope helper + DRY refactor of cto/status.mjs

**Files:**
- Create: `hub/lib/repo-scope.mjs`
- Modify: `cto/status.mjs:35-44` (delete local `shortHash`), `cto/status.mjs:53-88` (delete local `deriveRepoRootFromCwd`), add import + re-export
- Test: `tests/unit/repo-scope.test.mjs`

**Interfaces:**
- Produces:
  - `export const DEFAULT_ROLE_SCOPE = "global"`
  - `export function shortHash(value: string): string` — djb2, base36
  - `export function deriveRepoRootFromCwd(cwd: string): string`
  - `export function repoScopeHash(cwd: string): string`
  - `export function buildRegisterScopeMetadata(cwd: string): { cwd, repo_root, repoRootHash }` (used by Task 2)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/repo-scope.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ROLE_SCOPE,
  shortHash,
  deriveRepoRootFromCwd,
  repoScopeHash,
  buildRegisterScopeMetadata,
} from "../../hub/lib/repo-scope.mjs";

test("shortHash is deterministic djb2 base36", () => {
  assert.equal(shortHash("/Users/me/proj"), shortHash("/Users/me/proj"));
  assert.notEqual(shortHash("/a"), shortHash("/b"));
  assert.equal(shortHash(""), (5381 >>> 0).toString(36));
});

test("deriveRepoRootFromCwd strips worktree suffixes", () => {
  assert.equal(deriveRepoRootFromCwd("/Users/me/proj/.worktrees/feat-x"), "/Users/me/proj");
  assert.equal(deriveRepoRootFromCwd("/Users/me/proj/.claude/worktrees/feat-x/sub"), "/Users/me/proj");
  assert.equal(deriveRepoRootFromCwd("/Users/me/proj/.codex-swarm/wt-1/x"), "/Users/me/proj");
  assert.equal(deriveRepoRootFromCwd("/Users/me/proj"), "/Users/me/proj");
});

test("repoScopeHash matches cto/status repoRootHash convention", () => {
  const cwd = "/Users/me/proj/.worktrees/feat-x";
  assert.equal(repoScopeHash(cwd), shortHash(deriveRepoRootFromCwd(cwd)));
});

test("two worktrees of the same repo share one scope", () => {
  assert.equal(
    repoScopeHash("/Users/me/proj/.worktrees/a"),
    repoScopeHash("/Users/me/proj/.claude/worktrees/b"),
  );
});

test("repoScopeHash collapses empty cwd to global sentinel", () => {
  assert.equal(repoScopeHash(""), DEFAULT_ROLE_SCOPE);
  assert.equal(repoScopeHash(null), DEFAULT_ROLE_SCOPE);
});

test("buildRegisterScopeMetadata stamps cwd, repo_root, repoRootHash", () => {
  const meta = buildRegisterScopeMetadata("/Users/me/proj/.worktrees/feat-x");
  assert.equal(meta.repo_root, "/Users/me/proj");
  assert.equal(meta.repoRootHash, repoScopeHash("/Users/me/proj/.worktrees/feat-x"));
  assert.equal(meta.cwd, "/Users/me/proj/.worktrees/feat-x");
});

test("buildRegisterScopeMetadata uses global sentinel when cwd missing", () => {
  assert.equal(buildRegisterScopeMetadata("").repoRootHash, DEFAULT_ROLE_SCOPE);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-lock.mjs --test --test-force-exit --test-concurrency=8 tests/unit/repo-scope.test.mjs`
Expected: FAIL with `Cannot find module '.../hub/lib/repo-scope.mjs'`

- [ ] **Step 3: Create the helper**

Create `hub/lib/repo-scope.mjs` (`shortHash` + `deriveRepoRootFromCwd` bodies copied verbatim from `cto/status.mjs:37-44` and `:53-88` so hash values are identical):

```javascript
// hub/lib/repo-scope.mjs — stable per-project scope keys for hub role state.
// shortHash is the SAME djb2 used by cto/status.mjs so scope keys correlate
// with the repoRootHash shown in the CTO console / tray.

export const DEFAULT_ROLE_SCOPE = "global";

// Non-cryptographic djb2-style hash used only to produce stable redacted
// labels for local paths. Do not use this as a trust boundary or secret token.
export function shortHash(value) {
  const str = String(value ?? "");
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (h * 33) ^ str.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

export function deriveRepoRootFromCwd(cwd) {
  if (typeof cwd !== "string" || !cwd) return "";
  if (cwd.includes("\\") || /^[A-Za-z]:/u.test(cwd)) return cwd;

  const normalized = cwd.replace(/\/+$/u, "");
  const gitWorktreeMarker = "/.worktrees/";
  const gitWorktreeIndex = normalized.indexOf(gitWorktreeMarker);
  if (gitWorktreeIndex > 0) {
    const suffix = normalized.slice(gitWorktreeIndex + gitWorktreeMarker.length);
    if (/^[^/]+(?:\/|$)/u.test(suffix)) {
      return normalized.slice(0, gitWorktreeIndex);
    }
  }

  const claudeMarker = "/.claude/worktrees/";
  const claudeIndex = normalized.indexOf(claudeMarker);
  if (claudeIndex > 0) {
    const suffix = normalized.slice(claudeIndex + claudeMarker.length);
    if (/^[^/]+(?:\/|$)/u.test(suffix)) {
      return normalized.slice(0, claudeIndex);
    }
  }

  const codexMarker = "/.codex-swarm/";
  const codexIndex = normalized.indexOf(codexMarker);
  if (codexIndex > 0) {
    const suffix = normalized.slice(codexIndex + codexMarker.length);
    if (/^wt-[^/]+(?:\/|$)/u.test(suffix)) {
      return normalized.slice(0, codexIndex);
    }
  }

  return cwd;
}

// Stable scope key for a working directory. Empty/unknown cwd collapses to
// DEFAULT_ROLE_SCOPE so unscoped agents share one bucket.
export function repoScopeHash(cwd) {
  const root = deriveRepoRootFromCwd(typeof cwd === "string" ? cwd : "");
  return root ? shortHash(root) : DEFAULT_ROLE_SCOPE;
}

// Register-time metadata describing the agent's project scope. Pure so the
// register path stays testable without a live hub.
export function buildRegisterScopeMetadata(cwd) {
  const safeCwd = typeof cwd === "string" ? cwd : "";
  return {
    cwd: safeCwd,
    repo_root: deriveRepoRootFromCwd(safeCwd),
    repoRootHash: repoScopeHash(safeCwd),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/test-lock.mjs --test --test-force-exit --test-concurrency=8 tests/unit/repo-scope.test.mjs`
Expected: PASS (7 tests)

- [ ] **Step 5: Refactor cto/status.mjs to import the shared helper (exact form)**

In `cto/status.mjs`, add to the top-level import block:

```javascript
import { shortHash, deriveRepoRootFromCwd } from "../hub/lib/repo-scope.mjs";
```

DELETE the now-duplicate local definitions:
- Delete `cto/status.mjs:35-44` (the `// Non-cryptographic...` comment + local `shortHash`).
- Delete `cto/status.mjs:53-88` (the local `export function deriveRepoRootFromCwd(cwd) { ... }`).

`cto/status.mjs` previously `export`ed `deriveRepoRootFromCwd`. Preserve that public surface by adding exactly this re-export line near the top-level exports (final form: one `import` + one `export`):

```javascript
export { deriveRepoRootFromCwd } from "../hub/lib/repo-scope.mjs";
```

Then remove `deriveRepoRootFromCwd` from the `import` above so it is imported once via the bare `import` for internal use OR re-exported once — use exactly: `import { shortHash, deriveRepoRootFromCwd } from "../hub/lib/repo-scope.mjs";` for internal use, and a SEPARATE `export { deriveRepoRootFromCwd };` statement (not the `export ... from` form) to avoid a duplicate-binding lint error. Leave `pathLabel` (`cto/status.mjs:46-51`) and all call sites unchanged.

- [ ] **Step 6: Verify cto/status callers still pass + lint**

Run: `node scripts/test-lock.mjs --test --test-force-exit --test-concurrency=8 tests/unit/repo-scope.test.mjs && npm run lint`
Expected: tests PASS, lint clean. Also run any existing `cto` status test file found under `tests/`.

- [ ] **Step 7: Commit**

```bash
git add hub/lib/repo-scope.mjs cto/status.mjs tests/unit/repo-scope.test.mjs
git commit -m "feat(hub): extract shared repo-scope hash helper (DRY cto/status)"
```

---

## Task 2: Scope chokepoint at register + bridge cwd stamp

**Files:**
- Modify: `hub/router.mjs` `registerAgent` (803-814) — normalize scope from incoming metadata; add `normalizeRegisterScope` helper + import
- Modify: `hub/bridge.mjs:611-625` (`cmdRegister`) — stamp `cwd`/`repo_root`/`repoRootHash`; add import
- Test: `tests/integration/router.test.mjs`

**Interfaces:**
- Consumes: `repoScopeHash`, `buildRegisterScopeMetadata` from Task 1
- Produces: any agent registering with `metadata.repoRootHash` OR `metadata.repo_root`/`metadata.cwd` lands in the correct scope. `router.registerAgent` is the single normalization chokepoint, covering the three production register call sites: `hub/pipe.mjs:224`, `hub/tools.mjs:159`, and the CLI bridge.

> **Why a chokepoint (review finding F2):** `process.cwd()` inside the hub is the hub's directory, not the agent's, so the hub cannot infer scope. Scope must arrive in the register payload. The CLI bridge (this task) stamps it; the MCP `register` tool (`hub/tools.mjs`) forwards caller `metadata` verbatim. Normalizing inside `router.registerAgent` means ANY caller that supplies `cwd`/`repo_root` (or a precomputed `repoRootHash`) is scoped, without editing each call site.

- [ ] **Step 1: Investigate the production CTO-candidate register path (no code change)**

Run and record the result in the PR description:

```bash
grep -rn "registerAgent\|cto_priority\|role.*cto\|capabilities.*cto" hub/pipe.mjs hub/tools.mjs hub/team/ hooks/ cto/ | grep -v "\.test\."
```

Confirm whether the agents that become CTO election candidates (`metadata.role:"cto"` / `capabilities:["cto"]`) pass a `cwd`/`repo_root` in their register `metadata`. If a specific spawner (conductor, session hook) creates CTO candidates WITHOUT cwd, add a one-line stamp there using `buildRegisterScopeMetadata(<agent cwd>)`. Document the exact path(s) found. (The chokepoint in Step 3 makes the feature correct for any caller that supplies cwd; this step verifies the real caller does.)

- [ ] **Step 2: Write the failing test (chokepoint derives scope from cwd, no repoRootHash)**

Add to `tests/integration/router.test.mjs` inside a new `describe("CTO per-project scope", ...)` block (reuse `createIsolatedRouter()`):

```javascript
  it("registerAgent derives scope from metadata.cwd when repoRootHash absent", () => {
    const isolated = createIsolatedRouter();
    try {
      isolated.router.registerAgent({
        agent_id: "cto-cwd",
        cli: "codex",
        capabilities: ["code"],
        topics: [],
        metadata: { role: "cto", cwd: "/repo/x/.worktrees/feat" }, // no repoRootHash
        heartbeat_ttl_ms: 60000,
      });
      const stored = isolated.store.getAgent("cto-cwd");
      // chokepoint stamped repoRootHash from cwd's repo root
      assert.equal(typeof stored.metadata.repoRootHash, "string");
      assert.notEqual(stored.metadata.repoRootHash, "global");
      assert.equal(stored.metadata.repoRootHash, repoScopeHash("/repo/x/.worktrees/feat"));
    } finally {
      isolated.cleanup();
    }
  });
```

(Import `repoScopeHash` at the top of the test file: `import { repoScopeHash } from "../../hub/lib/repo-scope.mjs";`. This test asserts ONLY Task 2's deliverable — the persisted `metadata.repoRootHash`. The per-scope `getRoleSnapshot` behavior is proven by Task 3's election test, which is the task that makes election scope-aware.)

- [ ] **Step 3: Add the normalization chokepoint + import**

In `hub/router.mjs`, add to the import block (Task 3 extends this line to also import `DEFAULT_ROLE_SCOPE`):

```javascript
import { repoScopeHash } from "./lib/repo-scope.mjs";
```

Add this helper inside `createRouter` (it only needs `repoScopeHash`; it does NOT use the Task 3 scope helpers):

```javascript
  function normalizeRegisterScope(metadata = {}) {
    const meta = metadata && typeof metadata === "object" ? metadata : {};
    if (typeof meta.repoRootHash === "string" && meta.repoRootHash) return meta;
    const source =
      typeof meta.repo_root === "string" && meta.repo_root
        ? meta.repo_root
        : typeof meta.cwd === "string"
          ? meta.cwd
          : "";
    if (!source) return meta;
    return { ...meta, repoRootHash: repoScopeHash(source) };
  }
```

Update `registerAgent` (`hub/router.mjs:803-814`) to normalize metadata before persisting. **Keep the election loop at its current 2-arg form** — Task 3 migrates this call site (and all others) atomically when `ensureRoleLeader` becomes scope-aware. Doing it here would reference symbols (`scopeForAgent`, the 3-arg signature) that don't exist until Task 3, breaking this task:

```javascript
    registerAgent(args) {
      const metadata = normalizeRegisterScope(args.metadata);
      const result = store.registerAgent({ ...args, metadata });
      upsertRuntimeTopics(args.agent_id, args.topics || [], { replace: true });
      refreshRoleCandidateForAgent(args.agent_id);
      for (const roleName of ROLE_TOPICS) {
        ensureRoleLeader(roleName, {
          reason: "register",
          transferBacklog: true,
        });
      }
      return result;
    },
```

(Role election stays global-scoped in this task; the normalized `metadata.repoRootHash` is now persisted, which is Task 2's only deliverable. Per-scope election arrives in Task 3.)

- [ ] **Step 4: Stamp scope in the CLI bridge**

In `hub/bridge.mjs`, add to the import block:

```javascript
import { buildRegisterScopeMetadata } from "./lib/repo-scope.mjs";
```

Replace `hub/bridge.mjs:621-624` (the `metadata` literal in `cmdRegister`):

```javascript
    metadata: {
      pid: process.ppid,
      registered_at: Date.now(),
      ...buildRegisterScopeMetadata(process.cwd()),
    },
```

- [ ] **Step 5: Run test to verify it passes (after Task 3) + lint**

Run: `node scripts/test-lock.mjs --test --test-force-exit --test-concurrency=8 tests/integration/router.test.mjs && npm run lint`
Expected: the metadata-stamp asserts PASS now; the `getRoleSnapshot` assert PASSes once Task 3 lands.

- [ ] **Step 6: Commit**

```bash
git add hub/router.mjs hub/bridge.mjs tests/integration/router.test.mjs
git commit -m "feat(hub): normalize per-project scope at register chokepoint"
```

---

## Task 3: Scope-key the role-state core

**Files:**
- Modify: `hub/router.mjs` — scope helpers; `ensureRoleState`, `buildRoleCandidate`, `refreshRoleCandidateForAgent`, `refreshRoleCandidates`, `chooseRoleLeader`, `buildRoleSnapshot`, `ensureRoleLeader` (+ phantom-leader guard), `getRoleSnapshot`; signature shims for `transferRoleBacklog`/`countPendingForRole`; **explicit fix of the `takeoverRole` backlog caller**
- Test: `tests/integration/router.test.mjs`

**Interfaces:**
- Consumes: `DEFAULT_ROLE_SCOPE` (Task 2 import), `agent.metadata.repoRootHash`
- Produces (stable signatures used by later tasks):
  - `roleScopeKey(role, scope)`, `scopeFromAgent(agent)`, `scopeForAgent(agentId)`
  - `ensureRoleState(roleName, scope = DEFAULT_ROLE_SCOPE)`
  - `buildRoleCandidate(agentId, roleName)` → candidate includes `scope`, `repo_root`
  - `refreshRoleCandidates(roleName, scope)`, `chooseRoleLeader(roleName, scope)`
  - `buildRoleSnapshot(roleName, scope, { refreshCandidates })` → snapshot includes `scope`, `repo_root_hash`, `repo_root`
  - `ensureRoleLeader(roleName, scope, { reason, transferBacklog })`
  - `getRoleSnapshot(roleName, scope)` — also exposed on the public `router` object
  - `transferRoleBacklog(roleName, scope, newLeaderAgentId, previousLeaderAgentId)` (body finished in Task 5; signature now)
  - `countPendingForRole(roleName, scope = DEFAULT_ROLE_SCOPE)` (body finished in Task 5; signature now)

- [ ] **Step 1: Write the failing tests (per-project election + scope churn)**

Add inside the `describe("CTO per-project scope", ...)` block:

```javascript
  it("elects an independent CTO leader per repoRootHash scope", () => {
    const isolated = createIsolatedRouter();
    try {
      isolated.router.registerAgent({
        agent_id: "cto-proj-a", cli: "claude", capabilities: ["code"], topics: [],
        metadata: { role: "cto", cto_priority: 5, repoRootHash: "aaa", repo_root: "/repo/a" },
        heartbeat_ttl_ms: 60000,
      });
      isolated.router.registerAgent({
        agent_id: "cto-proj-b", cli: "codex", capabilities: ["code"], topics: [],
        metadata: { role: "cto", cto_priority: 5, repoRootHash: "bbb", repo_root: "/repo/b" },
        heartbeat_ttl_ms: 60000,
      });

      const a = isolated.router.getRoleSnapshot("cto", "aaa");
      const b = isolated.router.getRoleSnapshot("cto", "bbb");
      assert.equal(a.leader_agent_id, "cto-proj-a");
      assert.equal(a.scope, "aaa");
      assert.equal(a.repo_root, "/repo/a");
      assert.equal(b.leader_agent_id, "cto-proj-b");

      isolated.router.updateAgentStatus("cto-proj-a", "offline");
      assert.equal(isolated.router.getRoleSnapshot("cto", "aaa").status, "offline");
      assert.equal(isolated.router.getRoleSnapshot("cto", "bbb").leader_agent_id, "cto-proj-b");
    } finally {
      isolated.cleanup();
    }
  });

  it("does not keep a phantom leader after the leader moves scope", () => {
    const isolated = createIsolatedRouter();
    try {
      isolated.router.registerAgent({
        agent_id: "mover", cli: "codex", capabilities: ["code"], topics: [],
        metadata: { role: "cto", repoRootHash: "aaa" }, heartbeat_ttl_ms: 60000,
      });
      assert.equal(isolated.router.getRoleSnapshot("cto", "aaa").leader_agent_id, "mover");

      // same agent re-registers under a different repo scope
      isolated.router.registerAgent({
        agent_id: "mover", cli: "codex", capabilities: ["code"], topics: [],
        metadata: { role: "cto", repoRootHash: "bbb" }, heartbeat_ttl_ms: 60000,
      });

      // scope aaa must NOT still report "mover" as its live leader
      assert.notEqual(isolated.router.getRoleSnapshot("cto", "aaa").leader_agent_id, "mover");
      assert.equal(isolated.router.getRoleSnapshot("cto", "bbb").leader_agent_id, "mover");
    } finally {
      isolated.cleanup();
    }
  });
```

Expose `getRoleSnapshot` on the public router object — add near `getStatus` in the `router` object literal:

```javascript
    getRoleSnapshot(roleName, scope) {
      return getRoleSnapshot(roleName, scope);
    },
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node scripts/test-lock.mjs --test --test-force-exit --test-concurrency=8 tests/integration/router.test.mjs`
Expected: FAIL — `getRoleSnapshot` missing / leaders collide on one global scope / phantom leader retained.

- [ ] **Step 3: Extend the import + add scope helpers**

Change the Task 2 import line in `hub/router.mjs` to add `DEFAULT_ROLE_SCOPE`:

```javascript
import { DEFAULT_ROLE_SCOPE, repoScopeHash } from "./lib/repo-scope.mjs";
```

Inside `createRouter`, after line 161 (before the current `ensureRoleState`):

```javascript
  function roleScopeKey(role, scope) {
    return `${role}::${scope || DEFAULT_ROLE_SCOPE}`;
  }

  function scopeFromAgent(agent) {
    const hash = agent?.metadata?.repoRootHash;
    return typeof hash === "string" && hash ? hash : DEFAULT_ROLE_SCOPE;
  }

  function scopeForAgent(agentId) {
    return scopeFromAgent(store.getAgent(agentId));
  }
```

- [ ] **Step 4: Rewrite `ensureRoleState`** (replace `hub/router.mjs:163-181`):

```javascript
  function ensureRoleState(roleName, scope = DEFAULT_ROLE_SCOPE) {
    const role = normalizeRoleName(roleName);
    if (!role) return null;
    const scopeKey = scope || DEFAULT_ROLE_SCOPE;
    const key = roleScopeKey(role, scopeKey);
    if (!roleStates.has(key)) {
      roleStates.set(key, {
        role,
        scope: scopeKey,
        leaderAgentId: null,
        previousLeaderAgentId: null,
        leaderEpoch: 0,
        leaderSource: null,
        status: "offline",
        candidates: new Map(),
        lastTransitionMs: null,
        lastReason: "init",
        transferredCount: 0,
      });
    }
    return roleStates.get(key);
  }
```

- [ ] **Step 5: Add `scope`+`repo_root` to candidates** (replace `hub/router.mjs:210-228`):

```javascript
  function buildRoleCandidate(agentId, roleName) {
    const role = normalizeRoleName(roleName);
    if (!agentId || !role) return null;
    const agent = store.getAgent(agentId);
    if (!agent) return null;
    const topics = listRuntimeTopics(agentId);
    const source = getRoleCandidateSource(agent, topics, role);
    if (!source) return null;
    return {
      agent_id: agent.agent_id,
      scope: scopeFromAgent(agent),
      repo_root:
        typeof agent.metadata?.repo_root === "string" ? agent.metadata.repo_root : "",
      status: agent.status,
      source,
      priority: rolePriority(agent.metadata, role),
      last_seen_ms: agent.last_seen_ms || 0,
      lease_expires_ms: agent.lease_expires_ms || 0,
      topics,
      capabilities: agent.capabilities || [],
    };
  }
```

- [ ] **Step 6: Route each candidate to its own scope + clear a purged leader** (replace `hub/router.mjs:230-238`):

```javascript
  function refreshRoleCandidateForAgent(agentId) {
    if (!agentId) return;
    for (const roleName of ROLE_TOPICS) {
      const candidate = buildRoleCandidate(agentId, roleName);
      const scope = candidate?.scope || scopeForAgent(agentId);
      // An agent belongs to exactly one scope. Purge it from every other
      // scope's candidates, and if it was that scope's leader, vacate the seat
      // so a stale cross-scope leader cannot linger (review finding F4).
      for (const state of roleStates.values()) {
        if (state.role !== roleName || state.scope === scope) continue;
        if (state.candidates.delete(agentId) && state.leaderAgentId === agentId) {
          state.previousLeaderAgentId = state.leaderAgentId;
          state.leaderAgentId = null;
          state.leaderSource = null;
          state.status = "offline";
          state.leaderEpoch += 1;
          state.lastTransitionMs = Date.now();
          state.lastReason = "scope-moved";
        }
      }
      const role = ensureRoleState(roleName, scope);
      if (candidate) role.candidates.set(agentId, candidate);
      else role.candidates.delete(agentId);
    }
  }
```

- [ ] **Step 7: Make `refreshRoleCandidates` scope-aware** (replace `hub/router.mjs:240-255`):

```javascript
  function refreshRoleCandidates(roleName, scope = DEFAULT_ROLE_SCOPE) {
    const role = ensureRoleState(roleName, scope);
    if (!role) return [];
    const ids = new Set(role.candidates.keys());
    for (const [agentId, topics] of runtimeTopics) {
      if (topics.has(role.role)) ids.add(agentId);
    }
    for (const agent of store.getAgentsByTopic(role.role)) ids.add(agent.agent_id);
    if (typeof store.listAllAgents === "function") {
      for (const agent of store.listAllAgents()) ids.add(agent.agent_id);
    }
    // refreshRoleCandidateForAgent files each agent under its own scope, so
    // after refreshing, role.candidates holds only this scope's candidates.
    for (const agentId of ids) refreshRoleCandidateForAgent(agentId);
    return Array.from(role.candidates.values());
  }
```

- [ ] **Step 8: Thread scope through choose/snapshot/ensure/get + phantom-leader guard**

Replace `chooseRoleLeader` (`279-286`):

```javascript
  function chooseRoleLeader(roleName, scope = DEFAULT_ROLE_SCOPE) {
    const now = Date.now();
    return (
      sortRoleCandidates(refreshRoleCandidates(roleName, scope)).find((candidate) =>
        isCandidateLive(candidate, now),
      ) || null
    );
  }
```

Replace `buildRoleSnapshot` (`393-437`):

```javascript
  function buildRoleSnapshot(
    roleName,
    scope = DEFAULT_ROLE_SCOPE,
    { refreshCandidates = true } = {},
  ) {
    const role = ensureRoleState(roleName, scope);
    if (!role) return null;
    const now = Date.now();
    const candidates = sortRoleCandidates(
      refreshCandidates
        ? refreshRoleCandidates(role.role, role.scope)
        : Array.from(role.candidates.values()),
    );
    const leader =
      role.leaderAgentId && buildRoleCandidate(role.leaderAgentId, role.role);
    // A leader still counts only if it remains in this scope (finding F4).
    const leaderLive = isCandidateLive(leader, now) && leader.scope === role.scope;
    const liveCandidates = candidates.filter((candidate) =>
      isCandidateLive(candidate, now),
    );
    const repoRoot =
      (leaderLive && leader.repo_root) ||
      candidates.find((candidate) => candidate.repo_root)?.repo_root ||
      "";
    return {
      role: role.role,
      scope: role.scope,
      repo_root_hash: role.scope,
      repo_root: repoRoot,
      status: leaderLive ? "active" : liveCandidates.length ? "electable" : "offline",
      leader_agent_id: leaderLive ? role.leaderAgentId : null,
      previous_leader_agent_id: role.previousLeaderAgentId || null,
      leader_epoch: role.leaderEpoch,
      lease_expires_ms: leaderLive ? leader.lease_expires_ms : null,
      candidate_source: leaderLive ? leader.source : liveCandidates[0]?.source || null,
      candidate_count: candidates.length,
      live_candidate_count: liveCandidates.length,
      pending_count: countPendingForRole(role.role, role.scope),
      transferred_count: role.transferredCount,
      last_transition_ms: role.lastTransitionMs,
      last_reason: role.lastReason,
      candidates: candidates.slice(0, 16).map((candidate) => ({
        agent_id: candidate.agent_id,
        status: isCandidateLive(candidate, now) ? "online" : candidate.status,
        source: candidate.source,
        priority: candidate.priority,
        last_seen_ms: candidate.last_seen_ms,
        lease_expires_ms: candidate.lease_expires_ms,
      })),
    };
  }
```

Replace `ensureRoleLeader` (`439-491`) — note the `current.scope === role.scope` guard and the scope arg to `transferRoleBacklog`:

```javascript
  function ensureRoleLeader(
    roleName,
    scope = DEFAULT_ROLE_SCOPE,
    { reason = "ensure", transferBacklog = true } = {},
  ) {
    const role = ensureRoleState(roleName, scope);
    if (!role) return null;
    const now = Date.now();
    const currentCandidate =
      role.leaderAgentId && buildRoleCandidate(role.leaderAgentId, role.role);
    const current =
      currentCandidate && currentCandidate.scope === role.scope
        ? currentCandidate
        : null;
    const best = chooseRoleLeader(role.role, role.scope);
    const currentLive = isCandidateLive(current, now);
    const shouldPreemptFallback =
      currentLive &&
      current?.source === "topic-fallback" &&
      best?.source === "explicit" &&
      best.agent_id !== current.agent_id;

    if (currentLive && !shouldPreemptFallback) {
      role.status = "active";
      role.leaderSource = current.source;
      return buildRoleSnapshot(role.role, role.scope);
    }

    if (!best) {
      if (role.leaderAgentId) {
        role.previousLeaderAgentId = role.leaderAgentId;
        role.leaderAgentId = null;
        role.leaderSource = null;
        role.leaderEpoch += 1;
        role.lastTransitionMs = Date.now();
        role.lastReason = reason;
      }
      role.status = "offline";
      return buildRoleSnapshot(role.role, role.scope);
    }

    if (role.leaderAgentId !== best.agent_id) {
      const previousLeaderAgentId = role.leaderAgentId;
      role.previousLeaderAgentId = previousLeaderAgentId || role.previousLeaderAgentId;
      role.leaderAgentId = best.agent_id;
      role.leaderSource = best.source;
      role.leaderEpoch += 1;
      role.status = "active";
      role.lastTransitionMs = Date.now();
      role.lastReason = reason;
      if (transferBacklog) {
        transferRoleBacklog(role.role, role.scope, best.agent_id, previousLeaderAgentId);
      }
    }

    return buildRoleSnapshot(role.role, role.scope);
  }
```

Replace `getRoleSnapshot` (`493-495`):

```javascript
  function getRoleSnapshot(roleName, scope = DEFAULT_ROLE_SCOPE) {
    return buildRoleSnapshot(roleName, scope, { refreshCandidates: true });
  }
```

- [ ] **Step 9: Apply the Task 3→5 signature shims (finding F1 — explicit, not prose)**

`transferRoleBacklog` and `countPendingForRole` get their `scope` parameter NOW; bodies are finished in Task 5. Apply minimal signature shims so the file compiles and stays green:

- `countPendingForRole(roleName, scope = DEFAULT_ROLE_SCOPE)` — add the param; body unchanged in this task (its only caller is `buildRoleSnapshot`, already updated above).
- `transferRoleBacklog(roleName, scope, newLeaderAgentId, previousLeaderAgentId)` — add `scope` as the 2nd param; body unchanged.
- **Fix EVERY caller of `transferRoleBacklog`** (grep first: `grep -n "transferRoleBacklog(" hub/router.mjs` → callers at the rewritten `ensureRoleLeader` (already passes `role.scope`) AND **`takeoverRole` at ~router.mjs:1096**). Edit the `takeoverRole` call (it is NOT rewritten until Task 6) to pass a placeholder scope:

```javascript
      const transfer = transferRoleBacklog(
        roleName,
        DEFAULT_ROLE_SCOPE,
        targetAgentId,
        previousLeaderAgentId,
      );
```

(Task 6 replaces `DEFAULT_ROLE_SCOPE` with `roleState.scope`. Without this step the existing `takeoverRole` test at `tests/integration/router.test.mjs:546` and `tests/integration/pipe.test.mjs:349,409` go RED in Task 3.)

- [ ] **Step 9b: Migrate ALL remaining `ensureRoleLeader` call sites to the 3-arg signature (review finding NEW-1 — atomic signature+callers change)**

`ensureRoleLeader` changed arity in Step 8. There are 6 call sites (grep to confirm: `grep -n "ensureRoleLeader(" hub/router.mjs`): `registerAgent` (Task 2), `refreshAgentLease`, `subscribeAgent`, `updateAgentStatus`, `resolveRecipients`, `reelectStaleRoles`. ALL must move to the 3-arg form NOW, or they pass the options object in the `scope` slot → `roleScopeKey("cto", {object})` = `"cto::[object Object]"` → election/routing breaks and Step 10 goes RED.

`registerAgent` (the Task 2 loop) — make it scope-aware (final form):

```javascript
      const scope = scopeForAgent(args.agent_id);
      for (const roleName of ROLE_TOPICS) {
        ensureRoleLeader(roleName, scope, { reason: "register", transferBacklog: true });
      }
```

`refreshAgentLease` (`hub/router.mjs:816-826`) — final form (single-scope hot path, also resolves the P2 amplification finding):

```javascript
    refreshAgentLease(agentId, ttlMs = 30000) {
      const result = store.refreshLease(agentId, ttlMs);
      refreshRoleCandidateForAgent(agentId);
      const scope = scopeForAgent(agentId);
      for (const roleName of ROLE_TOPICS) {
        ensureRoleLeader(roleName, scope, { reason: "heartbeat", transferBacklog: true });
      }
      return result;
    },
```

`subscribeAgent` (`828-838`) — final form:

```javascript
    subscribeAgent(agentId, topics, { replace = false } = {}) {
      const nextTopics = upsertRuntimeTopics(agentId, topics, { replace });
      refreshRoleCandidateForAgent(agentId);
      const scope = scopeForAgent(agentId);
      for (const roleName of ROLE_TOPICS) {
        ensureRoleLeader(roleName, scope, { reason: "subscribe", transferBacklog: true });
      }
      return { agent_id: agentId, topics: nextTopics };
    },
```

`updateAgentStatus` (`844-857`) — final form; capture scope BEFORE the offline branch (scope comes from stored metadata, not runtime topics, so it survives, but read it once up front):

```javascript
    updateAgentStatus(agentId, status) {
      const scope = scopeForAgent(agentId);
      if (status === "offline") {
        runtimeTopics.delete(agentId);
      }
      const updated = store.updateAgentStatus(agentId, status);
      refreshRoleCandidateForAgent(agentId);
      for (const roleName of ROLE_TOPICS) {
        ensureRoleLeader(roleName, scope, { reason: `status:${status}`, transferBacklog: true });
      }
      return updated;
    },
```

`resolveRecipients` (`529-552`) — TRANSITIONAL edit (Task 5 fully rewrites this with `@scope` parsing + `msg.role_scope`): change only the role branch's `ensureRoleLeader` call to pass the sender's scope:

```javascript
    const topic = to.slice(6);
    if (ROLE_TOPICS.has(topic)) {
      const scope = scopeForAgent(msg.from ?? msg.from_agent);
      const role = ensureRoleLeader(topic, scope, { reason: "route", transferBacklog: true });
      return role?.leader_agent_id ? [role.leader_agent_id] : [];
    }
```

`reelectStaleRoles` (`1364-1374`) — TRANSITIONAL edit (Task 4 fully rewrites with the all-scope loop): pass a placeholder scope so it compiles:

```javascript
    reelectStaleRoles({ reason = "sweep" } = {}) {
      for (const roleName of ROLE_TOPICS) {
        const role = roleStates.get(roleScopeKey(roleName, DEFAULT_ROLE_SCOPE));
        const leader = role?.leaderAgentId
          ? buildRoleCandidate(role.leaderAgentId, roleName)
          : null;
        if (!isCandidateLive(leader)) {
          ensureRoleLeader(roleName, DEFAULT_ROLE_SCOPE, { reason });
        }
      }
    },
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `node scripts/test-lock.mjs --test --test-force-exit --test-concurrency=8 tests/integration/router.test.mjs`
Expected: PASS — including the existing CTO/takeover tests (they register without `repoRootHash` → `global` scope → unaffected; takeover backlog now passes `global`).

- [ ] **Step 11: Lint + commit**

```bash
npm run lint
git add hub/router.mjs tests/integration/router.test.mjs
git commit -m "feat(hub): key CTO role state by per-project scope"
```

---

## Task 4: Scope-aware election entry points + sweep re-election

**Files:**
- Modify: `hub/router.mjs` — `refreshAgentLease` (816-826), `subscribeAgent` (828-838), `updateAgentStatus` (844-857); add `listRoleScopes`; rewrite `reelectStaleRoles` (1364-1374)
- Test: `tests/integration/router.test.mjs`

**Interfaces:**
- Consumes: scope-keyed core from Task 3 (all entry-point call sites — register/lease/subscribe/status — already migrated to single-scope `scopeForAgent(agentId)` re-election in Task 3 Step 9b, which is both the arity fix and the P2 anti-amplification optimization).
- Produces: `listRoleScopes(roleName): string[]`; the 120 s `reelectStaleRoles` full rewrite sweeps all scopes (replaces the Task 3 transitional version).

- [ ] **Step 1: Write the failing test**

Add inside the `describe` block:

```javascript
  it("sweep re-elects a stale leader only within its own scope", () => {
    const isolated = createIsolatedRouter();
    try {
      for (const [id, hash, pr] of [["a1", "aaa", 10], ["a2", "aaa", 1], ["b1", "bbb", 1]]) {
        isolated.router.registerAgent({
          agent_id: id, cli: "codex", capabilities: ["code"], topics: [],
          metadata: { role: "cto", cto_priority: pr, repoRootHash: hash },
          heartbeat_ttl_ms: 60000,
        });
      }
      assert.equal(isolated.router.getRoleSnapshot("cto", "aaa").leader_agent_id, "a1");
      assert.equal(isolated.router.getRoleSnapshot("cto", "bbb").leader_agent_id, "b1");

      isolated.router.updateAgentStatus("a1", "offline");
      isolated.router.reelectStaleRoles({ reason: "sweep" });

      assert.equal(isolated.router.getRoleSnapshot("cto", "aaa").leader_agent_id, "a2");
      assert.equal(isolated.router.getRoleSnapshot("cto", "bbb").leader_agent_id, "b1");
    } finally {
      isolated.cleanup();
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-lock.mjs --test --test-force-exit --test-concurrency=8 tests/integration/router.test.mjs`
Expected: FAIL — `reelectStaleRoles` only handles one global scope.

- [ ] **Step 3: Add `listRoleScopes`** (inside `createRouter`, near `chooseRoleLeader`):

```javascript
  function listRoleScopes(roleName) {
    const role = normalizeRoleName(roleName);
    if (!role) return [];
    const ids = new Set();
    for (const [agentId, topics] of runtimeTopics) {
      if (topics.has(role)) ids.add(agentId);
    }
    for (const agent of store.getAgentsByTopic(role)) ids.add(agent.agent_id);
    if (typeof store.listAllAgents === "function") {
      for (const agent of store.listAllAgents()) ids.add(agent.agent_id);
    }
    for (const agentId of ids) refreshRoleCandidateForAgent(agentId);
    const scopes = new Set();
    for (const state of roleStates.values()) {
      if (state.role === role) scopes.add(state.scope);
    }
    if (!scopes.size) scopes.add(DEFAULT_ROLE_SCOPE);
    return Array.from(scopes);
  }
```

- [ ] **Step 4: (Hot-path entry points already migrated in Task 3 Step 9b)**

`refreshAgentLease`, `subscribeAgent`, `updateAgentStatus` were finalized to the single-scope form (`ensureRoleLeader(roleName, scopeForAgent(agentId), ...)`) in Task 3 Step 9b — this is both their atomic arity migration AND the P2 anti-amplification optimization (they re-elect only the heartbeating agent's scope, never an all-scope sweep). No edit here. Verify with `grep -n "ensureRoleLeader(" hub/router.mjs` that all four entry points pass a scope.

- [ ] **Step 5: Rewrite `reelectStaleRoles` to sweep all scopes** (replace the Task 3 Step 9b transitional version with the full all-scope loop):

```javascript
    reelectStaleRoles({ reason = "sweep" } = {}) {
      for (const roleName of ROLE_TOPICS) {
        for (const scope of listRoleScopes(roleName)) {
          const role = roleStates.get(roleScopeKey(roleName, scope));
          const leader = role?.leaderAgentId
            ? buildRoleCandidate(role.leaderAgentId, roleName)
            : null;
          if (!isCandidateLive(leader) || leader.scope !== scope) {
            ensureRoleLeader(roleName, scope, { reason });
          }
        }
      }
    },
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node scripts/test-lock.mjs --test --test-force-exit --test-concurrency=8 tests/integration/router.test.mjs`
Expected: PASS (all existing + new).

- [ ] **Step 7: Lint + commit**

```bash
npm run lint
git add hub/router.mjs tests/integration/router.test.mjs
git commit -m "feat(hub): elect and sweep CTO leaders per scope"
```

---

## Task 5: Scope-aware routing, persisted scope, backlog + replay

**Files:**
- Modify: `hub/schema.sql` — add `role_scope TEXT` to the `messages` table
- Modify: `hub/store.mjs` — bump `SCHEMA_VERSION`, `ensureColumn(db, "messages", "role_scope", "TEXT")`, add `role_scope` to the `insertAuditMessage` prepared statement + `auditLog` row
- Modify: `hub/router.mjs` — `dispatchMessage` (617-654, pass `role_scope` to `auditLog`, NOT into payload), `resolveRecipients` (529-552), `messageMatchesRole` (288-292), `roleTopicForMessage` (294-298), `isReplayAllowedForAgent` (300-307), `shouldTrackWithoutRecipients` (309-313), `isRoleMessageFullyHandled` (315-321), `isRoleRecipient` (323-327), `countPendingForRole` (329-339, finish body), `transferRoleBacklog` (341-391, finish body), `handlePublish` role snapshot (line 1033); add `messageRoleScope`, `resolveMessageRoleScope` helpers
- Test: `tests/integration/router.test.mjs`

> **Persistence location (review finding NEW-2):** `role_scope` is persisted as a dedicated TOP-LEVEL message column, NOT injected into the user `payload`. This keeps the `topic:cto` consumer payload byte-for-byte unchanged (so `tests/integration/router.test.mjs:237`'s `deepEqual(payload, {...})` still passes and no consumer sees an unexpected key), while `parseMessageRow` surfaces `role_scope` top-level on reconstructed messages for scoped replay.

**Interfaces:**
- Consumes: scope-keyed election from Tasks 2-4
- Produces: a role-topic message carries `role_scope` BOTH in-memory (`msg.role_scope`) and persisted (`msg.payload.role_scope`), resolved at dispatch from the sender's scope or an explicit `topic:cto@<scope>`. Backlog, pending, and audit-replay are all scoped. `messageRoleScope(message)` reads the scope from either location; `isReplayAllowedForAgent` falls back to the agent's own scope for legacy/probe messages with no persisted scope.

- [ ] **Step 1: Write the failing tests (routing + scoped replay)**

Add inside the `describe` block:

```javascript
  it("routes topic:cto to the sender's project leader", () => {
    const isolated = createIsolatedRouter();
    try {
      isolated.router.registerAgent({ agent_id: "cto-a", cli: "codex", capabilities: ["code"], topics: [], metadata: { role: "cto", repoRootHash: "aaa" }, heartbeat_ttl_ms: 60000 });
      isolated.router.registerAgent({ agent_id: "cto-b", cli: "codex", capabilities: ["code"], topics: [], metadata: { role: "cto", repoRootHash: "bbb" }, heartbeat_ttl_ms: 60000 });
      isolated.router.registerAgent({ agent_id: "worker-a", cli: "claude", capabilities: ["code"], topics: [], metadata: { repoRootHash: "aaa" }, heartbeat_ttl_ms: 60000 });

      const published = isolated.router.handlePublish({ from: "worker-a", to: "topic:cto", topic: "cto", payload: { decision: "scoped to aaa" } });
      assert.equal(published.data.fanout_count, 1);
      assert.equal(isolated.router.getPendingMessages("cto-a").length, 1);
      assert.equal(isolated.router.getPendingMessages("cto-b").length, 0);
    } finally {
      isolated.cleanup();
    }
  });

  it("transfers backlog only within the failed leader's scope", () => {
    const isolated = createIsolatedRouter();
    try {
      isolated.router.registerAgent({ agent_id: "a-old", cli: "codex", capabilities: ["code"], topics: [], metadata: { role: "cto", cto_priority: 10, repoRootHash: "aaa" }, heartbeat_ttl_ms: 60000 });
      isolated.router.registerAgent({ agent_id: "a-new", cli: "codex", capabilities: ["code"], topics: [], metadata: { role: "cto", cto_priority: 1, repoRootHash: "aaa" }, heartbeat_ttl_ms: 60000 });
      isolated.router.registerAgent({ agent_id: "b-leader", cli: "codex", capabilities: ["code"], topics: [], metadata: { role: "cto", repoRootHash: "bbb" }, heartbeat_ttl_ms: 60000 });
      isolated.router.registerAgent({ agent_id: "worker-a", cli: "claude", capabilities: ["code"], topics: [], metadata: { repoRootHash: "aaa" }, heartbeat_ttl_ms: 60000 });

      isolated.router.handlePublish({ from: "worker-a", to: "topic:cto", topic: "cto", payload: { decision: "aaa backlog" } });
      assert.equal(isolated.router.getPendingMessages("a-old").length, 1);

      isolated.router.updateAgentStatus("a-old", "offline");
      assert.equal(isolated.router.getRoleSnapshot("cto", "aaa").leader_agent_id, "a-new");
      assert.equal(isolated.router.getPendingMessages("a-new").length, 1);
      assert.equal(isolated.router.getPendingMessages("b-leader").length, 0);
    } finally {
      isolated.cleanup();
    }
  });

  it("replay gating is scoped: persisted role_scope and agent-scope fallback", () => {
    const isolated = createIsolatedRouter();
    try {
      isolated.router.registerAgent({ agent_id: "cto-a", cli: "codex", capabilities: ["code"], topics: [], metadata: { role: "cto", repoRootHash: "aaa" }, heartbeat_ttl_ms: 60000 });
      isolated.router.registerAgent({ agent_id: "cto-b", cli: "codex", capabilities: ["code"], topics: [], metadata: { role: "cto", repoRootHash: "bbb" }, heartbeat_ttl_ms: 60000 });

      // A persisted scoped message (top-level role_scope column) replays only to its scope leader.
      const scopedMsg = { id: "m1", to_agent: "topic:cto", topic: "cto", role_scope: "aaa", payload: {} };
      assert.equal(isolated.router.canReplayMessageForAgent("cto-a", scopedMsg), true);
      assert.equal(isolated.router.canReplayMessageForAgent("cto-b", scopedMsg), false);

      // A legacy probe with no persisted scope falls back to the agent's own scope:
      // each scope leader is allowed for its own scope.
      const probe = { to_agent: "topic:cto", topic: "cto" };
      assert.equal(isolated.router.canReplayMessageForAgent("cto-a", probe), true);
      assert.equal(isolated.router.canReplayMessageForAgent("cto-b", probe), true);
    } finally {
      isolated.cleanup();
    }
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node scripts/test-lock.mjs --test --test-force-exit --test-concurrency=8 tests/integration/router.test.mjs`
Expected: FAIL — global routing, no `role_scope`, replay not scoped.

- [ ] **Step 3: Add scope-resolution helpers** (inside `createRouter`, near `roleTopicForMessage`):

```javascript
  function messageRoleScope(message = {}) {
    return message.role_scope || message.payload?.role_scope || DEFAULT_ROLE_SCOPE;
  }

  function resolveMessageRoleScope(to, from) {
    const toStr = String(to || "");
    if (!toStr.startsWith("topic:")) return null;
    const [bare, explicit] = toStr.slice(6).split("@");
    if (!ROLE_TOPICS.has(bare)) return null;
    return explicit || scopeForAgent(from) || DEFAULT_ROLE_SCOPE;
  }
```

- [ ] **Step 4a: Persist `role_scope` as a top-level message column (store + schema)**

In `hub/schema.sql`, add `role_scope` to the `messages` table (line ~18-22, after `to_agent`). Because the table uses `CREATE TABLE IF NOT EXISTS`, also add an `ensureColumn` migration for existing DBs:

```sql
-- in CREATE TABLE messages ( ... ), add:
  role_scope TEXT,
```

In `hub/store.mjs`:
1. Add the `role_scope` column migration alongside the EXISTING unconditional `ensureColumn(...)` calls at `store.mjs:140-151` (these run on every `createStore`, OUTSIDE the `if (curVer !== SCHEMA_VERSION)` gate — so this is the load-bearing migration for existing DBs and does not depend on a version bump):

```javascript
  ensureColumn(db, "messages", "role_scope", "TEXT");
```

2. (Optional, conventional) Bump `SCHEMA_VERSION` (`store.mjs:114`) from `"4"` to `"5"` so fresh DBs re-apply `schema.sql`. NOT load-bearing — `ensureColumn` already runs unconditionally — but keeps the version marker honest. Place the `ensureColumn` OUTSIDE the version gate regardless.

3. In the `insertAuditMessage` prepared statement (`store.mjs:186-188`), add the column + bind param:

```javascript
    insertAuditMessage: db.prepare(`
      INSERT INTO messages (id, type, from_agent, to_agent, topic, priority, ttl_ms, created_at_ms, expires_at_ms, correlation_id, trace_id, payload_json, status, role_scope)
      VALUES (@id, @type, @from_agent, @to_agent, @topic, @priority, @ttl_ms, @created_at_ms, @expires_at_ms, @correlation_id, @trace_id, @payload_json, @status, @role_scope)`),
```

4. In `auditLog` (`store.mjs:448-477`), accept `role_scope` and write it (default `null`):

```javascript
    auditLog({
      type,
      from,
      to,
      topic,
      priority = 5,
      ttl_ms = 300000,
      payload = {},
      trace_id,
      correlation_id,
      status = "queued",
      role_scope = null,
    }) {
      const now = Date.now();
      const row = {
        id: uuidv7(),
        type,
        from_agent: from,
        to_agent: to,
        topic,
        priority,
        ttl_ms,
        created_at_ms: now,
        expires_at_ms: now + ttl_ms,
        correlation_id: correlation_id || uuidv7(),
        trace_id: trace_id || uuidv7(),
        payload_json: JSON.stringify(payload),
        status,
        role_scope: role_scope ?? null,
      };
      S.insertAuditMessage.run(row);
      return { ...row, payload };
    },
```

(`parseMessageRow` (`store.mjs:25-34`) destructures only `*_json` columns, so `role_scope` is already surfaced top-level on reconstructed rows — no change needed there. Old rows have `role_scope = NULL`, which the replay fallback in Step 6 handles.)

- [ ] **Step 4b: Pass `role_scope` to `auditLog` at dispatch (NOT into payload)** (replace `dispatchMessage` body `617-654`):

```javascript
  function dispatchMessage({
    type,
    from,
    to,
    topic,
    priority = 5,
    ttl_ms = 300000,
    payload = {},
    trace_id,
    correlation_id,
  }) {
    const roleScope = resolveMessageRoleScope(to, from);
    const msg = store.auditLog({
      type,
      from,
      to,
      topic,
      priority,
      ttl_ms,
      payload,
      trace_id,
      correlation_id,
      role_scope: roleScope,
    });
    // msg.role_scope is surfaced from the persisted column by auditLog's return.
    const recipients = uniqueStrings(resolveRecipients(msg));
    if (recipients.length || shouldTrackWithoutRecipients(msg)) {
      trackMessage(msg, recipients);
    }
    if (recipients.length) {
      for (const agentId of recipients) {
        queueMessage(agentId, msg);
      }
      msg.status = "delivered";
      store.updateMessageStatus(msg.id, "delivered");
    }
    if (msg.type === "response") {
      responseEmitter.emit(msg.correlation_id, msg.payload);
    }
    return { msg, recipients };
  }
```

(`auditLog` returns `{ ...row, payload }`, and `row.role_scope` is the persisted value, so `msg.role_scope` is set in-memory for the live path with the payload untouched. `resolveRecipients` (Step 8) still prefers an already-set `msg.role_scope`.)

- [ ] **Step 5: Make `roleTopicForMessage` + `messageMatchesRole` scope-aware**

Replace `messageMatchesRole` (`288-292`):

```javascript
  function messageMatchesRole(record, roleName, scope = null) {
    const message = record?.message || {};
    const to = message.to_agent ?? message.to;
    const toStr = String(to || "");
    if (!toStr.startsWith("topic:")) return false;
    const [bare] = toStr.slice(6).split("@");
    if (normalizeRoleName(bare) !== normalizeRoleName(roleName)) return false;
    if (scope == null) return true;
    return messageRoleScope(message) === (scope || DEFAULT_ROLE_SCOPE);
  }
```

Replace `roleTopicForMessage` (`294-298`):

```javascript
  function roleTopicForMessage(message = {}) {
    const to = message?.to_agent ?? message?.to;
    const toStr = String(to || "");
    if (!toStr.startsWith("topic:")) return "";
    const [bare] = toStr.slice(6).split("@");
    return normalizeRoleName(bare);
  }
```

- [ ] **Step 6: Replay + track + recipient checks scope-aware**

Replace `isReplayAllowedForAgent` (`300-307`) — explicit persisted scope wins; else fall back to the agent's own scope (fixes the audit-replay probe, finding F5):

```javascript
  function isReplayAllowedForAgent(agentId, message = {}) {
    const roleName = roleTopicForMessage(message);
    if (!roleName) return true;
    const targetAgentId = String(agentId || "").trim();
    if (!targetAgentId) return false;
    const explicit = message.role_scope || message.payload?.role_scope;
    const scope = explicit || scopeForAgent(targetAgentId);
    const role = getRoleSnapshot(roleName, scope);
    return role?.leader_agent_id === targetAgentId;
  }
```

Replace `shouldTrackWithoutRecipients` (`309-313`):

```javascript
  function shouldTrackWithoutRecipients(message) {
    const to = message?.to_agent ?? message?.to;
    const toStr = String(to || "");
    if (!toStr.startsWith("topic:")) return false;
    const [bare] = toStr.slice(6).split("@");
    return ROLE_TOPICS.has(bare);
  }
```

Replace `isRoleMessageFullyHandled` (`315-321`):

```javascript
  function isRoleMessageFullyHandled(record, roleName, scope = null) {
    if (!messageMatchesRole(record, roleName, scope)) return true;
    return record.recipients.size > 0 && record.ackedBy.size >= record.recipients.size;
  }
```

Replace `isRoleRecipient` (`323-327`):

```javascript
  function isRoleRecipient(agentId, roleName, scope, previousLeaderAgentId = null) {
    if (!agentId) return false;
    if (agentId === previousLeaderAgentId) return true;
    const candidate = buildRoleCandidate(agentId, roleName);
    return Boolean(candidate) && candidate.scope === (scope || DEFAULT_ROLE_SCOPE);
  }
```

- [ ] **Step 7: Finish `countPendingForRole` + `transferRoleBacklog` bodies**

Replace `countPendingForRole` (`329-339`):

```javascript
  function countPendingForRole(roleName, scope = DEFAULT_ROLE_SCOPE) {
    const now = Date.now();
    let count = 0;
    for (const record of liveMessages.values()) {
      if (!messageMatchesRole(record, roleName, scope)) continue;
      if (record.message.expires_at_ms <= now) continue;
      if (isRoleMessageFullyHandled(record, roleName, scope)) continue;
      count += 1;
    }
    return count;
  }
```

Replace `transferRoleBacklog` (`341-391`):

```javascript
  function transferRoleBacklog(roleName, scope, newLeaderAgentId, previousLeaderAgentId) {
    const role = ensureRoleState(roleName, scope);
    const now = Date.now();
    const stats = { transferred_count: 0, skipped_count: 0, removed_count: 0 };
    if (!role || !newLeaderAgentId) return stats;
    const scopeKey = role.scope;

    for (const record of liveMessages.values()) {
      const { message, recipients, ackedBy } = record;
      if (!messageMatchesRole(record, role.role, scopeKey)) continue;
      if (message.expires_at_ms <= now) {
        stats.skipped_count += 1;
        continue;
      }
      if (isRoleMessageFullyHandled(record, role.role, scopeKey)) {
        stats.skipped_count += 1;
        continue;
      }
      for (const recipient of Array.from(recipients)) {
        if (
          recipient !== newLeaderAgentId &&
          isRoleRecipient(recipient, role.role, scopeKey, previousLeaderAgentId)
        ) {
          queuesByAgent.get(recipient)?.delete(message.id);
          recipients.delete(recipient);
          ackedBy.delete(recipient);
          stats.removed_count += 1;
        }
      }
      recipients.add(newLeaderAgentId);
      const alreadyQueued = queuesByAgent.get(newLeaderAgentId)?.has(message.id);
      if (!alreadyQueued && !ackedBy.has(newLeaderAgentId)) {
        queueMessage(newLeaderAgentId, message);
        stats.transferred_count += 1;
      } else {
        stats.skipped_count += 1;
      }
      message.status = "delivered";
      store.updateMessageStatus(message.id, "delivered");
    }
    role.transferredCount += stats.transferred_count;
    return stats;
  }
```

- [ ] **Step 8: Route topic:cto to the sender's scope leader** (replace `resolveRecipients` `529-552`):

```javascript
  function resolveRecipients(msg) {
    const to = msg.to_agent ?? msg.to;
    if (!to?.startsWith("topic:")) {
      return [to];
    }
    const rawTopic = to.slice(6);
    const [topic, explicitScope] = rawTopic.split("@");
    if (ROLE_TOPICS.has(topic)) {
      const scope = msg.role_scope || explicitScope || scopeForAgent(msg.from ?? msg.from_agent);
      msg.role_scope = scope || DEFAULT_ROLE_SCOPE;
      const role = ensureRoleLeader(topic, msg.role_scope, { reason: "route", transferBacklog: true });
      return role?.leader_agent_id ? [role.leader_agent_id] : [];
    }
    const recipients = new Set();
    for (const [agentId, topics] of runtimeTopics) {
      if (topics.has(topic)) recipients.add(agentId);
    }
    for (const agent of store.getAgentsByTopic(topic)) {
      recipients.add(agent.agent_id);
    }
    return Array.from(recipients);
  }
```

- [ ] **Step 9: Scope the publish-response role snapshot** (replace `hub/router.mjs:1033`):

```javascript
          role: roleTopicForMessage(msg)
            ? getRoleSnapshot(roleTopicForMessage(msg), messageRoleScope(msg))
            : undefined,
```

(Confirm the in-scope variable at that return is the dispatched message; match the surrounding name.)

- [ ] **Step 10: Run tests to verify they pass**

Run: `node scripts/test-lock.mjs --test --test-force-exit --test-concurrency=8 tests/integration/router.test.mjs`
Expected: PASS. Because `role_scope` is a top-level column (NOT in payload), the existing `deepEqual(pending[0].payload, { decision: "wait for a CTO" })` at `router.test.mjs:237` still passes, and the backlog-handoff test (all `global`) is preserved. Also run:
Run: `node scripts/test-lock.mjs --test --test-force-exit --test-concurrency=8 tests/integration/pipe.test.mjs`
Expected: PASS (the `topic:cto` payload `deepEqual` at `pipe.test.mjs:317` is unaffected since payload is untouched).

- [ ] **Step 11: Lint + commit**

```bash
npm run lint
git add hub/router.mjs hub/store.mjs hub/schema.sql tests/integration/router.test.mjs
git commit -m "feat(hub): scope topic:cto routing, backlog, and replay"
```

---

## Task 6: Scope-aware manual takeover

**Files:**
- Modify: `hub/router.mjs` — `takeoverRole` (1038-1116)
- Test: `tests/integration/router.test.mjs`

**Interfaces:**
- Consumes: scope-keyed core + backlog from Tasks 3 & 5
- Produces: `takeoverRole({ role, agent_id, scope, reason, requested_by })` — `scope` optional, resolved from `agent_id` when omitted. Replaces the Task 3 placeholder `DEFAULT_ROLE_SCOPE` in the backlog call with `roleState.scope`.

- [ ] **Step 1: Write the failing test**

Add inside the `describe` block:

```javascript
  it("takeoverRole promotes within the target agent's scope only", () => {
    const isolated = createIsolatedRouter();
    try {
      isolated.router.registerAgent({ agent_id: "a-leader", cli: "codex", capabilities: ["code"], topics: [], metadata: { role: "cto", cto_priority: 10, repoRootHash: "aaa" }, heartbeat_ttl_ms: 60000 });
      isolated.router.registerAgent({ agent_id: "a-other", cli: "codex", capabilities: ["code"], topics: [], metadata: { role: "cto", cto_priority: 1, repoRootHash: "aaa" }, heartbeat_ttl_ms: 60000 });
      isolated.router.registerAgent({ agent_id: "b-leader", cli: "codex", capabilities: ["code"], topics: [], metadata: { role: "cto", repoRootHash: "bbb" }, heartbeat_ttl_ms: 60000 });

      const res = isolated.router.takeoverRole({ role: "cto", agent_id: "a-other" });
      assert.equal(res.ok, true);
      assert.equal(res.data.scope, "aaa");
      assert.equal(isolated.router.getRoleSnapshot("cto", "aaa").leader_agent_id, "a-other");
      assert.equal(isolated.router.getRoleSnapshot("cto", "bbb").leader_agent_id, "b-leader");
    } finally {
      isolated.cleanup();
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-lock.mjs --test --test-force-exit --test-concurrency=8 tests/integration/router.test.mjs`
Expected: FAIL — `takeoverRole` uses global scope; `getRoleSnapshot("cto","aaa")` not updated; `res.data.scope` is `global`/undefined.

- [ ] **Step 3: Make `takeoverRole` scope-aware** (replace `1038-1116`):

```javascript
    takeoverRole({ role = "cto", agent_id, scope, reason = "manual", requested_by = "manual" } = {}) {
      const roleName = normalizeRoleName(role);
      if (!roleName) {
        return { ok: false, error: { code: "ROLE_NOT_SUPPORTED", message: `unsupported role: ${role}` } };
      }
      const targetAgentId = String(agent_id || "").trim();
      if (!targetAgentId) {
        return { ok: false, error: { code: "AGENT_ID_REQUIRED", message: "agent_id required" } };
      }
      const resolvedScope = scope || scopeForAgent(targetAgentId);
      refreshRoleCandidates(roleName, resolvedScope);
      const roleState = ensureRoleState(roleName, resolvedScope);
      const candidate = buildRoleCandidate(targetAgentId, roleName);
      if (!isCandidateLive(candidate) || candidate.scope !== roleState.scope) {
        return {
          ok: false,
          error: {
            code: "ROLE_CANDIDATE_UNAVAILABLE",
            message: `${targetAgentId} is not a live ${roleName} candidate in scope ${roleState.scope}`,
          },
          data: { role: buildRoleSnapshot(roleName, roleState.scope) },
        };
      }
      const previousLeaderAgentId =
        roleState.leaderAgentId && roleState.leaderAgentId !== targetAgentId
          ? roleState.leaderAgentId
          : roleState.previousLeaderAgentId || null;
      const changed = roleState.leaderAgentId !== targetAgentId;
      if (changed) {
        roleState.previousLeaderAgentId = previousLeaderAgentId || null;
        roleState.leaderAgentId = targetAgentId;
        roleState.leaderSource = candidate.source;
        roleState.leaderEpoch += 1;
        roleState.status = "active";
        roleState.lastTransitionMs = Date.now();
        roleState.lastReason = reason || "manual";
      }
      const transfer = transferRoleBacklog(roleName, roleState.scope, targetAgentId, previousLeaderAgentId);
      const snapshot = buildRoleSnapshot(roleName, roleState.scope);
      return {
        ok: true,
        data: {
          role: roleName,
          scope: roleState.scope,
          requested_by,
          reason,
          changed,
          previous_leader_agent_id: previousLeaderAgentId,
          leader_agent_id: snapshot.leader_agent_id,
          leader_epoch: snapshot.leader_epoch,
          ...transfer,
          status: snapshot,
        },
      };
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/test-lock.mjs --test --test-force-exit --test-concurrency=8 tests/integration/router.test.mjs && node scripts/test-lock.mjs --test --test-force-exit --test-concurrency=8 tests/integration/pipe.test.mjs`
Expected: PASS (existing takeover tests still hold under `global`).

- [ ] **Step 5: Lint + commit**

```bash
npm run lint
git add hub/router.mjs tests/integration/router.test.mjs
git commit -m "feat(hub): scope-aware CTO takeover"
```

---

## Task 7: getStatus exposes per-scope roles

**Files:**
- Modify: `hub/router.mjs` — `getStatus` (1401-1434)
- Test: `tests/integration/router.test.mjs`

**Interfaces:**
- Consumes: `listRoleScopes`, `getRoleSnapshot`
- Produces: `getStatus("hub").data.roles.cto` = `global` snapshot (back-compat); `getStatus("hub").data.role_scopes.cto` = array of per-scope snapshots.

- [ ] **Step 1: Write the failing test**

```javascript
  it("getStatus exposes role_scopes per project and keeps global back-compat", () => {
    const isolated = createIsolatedRouter();
    try {
      isolated.router.registerAgent({ agent_id: "g-leader", cli: "codex", capabilities: ["code"], topics: [], metadata: { role: "cto" }, heartbeat_ttl_ms: 60000 });
      isolated.router.registerAgent({ agent_id: "a-leader", cli: "codex", capabilities: ["code"], topics: [], metadata: { role: "cto", repoRootHash: "aaa", repo_root: "/repo/a" }, heartbeat_ttl_ms: 60000 });

      const status = isolated.router.getStatus("hub");
      assert.equal(status.data.roles.cto.leader_agent_id, "g-leader");
      assert.equal(status.data.roles.cto.scope, "global");

      const scopes = status.data.role_scopes.cto;
      assert.ok(Array.isArray(scopes));
      const aaa = scopes.find((s) => s.scope === "aaa");
      assert.equal(aaa.leader_agent_id, "a-leader");
      assert.equal(aaa.repo_root, "/repo/a");
      assert.equal(aaa.repo_root_hash, "aaa");
    } finally {
      isolated.cleanup();
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-lock.mjs --test --test-force-exit --test-concurrency=8 tests/integration/router.test.mjs`
Expected: FAIL — `status.data.role_scopes` is `undefined`.

- [ ] **Step 3: Add `role_scopes`** (replace `hub/router.mjs:1414-1416`):

```javascript
        data.roles = {
          cto: getRoleSnapshot("cto", DEFAULT_ROLE_SCOPE),
        };
        data.role_scopes = {
          cto: listRoleScopes("cto").map((scope) => getRoleSnapshot("cto", scope)),
        };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/test-lock.mjs --test --test-force-exit --test-concurrency=8 tests/integration/router.test.mjs`
Expected: PASS — existing `getStatus("hub").data.roles.cto.*` assertions hold (global).

- [ ] **Step 5: Lint + commit**

```bash
npm run lint
git add hub/router.mjs tests/integration/router.test.mjs
git commit -m "feat(hub): expose per-scope CTO roles in getStatus"
```

---

## Task 8: Forward role_scopes through the tray-state payload

**Files:**
- Modify: `hub/server.mjs` (`/api/tray-state` `mergedCtoStatus` — add `role_scopes`)
- Modify: `hub/tray-state.mjs:454-499` (`normalizeCtoStatus` — pass `role_scopes` through)
- Test: `tests/unit/tray-state.test.mjs`

**Interfaces:**
- Consumes: `getStatus(...).data.role_scopes` from Task 7
- Produces: `buildTrayStatePayload(...).cto.role_scopes` reaches the browser via `/api/tray-state`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/tray-state.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTrayStatePayload } from "../../hub/tray-state.mjs";

test("buildTrayStatePayload forwards cto.role_scopes", () => {
  const payload = buildTrayStatePayload({
    hub: { id: "h1", projectRoot: "/repo/a" },
    ctoStatus: {
      roles: { cto: { role: "cto", scope: "global", leader_agent_id: null } },
      role_scopes: {
        cto: [
          { role: "cto", scope: "aaa", repo_root: "/repo/a", repo_root_hash: "aaa", leader_agent_id: "a-leader", status: "active", leader_epoch: 1 },
          { role: "cto", scope: "bbb", repo_root: "/repo/b", repo_root_hash: "bbb", leader_agent_id: "b-leader", status: "active", leader_epoch: 1 },
        ],
      },
    },
  });
  assert.ok(Array.isArray(payload.cto.role_scopes.cto));
  assert.equal(payload.cto.role_scopes.cto.length, 2);
  assert.equal(payload.cto.role_scopes.cto[0].repo_root, "/repo/a");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-lock.mjs --test --test-force-exit --test-concurrency=8 tests/unit/tray-state.test.mjs`
Expected: FAIL — `payload.cto.role_scopes` is `undefined`.

- [ ] **Step 3: Pass `role_scopes` through `normalizeCtoStatus`**

In `hub/tray-state.mjs`, after the `roles`/`succession` extraction (~475-482), add:

```javascript
  const roleScopes =
    ctoStatus?.role_scopes && typeof ctoStatus.role_scopes === "object"
      ? ctoStatus.role_scopes
      : null;
```

In the returned object (~488-490), add next to `roles`:

```javascript
    ...(roles ? { roles } : {}),
    ...(roleScopes ? { role_scopes: roleScopes } : {}),
    ...(succession ? { succession } : {}),
```

- [ ] **Step 4: Merge `role_scopes` in the server endpoint**

In `hub/server.mjs`, locate the `mergedCtoStatus` literal in the `/api/tray-state` handler and add one line:

```javascript
  const mergedCtoStatus = {
    ...(ctoStatus || {}),
    roles: hubStatus?.data?.roles || ctoStatus?.roles || {},
    role_scopes: hubStatus?.data?.role_scopes || ctoStatus?.role_scopes || {},
  };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node scripts/test-lock.mjs --test --test-force-exit --test-concurrency=8 tests/unit/tray-state.test.mjs`
Expected: PASS.

- [ ] **Step 6: Lint + commit**

```bash
npm run lint
git add hub/server.mjs hub/tray-state.mjs tests/unit/tray-state.test.mjs
git commit -m "feat(hub): forward per-scope CTO roles to tray-state payload"
```

---

## Task 9: Render each project's CTO in its own group

**Files:**
- Modify: `hub/public/tray.html:336-415` (`ctoRoleFromPayload`, `ctoRoleRow`, `buildProjectGroups`) + its caller `renderSessions` (~603-644)
- Test: manual tray verification (payload-shape contract covered by Task 8)

**Interfaces:**
- Consumes: `cto.role_scopes.cto` (array; each carries `scope`, `repo_root`, `repo_root_hash`, `leader_agent_id`, `status`, `leader_epoch`, `pending_count`, `live_candidate_count`)
- Produces: one synthetic CTO row per project scope, each grouped under its own `repo_root`. Legacy single-role payloads still render.

- [ ] **Step 1: Add a multi-scope extractor** (after `ctoRoleFromPayload`, line 336-338):

```javascript
        function ctoRoleScopesFromPayload(cto) {
          const scopes = cto?.role_scopes?.cto;
          if (Array.isArray(scopes) && scopes.length) return scopes;
          const single = ctoRoleFromPayload(cto);
          return single ? [single] : [];
        }
```

- [ ] **Step 2: `ctoRoleRow` places by the role's own repo_root** (replace lines 360-374):

```javascript
        function ctoRoleRow(ctoRole, hub, fallbackProject) {
          if (!ctoRole) return null;
          const status = ctoRole.status === 'active' ? 'active' : 'offline';
          const leader = ctoRole.leader_agent_id || ctoRole.previous_leader_agent_id || 'unassigned';
          const scope = ctoRole.scope || ctoRole.repo_root_hash || '';
          const projectCwd = ctoRole.repo_root || hub.projectRoot || fallbackProject || 'local';
          const idHint = ctoRole.leader_agent_id
            ? `cto:${ctoRole.leader_agent_id}`
            : `cto:${scope || shortId(hub.id || fallbackProject || 'role')}`;
          return {
            sessionId: idHint,
            status,
            cwd: projectCwd,
            taskSummary: status === 'active'
              ? `CTO leader ${leader} · epoch ${ctoRole.leader_epoch || 0} · pending ${ctoRole.pending_count || 0}`
              : `CTO offline · previous ${leader} · candidates ${ctoRole.live_candidate_count || 0}`,
            synthetic: true,
            roleStatus: ctoRole,
          };
        }
```

- [ ] **Step 3: One CTO row per scope into its project group** (replace `buildProjectGroups` 376-415):

```javascript
        function buildProjectGroups(activeSessions, liveRows, hub, ctoRoles = []) {
          const groups = new Map();
          const fallbackProject = hub.projectRoot || activeSessions[0]?.cwd || activeSessions[0]?.worktreePath || 'local';
          const primaryRole = ctoRoles[0] || null;
          for (const session of activeSessions) {
            const group = getProjectGroup(groups, projectPathFor(session, hub, fallbackProject));
            if (rowHasCtoRole(session, primaryRole)) group.ctos.push(session);
            else group.workers.push(session);
          }
          const activeSessionIds = new Set(activeSessions.map(session => session.sessionId).filter(Boolean));
          for (const worker of liveRows) {
            if (activeSessionIds.has(worker.sessionId)) continue;
            const group = getProjectGroup(groups, projectPathFor(worker, hub, fallbackProject));
            if (rowHasCtoRole(worker, primaryRole)) group.ctos.push(worker);
            else group.workers.push(worker);
          }
          if (groups.size === 0 && fallbackProject) getProjectGroup(groups, fallbackProject);
          for (const ctoRole of ctoRoles) {
            const roleRow = ctoRoleRow(ctoRole, hub, fallbackProject);
            if (!roleRow) continue;
            const project = projectPathFor(roleRow, hub, fallbackProject);
            const group = getProjectGroup(groups, project);
            const leader = String(ctoRole?.leader_agent_id || '').trim();
            const existing = group.ctos.find(row => {
              const sid = String(row?.sessionId || '').trim();
              const agentId = String(row?.agent_id || row?.agent?.id || '').trim();
              return sid === roleRow.sessionId || (leader && (sid === leader || agentId === leader));
            });
            if (existing) existing.roleStatus = ctoRole;
            else group.ctos.unshift(roleRow);
          }
          return [...groups.values()].sort((a, b) => a.projectPath.localeCompare(b.projectPath));
        }
```

- [ ] **Step 4: Update the caller in `renderSessions`** (~603-644):

Replace:
```javascript
          const ctoRole = ctoRoleFromPayload(cto);
          const projectGroups = buildProjectGroups(activeSessions.slice(0, 10), liveRows, hub, ctoRole);
```
with:
```javascript
          const ctoRoles = ctoRoleScopesFromPayload(cto);
          const projectGroups = buildProjectGroups(activeSessions.slice(0, 10), liveRows, hub, ctoRoles);
```

- [ ] **Step 5: Manual tray verification**

1. Register two `cto` candidates from two different repo cwds: from repo X run `node hub/bridge.mjs register --agent ctoX --capabilities cto`, from repo Y run `node hub/bridge.mjs register --agent ctoY --capabilities cto` (the bridge stamps each cwd's scope).
2. `curl -s http://127.0.0.1:27888/api/tray-state | jq '.cto.role_scopes.cto'` → confirm two entries with distinct `repo_root_hash` and `repo_root`.
3. Open the tray (`tfx tray`) → confirm each project group shows its OWN CTO row.
4. Take one project's leader offline → only that project's CTO row flips to offline.

Record the `jq` output + observation in the PR description.

- [ ] **Step 6: Lint + commit**

```bash
npm run lint
git add hub/public/tray.html
git commit -m "feat(tray): render per-project CTO leaders in their own groups"
```

---

## Task 10: Mirror sync + full verification

**Files (generated by `pack.mjs`):** `packages/core/hub/{router,bridge}.mjs`, `packages/core/hub/lib/repo-scope.mjs`, `packages/triflux/hub/{router,bridge,server,tray-state,store}.mjs`, `packages/triflux/hub/lib/repo-scope.mjs`, `packages/triflux/hub/schema.sql`, `packages/triflux/hub/public/tray.html`, `packages/triflux/cto/status.mjs`, **`packages/remote/cto/status.mjs`**, **`packages/remote/hub/{server,tray-state,store}.mjs`**, **`packages/remote/hub/public/tray.html`**. (`hub/store.mjs` → remote+triflux; `hub/schema.sql` → triflux only.)

- [ ] **Step 1: Run the canonical mirror sync**

Run: `node scripts/pack.mjs all`
Expected: copies sources into mirrors (byte-identical for core/triflux; `@triflux/core` import rewrite for remote). No unresolved errors.

- [ ] **Step 2: Verify byte-identical mirrors**

```bash
for f in hub/router.mjs hub/bridge.mjs hub/lib/repo-scope.mjs; do
  diff -q "$f" "packages/core/$f" && diff -q "$f" "packages/triflux/$f"
done
# store.mjs mirrors to remote + triflux (NOT core); schema.sql to triflux only
diff -q hub/store.mjs packages/triflux/hub/store.mjs && diff -q hub/store.mjs packages/remote/hub/store.mjs
diff -q hub/schema.sql packages/triflux/hub/schema.sql
diff -q cto/status.mjs packages/triflux/cto/status.mjs
diff -q hub/server.mjs packages/triflux/hub/server.mjs
diff -q hub/tray-state.mjs packages/triflux/hub/tray-state.mjs
diff -q hub/public/tray.html packages/triflux/hub/public/tray.html
```
Expected: every `diff -q` exits 0. (Note: `packages/remote/hub/` has no `schema.sql` — this is PRE-EXISTING and unchanged by this plan. `hub/store.mjs:110` reads `schema.sql` unconditionally at the top of `createStore`, BEFORE the `ensureColumn` calls — so `ensureColumn` does NOT rescue a missing schema.sql; a fresh-local-DB `createStore` in remote would already `ENOENT` today, independent of `role_scope`. Remote is unaffected only because that path isn't exercised against a fresh local SQLite store in remote deployments. If a future change wires remote to a real local store, `schema.sql` must ship to remote too — track separately, out of scope here.)

- [ ] **Step 3: Verify the remote import rewrite (finding F3)**

```bash
grep -n "repo-scope" packages/remote/cto/status.mjs
```
Expected: imports `@triflux/core/hub/lib/repo-scope.mjs` (NOT `../hub/lib/...`). Then smoke-test resolution:
```bash
node --input-type=module -e "import('@triflux/core/hub/lib/repo-scope.mjs').then(m=>console.log('ok', typeof m.repoScopeHash))" 2>&1 || echo "verify @triflux/core is built/linked"
```
Also confirm `packages/core/hub/lib/repo-scope.mjs` exists post-sync (`test -f packages/core/hub/lib/repo-scope.mjs && echo OK`).

- [ ] **Step 4: Full suite + lint**

Run: `npm test`
Expected: all tests PASS, `lint:skills` clean.
Run: `npm run lint`
Expected: Biome clean.

- [ ] **Step 5: Verify npm pack size**

Run: `cd packages/triflux && npm pack --dry-run 2>&1 | tail -5 && cd -`
Expected: ~1MB (no stray binary path).

- [ ] **Step 6: Commit the mirror sync**

```bash
git add packages/
git commit -m "chore(mirror): sync per-project CTO scope to package mirrors"
```

---

## Self-Review

**1. Spec coverage** — every requirement of "true per-project CTO" maps to a task:
- Project scope carried by agents → Task 1 (helper) + Task 2 (register chokepoint covering all 3 register paths + bridge stamp).
- Per-project election → Task 3 (scope-keyed `roleStates`, `ensureRoleLeader(role, scope)` with phantom-leader guard).
- Per-project succession/failover → Task 4 (scoped hot-path re-election + `reelectStaleRoles` over all scopes).
- Per-project `topic:cto` routing + persisted scope + replay → Task 5.
- Per-project backlog isolation → Task 5.
- Per-project manual takeover → Task 6.
- Per-project status surface → Task 7.
- Per-project tray display (the reported symptom) → Tasks 8-9.
- Mirror (incl. remote) + green suite → Task 10.

**2. Placeholder scan** — every code step shows the full function body or the exact literal. The only deferred body (Task 3 → Task 5 shim for `transferRoleBacklog`/`countPendingForRole`) is explicit, AND the `takeoverRole` caller fix is now a numbered step (Task 3 Step 9), not prose.

**3. Type consistency** — stable signatures: `ensureRoleState(roleName, scope)`, `buildRoleSnapshot(roleName, scope, opts)`, `ensureRoleLeader(roleName, scope, opts)`, `getRoleSnapshot(roleName, scope)`, `chooseRoleLeader(roleName, scope)`, `refreshRoleCandidates(roleName, scope)`, `transferRoleBacklog(roleName, scope, newLeader, prevLeader)`, `countPendingForRole(roleName, scope)`, `messageMatchesRole(record, roleName, scope)`, `isRoleRecipient(agentId, roleName, scope, prev)`, `takeoverRole({ role, agent_id, scope, ... })`, `messageRoleScope(message)`, `resolveMessageRoleScope(to, from)`, `normalizeRegisterScope(metadata)`. Candidates carry `scope`+`repo_root`; snapshots carry `scope`+`repo_root_hash`+`repo_root`; messages carry `role_scope` in-memory AND in `payload.role_scope`.

## Review findings resolution (R3)

| Finding | Severity | Resolution |
|---------|----------|-----------|
| F1 takeoverRole backlog caller breaks Task 3 | P1 | Task 3 Step 9 — explicit numbered edit of `takeoverRole`'s `transferRoleBacklog` call to `DEFAULT_ROLE_SCOPE` placeholder; Task 6 finalizes to `roleState.scope`. |
| F2 scope only stamped in bridge → inert in prod | P1 | Task 2 — `normalizeRegisterScope` chokepoint in `router.registerAgent` covers `pipe.mjs:224` + `tools.mjs:159` + bridge; Step 1 investigates the real CTO-candidate path; e2e test asserts scope derived from `metadata.cwd`. |
| F3 mirror matrix wrong (4 remote targets) | P1 | Global Constraints matrix corrected; Task 10 Step 3 verifies `packages/remote/cto/status.mjs` import rewrite + resolution. |
| F4 phantom cross-scope leader | P1 | Task 3 — `ensureRoleLeader` `current.scope === role.scope` guard + `buildRoleSnapshot` `leader.scope === role.scope` + `refreshRoleCandidateForAgent` vacates a purged leader; scope-churn test. |
| F5 role_scope not persisted → replay mis-gated | P1 | Task 5 — scope persisted as a top-level `role_scope` COLUMN (see NEW-2); `messageRoleScope` reads it; `isReplayAllowedForAgent` falls back to the agent's own scope; replay test. |
| **NEW-1** ensureRoleLeader arity change strands 5/6 callers → Task 3 RED | **P0** | Task 3 Step 9b — atomic migration of ALL 6 `ensureRoleLeader` call sites the moment the signature changes (entry points final `scopeForAgent`; `resolveRecipients`/`reelectStaleRoles` transitional). Task 2's register loop kept 2-arg; Task 4 reduced to `listRoleScopes`+`reelectStaleRoles` only. |
| **NEW-2** role_scope in payload breaks deepEqual + changes contract | **P1** | Task 5 — persist `role_scope` as a dedicated TOP-LEVEL `messages` column (schema.sql + `ensureColumn` migration + `insertAuditMessage` + `auditLog`), NOT in payload; consumer payload + `to_agent` unchanged → `router.test.mjs:237` / `pipe.test.mjs:317` deepEquals pass. |
| P2 heartbeat re-election amplification | P2 | Task 3 Step 9b — hot paths re-elect only `scopeForAgent(agentId)`; all-scope sweep only in `reelectStaleRoles` (Task 4). |
| P2 unused shim param lint | P2 | Interim shim params are leading/used-after; Biome default tolerates — confirm at Task 3 lint gate. |
| P2 cto/status re-export ambiguity | P2 | Task 1 Step 5 — exact `import {...}` + separate `export { deriveRepoRootFromCwd };`. |
| P2 dispatch payload guard (non-object) | P2 | Moot under NEW-2 column approach — payload is no longer mutated, so non-object payloads need no guard. |

## Open risks for re-review

- **`topic:cto` semantics change:** callers that intentionally relied on a single hub-wide CTO inbox must use `topic:cto@global`. Verified no external module reads `roleStates`/`getRoleSnapshot`/`role_scopes` outside `router.mjs` (critic confirmed), so back-compat surface holds.
- **Production CTO-candidate path (F2 Step 1):** the chokepoint makes any cwd-supplying caller correct, but the e2e proof that the REAL coordinator supplies cwd depends on Task 2 Step 1's investigation result — record it in the PR.

## Execution Handoff

Per the invocation (`/autopilot` + `/gstack-plan-eng-review`), the order is:
1. **Re-review** this R2 plan (eng-review gate) — confirm F1-F5 resolutions.
2. **autopilot** / superpowers:subagent-driven-development — execute Tasks 1-10 in order, fresh subagent + two-stage review per task.
