import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCliCommand } from "../../hub/team/pane.mjs";

describe("pane.mjs", () => {
  it("buildCliCommand(codex)는 codex를 반환해야 한다", () => {
    assert.equal(buildCliCommand("codex"), "codex");
  });

  it("buildCliCommand(codex, trustMode)는 trust 플래그를 포함해야 한다", () => {
    const command = buildCliCommand("codex", { trustMode: true });
    assert.ok(command.includes("codex"));
    assert.ok(command.includes("--dangerously-bypass-approvals-and-sandbox"));
    assert.ok(command.includes("--no-alt-screen"));
  });

  it("buildCliCommand(gemini)는 gemini를 반환해야 한다", () => {
    assert.equal(buildCliCommand("gemini"), "gemini");
  });
});
