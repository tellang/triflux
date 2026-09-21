import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as pane from "../../hub/team/pane.mjs";
import { buildCliCommand, shouldUseFileRef } from "../../hub/team/pane.mjs";

describe("pane.mjs", () => {
  it("interactive Codex는 approval/sandbox bypass posture로 시작한다", () => {
    const command = buildCliCommand("codex");

    assert.equal(command, "codex --dangerously-bypass-approvals-and-sandbox");
    assert.doesNotMatch(command, /dangerously-bypass-hook-trust/u);
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

describe("Antigravity prompt submission", () => {
  it("prompt가 composer에 남아 있으면 settle 뒤 Enter를 재전송하고 빈 composer에서 멈춘다", () => {
    const keys = [];
    const sleeps = [];
    const captures = [
      "│ ❯ 마지막 검증 문장이 화면에서 │\n│ 줄바꿈되어 남아 있습니다 │",
      "❯ 마지막 검증 문장이 화면에서 줄바꿈되어 남아 있습니다\n❯ ",
    ];

    pane.submitPromptWithVerification({
      cli: "agy",
      prompt: "마지막 검증 문장이 화면에서 줄바꿈되어 남아 있습니다",
      capture: () => captures.shift() ?? "",
      sendEnter: () => keys.push("Enter"),
      sleep: (ms) => sleeps.push(ms),
    });

    assert.deepEqual(keys, ["Enter", "Enter"]);
    assert.equal(sleeps[0], 350);
  });

  it("agy composer가 재시도 뒤에도 prompt를 유지하면 명확히 실패한다", () => {
    const keys = [];
    const composer = "❯ 검증 실패를 조용히 숨기지 않는다";

    assert.throws(
      () =>
        pane.submitPromptWithVerification({
          cli: "antigravity",
          prompt: "검증 실패를 조용히 숨기지 않는다",
          capture: () => composer,
          sendEnter: () => keys.push("Enter"),
          sleep: () => {},
        }),
      /Antigravity prompt submission failed after 3 attempts/u,
    );
    assert.deepEqual(keys, ["Enter", "Enter", "Enter"]);
  });

  it("agy capture가 비어 제출 여부를 검증할 수 없어도 bounded retry 후 실패한다", () => {
    const keys = [];

    assert.throws(
      () =>
        pane.submitPromptWithVerification({
          cli: "agy",
          prompt: "capture 없는 제출도 성공으로 오판하지 않는다",
          capture: () => "",
          sendEnter: () => keys.push("Enter"),
          sleep: () => {},
        }),
      /submission could not be verified/u,
    );
    assert.deepEqual(keys, ["Enter", "Enter", "Enter"]);
  });

  it("agy capture에 인식 가능한 composer가 없으면 성공으로 추측하지 않는다", () => {
    const keys = [];

    assert.throws(
      () =>
        pane.submitPromptWithVerification({
          cli: "agy",
          prompt: "composer 표식을 확인한다",
          capture: () => "Antigravity ready\ncomposer 표식을 확인한다",
          sendEnter: () => keys.push("Enter"),
          sleep: () => {},
        }),
      /submission could not be verified/u,
    );
    assert.deepEqual(keys, ["Enter", "Enter", "Enter"]);
  });

  it("agy가 composer 없이 busy 표식을 보이면 한 번만 Enter를 보내고 성공한다", () => {
    const keys = [];

    assert.doesNotThrow(() =>
      pane.submitPromptWithVerification({
        cli: "agy",
        prompt: "busy 표식으로 제출을 확인한다",
        capture: () => "Esc to interrupt",
        sendEnter: () => keys.push("Enter"),
        sleep: () => {},
      }),
    );
    assert.deepEqual(keys, ["Enter"]);
  });

  it("composer 안의 esc to cancel은 busy 표식으로 보지 않고 재시도한다", () => {
    const keys = [];
    const captures = [
      "❯ composer 안의 esc to cancel은 제출 확인이 아니다",
      "❯ ",
    ];

    pane.submitPromptWithVerification({
      cli: "agy",
      prompt: "composer 안의 esc to cancel은 제출 확인이 아니다",
      capture: () => captures.shift() ?? "",
      sendEnter: () => keys.push("Enter"),
      sleep: () => {},
    });

    assert.deepEqual(keys, ["Enter", "Enter"]);
  });

  it("prompt 본문의 working 단어를 busy indicator로 오판하지 않는다", () => {
    const keys = [];

    assert.throws(
      () =>
        pane.submitPromptWithVerification({
          cli: "agy",
          prompt: "working tree 상태를 확인한다",
          capture: () => "❯ working tree 상태를 확인한다",
          sendEnter: () => keys.push("Enter"),
          sleep: () => {},
        }),
      /prompt remains in composer/u,
    );
    assert.deepEqual(keys, ["Enter", "Enter", "Enter"]);
  });

  it("빈 prompt는 한 번만 제출하고 검증 불가능 오류로 바꾸지 않는다", () => {
    const keys = [];

    assert.doesNotThrow(() =>
      pane.submitPromptWithVerification({
        cli: "agy",
        prompt: " \n ",
        capture: () => "❯ ",
        sendEnter: () => keys.push("Enter"),
        sleep: () => {},
      }),
    );
    assert.deepEqual(keys, ["Enter"]);
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
