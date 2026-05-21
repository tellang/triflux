#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertVersionSync, parseArgs, ROOT } from "./lib.mjs";

const NPM_VERIFY_TARGETS = ["@triflux/core", "@triflux/remote", "triflux"];

function errorMessage(error) {
  const stderr = error?.stderr?.toString?.().trim();
  const stdout = error?.stdout?.toString?.().trim();
  return stderr || stdout || error?.message || "unknown error";
}

export async function verifyRelease({
  version,
  rootDir = ROOT,
  dryRun = true,
  execFileSyncFn = execFileSync,
} = {}) {
  const sync = assertVersionSync({ rootDir });
  if (!sync.ok) {
    throw new Error("Version sync failed. Fix metadata before verify.");
  }
  const releaseVersion = version || sync.rootVersion;
  const checks = [
    {
      name: "version-sync",
      ok: true,
      detail: `repo metadata matches ${releaseVersion}`,
    },
  ];

  if (!dryRun) {
    for (const packageName of NPM_VERIFY_TARGETS) {
      const packageSpec = `${packageName}@${releaseVersion}`;
      try {
        const npmVersion = execFileSyncFn(
          "npm",
          ["view", packageSpec, "version"],
          {
            cwd: rootDir,
            encoding: "utf8",
          },
        ).trim();
        checks.push({
          name: `npm-view ${packageName}`,
          ok: npmVersion === releaseVersion,
          detail:
            npmVersion === releaseVersion
              ? npmVersion
              : `expected ${releaseVersion}, got ${npmVersion}`,
        });
      } catch (error) {
        checks.push({
          name: `npm-view ${packageName}`,
          ok: false,
          detail: `npm view failed for ${packageSpec}: ${errorMessage(error)}`,
        });
      }
    }

    const ghRelease = execFileSyncFn(
      "gh",
      ["release", "view", `v${releaseVersion}`, "--json", "tagName"],
      {
        cwd: rootDir,
        encoding: "utf8",
      },
    ).trim();
    checks.push({
      name: "github-release",
      ok: ghRelease.length > 0,
      detail: ghRelease,
    });
  } else {
    checks.push(
      ...NPM_VERIFY_TARGETS.map((packageName) => ({
        name: `npm-view ${packageName}`,
        ok: null,
        detail: `would run: npm view ${packageName}@${releaseVersion} version`,
      })),
      {
        name: "github-release",
        ok: null,
        detail: `would run: gh release view v${releaseVersion} --json tagName`,
      },
    );
  }

  return {
    ok: checks.every((check) => check.ok !== false),
    version: releaseVersion,
    dryRun,
    checks,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = parseArgs(process.argv.slice(2));
  const result = await verifyRelease({
    version: args.version,
    rootDir: args.root,
    dryRun: !args.execute,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}
