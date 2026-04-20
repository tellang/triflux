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
const REPO_ROOT = join(SCRIPT_DIR, "..", "..");
const MIRROR_ROOT = join(REPO_ROOT, "packages", "triflux");
const MIRROR_TOPS = ["bin", "hub", "scripts"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);

function walkRelFiles(root) {
  const out = [];
  if (!existsSync(root)) return out;
  const stack = [""];
  while (stack.length > 0) {
    const rel = stack.pop();
    const abs = rel ? join(root, rel) : root;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const subRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) stack.push(subRel);
      else out.push(subRel);
    }
  }
  return out;
}

function compareMirror({ fix = false } = {}) {
  const issues = [];
  const fixed = [];

  for (const top of MIRROR_TOPS) {
    const srcDir = join(REPO_ROOT, top);
    const dstDir = join(MIRROR_ROOT, top);
    const srcFiles = new Set(walkRelFiles(srcDir));
    const dstFiles = new Set(walkRelFiles(dstDir));
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
      console.log("Mirror OK — packages/triflux matches root");
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
      "Run with --fix to copy root → packages/triflux. Orphans must be removed manually.",
    );
  }

  process.exitCode = result.ok ? 0 : 1;
}

main();

export { compareMirror };
