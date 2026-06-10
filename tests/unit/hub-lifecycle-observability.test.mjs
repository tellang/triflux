import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  HUB_DEFAULT_PORT,
  reapExistingHubProcesses,
  resolveHubPortForContext,
} from "../../hub/hub-lifecycle.mjs";

describe("hub lifecycle observability", () => {
  it("keeps SIGKILL failures visible alongside the reaped count", async () => {
    const result = await reapExistingHubProcesses({
      currentPid: 111,
      readPidFileFn: () => ({ pid: 222 }),
      findListeningPidsForPortFn: () => [333],
      execFileSyncFn: () =>
        "444 1 /opt/homebrew/bin/node /repo/hub/server.mjs\n",
      killFn: (pid, signal) => {
        assert.equal(pid, 444);
        if (signal === "SIGKILL") {
          throw new Error("operation not permitted");
        }
      },
      waitForExitFn: async () => false,
    });

    assert.equal(result.reaped.length, 1);
    assert.deepEqual(result.failed, [
      {
        pid: 444,
        signal: "SIGKILL",
        error: "operation not permitted",
      },
    ]);
  });

  it("clamps polluted hub ports in worktree contexts by default", () => {
    assert.equal(
      resolveHubPortForContext({
        env: { TFX_HUB_PORT: "30125" },
        cwd: "/repo/.codex-swarm/wt-agent-a",
      }),
      HUB_DEFAULT_PORT,
    );
  });
});
