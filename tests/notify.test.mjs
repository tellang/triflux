import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createNotifier } from "../hub/team/notify.mjs";

describe("createNotifier", () => {
  it("setChannel returns a new immutable notifier without mutating the original channel state", async () => {
    const writes = [];
    const stdout = {
      write(chunk) {
        writes.push(chunk);
        return true;
      },
    };

    const notifier = createNotifier({
      stdout,
      platform: "linux",
      env: {},
      hostname: "unit-host",
    });
    const muted = notifier
      .setChannel("bell", { enabled: false })
      .setChannel("toast", { enabled: false })
      .setChannel("webhook", { enabled: false });

    assert.ok(Object.isFrozen(notifier));
    assert.ok(Object.isFrozen(muted));
    assert.notStrictEqual(muted, notifier);

    const mutedResult = await muted.notify({
      type: "completed",
      sessionId: "s-muted",
      summary: "muted",
      timestamp: "2026-04-04T00:00:00.000Z",
    });

    assert.equal(mutedResult.results.bell.status, "skipped");
    assert.deepEqual(writes, []);

    const originalResult = await notifier.notify({
      type: "completed",
      sessionId: "s-live",
      summary: "live",
      timestamp: "2026-04-04T00:00:01.000Z",
    });

    assert.equal(originalResult.results.bell.status, "sent");
    assert.deepEqual(writes, ["\u0007"]);
    assert.equal(originalResult.event.host, "unit-host");
    assert.equal(originalResult.results.toast.status, "skipped");
    assert.equal(originalResult.results.webhook.status, "skipped");
  });

  it("uses Windows PowerShell fallback order for toast notifications", async () => {
    const calls = [];
    const execFile = (command, args, options, callback) => {
      calls.push({ command, args, options });
      if (command === "pwsh") {
        const error = new Error("spawn pwsh ENOENT");
        error.code = "ENOENT";
        callback(error, "", "");
        return;
      }
      callback(null, "", "");
    };

    const notifier = createNotifier({
      stdout: {
        write() {
          return true;
        },
      },
      platform: "win32",
      env: {},
      deps: { execFile },
      hostname: "toast-host",
    })
      .setChannel("bell", false)
      .setChannel("webhook", false);

    const result = await notifier.notify({
      type: "failed",
      sessionId: "toast-session",
      summary: "build failed",
      timestamp: "2026-04-04T00:00:02.000Z",
    });

    assert.equal(result.results.toast.status, "sent");
    assert.equal(result.results.toast.command, "powershell.exe");
    assert.deepEqual(
      calls.map((entry) => entry.command),
      ["pwsh", "powershell.exe"],
    );
    assert.match(calls[0].args[3], /New-BurntToastNotification/u);
    assert.match(calls[0].args[3], /ToastNotificationManager/u);
    assert.match(calls[0].args[3], /Triflux failed/u);
  });

  it("posts JSON payload to webhook when TRIFLUX_NOTIFY_WEBHOOK is configured", async () => {
    const requests = [];
    const fetch = async (url, init) => {
      requests.push({ url, init });
      return { ok: true, status: 202 };
    };

    const notifier = createNotifier({
      stdout: {
        write() {
          return true;
        },
      },
      platform: "linux",
      env: { TRIFLUX_NOTIFY_WEBHOOK: "https://example.test/triflux" },
      deps: { fetch },
      hostname: "webhook-host",
    })
      .setChannel("bell", false)
      .setChannel("toast", false);

    const result = await notifier.notify({
      type: "inputWait",
      sessionId: "wait-1",
      summary: "Need approval",
      timestamp: "2026-04-04T00:00:03.000Z",
    });

    assert.equal(result.results.webhook.status, "sent");
    assert.equal(result.results.webhook.statusCode, 202);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://example.test/triflux");
    assert.equal(requests[0].init.method, "POST");
    assert.equal(requests[0].init.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(requests[0].init.body), {
      type: "inputWait",
      sessionId: "wait-1",
      host: "webhook-host",
      summary: "Need approval",
      timestamp: "2026-04-04T00:00:03.000Z",
    });
  });
});
