import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RESOLVE_ROOT_MODULE_URL = new URL("../../hooks/lib/resolve-root.mjs", import.meta.url);
const EXPECTED_FALLBACK_ROOT = normalizePath(fileURLToPath(new URL("../..", RESOLVE_ROOT_MODULE_URL)));

const TEMP_DIRS = [];
let originalEnv;
let originalCwd;

function normalizePath(value) {
  return resolve(String(value || "")).replace(/\\/g, "/").replace(/\/+$/u, "");
}

function restoreProcessEnv(snapshot) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) {
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries(snapshot)) {
    process.env[key] = value;
  }
}

function getTestHomeDir() {
  return process.env.HOME || process.env.USERPROFILE || "";
}

function createValidPluginRoot(baseDir, name = "plugin-root") {
  const root = join(baseDir, name);
  const orchestratorPath = join(root, "hooks", "hook-orchestrator.mjs");
  mkdirSync(dirname(orchestratorPath), { recursive: true });
  writeFileSync(orchestratorPath, "// test fixture\n", "utf8");
  return root;
}

function createInvalidPluginRoot(baseDir, name = "invalid-root") {
  const root = join(baseDir, name);
  mkdirSync(root, { recursive: true });
  return root;
}

function writeBreadcrumb(rootPath, homeDir = getTestHomeDir()) {
  const breadcrumbPath = join(homeDir, ".claude", "scripts", ".tfx-pkg-root");
  mkdirSync(dirname(breadcrumbPath), { recursive: true });
  writeFileSync(breadcrumbPath, `${rootPath}\n`, "utf8");
  return breadcrumbPath;
}

async function loadResolvePluginRoot() {
  const cacheBuster = `test=${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    const mod = await import(`${RESOLVE_ROOT_MODULE_URL.href}?${cacheBuster}`);
    assert.equal(typeof mod.resolvePluginRoot, "function", "resolvePluginRoot export must be a function");
    return mod.resolvePluginRoot;
  } catch (error) {
    if (error && error.code === "ERR_MODULE_NOT_FOUND") {
      assert.fail("hooks/lib/resolve-root.mjs is missing. Add module implementation to run this test suite.");
    }
    throw error;
  }
}

beforeEach(() => {
  originalEnv = { ...process.env };
  originalCwd = process.cwd();

  const sandboxDir = mkdtempSync(join(tmpdir(), "triflux-resolve-plugin-root-"));
  TEMP_DIRS.push(sandboxDir);

  const homeDir = join(sandboxDir, "home");
  mkdirSync(homeDir, { recursive: true });

  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  delete process.env.CLAUDE_PLUGIN_ROOT;
  delete process.env.PLUGIN_ROOT;

  process.chdir(sandboxDir);
});

afterEach(() => {
  if (originalCwd) {
    process.chdir(originalCwd);
  }

  if (originalEnv) {
    restoreProcessEnv(originalEnv);
  }

  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop();
    if (!dir || !existsSync(dir)) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe("resolvePluginRoot", () => {
  it("TC1: breadcrumb이 없고 CLAUDE_PLUGIN_ROOT가 유효하면 env 값을 반환한다", async () => {
    const sandboxDir = process.cwd();
    const validEnvRoot = createValidPluginRoot(sandboxDir, "valid-env-root");
    process.env.CLAUDE_PLUGIN_ROOT = validEnvRoot;

    const resolvePluginRoot = await loadResolvePluginRoot();
    const resolved = resolvePluginRoot();

    assert.equal(normalizePath(resolved), normalizePath(validEnvRoot));
  });

  it("TC2: CLAUDE_PLUGIN_ROOT가 worktree 무효 경로면 breadcrumb 유효값을 반환한다", async () => {
    const sandboxDir = process.cwd();
    const invalidWorktreeRoot = createInvalidPluginRoot(sandboxDir, ".codex-swarm/wt-hook-integration");
    const validBreadcrumbRoot = createValidPluginRoot(sandboxDir, "stable-plugin-root");

    process.env.CLAUDE_PLUGIN_ROOT = invalidWorktreeRoot;
    writeBreadcrumb(validBreadcrumbRoot);

    const resolvePluginRoot = await loadResolvePluginRoot();
    const resolved = resolvePluginRoot();

    assert.equal(normalizePath(resolved), normalizePath(validBreadcrumbRoot));
  });

  it("TC3: breadcrumb이 존재하고 유효하면 breadcrumb 값을 반환한다", async () => {
    const sandboxDir = process.cwd();
    const validBreadcrumbRoot = createValidPluginRoot(sandboxDir, "breadcrumb-root");

    writeBreadcrumb(validBreadcrumbRoot);

    const resolvePluginRoot = await loadResolvePluginRoot();
    const resolved = resolvePluginRoot();

    assert.equal(normalizePath(resolved), normalizePath(validBreadcrumbRoot));
  });

  it("TC4: breadcrumb과 env가 모두 없으면 import.meta.url 기반 fallback을 반환한다", async () => {
    const resolvePluginRoot = await loadResolvePluginRoot();
    const resolved = resolvePluginRoot();

    assert.equal(normalizePath(resolved), EXPECTED_FALLBACK_ROOT);
  });

  it("TC5: 모든 후보가 무효여도 throw하지 않고 fallback으로 동작한다", async () => {
    const sandboxDir = process.cwd();
    const invalidEnvRoot = createInvalidPluginRoot(sandboxDir, "invalid-env-root");
    const invalidBreadcrumbRoot = createInvalidPluginRoot(sandboxDir, "invalid-breadcrumb-root");

    process.env.CLAUDE_PLUGIN_ROOT = invalidEnvRoot;
    writeBreadcrumb(invalidBreadcrumbRoot);

    const resolvePluginRoot = await loadResolvePluginRoot();
    const resolved = resolvePluginRoot();

    assert.equal(normalizePath(resolved), EXPECTED_FALLBACK_ROOT);
  });

  it("TC6: CLAUDE_PLUGIN_ROOT가 path traversal 문자열이면 검증 실패 후 breadcrumb/fallback으로 처리한다", async () => {
    const sandboxDir = process.cwd();
    const validBreadcrumbRoot = createValidPluginRoot(sandboxDir, "breadcrumb-root-for-traversal");

    process.env.CLAUDE_PLUGIN_ROOT = "../../etc/passwd";
    writeBreadcrumb(validBreadcrumbRoot);

    const resolvePluginRoot = await loadResolvePluginRoot();
    const resolved = resolvePluginRoot();

    assert.equal(normalizePath(resolved), normalizePath(validBreadcrumbRoot));
  });
});
