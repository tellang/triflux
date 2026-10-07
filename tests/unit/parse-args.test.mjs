import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { parseTeamArgs } from "../../hub/team/cli/commands/start/parse-args.mjs";

test("an empty interactive invocation shows usage without a multiplexer", () => {
  const url = new URL(
    "../../hub/team/cli/commands/start/index.mjs",
    import.meta.url,
  ).href;
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `Object.defineProperty(process.stdout, "isTTY", { value: true });
       const { teamStart } = await import(${JSON.stringify(url)});
       await teamStart([]);`,
    ],
    { env: { ...process.env, PATH: "", TMUX: "" }, encoding: "utf8" },
  );
  assert.match(output, /사용법:/);
});

test("legacy default flags are ignored without warnings or changing options", (t) => {
  const warnings = t.mock.method(console, "warn", () => {});
  const args = [
    "--teammate-mode",
    "headless",
    "--no-auto-attach",
    "--no-dashboard",
    "test",
  ];
  assert.deepEqual(
    parseTeamArgs([...args, "--auto-attach", "--dashboard"]),
    parseTeamArgs(args),
  );
  assert.equal(warnings.mock.callCount(), 0);
});

test("assign parses a mapped role after prompt-internal colons", () => {
  const parsed = parseTeamArgs([
    "--teammate-mode",
    "headless",
    "--assign",
    "codex:do:deep-executor",
    "--assign",
    "codex:범위: 조사:scientist-deep",
  ]);
  assert.deepEqual(parsed.assigns, [
    { cli: "codex", prompt: "do", role: "deep-executor" },
    { cli: "codex", prompt: "범위: 조사", role: "scientist-deep" },
  ]);
});

test("an unrecognized assign suffix stays in the prompt", () => {
  const parsed = parseTeamArgs([
    "--teammate-mode",
    "headless",
    "--assign",
    "codex:URL:https://example.com",
  ]);
  assert.deepEqual(parsed.assigns, [
    { cli: "codex", prompt: "URL:https://example.com", role: "" },
  ]);
});

test("native bridge UI defaults to agents in headless and stays off in mux mode", () => {
  const headless = parseTeamArgs(["--teammate-mode", "headless"]);
  assert.equal(headless.nativeBridge, true);
  assert.equal(headless.nativeBridgeMode, "agents");
  assert.equal(parseTeamArgs(["--teammate-mode", "tmux"]).nativeBridge, false);
  for (const flag of ["--native-bridge", "-nb"])
    assert.equal(
      parseTeamArgs(["--teammate-mode", "headless", flag]).nativeBridge,
      true,
    );
  for (const mode of ["roster", "interactive-attach", "claude-wrapper"])
    assert.throws(
      () =>
        parseTeamArgs([
          "--teammate-mode",
          "headless",
          "--native-bridge-mode",
          mode,
        ]),
      /unknown native bridge mode/,
    );
});
