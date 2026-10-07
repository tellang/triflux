import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tempRoots = [];

function makeCheckout() {
  const checkout = mkdtempSync(join(tmpdir(), "triflux-commit-hook-"));
  tempRoots.push(checkout);
  mkdirSync(join(checkout, "scripts"));
  mkdirSync(join(checkout, ".githooks"));
  copyFileSync(
    join(root, "scripts/install-commit-hook.mjs"),
    join(checkout, "scripts/install-commit-hook.mjs"),
  );
  copyFileSync(
    join(root, ".githooks/commit-msg"),
    join(checkout, ".githooks/commit-msg"),
  );
  chmodSync(join(checkout, ".githooks/commit-msg"), 0o755);
  writeFileSync(join(checkout, "package.json"), '{"name":"triflux"}\n');
  execFileSync("git", ["init", "-q", checkout]);
  return checkout;
}

afterEach(() => {
  for (const path of tempRoots.splice(0))
    rmSync(path, { recursive: true, force: true });
});

test("commit-msg가 AI attribution을 거부하고 일반 메시지를 허용한다", () => {
  const checkout = makeCheckout();
  const hook = join(checkout, ".githooks/commit-msg");
  const message = join(checkout, "message.txt");
  for (const trailer of [
    "Co-Authored-By: Bot <bot@example.test>",
    "Claude-Session: abc",
    "Generated with [Claude Code]",
    "🤖 Generated with [Claude Code](https://claude.ai/code)",
  ]) {
    writeFileSync(message, `chore: 테스트\n\n${trailer}\n`);
    const result = spawnSync(hook, [message], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /AI attribution trailer/u);
  }
  writeFileSync(message, "chore: 정상 메시지\n\n검증 완료\n");
  assert.equal(spawnSync(hook, [message]).status, 0);
});

test("prepare는 checkout에만 설치하고 기존 core.hooksPath를 보존한다", () => {
  const checkout = makeCheckout();
  const prepare = join(checkout, "scripts/install-commit-hook.mjs");
  const git = (...args) =>
    spawnSync("git", ["-C", checkout, ...args], {
      encoding: "utf8",
    }).stdout.trim();

  assert.equal(spawnSync(process.execPath, [prepare]).status, 0);
  assert.equal(
    git("config", "--local", "--get", "core.hooksPath"),
    ".githooks",
  );
  execFileSync("git", [
    "-C",
    checkout,
    "config",
    "--local",
    "core.hooksPath",
    "custom-hooks",
  ]);
  const result = spawnSync(process.execPath, [prepare], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /기존 core\.hooksPath/u);
  assert.equal(
    git("config", "--local", "--get", "core.hooksPath"),
    "custom-hooks",
  );

  rmSync(join(checkout, ".git"), { recursive: true, force: true });
  assert.equal(spawnSync(process.execPath, [prepare]).status, 0);
  assert.equal(
    readFileSync(join(checkout, "package.json"), "utf8"),
    '{"name":"triflux"}\n',
  );
});

test("prepare는 전역 core.hooksPath도 덮어쓰지 않는다", () => {
  const checkout = makeCheckout();
  const prepare = join(checkout, "scripts/install-commit-hook.mjs");
  const config = join(checkout, "global.gitconfig");
  writeFileSync(config, "[core]\n\thooksPath = shared-hooks\n");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: config };
  const result = spawnSync(process.execPath, [prepare], {
    encoding: "utf8",
    env,
  });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /기존 core\.hooksPath/u);
  assert.equal(
    spawnSync(
      "git",
      ["-C", checkout, "config", "--local", "--get", "core.hooksPath"],
      {
        env,
      },
    ).status,
    1,
  );
});
