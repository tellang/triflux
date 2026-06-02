#!/usr/bin/env node
// Verify that packages/triflux/<top>/ byte-equals <top>/ for every mirrored
// top-level directory. Release rule: `packages/triflux` is an npm-publishable
// copy of the root project. Silent drift (session 11 BUG-I cp sync was manual,
// session 12 npm link revealed 3 missing files + 6 drifted) defeats the point
// of the mirror.
//
// Usage:
//   node scripts/release/check-packages-mirror.mjs          # report only
//   node scripts/release/check-packages-mirror.mjs --fix    # copy root -> mirror
//   node scripts/release/check-packages-mirror.mjs --json   # machine output
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = join(SCRIPT_DIR, "..", "..");
const MIRROR_TOPS = [
  "bin",
  "config",
  "cto",
  "hooks",
  "hub",
  "hud",
  "mesh",
  "scripts",
  "skills",
  "tui",
];
const CORE_FILE_MIRRORS = [
  {
    source: "hub/bridge.mjs",
    target: "packages/core/hub/bridge.mjs",
  },
  {
    source: "hub/team/retry-state-machine.mjs",
    target: "packages/core/hub/team/retry-state-machine.mjs",
  },
  {
    source: "hub/team/claude-daemon-control.mjs",
    target: "packages/core/hub/team/claude-daemon-control.mjs",
  },
  {
    source: "hub/team/claude-session-projection.mjs",
    target: "packages/core/hub/team/claude-session-projection.mjs",
  },
];
// Whole directories under packages/core that must be byte-identical to root.
// Mirror policy (§packages/core): hooks/hud are byte-identical cp mirrors.
// See .claude/rules/tfx-mirror-policy.md and PR #377.
const CORE_DIR_MIRRORS = ["hud"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);
// Per-top relative paths to skip. Mirror policy excludes these via
// packages/triflux/package.json "files" negation patterns (e.g.
// "!skills/tfx-workspace"), so source-tree drift in these subtrees does not
// affect the npm tarball. See .claude/rules/tfx-mirror-policy.md.
const SKIP_RELS = new Map([["skills", new Set(["tfx-workspace"])]]);

function walkRelFiles(root, skipRels = new Set()) {
  const out = [];
  if (!existsSync(root)) return out;
  const stack = [""];
  while (stack.length > 0) {
    const rel = stack.pop();
    const abs = rel ? join(root, rel) : root;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const subRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (skipRels.has(subRel)) continue;
      if (entry.isDirectory()) stack.push(subRel);
      else out.push(subRel);
    }
  }
  return out;
}

