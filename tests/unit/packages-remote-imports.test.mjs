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

test("packages/remote imports core modules through @triflux/core", async () => {
  const violations = [];
  for (const filePath of await findMjsFiles(TEAM_DIR)) {
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

test("packages/remote team entrypoints load with published package layout", async () => {
  const execFileAsync = promisify(execFile);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-remote-import-"));
  try {
    const scopeDir = path.join(tmp, "node_modules", "@triflux");
    await fs.mkdir(scopeDir, { recursive: true });
    await fs.symlink(CORE_ROOT, path.join(scopeDir, "core"), "dir");
    await fs.symlink(REMOTE_ROOT, path.join(scopeDir, "remote"), "dir");

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--preserve-symlinks",
        "--input-type=module",
        "-e",
        "await import('@triflux/remote/hub/team/headless.mjs'); await import('@triflux/remote/hub/team/backend.mjs'); console.log('ok');",
      ],
      { cwd: tmp },
    );
    assert.match(stdout, /ok/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
