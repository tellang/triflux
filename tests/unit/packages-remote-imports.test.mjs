import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const REMOTE_ROOT = path.join(REPO_ROOT, "packages/remote");
const CORE_ROOT = path.join(REPO_ROOT, "packages/core");
const TEAM_DIR = path.join(REMOTE_ROOT, "hub/team");
const IMPORT_RE =
  /(?:from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\))/g;

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findMjsFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findMjsFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
      files.push(entryPath);
    }
  }
  return files;
}

async function linkPackageDependencies(tmpNodeModules) {
  const rootNodeModules = await findNodeModules();
  const entries = await fs.readdir(rootNodeModules, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".bin" || entry.name === "@triflux") continue;
    const src = path.join(rootNodeModules, entry.name);
    const dst = path.join(tmpNodeModules, entry.name);
    if (entry.name.startsWith("@")) {
      await fs.mkdir(dst, { recursive: true });
      for (const scopedEntry of await fs.readdir(src, {
        withFileTypes: true,
      })) {
        await fs.symlink(
          path.join(src, scopedEntry.name),
          path.join(dst, scopedEntry.name),
          "dir",
        );
      }
    } else {
      await fs.symlink(src, dst, "dir");
    }
  }
}

async function findNodeModules() {
  const candidates = [
    path.join(REPO_ROOT, "node_modules"),
    path.resolve(REPO_ROOT, "../../..", "node_modules"),
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  throw new Error(`node_modules not found near ${REPO_ROOT}`);
}

test("packages/remote imports core modules through @triflux/core", async () => {
  const violations = [];
  for (const filePath of await findMjsFiles(REMOTE_ROOT)) {
    const source = await fs.readFile(filePath, "utf8");
    for (const match of source.matchAll(IMPORT_RE)) {
      const specifier = match[1] || match[2];
      if (!specifier?.startsWith(".")) continue;

      const remoteTarget = path.normalize(
        path.join(path.dirname(filePath), specifier),
      );
      if (await fileExists(remoteTarget)) continue;

      const remoteRelativeTarget = path.relative(REMOTE_ROOT, remoteTarget);
      if (await fileExists(path.join(CORE_ROOT, remoteRelativeTarget))) {
        violations.push(
          `${path.relative(REPO_ROOT, filePath)} imports ${specifier}; use @triflux/core/${remoteRelativeTarget}`,
        );
      }
    }
  }

  assert.deepEqual(violations, []);
});

test("packages/remote conductor mesh imports use @triflux/core/mesh", async () => {
  const expected = new Map([
    ["conductor.mjs", 'from "@triflux/core/mesh/mesh-registry.mjs"'],
    [
      "conductor-mesh-bridge.mjs",
      'from "@triflux/core/mesh/mesh-protocol.mjs"',
    ],
    [
      "swarm-hypervisor.mjs",
      /import\(\s*["@']@triflux\/core\/mesh\/mesh-registry\.mjs["']\s*\)/u,
    ],
  ]);

  for (const [fileName, snippet] of expected) {
    const source = await fs.readFile(path.join(TEAM_DIR, fileName), "utf8");
    if (typeof snippet === "string") {
      assert.ok(
        source.includes(snippet),
        `${fileName} should include ${snippet}`,
      );
    } else {
      assert.match(source, snippet);
    }
    assert.doesNotMatch(source, /\.\.\/\.\.\/mesh/u);
  }
});

test("packages/remote team entrypoints load with published package layout", async () => {
  const execFileAsync = promisify(execFile);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-remote-import-"));
  try {
    const scopeDir = path.join(tmp, "node_modules", "@triflux");
    await fs.mkdir(scopeDir, { recursive: true });
    await linkPackageDependencies(path.join(tmp, "node_modules"));
    await fs.symlink(CORE_ROOT, path.join(scopeDir, "core"), "dir");
    await fs.symlink(REMOTE_ROOT, path.join(scopeDir, "remote"), "dir");

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--preserve-symlinks",
        "--input-type=module",
        "-e",
        "await import('@triflux/core/mesh/mesh-registry.mjs'); await import('@triflux/core/mesh/mesh-protocol.mjs'); await import('@triflux/remote/hub/team/headless.mjs'); await import('@triflux/remote/hub/team/backend.mjs'); await import('@triflux/remote/hub/team/conductor.mjs'); await import('@triflux/remote/hub/team/conductor-mesh-bridge.mjs'); await import('@triflux/remote/hub/team/swarm-hypervisor.mjs'); console.log('ok');",
      ],
      { cwd: tmp },
    );
    assert.match(stdout, /ok/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
