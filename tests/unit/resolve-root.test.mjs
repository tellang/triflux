import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MODULE_URL = new URL("../../hooks/lib/resolve-root.mjs", import.meta.url);

function toPosixPath(value) {
  return String(value).replace(/\\/g, "/");
}

function importFreshModule() {
  const fresh = new URL(MODULE_URL.href);
  fresh.searchParams.set("ts", `${Date.now()}-${Math.random()}`);
  return import(fresh.href);
}

function createValidPluginRoot(baseDir, name) {
  const root = join(baseDir, name);
  mkdirSync(join(root, "hooks"), { recursive: true });
  writeFileSync(join(root, "hooks", "hook-orchestrator.mjs"), "// sentinel\n", "utf8");
  return root;
}

describe("resolve-root", () => {
  let tempDir;
  let prevHome;
  let prevUserProfile;
  let prevClaudePluginRoot;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tfx-resolve-root-"));
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    prevClaudePluginRoot = process.env.CLAUDE_PLUGIN_ROOT;

    const testHome = join(tempDir, "home");
    mkdirSync(testHome, { recursive: true });
    process.env.HOME = testHome;
    process.env.USERPROFILE = testHome;
    delete process.env.CLAUDE_PLUGIN_ROOT;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;

    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;

    if (prevClaudePluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = prevClaudePluginRoot;

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("breadcrumb 경로가 유효하면 env보다 우선 사용한다", async () => {
    const breadcrumbRoot = createValidPluginRoot(tempDir, "breadcrumb-root");
    process.env.CLAUDE_PLUGIN_ROOT = join(tempDir, "invalid-env");

    const breadcrumbPath = join(process.env.HOME, ".claude", "scripts", ".tfx-pkg-root");
    mkdirSync(join(process.env.HOME, ".claude", "scripts"), { recursive: true });
    writeFileSync(breadcrumbPath, breadcrumbRoot, "utf8");

    const { PLUGIN_ROOT } = await importFreshModule();
    assert.equal(toPosixPath(PLUGIN_ROOT), toPosixPath(breadcrumbRoot));
  });

  it("breadcrumb이 없으면 유효한 CLAUDE_PLUGIN_ROOT를 사용한다", async () => {
    const envRoot = createValidPluginRoot(tempDir, "env-root");
    process.env.CLAUDE_PLUGIN_ROOT = envRoot;

    const { PLUGIN_ROOT } = await importFreshModule();
    assert.equal(toPosixPath(PLUGIN_ROOT), toPosixPath(envRoot));
  });

  it("breadcrumb/env가 모두 실패하면 callerUrl 기반 fallback을 사용한다", async () => {
    process.env.CLAUDE_PLUGIN_ROOT = join(tempDir, "invalid-env");
    const callerRoot = createValidPluginRoot(tempDir, "caller-root");
    const callerUrl = pathToFileURL(join(callerRoot, "hooks", "pipeline-stop.mjs")).href;

    const { resolvePluginRoot } = await importFreshModule();
    const resolved = resolvePluginRoot(callerUrl);
    assert.equal(toPosixPath(resolved), toPosixPath(callerRoot));
  });

  it("모든 후보가 실패하면 경고를 출력하고 import.meta fallback을 반환한다", async () => {
    process.env.CLAUDE_PLUGIN_ROOT = join(tempDir, "invalid-env");
    const { resolvePluginRoot } = await importFreshModule();

    let stderr = "";
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk, ...args) => {
      stderr += String(chunk);
      const callback = args[args.length - 1];
      if (typeof callback === "function") callback();
      return true;
    };

    try {
      const resolved = resolvePluginRoot(pathToFileURL(join(tempDir, "no-hooks", "file.mjs")).href);
      assert.ok(existsSync(join(resolved, "hooks", "hook-orchestrator.mjs")));
      assert.match(stderr, /resolve-root/i);
    } finally {
      process.stderr.write = originalWrite;
    }
  });
});
