import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
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

// Static guard for the published native-bridge entrypoints. We deliberately
// avoid `import()` here because packages/core has known structural gaps that
// would cascade into module-resolution failures unrelated to packages/remote's
// own surface (e.g. core/hub/bridge.mjs imports ./team/retry-state-machine.mjs
// while core/hub/team/ is not mirrored). The static check still catches the
// PR #311 / PR #323 regression we care about: that the file exists, parses,
// and routes its cross-package imports through @triflux/core (no relative
// `../../core` paths).
test("packages/remote native-bridge entrypoints exist and parse", async () => {
  const ENTRYPOINTS = [
    "hub/team/headless.mjs",
    "hub/team/backend.mjs",
    "hub/team/swarm-cli.mjs",
    "hub/team/swarm-hypervisor.mjs",
    "hub/team/claude-daemon-control.mjs",
    "hub/team/claude-native-bridge.mjs",
  ];

  const execFileAsync = promisify(execFile);
  const missing = [];
  const syntaxErrors = [];
  const relativeCoreImports = [];

  for (const rel of ENTRYPOINTS) {
    const abs = path.join(REMOTE_ROOT, rel);
    if (!(await fileExists(abs))) {
      missing.push(rel);
      continue;
    }

    try {
      await execFileAsync(process.execPath, ["--check", abs]);
    } catch (err) {
      syntaxErrors.push(`${rel}: ${err.stderr || err.message}`);
    }

    const source = await fs.readFile(abs, "utf8");
    for (const match of source.matchAll(IMPORT_RE)) {
      const specifier = match[1] || match[2];
      if (!specifier?.startsWith(".")) continue;
      const target = path.normalize(path.join(path.dirname(abs), specifier));
      if (await fileExists(target)) continue;
      const remoteRelativeTarget = path.relative(REMOTE_ROOT, target);
      if (await fileExists(path.join(CORE_ROOT, remoteRelativeTarget))) {
        relativeCoreImports.push(
          `${rel} imports ${specifier} via relative path; should be @triflux/core/${remoteRelativeTarget}`,
        );
      }
    }
  }

  assert.deepEqual(missing, [], `missing native-bridge entrypoints: ${missing.join(", ")}`);
  assert.deepEqual(syntaxErrors, [], `parse errors:\n${syntaxErrors.join("\n")}`);
  assert.deepEqual(
    relativeCoreImports,
    [],
    `native-bridge entrypoints reach into core via relative paths:\n${relativeCoreImports.join("\n")}`,
  );
});
