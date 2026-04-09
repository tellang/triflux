// tests/unit/mcp-guard-fallback.test.mjs — loadRegistryOrDefault + removeRegistryServer fallback 테스트

import assert from "node:assert/strict";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  inspectRegistry,
  loadRegistryOrDefault,
  removeRegistryServer,
} from "../../scripts/lib/mcp-guard-engine.mjs";

const REGISTRY_PATH = inspectRegistry().path;
const BACKUP_PATH = `${REGISTRY_PATH}.test-bak`;

describe("mcp-guard-engine fallback", () => {
  let originalExists;

  beforeEach(() => {
    originalExists = existsSync(REGISTRY_PATH);
    if (originalExists) {
      renameSync(REGISTRY_PATH, BACKUP_PATH);
    }
  });

  afterEach(() => {
    // 테스트 중 생성된 파일 정리 후 원본 복원
    if (existsSync(REGISTRY_PATH) && existsSync(BACKUP_PATH)) {
      renameSync(BACKUP_PATH, REGISTRY_PATH);
    } else if (existsSync(BACKUP_PATH)) {
      renameSync(BACKUP_PATH, REGISTRY_PATH);
    }
  });

  it("loadRegistryOrDefault: 파일 없으면 DEFAULT_REGISTRY fallback", () => {
    assert.ok(!existsSync(REGISTRY_PATH), "registry should be missing");
    const registry = loadRegistryOrDefault();
    assert.ok(registry.servers["tfx-hub"], "should have tfx-hub from default");
    assert.equal(registry.defaults.transport, "hub-url");
  });

  it("loadRegistryOrDefault: invalid JSON이면 DEFAULT_REGISTRY fallback", () => {
    mkdirSync(join(REGISTRY_PATH, ".."), { recursive: true });
    writeFileSync(REGISTRY_PATH, "{ invalid json !!!", "utf8");
    const registry = loadRegistryOrDefault();
    assert.ok(registry.servers["tfx-hub"], "should fallback to default");
  });

  it("removeRegistryServer: 파일 없으면 null 반환", () => {
    assert.ok(!existsSync(REGISTRY_PATH), "registry should be missing");
    const result = removeRegistryServer("nonexistent");
    assert.equal(result, null);
  });

  it("removeRegistryServer: invalid 파일이면 null 반환", () => {
    mkdirSync(join(REGISTRY_PATH, ".."), { recursive: true });
    writeFileSync(REGISTRY_PATH, "not json", "utf8");
    const result = removeRegistryServer("tfx-hub");
    assert.equal(result, null);
  });
});
