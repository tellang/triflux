import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { getProjectMcpJsonPaths } from "../../scripts/sync-hub-mcp-settings.mjs";

const ORIG_CWD = process.cwd();
let TEMP_CWD;

beforeEach(() => {
  TEMP_CWD = mkdtempSync(join(tmpdir(), "tfx-sync-cwd-test-"));
  process.chdir(TEMP_CWD);
});

afterEach(() => {
  process.chdir(ORIG_CWD);
  try {
    rmSync(TEMP_CWD, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe("getProjectMcpJsonPaths", () => {
  it("returns cwd-based paths when projectRoot undefined", () => {
    const paths = getProjectMcpJsonPaths();
    const cwd = process.cwd();
    assert.deepEqual(paths, [
      join(cwd, ".claude", "mcp.json"),
      join(cwd, ".mcp.json"),
    ]);
  });

  it("returns projectRoot-based paths when provided", () => {
    const root = "/fake/project/root";
    const paths = getProjectMcpJsonPaths(root);
    assert.deepEqual(paths, [
      join(root, ".claude", "mcp.json"),
      join(root, ".mcp.json"),
    ]);
  });

  it("falls back to cwd when projectRoot is empty string", () => {
    const paths = getProjectMcpJsonPaths("");
    const cwd = process.cwd();
    assert.deepEqual(paths, [
      join(cwd, ".claude", "mcp.json"),
      join(cwd, ".mcp.json"),
    ]);
  });
});
