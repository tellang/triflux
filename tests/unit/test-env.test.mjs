import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { writesRealHomeInTest } from "../../scripts/lib/test-env.mjs";

const SETUP = fileURLToPath(
  new URL("../../scripts/setup.mjs", import.meta.url),
);
const CLI = fileURLToPath(new URL("../../bin/triflux.mjs", import.meta.url));

test("테스트 실행이면서 홈 격리 신호가 없을 때만 실제 홈 쓰기로 본다", () => {
  assert.equal(writesRealHomeInTest({}), false);
  assert.equal(writesRealHomeInTest({ NODE_TEST_CONTEXT: "child-v8" }), true);
  assert.equal(
    writesRealHomeInTest({
      NODE_TEST_CONTEXT: "child-v8",
      TRIFLUX_TEST_HOME: "/t",
    }),
    false,
  );
  assert.equal(
    writesRealHomeInTest({ TEST_LOCK_PID: "1", TFX_TEST_HOME_ISOLATED: "1" }),
    false,
  );
});

test("홈 격리 없이 테스트에서 돈 setup 과 tfx setup 은 홈에 아무것도 쓰지 않는다", () => {
  const home = mkdtempSync(join(tmpdir(), "tfx-test-env-home-"));
  try {
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      NODE_TEST_CONTEXT: "child-v8",
    };
    delete env.TRIFLUX_TEST_HOME;
    delete env.TFX_TEST_HOME_ISOLATED;
    for (const args of [[SETUP], [CLI, "setup"]]) {
      const run = spawnSync(process.execPath, args, {
        env,
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /skip/);
      assert.equal(existsSync(join(home, ".claude")), false, args.join(" "));
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
