import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildHeadlessCommand } from "../../hub/team/headless.mjs";

function extractRouteAgent(cmd) {
  const match = cmd.match(/tfx-route\.sh'\\'' '\\''([^']+)'\\''/);
  assert.ok(match, `tfx-route.sh 첫 번째 인자를 추출할 수 있어야 함: ${cmd}`);
  return match[1];
}

describe("headless antigravity route agent resolution", () => {
  for (const [role, expected] of [
    ["worker-2", "antigravity"],
    ["investigator", "antigravity"],
    ["", "antigravity"],
    ["writer", "writer"],
    ["architect", "architect"],
    ["antigravity", "antigravity"],
  ]) {
    it(`role=${JSON.stringify(role)} -> route agent ${expected}`, () => {
      const cmd = buildHeadlessCommand(
        "antigravity",
        "test prompt",
        "/tmp/tfx-headless-route-agent-result.txt",
        {
          handoff: false,
          role,
          routeScript: "tfx-route.sh",
        },
      );

      assert.equal(extractRouteAgent(cmd), expected);
    });
  }
});
