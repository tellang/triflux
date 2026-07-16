import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildCapabilityDegradedEvent,
  buildDriftDetectedEvent,
  emitRoleControlEvent,
} from "../../hub/role-control-events.mjs";

describe("role control events", () => {
  it("builds allowlisted structured events with injected identifiers and time", () => {
    const event = buildCapabilityDegradedEvent(
      {
        module: "role-transport",
        dur_ms: 12,
        control_action: "adapter_disable",
        reason_code: "adapter_unavailable",
        unexpected: "must-not-leak",
      },
      { eventId: () => "evt-1" },
    );

    assert.deepEqual(event, {
      schema_version: "tfx.role-control-event.v1",
      event: "capability.degraded",
      event_id: "evt-1",
      module: "role-transport",
      dur_ms: 12,
      control_action: "adapter_disable",
      reason_code: "adapter_unavailable",
    });
  });

  it("emits event as an object field and matching message", () => {
    const calls = [];
    const event = buildDriftDetectedEvent(
      {
        module: "role-schema",
        dur_ms: 0,
        control_action: "manager_disable",
        reason_code: "schema_invalid",
      },
      { eventId: () => "evt-2" },
    );

    emitRoleControlEvent(
      { warn: (...args) => calls.push(args) },
      { ...event, unexpected: "must-not-leak" },
    );
    assert.deepEqual(calls, [[event, "drift.detected"]]);
  });

  it("rejects missing required event fields", () => {
    assert.throws(
      () =>
        buildCapabilityDegradedEvent({
          module: "role-transport",
          dur_ms: 1,
          control_action: "log_only",
        }),
      { code: "ROLE_CONTROL_EVENT_REQUIRED" },
    );
  });
});
