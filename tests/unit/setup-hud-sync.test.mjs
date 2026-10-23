import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { SYNC_MAP, PLUGIN_ROOT } = await import("../../scripts/setup.mjs");

describe("setup-hud-sync: SYNC_MAP", () => {
  it("현재 hud 파일 목록을 동적으로 포함하고 레거시 omc-hud 파일은 제외한다", () => {
    const hudEntries = SYNC_MAP.filter((entry) =>
      entry.src
        .replace(/\\/g, "/")
        .startsWith(`${PLUGIN_ROOT.replace(/\\/g, "/")}/hud/`),
    );

    const labels = hudEntries.map((entry) => entry.label);

    assert.ok(
      labels.includes("hud/context-monitor.mjs"),
      "context-monitor.mjs must be auto-discovered",
    );
    assert.ok(
      labels.includes("hud/providers/claude.mjs"),
      "provider files must be discovered recursively",
    );
    assert.ok(
      labels.includes("hud/hud-qos-status.mjs"),
      "hud-qos-status.mjs must remain synced",
    );
    assert.ok(
      !labels.includes("hud/omc-hud.mjs"),
      "legacy omc-hud.mjs must be excluded",
    );
    assert.ok(
      hudEntries.length >= 8,
      `expected at least 8 hud .mjs files to be synced, got ${hudEntries.length}`,
    );
  });
});
