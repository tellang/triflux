// tests/regression/release-prepare-completes-all-steps.test.mjs
//
// 회귀 가드 — prepare.mjs 의 npm-test step 후 후속 step (lint, pack, release-notes) 가
// 모두 실행되는지 검증한다.
//
// 회귀 컨텍스트 (issue #192 후속):
// - 사용자 보고: `npm run release:prepare -- --execute --version X --allow-dirty` 가
//   `[prepare] step=npm-test t=53ms` 직후 silent exit 0, lint/pack/release-notes 단계 미실행
// - F1 fix (test-lock.mjs:174 stdio split + close stdin) 적용 후에도 재발 보고됨
// - root cause 미확정 — 본 테스트는 prepare.mjs 의 step sequence 자체를 보호하는 안전망
//
// 한계: 본 테스트가 PASS 하더라도 --execute 시 회귀가 재발할 수 있다 (prepare.mjs 외부의
// child process / npm wrapper / OS-level stdio 요인). 다만 prepare.mjs 자체의
// step sequence 단락 회귀는 즉시 catch.

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { prepareRelease } from "../../scripts/release/prepare.mjs";

describe("release:prepare regression — step sequence completeness", () => {
  let tmpRoot;

  before(() => {
    // Minimal scaffolded root: package.json + version-manifest.json + .omx/plans
    tmpRoot = mkdtempSync(join(tmpdir(), "tfx-prepare-regression-"));

    const manifest = {
      canonicalFile: "package.json",
      canonicalPath: ["version"],
      targets: [{ file: "package.json", paths: [["version"]] }],
    };

    mkdirSync(join(tmpRoot, "scripts", "release"), { recursive: true });
    writeFileSync(
      join(tmpRoot, "scripts", "release", "version-manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
    writeFileSync(
      join(tmpRoot, "package.json"),
      JSON.stringify({ name: "test", version: "10.18.0" }, null, 2),
    );
    mkdirSync(join(tmpRoot, ".omx", "plans"), { recursive: true });
  });

  after(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // overrides: per-command override map { "npm test": (ctx) => string | throw, ... }
  // calls 는 항상 push 된다 (override 가 throw 하더라도 trace 는 보존)
  function makeMockExec(overrides = {}) {
    const calls = [];
    const fn = (command, args, opts) => {
      calls.push({ command, args: [...args] });

      const key = `${command} ${args[0]}`;
      if (overrides[key]) return overrides[key]({ command, args, opts });

      // git status --porcelain → clean working tree
      if (command === "git" && args[0] === "status") return "";
      // git describe --tags --abbrev=0 → previous tag
      if (command === "git" && args[0] === "describe") return "v10.17.0\n";
      // git log --oneline → some commits
      if (command === "git" && args[0] === "log") return "abc123 feat: test\n";
      // npm test/lint/pack → success (empty stdout)
      if (command === "npm") return "";
      return "";
    };
    return { fn, calls };
  }

  it("npm-test EXIT 0 (success) 시 후속 step (lint, pack, release-notes) 모두 실행", async () => {
    const { fn, calls } = makeMockExec();
    const result = await prepareRelease({
      version: "10.18.0",
      rootDir: tmpRoot,
      allowDirty: true,
      dryRun: false,
      execFileSyncFn: fn,
    });

    assert.equal(result.ok, true);

    // npm 호출은 정확히 3회: npm test, npm run lint, npm pack --dry-run
    const npmCalls = calls.filter((c) => c.command === "npm");
    assert.equal(
      npmCalls.length,
      3,
      `expected 3 npm calls (test/lint/pack), got ${npmCalls.length}: ${JSON.stringify(
        npmCalls.map((c) => c.args),
      )}`,
    );
    assert.deepEqual(npmCalls[0].args, ["test"]);
    assert.deepEqual(npmCalls[1].args, ["run", "lint"]);
    assert.deepEqual(npmCalls[2].args, ["pack", "--dry-run"]);

    // release-notes step 실행 검증 (releaseNotesPath 가 결과에 포함됨)
    assert.ok(result.releaseNotesPath, "releaseNotesPath should be set");
    assert.match(result.releaseNotesPath, /release-notes-v10\.18\.0\.md$/);
  });

  it("npm-test 가 빈 stdout 반환해도 (silent EXIT 0 시뮬레이션) 후속 step 호출", async () => {
    // 회귀 시나리오: npm test 가 53ms 안에 EXIT 0 + 빈 stdout 반환
    // 이 경우에도 prepare.mjs 의 for-loop 가 다음 step 으로 진행해야 한다.
    const { fn, calls } = makeMockExec({
      "npm test": () => "", // silent EXIT 0
    });

    const result = await prepareRelease({
      version: "10.18.0",
      rootDir: tmpRoot,
      allowDirty: true,
      dryRun: false,
      execFileSyncFn: fn,
    });

    assert.equal(result.ok, true);
    const npmCalls = calls.filter((c) => c.command === "npm");
    // 회귀 가드 핵심: 3개 모두 호출됐는지 (lint/pack 단락 회귀 즉시 catch)
    assert.equal(
      npmCalls.length,
      3,
      "npm-test silent EXIT 0 후에도 lint/pack 호출되어야 함",
    );
  });

  it("npm-test 가 throw 시 후속 step 호출 안 됨 (정상 단락 동작)", async () => {
    const { fn, calls } = makeMockExec({
      "npm test": () => {
        const err = new Error("npm test failed");
        err.status = 1;
        throw err;
      },
    });

    await assert.rejects(
      prepareRelease({
        version: "10.18.0",
        rootDir: tmpRoot,
        allowDirty: true,
        dryRun: false,
        execFileSyncFn: fn,
      }),
      /npm test failed/,
    );

    // 단락 검증: npm test 만 호출됐고, lint/pack 은 호출 안 됨
    const npmCalls = calls.filter((c) => c.command === "npm");
    assert.equal(
      npmCalls.length,
      1,
      "npm test fail 시 lint/pack 은 호출되지 않아야 함 (단락)",
    );
    assert.deepEqual(npmCalls[0].args, ["test"]);
  });

  it("skipTests=true 시 npm test 만 skip, lint/pack/release-notes 정상 실행", async () => {
    const { fn, calls } = makeMockExec();

    const result = await prepareRelease({
      version: "10.18.0",
      rootDir: tmpRoot,
      allowDirty: true,
      dryRun: false,
      skipTests: true,
      execFileSyncFn: fn,
    });

    assert.equal(result.ok, true);
    const npmCalls = calls.filter((c) => c.command === "npm");
    // skipTests=true 일 때 npm test 는 skip, npm run lint + npm pack 만 호출
    assert.equal(npmCalls.length, 2);
    assert.deepEqual(npmCalls[0].args, ["run", "lint"]);
    assert.deepEqual(npmCalls[1].args, ["pack", "--dry-run"]);
    assert.ok(result.releaseNotesPath);
  });
});
