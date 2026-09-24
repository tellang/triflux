#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isSemver, ROOT } from "./lib.mjs";

function compareStableVersions(left, right) {
  const a = left.split(".").map(BigInt);
  const b = right.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

export function resolveAutoRelease({
  eventName,
  version,
  channel,
  headSha,
  rootDir = ROOT,
  execFileSyncFn = execFileSync,
} = {}) {
  if (eventName === "workflow_dispatch") {
    return {
      release: true,
      version,
      channel,
      mode: "dispatch",
      npm_tag: channel === "canary" ? "canary" : "latest",
      sha: headSha,
    };
  }
  if (eventName !== "workflow_run" || !headSha) {
    throw new Error(
      "Automatic release requires workflow_run and its head SHA.",
    );
  }

  const git = (args) =>
    execFileSyncFn("git", args, { cwd: rootDir, encoding: "utf8" });
  const releaseVersion = JSON.parse(
    git(["show", `${headSha}:package.json`]),
  ).version;
  if (!isSemver(releaseVersion)) {
    throw new Error(`Invalid package.json version: ${releaseVersion}`);
  }
  const result = {
    release: false,
    version: releaseVersion,
    channel: "stable",
    mode: "auto",
    npm_tag: "latest",
    sha: headSha,
  };
  const parentVersion = JSON.parse(
    git(["show", `${headSha}^1:package.json`]),
  ).version;
  if (releaseVersion === parentVersion) {
    return {
      ...result,
      reason: "This commit did not change the package.json version.",
    };
  }
  // A remote snapshot avoids stale local tags and origin/main tracking refs.
  const refs = new Map(
    execFileSyncFn(
      "git",
      ["ls-remote", "--refs", "origin", "refs/heads/main", "refs/tags/v*"],
      { cwd: rootDir, encoding: "utf8" },
    )
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [sha, ref] = line.split(/\s+/);
        return [ref, sha];
      }),
  );
  if (refs.has(`refs/tags/v${releaseVersion}`)) {
    return { ...result, reason: `Already released: v${releaseVersion}.` };
  }
  const mainSha = refs.get("refs/heads/main");
  if (!mainSha) throw new Error("Cannot resolve origin/main from remote refs.");
  // main may have advanced after checkout; fetch the exact remote snapshot
  // before checking ancestry so a missing local object cannot look like a skip.
  git(["fetch", "--no-tags", "origin", mainSha]);
  try {
    git(["merge-base", "--is-ancestor", headSha, mainSha]);
  } catch (error) {
    if (error.status !== 1) throw error;
    return { ...result, reason: "CI head is not an ancestor of origin/main." };
  }
  if (releaseVersion.includes("-")) {
    return {
      ...result,
      reason: `Prerelease ${releaseVersion} requires manual dispatch.`,
    };
  }

  const stableVersions = [...refs.keys()]
    .map((ref) => /^refs\/tags\/v(\d+\.\d+\.\d+)$/.exec(ref)?.[1])
    .filter(Boolean)
    .sort(compareStableVersions);
  const latest = stableVersions.at(-1);
  if (latest && compareStableVersions(releaseVersion, latest) <= 0) {
    throw new Error(
      `Version ${releaseVersion} must be greater than latest stable tag v${latest}.`,
    );
  }
  return { ...result, release: true };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = resolveAutoRelease({
      eventName: process.env.GITHUB_EVENT_NAME,
      version: process.env.RELEASE_VERSION,
      channel: process.env.RELEASE_CHANNEL,
      headSha: process.env.RELEASE_HEAD_SHA,
    });
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        ["release", "version", "channel", "mode", "npm_tag", "sha"]
          .map((key) => `${key}=${result[key]}\n`)
          .join(""),
      );
    }
    if (!result.release) console.log(`::notice::${result.reason}`);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
