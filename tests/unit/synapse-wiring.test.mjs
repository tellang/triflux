import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const ROOT = process.cwd();

function read(relPath) {
  return readFileSync(join(ROOT, relPath), "utf8");
}

describe("synapse wiring", () => {
  it("headless worker lifecycle에 synapse register/unregister 배선이 있어야 한다", () => {
    const src = read("hub/team/headless.mjs");
    assert.match(
      src,
      /registerHeadlessSynapseWorker\(workerId,\s*assignment\.prompt\)/,
    );
    assert.match(src, /unregisterHeadlessSynapseWorker\(d\.workerId\)/);
    assert.match(src, /taskSummary:\s*buildSynapseTaskSummary\(prompt\)/);
  });

  it("conductor state transition에 synapse register/heartbeat/unregister 배선이 있어야 한다", () => {
    const src = read("hub/team/conductor.mjs");
    assert.match(
      src,
      /if \(nextState === STATES\.HEALTHY\)\s*\{\s*registerSynapseSession/s,
    );
    assert.match(src, /heartbeatSynapseSession\(/);
    assert.match(
      src,
      /if \(nextState === STATES\.COMPLETED \|\| nextState === STATES\.DEAD\)\s*\{\s*unregisterSynapseSession/s,
    );
  });
});
