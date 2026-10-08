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
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_ENTRIES } from "../pack.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = join(SCRIPT_DIR, "..", "..");
const MIRROR_TOPS = [
  "adapters",
  "bin",
  "config",
  "hooks",
  "hub",
  "hud",
  "scripts",
  "skills",
];
// core 미러 대상은 pack.mjs 의 CORE_ENTRIES 하나로 정한다. 검사기가 따로 손 목록을 두면
// 하위 디렉터리나 새 파일이 빠져도 OK 가 나왔다(#674).
const CORE_NON_MIRROR = new Set([
  "package.json",
  "README.md",
  "README.ko.md",
  "LICENSE",
  "hub/index.mjs", // pack 이 만드는 배럴(CORE_INDEX)
]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);
// Per-top relative paths to skip. Mirror policy excludes these via
// packages/triflux/package.json "files" negation patterns (e.g.
// "!skills/tfx-workspace"), so source-tree drift in these subtrees does not
// affect the npm tarball. See .claude/rules/tfx-mirror-policy.md.
const SKIP_RELS = new Map([["skills", new Set([".omc", "tfx-workspace"])]]);

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

// packages/remote is NOT a byte-identical mirror: pack:remote rewrites relative
// imports of core-owned modules to @triflux/core/* specifiers. So validate it
// structurally instead — every .mjs import must resolve (relative -> exists
// under packages/remote; @triflux/core/X -> exists under packages/core), and
// every non-.mjs file mirrored from root must stay byte-identical. This catches
// the two drift classes that shipped silently in v10.33.0: a broken remote
// import (relative specifier to a core-only module) and a stale non-JS asset
// (the tray UI), neither of which the triflux/core byte-mirror check can see.
const REMOTE_NON_MIRROR = new Set([
  "package.json",
  "package-lock.json",
  "README.md",
  "README.ko.md",
  "LICENSE",
  "hub/index.mjs", // pack-generated barrel (REMOTE_INDEX), not a root mirror
]);

