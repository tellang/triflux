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

test("remote 본문 드리프트를 잡고 pack:remote 리라이트만 다른 미러는 통과시킨다", () => {
  const root = mkdtempSync(join(tmpdir(), "tfx-mirror-"));
  const remoteIssues = () =>
    compareMirror({ repoRoot: root }).issues.filter((issue) =>
      issue.path.startsWith("packages/remote/"),
    );
  try {
    write(root, "hub/lib/a.mjs", "export const a = 1;\n");
    write(root, "packages/core/hub/lib/a.mjs", "export const a = 1;\n");
    write(root, "hub/team/b.mjs", "export const b = 2;\n");
    write(root, "packages/remote/hub/team/b.mjs", "export const b = 2;\n");
    // 비정규 상대 경로는 정규화돼 바뀌고, root 에 원래 있던 @triflux/core import 와 그 인용 주석은 pack 이 그대로 둔다.
    const body = (spec) =>
      [
        `import { a } from "${spec}";`,
        'import { b } from "./b.mjs";',
        'import { a as c } from "@triflux/core/hub/lib/a.mjs";',
        '// import { a } from "@triflux/core/hub/lib/a.mjs";',
        `const m = await import("${spec}");`,
        "export const x = a + b + c + m.a;",
        "",
      ].join("\n");
    write(root, "hub/team/x.mjs", body("./../lib/a.mjs"));
    write(
      root,
      "packages/remote/hub/team/x.mjs",
      body("@triflux/core/hub/lib/a.mjs"),
    );
    assert.deepEqual(remoteIssues(), []);

    write(
      root,
      "packages/remote/hub/team/x.mjs",
      body("@triflux/core/hub/lib/a.mjs").replace("a + b", "a - b"),
    );
    assert.deepEqual(remoteIssues(), [
      {
        path: "packages/remote/hub/team/x.mjs",
        kind: "remote-content-diff",
        detail:
          'line 6: root "export const x = a + b + c + m.a;" / remote "export const x = a - b + c + m.a;"',
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
