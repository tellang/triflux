// tests/unit/mcp-guard-fallback.test.mjs — loadRegistryOrDefault + removeRegistryServer fallback 테스트

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  loadRegistryOrDefault,
  removeRegistryServer,
} from "../../scripts/lib/mcp-guard-engine.mjs";

// 추적 파일 config/mcp-registry.json 을 옮기지 않고 임시 경로를 쓴다(#530).
describe("mcp-guard-engine fallback", () => {
  let dir;
  let REGISTRY_PATH;
  let previous;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tfx-mcp-registry-"));
    REGISTRY_PATH = join(dir, "mcp-registry.json");
    previous = process.env.TFX_MCP_REGISTRY_PATH;
    process.env.TFX_MCP_REGISTRY_PATH = REGISTRY_PATH;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.TFX_MCP_REGISTRY_PATH;
    else process.env.TFX_MCP_REGISTRY_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  it("loadRegistryOrDefault: 파일 없으면 DEFAULT_REGISTRY fallback", () => {
    assert.ok(!existsSync(REGISTRY_PATH), "registry should be missing");
    const registry = loadRegistryOrDefault();
    assert.deepEqual(registry.servers, {});
    assert.equal(registry.defaults.transport, "http");
  });

  it("loadRegistryOrDefault: invalid JSON이면 DEFAULT_REGISTRY fallback", () => {
    writeFileSync(REGISTRY_PATH, "{ invalid json !!!", "utf8");
    const registry = loadRegistryOrDefault();
    assert.deepEqual(registry.servers, {});
  });

  it("removeRegistryServer: 파일 없으면 null 반환", () => {
    assert.ok(!existsSync(REGISTRY_PATH), "registry should be missing");
    const result = removeRegistryServer("nonexistent");
    assert.equal(result, null);
  });

  it("removeRegistryServer: invalid 파일이면 null 반환", () => {
    writeFileSync(REGISTRY_PATH, "not json", "utf8");
    const result = removeRegistryServer("context7");
    assert.equal(result, null);
  });
});
