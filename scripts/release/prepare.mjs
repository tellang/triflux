#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertVersionSync,
  buildReleaseNotes,
  ensureGitClean,
  getPreviousTag,
  parseArgs,
  ROOT,
  runCommand,
} from "./lib.mjs";

const TEST_TIMEOUT_MS = 10 * 60 * 1000;
const STALE_LOCK = join(ROOT, ".test-lock", "pid.lock");

export function cleanupStaleTestLock(lockPath = STALE_LOCK) {
  if (!existsSync(lockPath)) return;
  try {
    rmSync(lockPath, { force: true });
    console.log("[prepare] cleaned stale .test-lock/pid.lock");
  } catch (e) {
    console.warn(`[prepare] failed to clean test-lock: ${e.message}`);
  }
}

function createStepLogger() {
  const startedAt = Date.now();
  return function logStep(step) {
    const elapsedMs = Date.now() - startedAt;
    console.error(`[prepare] step=${step} t=${elapsedMs}ms`);
  };
}

export async function prepareRelease({
  version,
  rootDir = ROOT,
  allowDirty = false,
  dryRun = true,
  skipTests = false,
  execFileSyncFn,
} = {}) {
  // Derive the preflight lock from rootDir so tests that pass a temp rootDir
  // never delete the live repo-root .test-lock/pid.lock owned by the running
  // test-lock.mjs wrapper. Production (rootDir = ROOT) is unchanged.
  cleanupStaleTestLock(join(rootDir, ".test-lock", "pid.lock"));
  const logStep = createStepLogger();
  logStep("version-sync");
  const sync = assertVersionSync({ rootDir });
  if (!sync.ok) {
    throw new Error(
      "Version sync failed. Run scripts/release/check-sync.mjs first.",
    );
  }

  logStep("git-clean");
  const gitState = ensureGitClean({ rootDir, execFileSyncFn });
  if (!gitState.clean && !allowDirty) {
    throw new Error(
      "Working tree is dirty. Re-run with --allow-dirty only for scaffolding.",
    );
  }

  const releaseVersion = version || sync.rootVersion;
  const previousTag = getPreviousTag({ rootDir, execFileSyncFn });
  const steps = [
    {
      name: "npm-test",
      // F3 fix (issue #192 — silent EXIT 0 회귀 우회):
      // npm wrapper 경유 시 prepare.mjs process 가 native level 에서 hard kill
      // 됨 (process.on("exit") 핸들러 호출 안 됨, EXIT 0 silent, 후속 lint/pack
      // step 누락). 2026-04-30 진단 세션에서 5 시나리오 reproduce 결과:
      //   - npm wrapper 경유 + npm test 실행: silent EXIT 0 재현 (12-24s 비결정)
      //   - 직접 node 실행 또는 npm test 단독: 정상 진행
      //   - --skip-tests 우회: 정상 unhandled rejection (lint fail visible)
      // 따라서 npm wrapper 한 단계 줄여 trigger 약화 (cmd.exe shim → npm-cli.js
      // → spawn 3 layers 제거). package.json `scripts.test` 와 sync 유지 필수.
      command: process.execPath,
      args: [
        "scripts/test-lock.mjs",
        "--test",
        "--test-force-exit",
        "--test-concurrency=8",
        "tests/**/*.test.mjs",
        "scripts/__tests__/**/*.test.mjs",
      ],
      skip: skipTests,
      // Stream test output directly so GitHub Actions preserves the failing
      // test name and assertion details instead of truncating a captured
      // execFileSync error object.
      options: {
        stdio: ["ignore", "inherit", "inherit"],
        timeoutMs: TEST_TIMEOUT_MS,
        shell: false,
      },
    },
    {
      name: "npm-lint",
      command: "npm",
      args: ["run", "lint"],
    },
    {
      name: "npm-pack-dry-run",
      command: "npm",
      args: ["pack", "--dry-run"],
    },
  ];

  if (!dryRun) {
    for (const step of steps) {
      if (step.skip) {
        logStep(`${step.name}:skipped`);
        continue;
      }
      logStep(step.name);
      try {
        runCommand(step.command, step.args, {
          cwd: rootDir,
          execFileSyncFn,
          ...step.options,
        });
      } catch (error) {
        const exitCode = Number.isInteger(error?.status)
          ? error.status
          : "unknown";
        const signal = error?.signal ? `, signal=${error.signal}` : "";
        const timeout =
          error?.code === "ETIMEDOUT"
            ? `, timeout after ${step.options?.timeoutMs ?? "unknown"}ms`
            : "";
        throw new Error(
          `[prepare] step=${step.name} failed (exit code=${exitCode}${signal}${timeout})`,
          { cause: error },
        );
      }
    }
  } else {
    for (const step of steps) {
      logStep(step.skip ? `${step.name}:skipped` : `${step.name}:planned`);
    }
  }

  logStep("release-notes");
  const notes = buildReleaseNotes({
    version: releaseVersion,
    rootDir,
    execFileSyncFn,
  });
  const notesPath = join(
    rootDir,
    ".omx",
    "plans",
    `release-notes-v${releaseVersion}.md`,
  );
  mkdirSync(join(rootDir, ".omx", "plans"), { recursive: true });
  writeFileSync(notesPath, notes, "utf8");

  return {
    ok: true,
    version: releaseVersion,
    previousTag,
    clean: gitState.clean,
    allowDirty,
    dryRun,
    skipTests,
    steps: steps.map((step) => ({
      name: step.name,
      command: [step.command, ...step.args].join(" "),
      skipped: Boolean(step.skip),
      timeoutMs: step.options?.timeoutMs ?? null,
    })),
    commands: steps
      .filter((step) => !step.skip)
      .map((step) => [step.command, ...step.args].join(" ")),
    releaseNotesPath: notesPath,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = parseArgs(process.argv.slice(2));
  const result = await prepareRelease({
    version: args.version,
    rootDir: args.root,
    allowDirty: Boolean(args["allow-dirty"]),
    skipTests: Boolean(args["skip-tests"]),
    dryRun: !args.execute,
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}
