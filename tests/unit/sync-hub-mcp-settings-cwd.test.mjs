import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// Regression test for sync-hub-mcp-settings getProjectMcpJsonPaths scope.
//
// 버그 요약:
// getProjectMcpJsonPaths(projectRoot)는 이전까지 projectRoot 가 주어지면 그 경로만
// 사용하고, 주어지지 않으면 process.cwd() fallback 만 사용했다. hub-ensure.mjs는
// PLUGIN_ROOT(triflux 설치 디렉토리)를 항상 명시 전달하므로, 사용자 실제 작업
// 디렉토리(.mcp.json / .claude/mcp.json)는 sync 대상에서 영원히 빠지는 증상이 있었다.
// 수정: projectRoot 와 process.cwd() 를 **둘 다** 대상에 포함. Set 으로 dedup.
// 배열 입력도 허용하여 여러 외부 root 를 명시 지정 가능.

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

describe("getProjectMcpJsonPaths — CWD always included", () => {
  it("returns cwd-based paths when projectRoot undefined", () => {
    const paths = getProjectMcpJsonPaths();
    assert.deepEqual(paths, [
      join(TEMP_CWD, ".claude", "mcp.json"),
      join(TEMP_CWD, ".mcp.json"),
    ]);
  });

  it("REGRESSION: includes CWD even when projectRoot is different", () => {
    // 버그 재현: hub-ensure가 PLUGIN_ROOT를 전달하면 과거에는 cwd 가 빠졌다.
    // 수정 후에는 projectRoot + cwd 둘 다 포함되어야 한다.
    const pluginRoot = "/fake/plugin/root";
    const paths = getProjectMcpJsonPaths(pluginRoot);

    assert.ok(
      paths.includes(join(pluginRoot, ".mcp.json")),
      "projectRoot의 .mcp.json 포함되어야 함",
    );
    assert.ok(
      paths.includes(join(TEMP_CWD, ".mcp.json")),
      "process.cwd()의 .mcp.json도 항상 포함되어야 함 (regression)",
    );
    assert.ok(
      paths.includes(join(pluginRoot, ".claude", "mcp.json")),
      "projectRoot의 .claude/mcp.json 포함되어야 함",
    );
    assert.ok(
      paths.includes(join(TEMP_CWD, ".claude", "mcp.json")),
      "process.cwd()의 .claude/mcp.json도 포함되어야 함 (regression)",
    );
  });

  it("accepts string[] projectRoot and dedups against cwd", () => {
    const roots = ["/fake/root-a", "/fake/root-b", TEMP_CWD];
    const paths = getProjectMcpJsonPaths(roots);

    // 각 root 당 2 paths (.claude/mcp.json + .mcp.json).
    // TEMP_CWD 는 roots 에 명시 + cwd 로 자동 추가되지만 Set dedup 이므로 한 번만.
    assert.equal(paths.length, 6);
    assert.ok(paths.includes(join("/fake/root-a", ".mcp.json")));
    assert.ok(paths.includes(join("/fake/root-b", ".mcp.json")));
    assert.ok(paths.includes(join(TEMP_CWD, ".mcp.json")));
  });

  it("filters out empty / non-string entries from array input", () => {
    const roots = ["/fake/root-a", "", null, undefined, 123];
    const paths = getProjectMcpJsonPaths(roots);

    // /fake/root-a 두 개 + cwd 두 개 = 4
    assert.equal(paths.length, 4);
    assert.ok(paths.includes(join("/fake/root-a", ".mcp.json")));
    assert.ok(paths.includes(join(TEMP_CWD, ".mcp.json")));
  });

  it("handles empty string projectRoot (falls back to cwd only)", () => {
    const paths = getProjectMcpJsonPaths("");
    assert.deepEqual(paths, [
      join(TEMP_CWD, ".claude", "mcp.json"),
      join(TEMP_CWD, ".mcp.json"),
    ]);
  });
});
