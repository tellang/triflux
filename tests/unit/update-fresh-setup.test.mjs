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
import { runUpdatedSetup } from "../../bin/triflux.mjs";

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
  writeFileSync(cli, "throw new Error('old code');\n");
  // 부모가 helper를 이미 import한 뒤 설치 파일이 바뀌는 상황이다.
  writeFileSync(
    cli,
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(result)}, JSON.stringify({pid: process.pid, argv: process.argv.slice(2)}));\n`,
  );
  runUpdatedSetup({ packageRoot: root });
  const actual = JSON.parse(readFileSync(result, "utf8"));
  assert.notEqual(actual.pid, process.pid);
  assert.deepEqual(actual.argv, ["setup", "--from-update"]);
});

test("남는 핵심 파일이 없으면 새 setup을 실행하지 않는다", (t) => {
  assert.throws(
    () => runUpdatedSetup({ packageRoot: fixture(t) }),
    /핵심 파일 누락/,
  );
});

test("새 setup 실패를 부모에게 전달한다", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "bin", "triflux.mjs"), "process.exit(7);\n");
  assert.throws(
    () => runUpdatedSetup({ packageRoot: root }),
    (error) => error.status === 7,
  );
});
