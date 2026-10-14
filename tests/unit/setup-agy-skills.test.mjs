import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cliFixture, version } from "../helpers/cli-output-fixture.mjs";

test("setup installs and refreshes managed agy skills, including the version cache path", (t) => {
  const cli = cliFixture(t);
  writeFileSync(
    join(cli.env.PATH, process.platform === "win32" ? "agy.exe" : "agy"),
    "",
  );
  const skills = join(cli.home, ".gemini/antigravity-cli/skills");
  const installed = cli.run(["setup", "--json", "--non-interactive"]);
  assert.equal(installed.status, 0, installed.stderr);
  const report = JSON.parse(installed.stdout);
  assert.equal(report.targets.find(({ name }) => name === "agy").status, "ok");
  assert.match(
    report.targets.find(({ name }) => name === "agy").detail,
    /스킬 2개/,
  );
  assert.match(
    report.targets.find(({ name }) => name === "codex").detail,
    /스킬 3개/,
  );
  for (const [name, source] of [
    ["tfx-live", "adapters/agy/skills/tfx-live/SKILL.md"],
    ["tfx-lead", "skills/tfx-lead/SKILL.md"],
  ]) {
    assert.equal(
      readFileSync(join(skills, name, "SKILL.md"), "utf8"),
      readFileSync(join(cli.pkg, source), "utf8"),
    );
    assert.ok(existsSync(join(skills, name, ".triflux-managed-skill")));
  }
  const marker = join(cli.home, ".claude/cache/tfx-setup-marker.json");
  mkdirSync(join(cli.home, ".claude/cache"), { recursive: true });
  writeFileSync(marker, JSON.stringify({ version, timestamp: 1234 }));
  writeFileSync(join(skills, "tfx-live/SKILL.md"), "old managed skill\n");
  const refreshed = cli.run(["--sync", "--json"], {}, "scripts/setup.mjs");
  assert.equal(refreshed.status, 0, refreshed.stderr);
  assert.match(
    JSON.parse(refreshed.stdout).targets.find(({ name }) => name === "agy")
      .detail,
    /스킬 2개/,
  );
  assert.equal(
    readFileSync(join(skills, "tfx-live/SKILL.md"), "utf8"),
    readFileSync(
      join(cli.pkg, "adapters/agy/skills/tfx-live/SKILL.md"),
      "utf8",
    ),
  );
  assert.equal(JSON.parse(readFileSync(marker, "utf8")).timestamp, 1234);
});

test("setup preserves user-owned agy skills and reports each skip", (t) => {
  const cli = cliFixture(t);
  writeFileSync(
    join(cli.env.PATH, process.platform === "win32" ? "agy.exe" : "agy"),
    "",
  );
  const skills = join(cli.home, ".gemini/antigravity-cli/skills");
  for (const name of ["tfx-live", "tfx-lead"]) {
    mkdirSync(join(skills, name), { recursive: true });
    writeFileSync(join(skills, name, "SKILL.md"), `user ${name}\n`);
  }
  const result = cli.run(["setup", "--json", "--non-interactive"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  for (const name of ["tfx-live", "tfx-lead"]) {
    assert.equal(
      readFileSync(join(skills, name, "SKILL.md"), "utf8"),
      `user ${name}\n`,
    );
    assert.equal(
      existsSync(join(skills, name, ".triflux-managed-skill")),
      false,
    );
    assert.ok(
      report.warnings.some(
        ({ message }) => message === `agy ${name}: 사용자 스킬 보존`,
      ),
    );
  }
});

test("setup skips agy skills when the executable is absent", (t) => {
  const cli = cliFixture(t);
  const result = cli.run(["setup", "--json", "--non-interactive"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    existsSync(join(cli.home, ".gemini/antigravity-cli/skills")),
    false,
  );
  assert.equal(
    JSON.parse(result.stdout).targets.find(({ name }) => name === "agy").status,
    "skipped",
  );
});

test("setup reports an agy sync failure when its packaged adapter is missing", (t) => {
  const cli = cliFixture(t);
  writeFileSync(
    join(cli.env.PATH, process.platform === "win32" ? "agy.exe" : "agy"),
    "",
  );
  rmSync(join(cli.pkg, "adapters/agy"), { recursive: true, force: true });
  for (const [args, script] of [
    [["setup", "--json", "--non-interactive"], "bin/triflux.mjs"],
    [["--sync", "--json"], "scripts/setup.mjs"],
  ]) {
    const result = cli.run(args, {}, script);
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(
      report.targets.find(({ name }) => name === "agy").status,
      "failed",
    );
    assert.match(
      report.targets.find(({ name }) => name === "agy").detail,
      /스킬 동기화 실패/,
    );
    assert.ok(
      report.warnings.some(({ message }) =>
        message.startsWith("agy tfx-live:"),
      ),
    );
    assert.equal(
      existsSync(join(cli.home, ".gemini/antigravity-cli/skills/tfx-live")),
      false,
    );
  }
});
