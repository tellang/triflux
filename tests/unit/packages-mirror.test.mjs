// packages-mirror — smoke test that check-packages-mirror.mjs reports
// Mirror OK on a healthy tree. If this fails in CI, the dev forgot to
// run `npm run release:check-mirror:fix` after editing hub/bin/scripts.

import assert from "node:assert/strict";
import { test } from "node:test";
import { compareMirror } from "../../scripts/release/check-packages-mirror.mjs";

test("packages/triflux mirror is byte-identical to root", () => {
  const result = compareMirror({ fix: false });
  if (!result.ok) {
    const lines = result.issues
      .map((i) => `  ${i.kind.padEnd(18)} ${i.path}`)
      .join("\n");
    assert.fail(
      `packages/triflux mirror drift — run 'npm run release:check-mirror:fix':\n${lines}`,
    );
  }
  assert.equal(result.ok, true);
  assert.equal(result.issues.length, 0);
});
