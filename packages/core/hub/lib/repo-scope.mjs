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
    const suffix = normalized.slice(
      gitWorktreeIndex + gitWorktreeMarker.length,
    );
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
