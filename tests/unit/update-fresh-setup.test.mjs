import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { findTrifluxPluginEntry } from "../../bin/triflux.mjs";
import {
  createCliResult,
  outputOptions,
  renderCliResult,
} from "../../scripts/lib/cli-output.mjs";
import {
  cliFixture,
  snapshot,
  version,
} from "../helpers/cli-output-fixture.mjs";

function success(result) {
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(
    result.stdout,
    /\x1b\[|테스트 환경:|주입한 run|Setup Complete|background/,
  );
  return result.stdout;
}

test("mods 플러그인은 본체 설치 감지에서 제외한다", () => {
  const mods = { installPath: "/plugins/triflux-mods/10.57.1" };
  const core = { installPath: "/plugins/triflux/10.57.1" };
  assert.equal(
    findTrifluxPluginEntry({ plugins: { "triflux-mods@triflux": [mods] } }),
    null,
  );
  assert.equal(
    findTrifluxPluginEntry({
      plugins: { "triflux-mods@triflux": [mods], "triflux@triflux": [core] },
    }),
    core,
  );
});

test("에이전트 env 표와 JSON은 TTY에서도 비대화식이며 색상 조건을 지킨다", () => {
  const tty = { isTTY: true };
  for (const [name, keys] of [
    ["claude-code", ["CLAUDECODE", "CLAUDE_CODE"]],
    ["codex", ["CODEX_SANDBOX", "CODEX_CI", "CODEX_THREAD_ID"]],
    ["gemini-cli", ["GEMINI_CLI"]],
    ["antigravity", ["ANTIGRAVITY_AGENT"]],
    ["opencode", ["OPENCODE_CLIENT"]],
    ["cursor", ["CURSOR_AGENT"]],
    ["ai-agent", ["AI_AGENT"]],
  ])
    for (const key of keys) {
      const options = outputOptions([], {
        env: { [key]: "1" },
        input: tty,
        output: tty,
      });
      assert.equal(options.agent, name);
      assert.equal(options.nonInteractive, true);
    }
  assert.equal(
    outputOptions(["--json"], { env: {}, input: tty, output: tty })
      .nonInteractive,
    true,
  );
  assert.equal(
    outputOptions([], { env: {}, input: tty, output: tty }).nonInteractive,
    false,
  );
  for (const env of [
    { NO_COLOR: "" },
    { TERM: "dumb" },
    { FORCE_COLOR: "0" },
    { FORCE_COLOR: "false" },
  ])
    assert.equal(
      outputOptions([], { env, input: tty, output: tty }).color,
      false,
    );
  assert.equal(
    outputOptions([], { env: { FORCE_COLOR: "1" }, input: tty, output: {} })
      .color,
    false,
  );
  assert.equal(
    outputOptions([], { env: { FORCE_COLOR: "1" }, input: tty, output: tty })
      .color,
    true,
  );
});

test("실제 CLI 최신 update는 한 줄, JSON은 마지막 줄 하나이며 파일 변경만 표시한다", (t) => {
  const cli = cliFixture(t);
  success(cli.run(["setup"]));
  cli.trustHooks();
  const output = success(cli.run(["update"], { CLAUDECODE: "1" }));
  assert.match(
    output,
    new RegExp(
      `^✓ triflux ${version} 최신 \\(파일 \\d+개 일치, \\d+\\.\\ds\\)\\n$`,
    ),
  );
  const json = success(cli.run(["update", "--json"]));
  assert.equal(json.trim().split("\n").length, 1);
  assert.equal(JSON.parse(json).alreadyInGoalState, true);
  assert.deepEqual(JSON.parse(json).changed, []);
  assert.deepEqual(Object.keys(JSON.parse(json)), [
    "command",
    "outcome",
    "message",
    "alreadyInGoalState",
    "from",
    "to",
    "changed",
    "unchanged",
    "targets",
    "warnings",
  ]);
  assert.match(
    success(cli.run(["update", "--verbose"])),
    / {2}✓ hud\/renderers.mjs/,
  );
  const setup = JSON.parse(success(cli.run(["setup", "--json"])));
  assert.equal(setup.alreadyInGoalState, true);
  assert.equal(success(cli.run(["update", "-q"])), "");
  const file = "scripts/tfx-route-post.mjs";
  writeFileSync(join(cli.home, ".claude", file), "stale file\n");
  const changed = success(cli.run(["update"]));
  assert.match(changed, /파일 1개 반영/);
  assert.match(changed, /~ scripts\/tfx-route-post.mjs/);
  assert.equal(
    readFileSync(join(cli.home, ".claude", file), "utf8"),
    readFileSync(join(cli.pkg, file), "utf8"),
  );
  assert.ok(
    cli
      .trace()
      .some((entry) => entry.argv?.join(" ") === "setup --from-update --json"),
  );
  assert.equal(
    cli.trace().some((entry) => entry.command?.startsWith("npm install")),
    false,
  );
});

test("실제 복제 패키지 버전 변경 후 새 프로세스가 새 파일과 경고를 합쳐 출력한다", (t) => {
  const cli = cliFixture(t);
  cli.setVersion("10.57.3");
  success(cli.run(["setup"]));
  const output = success(cli.run(["update"], { FIXTURE_LATEST: version }));
  assert.match(output, new RegExp(`^✓ triflux 10.57.3 -> ${version} \\(`));
  assert.match(output, new RegExp(`releases/tag/v${version}`));
  assert.match(output, /파일 2개 반영/);
  assert.match(output, /~ hud\/renderers.mjs/);
  assert.match(output, /\+ hud\/output-fixture-new.mjs/);
  assert.match(output, /! Codex 훅 승인 전/);
  assert.match(output, /경고 1건. 되돌리기: npm i -g triflux@10.57.3/);
  assert.doesNotMatch(output, /설정 완료|triflux .* setup/);
  assert.equal(
    JSON.parse(readFileSync(join(cli.pkg, "package.json"))).version,
    version,
  );
  assert.ok(
    readFileSync(
      join(cli.home, ".claude/hud/output-fixture-new.mjs"),
      "utf8",
    ).includes("added"),
  );
  const processes = cli.trace().filter((entry) => entry.argv);
  assert.notEqual(
    processes.find((entry) => entry.argv[0] === "update").pid,
    processes.find((entry) => entry.argv.includes("--from-update")).pid,
  );
  writeFileSync(join(cli.home, ".claude/settings.json"), "{");
  const failed = cli.run(["update", "--json"]);
  assert.equal(failed.status, 1);
  assert.match(JSON.parse(failed.stdout).message, /이전 hook 정리 실패/);
  const childFailure = {
    command: "setup",
    outcome: "failed",
    message: "파일 동기화 실패",
    alreadyInGoalState: false,
    from: version,
    to: version,
    changed: ["hud/renderers.mjs"],
    unchanged: 3,
    targets: [{ name: "claude", status: "failed", detail: "복사 실패" }],
    warnings: [{ code: "copy", message: "복사 실패" }],
    files: [{ path: "hud/renderers.mjs", change: "update" }],
    steps: [],
  };
  const reported = cli.run(["update", "--json"], {
    FIXTURE_SETUP_RESULT: JSON.stringify(childFailure),
  });
  assert.equal(reported.status, 1);
  assert.deepEqual(JSON.parse(reported.stdout).changed, childFailure.changed);
  assert.deepEqual(JSON.parse(reported.stdout).warnings, childFailure.warnings);
  assert.deepEqual(JSON.parse(reported.stdout).targets, childFailure.targets);
  assert.equal(JSON.parse(reported.stdout).outcome, "failed");
  assert.equal(JSON.parse(reported.stdout).alreadyInGoalState, false);
});

test("버전 변화에 경고가 없어도 되돌리기 명령을 보여준다", () => {
  const report = createCliResult("update", "10.57.3");
  report.to = version;
  report.elapsed = 100;
  assert.match(
    renderCliResult(report, {}),
    /\n되돌리기: npm i -g triflux@10\.57\.3\n$/,
  );
});

test("--check 는 registry만 읽고 HOME과 tmp를 쓰지 않으며 조회 실패는 exit 1", (t) => {
  const cli = cliFixture(t);
  const before = [snapshot(cli.home), snapshot(cli.temp)];
  assert.equal(
    success(cli.run(["update", "--check"])),
    `✓ triflux ${version} 최신\n`,
  );
  assert.equal(
    success(cli.run(["update", "--check"], { FIXTURE_LATEST: "99.0.0" })),
    `업데이트 있음: ${version} -> 99.0.0\n`,
  );
  assert.equal(
    JSON.parse(
      success(
        cli.run(["update", "--check", "--json"], {
          FIXTURE_LATEST: "99.0.0",
        }),
      ),
    ).message,
    "업데이트 있음",
  );
  const failed = cli.run(["update", "--check", "--json"], {
    FIXTURE_LATEST: "error",
  });
  assert.equal(failed.status, 1);
  assert.equal(
    JSON.parse(failed.stdout.trim().split("\n").at(-1)).outcome,
    "failed",
  );
  assert.deepEqual([snapshot(cli.home), snapshot(cli.temp)], before);
  assert.equal(
    cli.trace().some((entry) => entry.blockedWrite),
    false,
  );
  assert.deepEqual(
    cli
      .trace()
      .filter((entry) => entry.command)
      .map((entry) => entry.command),
    [],
  );
  assert.equal(cli.trace().filter((entry) => entry.fetch).length, 4);
});

test("scripts/setup --json 복사 실패는 완료된 파일만 보고하고 exit 1", (t) => {
  const cli = cliFixture(t);
  const failed = cli.run(
    ["--force", "--json"],
    { FIXTURE_COPY_FAIL_AT: "hud/renderers.mjs" },
    "scripts/setup.mjs",
  );
  assert.equal(failed.status, 1);
  const report = JSON.parse(failed.stdout.trim().split("\n").at(-1));
  assert.equal(report.outcome, "failed");
  assert.match(report.message, /fixture copy denied/);
  assert.ok(report.changed.length > 0);
  assert.ok(!report.changed.includes("hud/renderers.mjs"));
  assert.equal(report.alreadyInGoalState, false);
});

test("setup non-TTY/agent와 postinstall skip은 공용 형식을 쓰고 경고는 한 번 나온다", (t) => {
  const cli = cliFixture(t);
  assert.match(
    success(cli.run(["setup"])),
    new RegExp(`^triflux ${version} setup \\(비대화식\\)\\n`),
  );
  const agent = success(
    cli.run(["setup"], { CLAUDECODE: "1", FIXTURE_MODS: "10.57.1" }),
  );
  assert.match(agent, /setup \(에이전트: claude-code, 비대화식\)/);
  assert.equal(agent.split("mods 버전이 다르다").length, 2);
  assert.match(agent, /설정 완료, 경고 2건\n다음: tfx doctor\n$/);
  const quiet = success(cli.run(["setup", "--quiet"]));
  assert.match(quiet, /^! Codex 훅 승인 전[^\n]*\n$/);
  assert.equal(
    success(
      cli.run(
        [],
        { npm_lifecycle_event: "postinstall", CI: "1" },
        "scripts/setup.mjs",
      ),
    ),
    `triflux ${version} 설치됨. 설정: tfx setup  (CI 에서는 건너뜀)\n`,
  );
  assert.match(
    success(cli.run(["--force"], {}, "scripts/setup.mjs")),
    new RegExp(`^triflux ${version} setup`),
  );
});

test("설치 실패는 exit 1이며 Windows에서만 한 번 --force 재시도한다", (t) => {
  for (const platform of ["darwin", "linux", "win32"]) {
    const cli = cliFixture(t);
    const result = cli.run(["update"], {
      FIXTURE_PLATFORM: platform,
      FIXTURE_LATEST: "99.0.0",
      FIXTURE_INSTALL_FAIL: "1",
    });
    assert.equal(result.status, 1);
    assert.equal(
      result.stdout,
      "✗ 업데이트 실패: install denied\n직접 실행: npm i -g triflux@latest\n",
    );
    assert.deepEqual(
      cli
        .trace()
        .filter((entry) => entry.command?.startsWith("npm install"))
        .map((entry) => entry.command),
      [
        "npm install -g triflux@latest",
        ...(platform === "win32"
          ? ["npm install -g triflux@latest --force"]
          : []),
      ],
    );
  }
});
