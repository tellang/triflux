import assert from "node:assert/strict";
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cliFixture, version } from "../helpers/cli-output-fixture.mjs";

test("CI postinstall도 설치하며 체크아웃 postinstall만 건너뛴다", (t) => {
  const cli = cliFixture(t);
  const env = { npm_lifecycle_event: "postinstall", CI: "1" };
  const installed = cli.run([], env, "scripts/setup.mjs");
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(
    installed.stdout,
    `triflux ${version} 설치됨. 설정 완료. 확인: tfx setup\n`,
  );
  assert.ok(existsSync(join(cli.home, ".claude/scripts/tfx-route.sh")));
  const checkout = join(cli.root, "checkout");
  renameSync(cli.pkg, checkout);
  const before = cli.trace().filter((entry) => entry.write).length;
  const skipped = cli.run(
    [],
    { ...env, FIXTURE_PACKAGE: checkout },
    join(checkout, "scripts/setup.mjs"),
  );
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.equal(
    skipped.stdout,
    "저장소 체크아웃이라 setup 을 건너뜀. 설정: tfx setup\n",
  );
  assert.equal(cli.trace().filter((entry) => entry.write).length, before);
});
