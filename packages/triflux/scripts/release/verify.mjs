#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertVersionSync, parseArgs, ROOT } from "./lib.mjs";

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
    const npmVersion = execFileSyncFn("npm", ["view", "triflux", "version"], {
      cwd: rootDir,
      encoding: "utf8",
    }).trim();
    checks.push({
      name: "npm-view",
      ok: npmVersion === releaseVersion,
      detail: npmVersion,
    });

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
      {
        name: "npm-view",
        ok: null,
        detail: `would run: npm view triflux version`,
      },
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
