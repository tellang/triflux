import assert from "node:assert/strict";
import { appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  findTrifluxPluginEntry,
  installNpmGlobal,
  runUpdatedSetup,
} from "../../bin/triflux.mjs";
import { cliFixture, version } from "../helpers/cli-output-fixture.mjs";

function success(result) {
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(result.stderr, "");
  return result.stdout;
}

test("최신 update는 한 줄이며 JSON은 마지막 줄 하나다", (t) => {
  const cli = cliFixture(t);
  success(cli.run(["setup"], { FIXTURE_TTY: "1" }));
  assert.match(
    success(cli.run(["update"])),
    new RegExp(
      `^✓ triflux ${version} 최신 \\(파일 \\d+개 일치, \\d+\\.\\ds\\)\\n안내: .*native peer 전역 승인은 불가하다.*\\n안내: .*tfx-live\\.rules.*ask/queue/tmux.*\\n$`,
    ),
  );
  const json = success(cli.run(["update", "--json"]));
  assert.equal(json.trim().split("\n").length, 1);
  assert.equal(JSON.parse(json).alreadyInGoalState, true);
  assert.deepEqual(JSON.parse(json).changed, []);
});

test("버전 변경은 최신 자식 setup의 파일, 경고 1건과 안내 1건을 합친다", (t) => {
  const cli = cliFixture(t);
  cli.setVersion("10.57.3");
  success(cli.run(["setup"]));
  const output = success(
    cli.run(["update"], { FIXTURE_LATEST: version, FIXTURE_MODS: "10.57.3" }),
  );
  assert.match(output, new RegExp(`^✓ triflux 10.57.3 -> ${version}`));
  assert.match(output, /파일 1개 반영/);
  assert.match(output, /~ hud\/renderers.mjs/);
  assert.match(output, /! mods 버전이 다르다/);
  assert.match(output, /안내: Codex 훅 승인 전/);
  assert.match(output, /경고 1건. 되돌리기: npm i -g triflux@10.57.3/);
  assert.doesNotMatch(output, /설정 완료|triflux .* setup/);
});

test("update --check는 쓰기가 없으며 setup --check는 인자 오류다", (t) => {
  const cli = cliFixture(t);
  assert.equal(
    success(cli.run(["update", "--check"], { FIXTURE_LATEST: "99.0.0" })),
    `업데이트 있음: ${version} -> 99.0.0\n`,
  );
  assert.equal(cli.run(["setup", "--check"]).status, 2);
  assert.equal(cli.run(["--check"], {}, "scripts/setup.mjs").status, 2);
  assert.equal(cli.trace().filter((entry) => entry.write).length, 0);
});

test("비TTY setup은 묻지 않고 보류 안내는 경고와 quiet 출력에서 뺀다", (t) => {
  const cli = cliFixture(t);
  rmSync(join(cli.env.PATH, "codex"));
  const output = success(cli.run(["setup"]));
  assert.match(output, /setup \(비대화식\)/);
  assert.match(output, /codex\s+미설치 \(npm i -g @openai\/codex\)/);
  assert.match(output, /안내: Codex 훅 승인 전/);
  assert.doesNotMatch(output, /경고|\[y\/N\]/);
  assert.equal(success(cli.run(["setup", "--quiet"])), "");
  assert.equal(
    cli.trace().some((entry) => entry.question),
    false,
  );
});

test("사람 TTY update는 새 packageRoot의 CLI 자식이 consent를 실행한다", (t) => {
  const cli = cliFixture(t);
  cli.setVersion("10.57.3");
  const output = success(
    cli.run(["update"], {
      FIXTURE_TTY: "1",
      FIXTURE_LATEST: version,
      FIXTURE_MODS: "10.57.3",
    }),
  );
  const trace = cli.trace();
  const parent = trace.find((entry) => entry.argv?.[0] === "update");
  const child = trace.find((entry) => entry.argv?.includes("--from-update"));
  const consent = trace.find((entry) => entry.argv?.includes("--consent-only"));
  const questions = trace.filter((entry) => entry.question);
  assert.notEqual(parent.pid, child.pid);
  assert.equal(questions.length, 2);
  assert.notEqual(consent.pid, parent.pid);
  assert.notEqual(consent.pid, child.pid);
  assert.equal(consent.cli, join(cli.pkg, "bin/triflux.mjs"));
  assert.ok(questions.every((entry) => entry.pid === consent.pid));
  assert.match(questions[0].question, new RegExp(`패키지 ${version}`));
  assert.match(output, /mods 업데이트 완료/);
  assert.match(output, /Codex hooks: 승인 기록/);
  assert.doesNotMatch(output, /승인 전|경고|설정 완료/);
  assert.doesNotMatch(output, /Codex hooks: 세션 동기화 훅 등록/);
  const manual = success(
    cli.run(["setup", "--from-update", "--consent-only"], { FIXTURE_TTY: "1" }),
  );
  assert.equal(JSON.parse(manual.trim().split("\n").at(-1)).outcome, "ok");
});

