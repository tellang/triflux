// tests/unit/factory-lazy-import.test.mjs — SDK-missing factory import guard

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createWorker as createInstalledWorker } from "../../hub/workers/factory.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(TEST_DIR, "..", "..");
const WORKERS_DIR = resolve(PROJECT_ROOT, "hub", "workers");

async function importFactoryFromSdkMissingTree() {
  const root = mkdtempSync(join(tmpdir(), "triflux-factory-no-sdk-"));
  mkdirSync(join(root, "hub"), { recursive: true });
  cpSync(WORKERS_DIR, join(root, "hub", "workers"), { recursive: true });

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

describe("worker factory lazy imports SDK-dependent workers", () => {
  it("creates GeminiWorker when @modelcontextprotocol/sdk is absent", async () => {
    const { root, factory } = await importFactoryFromSdkMissingTree();
    try {
      const worker = await factory.createWorker("gemini");
      assert.equal(worker.constructor.name, "GeminiWorker");
      assert.equal(worker.type, "gemini");
    } finally {
      removeTree(root);
    }
  });

  it("creates ClaudeWorker when @modelcontextprotocol/sdk is absent", async () => {
    const { root, factory } = await importFactoryFromSdkMissingTree();
    try {
      const worker = await factory.createWorker("claude");
      assert.equal(worker.constructor.name, "ClaudeWorker");
      assert.equal(worker.type, "claude");
    } finally {
      removeTree(root);
    }
  });

  it("rejects codex-mcp creation clearly when @modelcontextprotocol/sdk is absent", async () => {
    const { root, factory } = await importFactoryFromSdkMissingTree();
    try {
      await assert.rejects(
        () => factory.createWorker("codex", { transport: "mcp" }),
        (error) =>
          error?.code === "ERR_MODULE_NOT_FOUND" &&
          /@modelcontextprotocol\/sdk/.test(error.message),
      );
    } finally {
      removeTree(root);
    }
  });

  it("creates CodexMcpWorker when @modelcontextprotocol/sdk is installed", async () => {
    const worker = await createInstalledWorker("codex", { transport: "mcp" });
    assert.equal(worker.constructor.name, "CodexMcpWorker");
    assert.equal(worker.type, "codex");
  });
});
