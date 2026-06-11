import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  handleCwdChangedHook,
  resolveCwdChangedPayload,
} from "../../hooks/claude-cwd-projection-refresh.mjs";
import {
  buildClaudeSessionProjection,
  writeClaudeSessionProjection,
} from "../../hub/team/claude-session-projection.mjs";

test("resolveCwdChangedPayload accepts Claude /cd payload variants", () => {
  const payload = resolveCwdChangedPayload(
    { hook_event_name: "CwdChanged", session_id: "s1", new_cwd: "/tmp/new" },
    { CLAUDE_CONFIG_DIR: "/tmp/claude-config" },
  );
  assert.equal(payload.sessionId, "s1");
  assert.equal(payload.cwd, "/tmp/new");
  assert.equal(payload.sessionsDir, "/tmp/claude-config/sessions");
});

test("handleCwdChangedHook refreshes matching projection", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cwd-hook-"));
  const configDir = path.join(tmp, ".claude");
  const sessionsDir = path.join(configDir, "sessions");
  await writeClaudeSessionProjection(
    sessionsDir,
    buildClaudeSessionProjection({
      pid: 12345,
      procStart: "Wed May 20 08:02:53 2026",
      sessionId: "cwd-session-1",
      short: "cwdse123",
      cwd: "/tmp/old",
      name: "Triflux cwd hook",
      agent: "claude",
    }),
  );

  const result = await handleCwdChangedHook(
    JSON.stringify({
      hook_event_name: "CwdChanged",
      session_id: "cwd-session-1",
      cwd: "/tmp/new",
    }),
    { CLAUDE_CONFIG_DIR: configDir },
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Triflux projection cwd refreshed/);
  const updated = JSON.parse(
    await fs.readFile(path.join(sessionsDir, "12345.json"), "utf8"),
  );
  assert.equal(updated.cwd, "/tmp/new");

  await fs.rm(tmp, { recursive: true, force: true });
});
