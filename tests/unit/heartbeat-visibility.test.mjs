import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";

const SCRIPT = "scripts/tfx-route.sh";

describe("heartbeat visibility for non-TTY callers", () => {
  it("emits [tfx-heartbeat] markers to caller stderr when invoked with redirected stderr", () => {
    // Caller stderr is captured by spawnSync (non-TTY by default).
    // The inert self-test runs `sleep 3` under _wait_with_heartbeat with interval=1.
    // Expected (after Task 3 fix): at least 1 [tfx-heartbeat] line in stderr.
    // Current (before fix): 0 lines (regression — heartbeat goes to STDERR_LOG file).
    const res = spawnSync(
      "bash",
      [SCRIPT, "--inert-self-test", "heartbeat-3s"],
      {
        encoding: "utf-8",
        timeout: 15_000,
        env: { ...process.env, TFX_HEARTBEAT_INTERVAL: "1", TFX_HEARTBEAT: "1" },
      },
    );
    assert.match(
      res.stderr || "",
      /\[tfx-heartbeat\]/,
      `expected at least one [tfx-heartbeat] marker in caller stderr; got stderr=${(res.stderr || "").slice(0, 500)}; status=${res.status}`,
    );
  });
});
