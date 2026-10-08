import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { collectInstallFiles, PLUGIN_ROOT } from "../../scripts/setup.mjs";

// 설치본 tfx-route.sh 는 ~/.claude/scripts 에서 돈다. 자기 옆에서 찾는 파일이 복사되지 않으면 조용히 건너뛴다.
test("tfx-route.sh 가 자기 옆에서 찾는 파일은 설치 목록에 있다", () => {
  const route = readFileSync(join(PLUGIN_ROOT, "scripts/tfx-route.sh"), "utf8");
  const siblings = [...route.matchAll(/\$\{route_dir\}\/([\w.-]+)/g)].map(
    ([, name]) => `scripts/${name}`,
  );
  assert.ok(siblings.length > 0);
  const installed = new Set(collectInstallFiles());
  assert.deepEqual(
    siblings.filter((file) => !installed.has(file)),
    [],
  );
});
