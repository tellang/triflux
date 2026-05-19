import { execFileSync } from "node:child_process";

export function detectChangedFiles({
  cwd = process.cwd(),
  includeStaged = true,
  includeUnstaged = true,
  includeUntracked = true,
} = {}) {
  const staged = includeStaged
    ? runGit(cwd, ["diff", "--cached", "--name-only"])
    : [];
  const unstaged = includeUnstaged ? runGit(cwd, ["diff", "--name-only"]) : [];
  const untracked = includeUntracked
    ? runGit(cwd, ["ls-files", "--others", "--exclude-standard"])
    : [];
  const files = [...new Set([...staged, ...unstaged, ...untracked])];

  return {
    stagedCount: staged.length,
    unstagedCount: unstaged.length,
    untrackedCount: untracked.length,
    totalChanged: files.length,
    files,
  };
}

export function hasCodeChange(opts) {
  return detectChangedFiles(opts).totalChanged > 0;
}

function runGit(cwd, args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    return [];
  }
}
