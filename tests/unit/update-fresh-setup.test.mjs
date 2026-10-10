import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findTrifluxPluginEntry, runUpdatedSetup } from "../../bin/triflux.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "tfx updated package "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts", "setup.mjs"), "");
  return root;
}

test("업데이트 후 새 CLI 파일을 별도 프로세스에서 setup --from-update로 실행한다", (t) => {
  const root = fixture(t);
  const result = join(root, "result.json");
  const cli = join(root, "bin", "triflux.mjs");
  writeFileSync(
    cli,
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(result)}, JSON.stringify({pid: process.pid, argv: process.argv.slice(2)}));\n`,
  );
  runUpdatedSetup({ packageRoot: root });
  const actual = JSON.parse(readFileSync(result, "utf8"));
  assert.notEqual(actual.pid, process.pid);
  assert.deepEqual(actual.argv, ["setup", "--from-update"]);
});

test("update 는 triflux-mods 플러그인을 triflux 본체 플러그인 설치로 보지 않는다", () => {
  const mods = { installPath: "/plugins/cache/triflux/triflux-mods/10.57.1" };
  const core = { installPath: "/plugins/cache/triflux/triflux/10.57.1" };
  assert.equal(
    findTrifluxPluginEntry({ plugins: { "triflux-mods@triflux": [mods] } }),
    null,
  );
  assert.equal(
    findTrifluxPluginEntry({
      plugins: { "triflux-mods@triflux": [mods], "triflux@triflux": [core] },
    }),
    core,
  );
});