test("동의 자식 실패는 경고 하나로 합치고 update 결과를 보존한다", (t) => {
  for (const json of [false, true]) {
    for (const consentJson of [false, true]) {
      const cli = cliFixture(t);
      cli.setVersion("10.57.3");
      success(cli.run(["setup"]));
      appendFileSync(
        join(cli.root, "preload.cjs"),
        `
if (process.argv.includes('--consent-only')) {
  if (${consentJson}) fs.writeSync(process.argv.includes('--json') ? 1 : 3, JSON.stringify({
    outcome: 'failed', message: 'consent denied', exitCode: 7,
    steps: [], notices: [], warnings: [], targets: [], alreadyInGoalState: false
  }) + '\\n');
  process.exit(7);
}
`,
      );
      const output = success(
        cli.run(["update", ...(json ? ["--json"] : [])], {
          FIXTURE_TTY: "1",
          FIXTURE_LATEST: version,
          NO_COLOR: "1",
        }),
      );
      const warning = `동의 단계 실패: ${consentJson ? "consent denied" : "종료 코드 7"}. 다시 실행: tfx setup`;
      if (json) {
        const report = JSON.parse(output);
        assert.equal(report.outcome, "ok");
        assert.deepEqual(report.changed, ["hud/renderers.mjs"]);
        assert.equal(report.to, version);
        assert.deepEqual(
          report.warnings.map(({ message }) => message),
          [warning],
        );
      } else {
        assert.match(output, new RegExp(`^✓ triflux 10.57.3 -> ${version}`));
        assert.match(output, /파일 1개 반영/);
        assert.match(output, /~ hud\/renderers.mjs/);
        assert.ok(output.includes(warning));
        assert.match(output, /경고 1건/);
      }
    }
  }
});

test("update 는 triflux-mods 플러그인을 triflux 본체 플러그인 설치로 보지 않는다", () => {
  const mods = { installPath: "/plugins/cache/triflux/triflux-mods/10.57.1" };
  const core = { installPath: "/plugins/cache/triflux/triflux/10.57.1" };
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

test("update 실패는 npm과 JSON 없는 자식의 stderr 첫 원인을 보여준다", async (t) => {
  const cli = cliFixture(t);
  const failed = cli.run(["update"], {
    FIXTURE_LATEST: "99.0.0",
    FIXTURE_INSTALL_FAIL: "1",
  });
  assert.equal(failed.status, 1);
  assert.match(
    failed.stdout,
    /Command failed: npm install -g triflux@latest: npm ERR! EACCES: permission denied/,
  );
  assert.match(failed.stdout, /직접 실행: npm i -g triflux@latest/);
  await assert.rejects(
    runUpdatedSetup({
      packageRoot: cli.pkg,
      execFileSyncFn() {
        throw Object.assign(new Error("Command failed: setup"), {
          stderr: Buffer.from("\n EACCES: setup denied\n"),
        });
      },
    }),
    /Command failed: setup: EACCES: setup denied/,
  );
});

test("Windows에서만 npm 글로벌 설치를 --force로 한 번 재시도한다", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    const calls = [];
    const error = new Error("denied");
    assert.throws(
      () =>
        installNpmGlobal({
          platform,
          exec(command) {
            calls.push(command);
            throw error;
          },
        }),
      error,
    );
    assert.deepEqual(calls, [
      "npm install -g triflux@latest",
      ...(platform === "win32"
        ? ["npm install -g triflux@latest --force"]
        : []),
    ]);
  }
});
