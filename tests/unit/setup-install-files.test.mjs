import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { test } from "node:test";

import { PLUGIN_ROOT, SYNC_MAP } from "../../scripts/setup.mjs";

// 설치본 사본이 import 하는 상대 경로가 모두 같이 복사되는지 본다.
// ~/.claude/scripts/hub 사본이 ../scripts/lib 를 못 찾던 결함의 회귀를 막는다.
test("설치 사본의 상대 import 는 모두 동기화 목록 안에서 풀린다", () => {
  const installed = new Set(SYNC_MAP.map(({ dst }) => resolve(dst)));
  const missing = [];
  for (const { src, dst } of SYNC_MAP) {
    if (!src.endsWith(".mjs")) continue;
    for (const [, spec] of readFileSync(src, "utf8").matchAll(
      /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.\.?\/[^"']+)["']/g,
    )) {
      const target = resolve(dirname(dst), spec);
      if (!installed.has(target))
        missing.push(`${relative(PLUGIN_ROOT, src)} -> ${spec}`);
    }
  }
  assert.deepEqual(missing, []);
});
