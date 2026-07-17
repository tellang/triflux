import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTfxLiveRoleAdapter } from "../../hub/role-activator-tfx-live.mjs";

const HOST_ID = "hst_local";

function udsLocator() {
  return {
    schema_version: "tfx.transport-locator.v1",
    transport_id: "uds-role",
    kind: "claude-uds",
    host_id: HOST_ID,
    capabilities: ["probe", "wake", "activate"],
    priority: 100,
    expires_at_ms: 60_000,
    locator: { session_id: "session-role", bridge_id: "local-hub" },
  };
}

function tmuxLocator() {
  return {
    schema_version: "tfx.transport-locator.v1",
    transport_id: "tmux-role",
    kind: "tmux",
    host_id: HOST_ID,
    capabilities: ["probe", "wake", "activate", "interrupt"],
    priority: 100,
    expires_at_ms: 60_000,
    locator: { session_name: "role-session", mux_server_id: "mux_local" },
  };
}

function activation() {
  return {
    schema_version: "tfx.role-activation.v1",
    role_key: {
      project_id: `prj_${"a".repeat(22)}`,
      role_kind: "cto",
    },
    role_key_wire: "rk2.test",
    epoch: 3,
    activation_seq: 4,
    activation_id: "activation-runtime",
    charter_version: "charter.v1",
    holder_cli: "codex",
  };
}

describe("tfx-live role adapter", () => {
  it("normalizes Claude UDS and tmux probes without inferring locators", async () => {
    const calls = [];
    const adapter = createTfxLiveRoleAdapter({
      localHostId: HOST_ID,
      tfxLivePath: "/repo/bin/tfx-live.mjs",
      bridgePath: "/repo/hub/bridge.mjs",
      nodePath: "/usr/bin/node",
      tmuxPath: "/usr/bin/tmux",
      now: () => 1_000,
      runProcess: async (command, args) => {
        calls.push({ command, args });
        return command === "/usr/bin/node"
          ? { stdout: '{"ok":true,"target":{"sessionId":"session-role"}}' }
          : { stdout: "" };
      },
    });

    assert.equal(adapter.supports(udsLocator()), true);
    assert.equal(adapter.supports(tmuxLocator()), true);
    assert.equal(
      adapter.supports({ ...tmuxLocator(), host_id: "hst_remote" }),
      false,
    );

    const uds = await adapter.probe(udsLocator(), {
      timeout_ms: 2_000,
      signal: new AbortController().signal,
    });
    const tmux = await adapter.probe(tmuxLocator(), {
      timeout_ms: 2_000,
      signal: new AbortController().signal,
    });

    assert.equal(uds.schema_version, "tfx-live.transport-probe.v1");
    assert.equal(uds.reachable, true);
    assert.equal(uds.transport_selected, "claude-uds");
    assert.equal(tmux.reachable, true);
    assert.equal(tmux.transport_selected, "tmux");
    assert.deepEqual(calls[0], {
      command: "/usr/bin/node",
      args: [
        "/repo/bin/tfx-live.mjs",
        "probe",
        "--session-id",
        "session-role",
        "--bridge",
        "/repo/hub/bridge.mjs",
        "--timeout",
        "2",
      ],
    });
    assert.deepEqual(calls[1], {
      command: "/usr/bin/tmux",
      args: ["has-session", "-t", "role-session"],
    });
  });

  it("maps wake, standup, and cancellation to argv-safe tfx-live calls", async () => {
    const calls = [];
    const adapter = createTfxLiveRoleAdapter({
      localHostId: HOST_ID,
      projectRoot: "/repo",
      tfxLivePath: "/repo/bin/tfx-live.mjs",
      bridgePath: "/repo/hub/bridge.mjs",
      nodePath: "/usr/bin/node",
      now: () => 1_000,
      sessionName: () => "tfx-role-cto-test",
      runProcess: async (command, args) => {
        calls.push({ command, args });
        return {
          stdout: JSON.stringify({
            ok: true,
            session: "tfx-role-cto-test",
            response: "queued",
          }),
        };
      },
    });

    const woke = await adapter.wake(tmuxLocator(), activation(), {
      signal: new AbortController().signal,
    });
    assert.equal(woke.ok, true);
    assert.equal(calls[0].command, "/usr/bin/node");
    assert.deepEqual(calls[0].args.slice(0, 8), [
      "/repo/bin/tfx-live.mjs",
      "ask",
      "--cli",
      "codex",
      "--transport",
      "tmux",
      "--session",
      "role-session",
    ]);
    const promptIndex = calls[0].args.indexOf("--prompt");
    const prompt = JSON.parse(calls[0].args[promptIndex + 1]);
    assert.equal(prompt.schema_version, "tfx.role-activation.v1");
    assert.equal(prompt.activation_id, "activation-runtime");

    const stoodUp = await adapter.standup(activation().role_key, "claude", {
      signal: new AbortController().signal,
      activation: activation(),
    });
    assert.equal(stoodUp.kind, "tmux");
    assert.equal(stoodUp.locator.session_name, "tfx-role-cto-test");
    assert.deepEqual(calls[1].args, [
      "/repo/bin/tfx-live.mjs",
      "start",
      "--session",
      "tfx-role-cto-test",
      "--cli",
      "claude",
      "--cwd",
      "/repo",
      "--ready-timeout",
      "60",
    ]);

    await adapter.cancel("activation-runtime");
    assert.deepEqual(calls[2].args.slice(0, 8), [
      "/repo/bin/tfx-live.mjs",
      "interrupt",
      "--cli",
      "codex",
      "--transport",
      "tmux",
      "--session",
      "role-session",
    ]);
    assert.equal(
      calls.every((call) => call.args.every((arg) => typeof arg === "string")),
      true,
    );
  });
});
