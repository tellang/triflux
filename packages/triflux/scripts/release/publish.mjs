#!/usr/bin/env node
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertVersionSync, parseArgs, ROOT, runCommand } from "./lib.mjs";

export async function publishRelease({
  version,
  rootDir = ROOT,
  channel = "stable",
  dryRun = true,
  createGithubRelease = true,
  execFileSyncFn,
} = {}) {
  const sync = assertVersionSync({ rootDir });
  if (!sync.ok) {
    throw new Error("Version sync failed. Refusing to publish.");
  }

  const releaseVersion = version || sync.rootVersion;
  const npmTag = channel === "canary" ? "canary" : "latest";
  const notesPath = join(
    rootDir,
    ".omx",
    "plans",
    `release-notes-v${releaseVersion}.md`,
  );
  const steps = [
    {
      label: "npm publish",
      command: "npm",
      args: ["publish", "--tag", npmTag],
    },
    { label: "git tag", command: "git", args: ["tag", `v${releaseVersion}`] },
    {
      label: "git push",
      command: "git",
      args: ["push", "origin", "HEAD", "--tags"],
    },
  ];

  if (createGithubRelease) {
    steps.push({
      label: "gh release create",
      command: "gh",
      args: [
        "release",
        "create",
        `v${releaseVersion}`,
        "--title",
        `v${releaseVersion}`,
        "--notes-file",
        notesPath,
      ],
    });
  }

  if (!dryRun) {
    for (const step of steps) {
      runCommand(step.command, step.args, { cwd: rootDir, execFileSyncFn });
    }
  }

  return {
    ok: true,
    version: releaseVersion,
    channel,
    npmTag,
    dryRun,
    notesPath,
    steps: steps.map((step) => ({
      label: step.label,
      command: [step.command, ...step.args].join(" "),
    })),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = parseArgs(process.argv.slice(2));
  const result = await publishRelease({
    version: args.version,
    rootDir: args.root,
    channel: args.channel || "stable",
    dryRun: !args.execute,
    createGithubRelease: !args["skip-gh-release"],
  });
  console.log(JSON.stringify(result, null, 2));
}
