import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { compareMirror } from "../../scripts/release/check-packages-mirror.mjs";

function write(root, rel, content) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

test("core 의 하위 디렉터리 누락과 깨진 import 를 잡는다", () => {
  const root = mkdtempSync(join(tmpdir(), "tfx-mirror-"));
  try {
    write(root, "hub/lib/a.mjs", "export const a = 1;\n");
    write(root, "hub/lib/spawn-trace.mjs", "export default {};\n");
    write(root, "hub/team/x.mjs", 'await import("./y.mjs");\n');
    write(root, "packages/core/hub/lib/a.mjs", "export const a = 1;\n");
    write(root, "packages/core/hub/team/x.mjs", 'await import("./y.mjs");\n');

    const kinds = compareMirror({ repoRoot: root })
      .issues.filter((issue) => issue.path.startsWith("packages/core/"))
      .map((issue) => `${issue.kind} ${issue.path}`);
    assert.deepEqual(kinds.sort(), [
      "core-unresolvable-import (./y.mjs) packages/core/hub/team/x.mjs",
      "missing-in-mirror packages/core/hub/lib/spawn-trace.mjs",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
