import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const routeSource = readFileSync(
  join(process.cwd(), "scripts", "tfx-route.sh"),
  "utf8",
);

describe("tfx-route codex recovery helper", () => {
  it("guards the optional codex-recovery.sh source (#227)", () => {
    assert.match(
      routeSource,
      /if\s+\[\[\s+-f\s+"\$_TFX_ROUTE_DIR\/lib\/codex-recovery\.sh"\s+\]\];\s+then[\s\S]+source\s+"\$_TFX_ROUTE_DIR\/lib\/codex-recovery\.sh"[\s\S]+else[\s\S]+codex-recovery\.sh/,
    );
  });
});
