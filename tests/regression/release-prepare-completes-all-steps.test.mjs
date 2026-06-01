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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { prepareRelease } from "../../scripts/release/prepare.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REAL_LOCK = join(REPO_ROOT, ".test-lock", "pid.lock");

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

  // F3 fix (PR fix/release-prepare-npm-bypass) 후 npm-test step 의 command 가
  // "npm" 에서 process.execPath ("node") 로 바뀌고 args 가 ["test"] 에서
  // ["scripts/test-lock.mjs", "--test", ...] 로 바뀐다. 본 테스트는 step sequence
  // completeness 보호가 목적이므로 command 종류와 무관하게 step 분류한다.
  function categorize(call) {
    const { command, args } = call;
    const arg0 = args[0] || "";
    // test step: 둘 다 허용 (legacy npm test 또는 F3 후 node test-lock.mjs)
    if (
      (command === "npm" && arg0 === "test") ||
      arg0.endsWith("test-lock.mjs")
    ) {
      return "test";
    }
    if (command === "npm" && arg0 === "run" && args[1] === "lint") {
      return "lint";
    }
    if (command === "npm" && arg0 === "pack") return "pack";
    if (command === "git") return "git";
    return "other";
  }

  // overrides: per-step override map { "test": (ctx) => string | throw, ... }
  // calls 는 항상 push 된다 (override 가 throw 하더라도 trace 는 보존)
  function makeMockExec(overrides = {}) {
    const calls = [];
    const fn = (command, args, opts) => {
      const call = { command, args: [...args] };
      calls.push(call);
      const step = categorize(call);

      if (overrides[step]) return overrides[step]({ command, args, opts });

      // git status --porcelain → clean working tree
      if (command === "git" && args[0] === "status") return "";
      // git describe --tags --abbrev=0 → previous tag
      if (command === "git" && args[0] === "describe") return "v10.17.0\n";
      // git log --oneline → some commits
      if (command === "git" && args[0] === "log") return "abc123 feat: test\n";
      // npm test/lint/pack 또는 node test-lock.mjs → success (empty stdout)
      return "";
    };
    return { fn, calls, categorize };
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

    // 정확히 3개 build step 호출: test, lint, pack
    const buildSteps = calls.map(categorize).filter((s) => s !== "git");
    assert.deepEqual(
      buildSteps,
      ["test", "lint", "pack"],
      `expected [test, lint, pack], got ${JSON.stringify(buildSteps)}: ${JSON.stringify(
        calls.map((c) => ({ command: c.command, args: c.args })),
      )}`,
    );

    // release-notes step 실행 검증 (releaseNotesPath 가 결과에 포함됨)
    assert.ok(result.releaseNotesPath, "releaseNotesPath should be set");
    assert.match(result.releaseNotesPath, /release-notes-v10\.18\.0\.md$/);
  });

  it("test step 이 빈 stdout 반환해도 (silent EXIT 0 시뮬레이션) 후속 step 호출", async () => {
    // 회귀 시나리오: npm test 가 53ms 안에 EXIT 0 + 빈 stdout 반환
    // 이 경우에도 prepare.mjs 의 for-loop 가 다음 step 으로 진행해야 한다.
    const { fn, calls } = makeMockExec({
      test: () => "", // silent EXIT 0
    });

    const result = await prepareRelease({
      version: "10.18.0",
      rootDir: tmpRoot,
      allowDirty: true,
      dryRun: false,
      execFileSyncFn: fn,
    });

    assert.equal(result.ok, true);
    const buildSteps = calls.map(categorize).filter((s) => s !== "git");
    // 회귀 가드 핵심: 3개 모두 호출됐는지 (lint/pack 단락 회귀 즉시 catch)
    assert.deepEqual(
      buildSteps,
      ["test", "lint", "pack"],
      "test step silent EXIT 0 후에도 lint/pack 호출되어야 함",
    );
  });

  it("test step 이 throw 시 후속 step 호출 안 됨 (정상 단락 동작)", async () => {
    const { fn, calls } = makeMockExec({
      test: () => {
        const err = new Error("test step failed");
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
      /test step failed/,
    );

    // 단락 검증: test 만 호출됐고, lint/pack 은 호출 안 됨
    const buildSteps = calls.map(categorize).filter((s) => s !== "git");
    assert.deepEqual(
      buildSteps,
      ["test"],
      "test step fail 시 lint/pack 은 호출되지 않아야 함 (단락)",
    );
  });

  it("skipTests=true 시 test step 만 skip, lint/pack/release-notes 정상 실행", async () => {
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
    const buildSteps = calls.map(categorize).filter((s) => s !== "git");
    // skipTests=true 일 때 test 는 skip, lint + pack 만 호출
    assert.deepEqual(buildSteps, ["lint", "pack"]);
    assert.ok(result.releaseNotesPath);
  });

  it("CI fresh checkout 처럼 .omx/plans 가 없어도 release-notes 디렉터리를 생성", async () => {
    const tmpRootNoOmx = mkdtempSync(join(tmpdir(), "tfx-prepare-no-omx-"));
    try {
      const manifest = {
        canonicalFile: "package.json",
        canonicalPath: ["version"],
        targets: [{ file: "package.json", paths: [["version"]] }],
      };

      mkdirSync(join(tmpRootNoOmx, "scripts", "release"), {
        recursive: true,
      });
      writeFileSync(
        join(tmpRootNoOmx, "scripts", "release", "version-manifest.json"),
        JSON.stringify(manifest, null, 2),
      );
      writeFileSync(
        join(tmpRootNoOmx, "package.json"),
        JSON.stringify({ name: "test", version: "10.25.1" }, null, 2),
      );

      const { fn } = makeMockExec();
      const result = await prepareRelease({
        version: "10.25.1",
        rootDir: tmpRootNoOmx,
        allowDirty: true,
        dryRun: false,
        skipTests: true,
        execFileSyncFn: fn,
      });

      assert.equal(result.ok, true);
      assert.equal(
        existsSync(
          join(tmpRootNoOmx, ".omx", "plans", "release-notes-v10.25.1.md"),
        ),
        true,
      );
    } finally {
      rmSync(tmpRootNoOmx, { recursive: true, force: true });
    }
  });

  it("preflight cleanup은 rootDir의 .test-lock만 제거한다 (실제 repo 락 무접촉)", async () => {
    // 회귀 가드: prepareRelease 의 preflight cleanupStaleTestLock 이 모듈 상수
    // 대신 rootDir 기준 락을 지워야 한다. 안 그러면 npm test 중 살아있는 repo
    // 루트 .test-lock/pid.lock (test-lock.mjs 래퍼 소유) 을 삭제해 싱글톤
    // 가드를 무력화한다.
    const tmpLockDir = join(tmpRoot, ".test-lock");
    const tmpLock = join(tmpLockDir, "pid.lock");
    mkdirSync(tmpLockDir, { recursive: true });
    writeFileSync(tmpLock, "99999\n");

    // 실제 repo 락은 절대 건드리지 않는다 — 존재 여부만 캡처해 불변 검증.
    const realBefore = existsSync(REAL_LOCK);

    const { fn } = makeMockExec();
    const result = await prepareRelease({
      version: "10.18.0",
      rootDir: tmpRoot,
      allowDirty: true,
      dryRun: false,
      skipTests: true,
      execFileSyncFn: fn,
    });

    assert.equal(result.ok, true);
    // rootDir 기준 락은 preflight 가 제거한다 (버그면 모듈 상수만 지워 tmpLock 잔존).
    assert.equal(
      existsSync(tmpLock),
      false,
      "rootDir .test-lock should be cleaned",
    );
    // 실제 repo 락은 불변 (버그면 삭제되어 realBefore 와 달라진다).
    assert.equal(
      existsSync(REAL_LOCK),
      realBefore,
      "real repo lock must be untouched",
    );
  });
});
