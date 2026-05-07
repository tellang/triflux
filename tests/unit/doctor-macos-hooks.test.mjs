import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  findPluginRootHookIssues,
  inspectMacTimeoutDependency,
} from "../../scripts/lib/doctor-env-checks.mjs";

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

  it("detects settings hooks that can collapse to /hooks when PLUGIN_ROOT is unset (#228)", () => {
    const settings = {
      hooks: {
        Stop: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: 'node "${PLUGIN_ROOT}/hooks/pipeline-stop.mjs"',
              },
            ],
          },
        ],
      },
    };

    const issues = findPluginRootHookIssues(settings);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].event, "Stop");
    assert.match(issues[0].command, /\$\{PLUGIN_ROOT\}/);
  });

  it("does not flag hooks with a PLUGIN_ROOT shell fallback (#228)", () => {
    const settings = {
      hooks: {
        Stop: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command:
                  'node "${PLUGIN_ROOT:-/opt/homebrew/lib/node_modules/triflux}/hooks/pipeline-stop.mjs"',
              },
            ],
          },
        ],
      },
    };

    assert.deepEqual(findPluginRootHookIssues(settings), []);
  });
});
