// tests/unit/factory-lazy-import.test.mjs: node_modules 없는 설치 사본에서 factory import 확인

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(TEST_DIR, "..", "..");
const WORKERS_DIR = resolve(PROJECT_ROOT, "hub", "workers");
const HUB_LIB_DIR = resolve(PROJECT_ROOT, "hub", "lib");
const FIXTURE_HUB_LIB_FILES = ["worker-lifecycle.mjs", "timeout-defaults.mjs"];

async function importFactoryFromIsolatedTree() {
  const root = mkdtempSync(join(tmpdir(), "triflux-factory-no-modules-"));
  mkdirSync(join(root, "hub"), { recursive: true });
  cpSync(WORKERS_DIR, join(root, "hub", "workers"), { recursive: true });
  mkdirSync(join(root, "hub", "lib"), { recursive: true });
  for (const file of FIXTURE_HUB_LIB_FILES) {
    cpSync(resolve(HUB_LIB_DIR, file), join(root, "hub", "lib", file));
  }

  try {
    const factoryUrl = pathToFileURL(
      join(root, "hub", "workers", "factory.mjs"),
    ).href;
    return {
      root,
      factory: await import(factoryUrl),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function removeTree(path) {
  rmSync(path, { recursive: true, force: true });
}

describe("worker factory loads without node_modules", () => {
  it("creates ClaudeWorker without node_modules", async () => {
    const { root, factory } = await importFactoryFromIsolatedTree();
    try {
      const worker = await factory.createWorker("claude");
      assert.equal(worker.constructor.name, "ClaudeWorker");
      assert.equal(worker.type, "claude");
    } finally {
      removeTree(root);
    }
  });
});
