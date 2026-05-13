import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import {
  attachBrokerDiagnostics,
  sanitizeBrokerDiagnosticEvent,
} from "../../hub/server.mjs";

describe("hub broker diagnostics", () => {
  it("sanitizes broker diagnostic events to safe fields", () => {
    const sanitized = sanitizeBrokerDiagnosticEvent({
      id: "fallback-account",
      accountId: "codex-auth-account",
      provider: "codex",
      direction: "fromSource",
      reason: "copy_failed",
      error: "permission denied",
      authFile: "codex-auth-secret.json",
      sourcePath: "/Users/example/.codex/auth.json",
      cachePath: "/Users/example/.claude/cache/tfx-hub/auth.json",
      runtimePath: "/tmp/tfx-runtime-secret",
      env: { CODEX_TOKEN: "secret-token" },
      secret: "secret-token",
      path: "/Users/example/path-with-secret",
    });

    assert.deepEqual(sanitized, {
      accountId: "codex-auth-account",
      provider: "codex",
      direction: "fromSource",
      reason: "copy_failed",
      error: "permission denied",
    });
    assert.equal(
      sanitizeBrokerDiagnosticEvent({ id: "fallback" }).accountId,
      "fallback",
    );
  });

  it("attaches diagnostics once and logs only sanitized broker events", () => {
    const broker = new EventEmitter();
    const logs = [];
    const logger = {
      warn(payload, message) {
        logs.push({ message, payload });
      },
    };

    assert.equal(attachBrokerDiagnostics(broker, logger), true);
    assert.equal(attachBrokerDiagnostics(broker, logger), false);

    broker.emit("securityViolation", {
      accountId: "codex-a",
      provider: "codex",
      direction: "toSource",
      reason: "path_escape",
      sourcePath: "/Users/example/.codex/auth-secret.json",
      secret: "super-secret-token",
      path: "/Users/example/secret-path",
    });
    broker.emit("authSyncError", {
      id: "codex-b",
      provider: "codex",
      direction: "fromSource",
      error: "EACCES",
      authFile: "codex-auth-private.json",
      cachePath: "/Users/example/.claude/cache/private-auth.json",
      runtimePath: "/tmp/tfx-runtime-private",
      env: { CODEX_REFRESH_TOKEN: "private-refresh-token" },
    });

    assert.deepEqual(logs, [
      {
        message: "broker.security_violation",
        payload: {
          brokerEvent: {
            accountId: "codex-a",
            provider: "codex",
            direction: "toSource",
            reason: "path_escape",
          },
        },
      },
      {
        message: "broker.auth_sync_error",
        payload: {
          brokerEvent: {
            accountId: "codex-b",
            provider: "codex",
            direction: "fromSource",
            error: "EACCES",
          },
        },
      },
    ]);

    const serialized = JSON.stringify(logs);
    for (const forbidden of [
      "super-secret-token",
      "secret-path",
      "codex-auth-private.json",
      "private-refresh-token",
      ".claude/cache/private-auth.json",
      "tfx-runtime-private",
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  });
});