function compareMirror({
  fix = false,
  repoRoot = DEFAULT_REPO_ROOT,
  mirrorRoot = join(repoRoot, "packages", "triflux"),
} = {}) {
  const issues = [];
  const fixed = [];

  for (const top of MIRROR_TOPS) {
    const srcDir = join(repoRoot, top);
    const dstDir = join(mirrorRoot, top);
    const skipRels = SKIP_RELS.get(top) ?? new Set();
    const srcFiles = new Set(walkRelFiles(srcDir, skipRels));
    const dstFiles = new Set(walkRelFiles(dstDir, skipRels));
    const allFiles = new Set([...srcFiles, ...dstFiles]);

    for (const rel of allFiles) {
      const srcPath = join(srcDir, rel);
      const dstPath = join(dstDir, rel);
      const inSrc = srcFiles.has(rel);
      const inDst = dstFiles.has(rel);
      const displayPath = `packages/triflux/${top}/${rel}`;

      if (inSrc && !inDst) {
        if (fix) {
          mkdirSync(dirname(dstPath), { recursive: true });
          copyFileSync(srcPath, dstPath);
          fixed.push({ path: displayPath, kind: "added" });
        } else {
          issues.push({ path: displayPath, kind: "missing-in-mirror" });
        }
        continue;
      }

      if (!inSrc && inDst) {
        // Orphan in mirror — source of truth is root, mirror must not have
        // extra files. Do not auto-delete; require manual decision.
        issues.push({ path: displayPath, kind: "orphan-in-mirror" });
        continue;
      }

      const a = readFileSync(srcPath);
      const b = readFileSync(dstPath);
      if (!a.equals(b)) {
        if (fix) {
          copyFileSync(srcPath, dstPath);
          fixed.push({ path: displayPath, kind: "updated" });
        } else {
          issues.push({ path: displayPath, kind: "content-diff" });
        }
      }
    }
  }

  for (const mirror of CORE_FILE_MIRRORS) {
    const srcPath = join(repoRoot, mirror.source);
    const dstPath = join(repoRoot, mirror.target);
    const srcExists = existsSync(srcPath);
    const dstExists = existsSync(dstPath);

    if (!srcExists) {
      issues.push({ path: mirror.source, kind: "missing-source" });
      continue;
    }

    if (!dstExists) {
      if (fix) {
        mkdirSync(dirname(dstPath), { recursive: true });
        copyFileSync(srcPath, dstPath);
        fixed.push({ path: mirror.target, kind: "added" });
      } else {
        issues.push({ path: mirror.target, kind: "missing-in-mirror" });
      }
      continue;
    }

    const a = readFileSync(srcPath);
    const b = readFileSync(dstPath);
    if (!a.equals(b)) {
      if (fix) {
        copyFileSync(srcPath, dstPath);
        fixed.push({ path: mirror.target, kind: "updated" });
      } else {
        issues.push({ path: mirror.target, kind: "content-diff" });
      }
    }
  }

  for (const dir of CORE_DIR_MIRRORS) {
    const srcDir = join(repoRoot, dir);
    const dstDir = join(repoRoot, "packages", "core", dir);
    const srcFiles = new Set(walkRelFiles(srcDir));
    const dstFiles = new Set(walkRelFiles(dstDir));
    const allFiles = new Set([...srcFiles, ...dstFiles]);

    for (const rel of allFiles) {
      const srcPath = join(srcDir, rel);
      const dstPath = join(dstDir, rel);
      const inSrc = srcFiles.has(rel);
      const inDst = dstFiles.has(rel);
      const displayPath = `packages/core/${dir}/${rel}`;

      if (inSrc && !inDst) {
        if (fix) {
          mkdirSync(dirname(dstPath), { recursive: true });
          copyFileSync(srcPath, dstPath);
          fixed.push({ path: displayPath, kind: "added" });
        } else {
          issues.push({ path: displayPath, kind: "missing-in-mirror" });
        }
        continue;
      }

      if (!inSrc && inDst) {
        issues.push({ path: displayPath, kind: "orphan-in-mirror" });
        continue;
      }

      const a = readFileSync(srcPath);
      const b = readFileSync(dstPath);
      if (!a.equals(b)) {
        if (fix) {
          copyFileSync(srcPath, dstPath);
          fixed.push({ path: displayPath, kind: "updated" });
        } else {
          issues.push({ path: displayPath, kind: "content-diff" });
        }
      }
    }
  }

  return { ok: issues.length === 0, issues, fixed };
}

function main() {
  const args = process.argv.slice(2);
  const fix = args.includes("--fix");
  const json = args.includes("--json");

  const result = compareMirror({ fix });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    if (result.fixed.length > 0) {
      console.log(`Mirror synced (${result.fixed.length} files fixed):`);
      for (const f of result.fixed) {
        console.log(`  ${f.kind.padEnd(8)} ${f.path}`);
      }
    } else {
      console.log(
        "Mirror OK — packages/triflux and packages/core file mirrors match root",
      );
    }
  } else {
    console.log(`Mirror mismatch (${result.issues.length} issues):`);
    for (const i of result.issues) {
      console.log(`  ${i.kind.padEnd(18)} ${i.path}`);
    }
    if (result.fixed.length > 0) {
      console.log(`Fixed during run (${result.fixed.length}):`);
      for (const f of result.fixed) {
        console.log(`  ${f.kind.padEnd(8)} ${f.path}`);
      }
    }
    console.log("");
    console.log(
      "Run with --fix to copy root → packages/triflux and packages/core file mirrors. Orphans must be removed manually.",
    );
  }

  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

export { compareMirror };