function extractImportSpecifiers(content) {
  // Strip comments first so JSDoc usage examples (`* import x from './y'`) and
  // commented-out imports are not mistaken for real specifiers.
  const code = content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const specs = [];
  const re = /(?:from\s+|import\(\s*)["']([^"']+)["']/g;
  let match;
  while ((match = re.exec(code)) !== null) specs.push(match[1]);
  return specs;
}

function restoreRemoteCoreHubImports(content) {
  return content
    .replace(
      /(from\s+["'])@triflux\/core\/hub\/([^"']+)(["'])/g,
      "$1../../hub/$2$3",
    )
    .replace(
      /(import\(\s*["'])@triflux\/core\/hub\/([^"']+)(["']\s*\))/g,
      "$1../../hub/$2$3",
    );
}

function checkRemoteMirror(repoRoot) {
  const issues = [];
  const remoteRoot = join(repoRoot, "packages", "remote");
  const coreRoot = join(repoRoot, "packages", "core");
  if (!existsSync(remoteRoot)) return issues;

  for (const rel of walkRelFiles(remoteRoot)) {
    if (REMOTE_NON_MIRROR.has(rel)) continue;
    const remotePath = join(remoteRoot, rel);
    const displayPath = `packages/remote/${rel}`;

    if (rel.endsWith(".mjs")) {
      const content = readFileSync(remotePath, "utf8");
      for (const spec of extractImportSpecifiers(content)) {
        let resolvedPath = null;
        if (spec.startsWith("@triflux/core/")) {
          resolvedPath = join(coreRoot, spec.slice("@triflux/core/".length));
        } else if (spec.startsWith(".")) {
          resolvedPath = join(dirname(remotePath), spec);
        } else {
          continue; // bare specifier (node: builtin or npm dependency)
        }
        if (!existsSync(resolvedPath)) {
          issues.push({
            path: displayPath,
            kind: `remote-unresolvable-import (${spec})`,
          });
        }
      }
      if (rel.startsWith("scripts/lib/")) {
        const rootPath = join(repoRoot, rel);
        if (
          existsSync(rootPath) &&
          !readFileSync(rootPath).equals(
            Buffer.from(restoreRemoteCoreHubImports(content)),
          )
        ) {
          issues.push({ path: displayPath, kind: "remote-content-diff" });
        }
      }
    } else {
      // Non-.mjs mirrored from root: no import rewrite -> must be byte-identical.
      const rootPath = join(repoRoot, rel);
      if (!existsSync(rootPath)) continue; // remote-only asset, nothing to mirror
      if (!readFileSync(rootPath).equals(readFileSync(remotePath))) {
        issues.push({ path: displayPath, kind: "remote-content-diff" });
      }
    }
  }
  return issues;
}

function checkCoreImports(coreRoot) {
  const issues = [];
  for (const rel of walkRelFiles(coreRoot)) {
    if (!rel.endsWith(".mjs")) continue;
    const corePath = join(coreRoot, rel);
    for (const spec of extractImportSpecifiers(
      readFileSync(corePath, "utf8"),
    )) {
      if (!spec.startsWith(".")) continue;
      if (!existsSync(join(dirname(corePath), spec))) {
        issues.push({
          path: `packages/core/${rel}`,
          kind: `core-unresolvable-import (${spec})`,
        });
      }
    }
  }
  return issues;
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

  const coreRoot = join(repoRoot, "packages", "core");
  const coreDirs = [];
  const coreFiles = [];
  for (const entry of CORE_ENTRIES) {
    const srcPath = join(repoRoot, entry);
    const dstPath = join(coreRoot, entry);
    const probe = existsSync(srcPath) ? srcPath : dstPath;
    if (!existsSync(probe)) continue; // pack 도 원본이 없으면 건너뛴다
    if (statSync(probe).isDirectory()) coreDirs.push(entry);
    else coreFiles.push(entry);
  }

  const syncCoreFile = (rel, inSrc, inDst) => {
    const srcPath = join(repoRoot, rel);
    const dstPath = join(coreRoot, rel);
    const displayPath = `packages/core/${rel}`;
    if (!inSrc) {
      issues.push({ path: displayPath, kind: "orphan-in-mirror" });
    } else if (!inDst) {
      if (fix) {
        mkdirSync(dirname(dstPath), { recursive: true });
        copyFileSync(srcPath, dstPath);
        fixed.push({ path: displayPath, kind: "added" });
      } else {
        issues.push({ path: displayPath, kind: "missing-in-mirror" });
      }
    } else if (!readFileSync(srcPath).equals(readFileSync(dstPath))) {
      if (fix) {
        copyFileSync(srcPath, dstPath);
        fixed.push({ path: displayPath, kind: "updated" });
      } else {
        issues.push({ path: displayPath, kind: "content-diff" });
      }
    }
  };

  for (const rel of coreFiles) {
    syncCoreFile(
      rel,
      existsSync(join(repoRoot, rel)),
      existsSync(join(coreRoot, rel)),
    );
  }
  for (const dir of coreDirs) {
    const srcFiles = new Set(walkRelFiles(join(repoRoot, dir)));
    const dstFiles = new Set(walkRelFiles(join(coreRoot, dir)));
    for (const rel of new Set([...srcFiles, ...dstFiles])) {
      syncCoreFile(`${dir}/${rel}`, srcFiles.has(rel), dstFiles.has(rel));
    }
  }
  // 목록 밖 core 파일도 root 와 어긋나면 잡는다.
  const covered = (rel) =>
    coreFiles.includes(rel) ||
    coreDirs.some((dir) => rel.startsWith(`${dir}/`));
  for (const rel of walkRelFiles(coreRoot)) {
    if (CORE_NON_MIRROR.has(rel) || covered(rel)) continue;
    syncCoreFile(rel, existsSync(join(repoRoot, rel)), true);
  }

  // 개별 미러는 의존 파일이 빠져도 바이트 비교로는 안 보이므로 import 해석으로 잡는다(#648).
  for (const issue of checkCoreImports(coreRoot)) issues.push(issue);

  // packages/remote structural validation (not a byte-mirror — see above).
  for (const issue of checkRemoteMirror(repoRoot)) issues.push(issue);

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
        "Mirror OK — packages/triflux + packages/core (byte) and packages/remote (imports + assets) match root",
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
      "Run with --fix to copy root → packages/triflux and packages/core file mirrors. Orphans must be removed manually. packages/remote drift (remote-*) is regenerated by `npm run pack:remote`, not --fix.",
    );
  }

  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

export { compareMirror };
