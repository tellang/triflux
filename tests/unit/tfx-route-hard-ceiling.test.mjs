import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const route = readFileSync(resolve(HERE, "../../scripts/tfx-route.sh"), "utf8");
const worker = readFileSync(
  resolve(HERE, "../../scripts/tfx-route-worker.mjs"),
  "utf8",
);

it("route execution uses hard ceiling while lane timeout remains advisory", () => {
  assert.match(route, /TFX_HARD_CEILING_SEC:-21600/);
  assert.match(route, /\^\(0\|\[1-9\]\[0-9\]\*\)\$/);
  assert.match(route, /TFX_TIMEOUT_MODE:-activity/);
  assert.match(route, /"\$\{TIMEOUT_CMD\[@\]\}" "\$HARD_CEILING_SEC"/);
  assert.doesNotMatch(route, /"\$TIMEOUT_BIN" "\$TIMEOUT_SEC"/);
  assert.match(route, /"--stall-ms" "\$\(\(STALL_THRESHOLD_SEC \* 1000\)\)"/);
  assert.match(route, /"--timeout-ms" "\$\(\(HARD_CEILING_SEC \* 1000\)\)"/);
});

it("stream worker accepts and forwards the activity-reset timeout", () => {
  assert.match(worker, /case "--stall-ms":/);
  assert.match(worker, /stallMs: args\.stallMs/);
});
