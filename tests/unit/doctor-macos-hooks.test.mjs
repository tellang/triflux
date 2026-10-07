import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { inspectMacTimeoutDependency } from "../../scripts/lib/doctor-env-checks.mjs";

describe("doctor environment checks", () => {
  it("flags macOS when neither timeout nor gtimeout is available (#227)", () => {
    const result = inspectMacTimeoutDependency({
      platform: "darwin",
      commandExists: () => false,
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "missing");
    assert.match(result.fix, /brew install coreutils/);
  });

  it("accepts gtimeout as the macOS timeout provider (#227)", () => {
    const result = inspectMacTimeoutDependency({
      platform: "darwin",
      commandExists: (name) => name === "gtimeout",
    });

    assert.equal(result.ok, true);
    assert.equal(result.provider, "gtimeout");
  });
});
