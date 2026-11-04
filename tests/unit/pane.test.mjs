import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as pane from "../../hub/team/pane.mjs";
import { buildCliCommand, shouldUseFileRef } from "../../hub/team/pane.mjs";

describe("pane.mjs", () => {
  for (const value of [undefined, "0", "1", ""]) {
    it(`interactive Codex는 기존 권한과 hook trust 기본값을 유지한다: ${JSON.stringify(value)}`, (t) => {
      setHookTrustEnv(t, value);
      for (const cli of ["codex", "executor"]) {
        const command = buildCliCommand(cli);
        assert.equal(
          command,
          "codex --dangerously-bypass-approvals-and-sandbox" +
            (value === "0" ? "" : " --dangerously-bypass-hook-trust"),
        );
      }
      assert.equal(buildCliCommand("claude"), "claude");
      assert.equal(buildCliCommand("agy"), "agy");
    });
  }

  it("buildCliCommand 은 antigravity 와 역할명을 실행 파일로 바꾸고 모르는 이름은 그대로 둔다", () => {
    assert.equal(buildCliCommand("antigravity"), "agy");
    assert.equal(buildCliCommand("agy"), "agy");
    assert.equal(buildCliCommand("designer"), "agy");
    assert.equal(buildCliCommand("my-cli"), "my-cli");
  });

  it("주입 판정도 역할명을 CLI 로 푼다", () => {
    const fileRef = (cli) =>
      shouldUseFileRef({ multiplexer: "psmux", useFileRef: true, cli });
    assert.equal(fileRef("executor"), false);
    assert.equal(fileRef("designer"), true);
  });

  it("리뷰 역할은 프롬프트 준비 전 CLI를 시작하지 않는다", () => {
    assert.equal(buildCliCommand("code-reviewer"), "");
    assert.equal(buildCliCommand("quality-reviewer"), "");
  });
});

