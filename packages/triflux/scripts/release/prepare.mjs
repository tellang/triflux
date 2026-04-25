#!/usr/bin/env node
import { existsSync, rmSync, writeFileSync } from "node:fs";
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

export function cleanupStaleTestLock() {
  if (!existsSync(STALE_LOCK)) return;
  try {
    rmSync(STALE_LOCK, { force: true });
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
  cleanupStaleTestLock();
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
      command: "npm",
      args: ["test"],
      skip: skipTests,
      // Windows background execution can stall when `npm test` inherits the
      // parent's console handles through nested shell/spawn layers. Run the
      // heavy test step non-interactively and fail fast if it never returns.
      // maxBuffer raised explicitly: 1 MiB default is too small for piped
      // npm test --test-concurrency=8 verbose output. This is generic
      // robustness, NOT a fix for the prepare-only EXIT=1 mismatch the
      // 20260425-191243 checkpoint flagged — that root cause is in the
      // eval-store fixture's nested env, not in buffer sizing (verified:
      // direct `npm test` EXIT=0, prepare-bypassed prepare:execute still
      // returns EXIT=1 with this fix in place). Tracking that separately.
      options: {
        stdio: ["ignore", "pipe", "pipe"],
        timeoutMs: TEST_TIMEOUT_MS,
        maxBuffer: 128 * 1024 * 1024,
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
      runCommand(step.command, step.args, {
        cwd: rootDir,
        execFileSyncFn,
        ...step.options,
      });
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
