import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const binPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "bin",
  "triflux.mjs",
);

function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("tfx --help 출력", () => {
  it("stale: tfx update --help 는 업데이트를 실행하지 않고 도움말만 출력", () => {
    const raw = execSync(`node "${binPath}" update --help`, {
      encoding: "utf8",
    });
    const out = stripAnsi(raw);
    assert.match(out, /tfx update/);
    assert.match(out, /Usage/);
    assert.doesNotMatch(out, /npm install -g|업데이트 완료|git pull/);
  });

  for (const command of ["setup", "doctor", "multi"]) {
    it(`stale: tfx ${command} --help 는 side-effect 없이 help 출력`, () => {
      const raw = execSync(`node "${binPath}" ${command} --help`, {
        encoding: "utf8",
      });
      const out = stripAnsi(raw);
      assert.match(out, new RegExp(`tfx ${command}`));
      assert.match(out, /Usage/);
    });
  }
});
