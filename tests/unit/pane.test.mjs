import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCliCommand, shouldUseFileRef } from "../../hub/team/pane.mjs";

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

describe("shouldUseFileRef(@ intercept 회귀 #117)", () => {
  it("psmux + useFileRef=true + gemini는 @file 경로 사용", () => {
    assert.equal(
      shouldUseFileRef({
        multiplexer: "psmux",
        useFileRef: true,
        cli: "gemini",
      }),
      true,
    );
  });

  it("psmux + useFileRef=true + codex는 @file 경로 거부 (paste-buffer fallback)", () => {
    assert.equal(
      shouldUseFileRef({
        multiplexer: "psmux",
        useFileRef: true,
        cli: "codex",
      }),
      false,
    );
  });

  it("psmux + useFileRef=true + claude는 @file 경로 사용", () => {
    assert.equal(
      shouldUseFileRef({
        multiplexer: "psmux",
        useFileRef: true,
        cli: "claude",
      }),
      true,
    );
  });

  it("psmux + useFileRef=true + cli null은 @file 경로 사용 (이전 동작 보존)", () => {
    assert.equal(
      shouldUseFileRef({ multiplexer: "psmux", useFileRef: true, cli: null }),
      true,
    );
  });

  it("psmux + useFileRef=false면 cli 무관하게 @file 경로 거부", () => {
    assert.equal(
      shouldUseFileRef({
        multiplexer: "psmux",
        useFileRef: false,
        cli: "gemini",
      }),
      false,
    );
  });

  it("tmux(비-psmux)는 cli 무관하게 @file 경로 거부 (paste-buffer 경로)", () => {
    assert.equal(
      shouldUseFileRef({
        multiplexer: "tmux",
        useFileRef: true,
        cli: "gemini",
      }),
      false,
    );
  });
});
