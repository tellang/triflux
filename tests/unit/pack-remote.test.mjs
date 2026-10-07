import assert from "node:assert/strict";
import { it } from "node:test";

it("remote package does not ship the removed CTO tray", async () => {
  const argv = process.argv;
  try {
    // import 시 패키지 조립을 막고 목록만 읽는다.
    process.argv = [...argv.slice(0, 2), "inspect"];
    const { REMOTE_FILES } = await import("../../scripts/pack.mjs");
    const removedFiles = new Set([
      "hub/tray.mjs",
      "hub/tray-lifecycle.mjs",
      "hub/tray-runtime.mjs",
      "hub/tray-state.mjs",
      "hub/mac-tray.swift",
      "hub/mac-focus.mjs",
    ]);

    assert.deepEqual(
      REMOTE_FILES.filter((file) => removedFiles.has(file)),
      [],
    );
  } finally {
    process.argv = argv;
  }
});
