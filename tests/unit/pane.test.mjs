import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCliCommand } from "../../hub/team/pane.mjs";

describe("pane.mjs", () => {
  it("buildCliCommand(codex)는 codex를 반환해야 한다", () => {
    assert.equal(buildCliCommand("codex"), "codex");
  });

  it("buildCliCommand(codex, trustMode)는 exec + sandbox bypass를 포함해야 한다", () => {
    const command = buildCliCommand("codex", { trustMode: true });
    assert.ok(command.includes("codex"), `codex 포함: ${command}`);
    assert.ok(command.includes("exec"), `exec 포함: ${command}`);
    assert.ok(
      command.includes("--dangerously-bypass-approvals-and-sandbox"),
      `sandbox bypass 포함: ${command}`,
    );
    assert.ok(
      command.includes("--skip-git-repo-check"),
      `skip-git 포함: ${command}`,
    );
  });

  it("buildCliCommand(gemini)는 gemini를 반환해야 한다", () => {
    assert.equal(buildCliCommand("gemini"), "gemini");
  });
});
