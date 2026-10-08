import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";

import {
  linkHubNodeModules,
  PLUGIN_ROOT,
  SYNC_MAP,
} from "../../scripts/setup.mjs";

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

test("hub/node_modules 링크는 끊어진 링크만 바꾸고 실제 디렉터리는 둔다", () => {
  const root = mkdtempSync(join(tmpdir(), "tfx-hub-link-"));
  try {
    const modules = join(root, "scripts/node_modules");
    mkdirSync(join(modules, "@modelcontextprotocol/sdk"), { recursive: true });
    writeFileSync(
      join(modules, "@modelcontextprotocol/sdk/package.json"),
      "{}",
    );
    const link = join(root, "hub/node_modules");
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(join(root, "missing"), link);
    const logs = [];
    linkHubNodeModules(modules, (message) => logs.push(message), link);
    assert.equal(
      existsSync(join(link, "@modelcontextprotocol/sdk/package.json")),
      true,
    );

    const userDir = join(root, "hub2/node_modules");
    mkdirSync(userDir, { recursive: true });
    linkHubNodeModules(modules, (message) => logs.push(message), userDir);
    assert.equal(lstatSync(userDir).isSymbolicLink(), false);
    assert.equal(logs.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