function setHookTrustEnv(t, value) {
  const key = "TFX_CODEX_BYPASS_HOOK_TRUST";
  const saved = process.env[key];
  t.after(() => {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  });
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("pane reviewer hook trust 환경 전달", () => {
  for (const cli of ["code-reviewer", "quality-reviewer"]) {
    for (const value of ["0", undefined, "not'zero"]) {
      it(`${cli}: ${JSON.stringify(value)} 값을 route 셸에 전달한다`, (t) => {
        setHookTrustEnv(t, value);
        const dir = mkdtempSync(join(tmpdir(), "tfx-pane-hook-env-"));
        const route = join(dir, "tfx-route.sh");
        const saved = process.env.TFX_ROUTE_SCRIPT;
        t.after(() => {
          if (saved === undefined) delete process.env.TFX_ROUTE_SCRIPT;
          else process.env.TFX_ROUTE_SCRIPT = saved;
          rmSync(dir, { recursive: true, force: true });
        });
        writeFileSync(
          route,
          'printf "%s" "${TFX_CODEX_BYPASS_HOOK_TRUST-unset}"\n',
        );
        process.env.TFX_ROUTE_SCRIPT = route;
        const command = buildCliCommand(cli, "review prompt");
        const env = { ...process.env };
        delete env.TFX_CODEX_BYPASS_HOOK_TRUST;
        assert.equal(
          childProcess.execFileSync("bash", ["-c", command], {
            env,
            encoding: "utf8",
            stdio: "pipe",
          }),
          value ?? "unset",
        );
        if (value === undefined) {
          assert.ok(!command.includes("TFX_CODEX_BYPASS_HOOK_TRUST"), command);
        }
      });
    }
  }
});

function mockPaneCapture(t, text) {
  const commands = [];
  const tracker = t.mock.method(childProcess, "execFileSync", (file, args) => {
    assert.match(file, /(?:tmux|psmux)(?:\.exe)?$/u);
    commands.push(args);
    if (args.includes("-V")) return "tmux 3.6";
    if (args[0] === "capture-pane") return text;
    return "";
  });
  syncBuiltinESMExports();
  t.after(() => {
    tracker.mock.restore();
    syncBuiltinESMExports();
  });
  t.mock.method(Atomics, "wait", () => "timed-out");
  return commands;
}

describe("Codex hook review 주입 차단", () => {
  const reviewOptions = [
    "1. Review hooks",
    "2. Trust all and continue",
    "3. Continue without trusting (hooks won't run)",
  ];
  const reviewCapture = (selected, options = reviewOptions) =>
    [
      "  Hooks need review",
      "  1 hook is new or changed.",
      "  Hooks can run outside the sandbox after you trust them.",
      "",
      ...options.map(
        (option, index) => `${index === selected ? "›" : " "} ${option}`,
      ),
      "",
      "  enter confirm · esc skip",
      "",
    ].join("\n");
  const review = reviewCapture(0);
  const narrowOptions = [
    "1. Review hooks",
    "2. Trust all and continue",
    "3. Continue without trusting (hooks won't\n  run)",
  ];
  for (const cli of ["codex", "executor"]) {
    for (const value of [undefined, "0"]) {
      for (const selected of [0, 1, 2]) {
        it(`${cli}: opt-out=${JSON.stringify(value)} 선택 ${selected + 1} 검토 메뉴에는 paste와 키를 보내지 않는다`, (t) => {
          setHookTrustEnv(t, value);
          const commands = mockPaneCapture(t, reviewCapture(selected));
          assert.throws(
            () =>
              pane.injectPrompt("tfx-hook-test:0.1", "작업 지시", {
                cli,
                useFileRef: true,
              }),
            (error) => {
              assert.match(error.message, /codex-hooks-review/u);
              assert.equal(error.ready, false);
              assert.equal(error.blockedBy, "codex-hooks-review");
              return true;
            },
          );
          assert.ok(commands.some((args) => args[0] === "capture-pane"));
          assert.ok(
            commands.every(
              (args) => args.includes("-V") || args[0] === "capture-pane",
            ),
          );
        });
      }
    }
    for (const selected of [0, 1, 2]) {
      it(`${cli}: 좁은 pane의 선택 ${selected + 1} 검토 메뉴에는 paste와 키를 보내지 않는다`, (t) => {
        setHookTrustEnv(t, "0");
        const commands = mockPaneCapture(
          t,
          reviewCapture(selected, narrowOptions),
        );
        assert.throws(
          () => pane.injectPrompt("tfx-hook-test:0.1", "작업 지시", { cli }),
          (error) => {
            assert.equal(error.ready, false);
            assert.equal(error.blockedBy, "codex-hooks-review");
            return true;
          },
        );
        assert.ok(commands.some((args) => args[0] === "capture-pane"));
        assert.ok(
          commands.every(
            (args) => args.includes("-V") || args[0] === "capture-pane",
          ),
        );
      });
    }
    for (const [label, capture] of [
      ["문구 인용 뒤 빈 composer", "• Hooks need review\n› "],
      ["문구 인용 뒤 작성 중 composer", "Hooks need review\n› 이어서 확인"],
      ["메뉴 인용 뒤 빈 composer", `• 이전 화면:\n${review}\n› `],
      ["메뉴 인용 뒤 작성 중 composer", `${reviewCapture(2)}\n› 이어서 확인`],
      ["메뉴 인용 뒤 숫자로 시작하는 composer", `${review}\n› 1. 다음 작업`],
      [
        "접힌 메뉴 인용 뒤 빈 composer",
        `${reviewCapture(2, narrowOptions)}\n› `,
      ],
      [
        "접힌 메뉴 인용 뒤 작성 중 composer",
        `${reviewCapture(2, narrowOptions)}\n› 이어서 확인`,
      ],
    ]) {
      it(`${cli}: ${label}에는 정상 입력을 유지한다`, (t) => {
        const commands = mockPaneCapture(t, capture);
        assert.doesNotThrow(() =>
          pane.injectPrompt("tfx-hook-test:0.1", "작업 지시", { cli }),
        );
        assert.ok(commands.some((args) => args[0] === "paste-buffer"));
        assert.ok(
          commands.some(
            (args) => args[0] === "send-keys" && args.includes("Enter"),
          ),
        );
      });
    }
  }
  for (const [cli, capture] of [
    ["codex", "› "],
    ["claude", review],
    ["agy", review],
    [null, review],
  ]) {
    it(`${cli}: 정상 입력창, 다른 CLI와 셸 시작 명령은 계속 주입한다`, (t) => {
      const commands = mockPaneCapture(t, capture);
      assert.doesNotThrow(() =>
        pane.injectPrompt("tfx-hook-test:0.1", "작업 지시", { cli }),
      );
      assert.ok(commands.some((args) => args[0] === "paste-buffer"));
      assert.ok(
        commands.some(
          (args) => args[0] === "send-keys" && args.includes("Enter"),
        ),
      );
    });
  }
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
  it("psmux + useFileRef=true + antigravity는 @file 경로 사용", () => {
    assert.equal(
      shouldUseFileRef({
        multiplexer: "psmux",
        useFileRef: true,
        cli: "antigravity",
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
        cli: "antigravity",
      }),
      false,
    );
  });

  it("tmux(비-psmux)는 cli 무관하게 @file 경로 거부 (paste-buffer 경로)", () => {
    assert.equal(
      shouldUseFileRef({
        multiplexer: "tmux",
        useFileRef: true,
        cli: "antigravity",
      }),
      false,
    );
  });
});
