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
  provenance = false,
  execFileSyncFn,
} = {}) {
  const sync = assertVersionSync({ rootDir });
  if (!sync.ok) {
    throw new Error("Version sync failed. Refusing to publish.");
  }

  const releaseVersion = version || sync.rootVersion;
  const npmTag = channel === "canary" ? "canary" : "latest";
  const provenanceArgs = provenance ? ["--provenance"] : [];
  const npmPublishTargets = [
    {
      label: "npm publish @triflux/core",
      cwd: join(rootDir, "packages", "core"),
      displayCwd: "packages/core",
      args: [
        "publish",
        "--tag",
        npmTag,
        ...provenanceArgs,
        "--access",
        "public",
      ],
    },
    {
      label: "npm publish @triflux/remote",
      cwd: join(rootDir, "packages", "remote"),
      displayCwd: "packages/remote",
      args: [
        "publish",
        "--tag",
        npmTag,
        ...provenanceArgs,
        "--access",
        "public",
      ],
    },
    {
      label: "npm publish triflux",
      cwd: join(rootDir, "packages", "triflux"),
      displayCwd: "packages/triflux",
      args: ["publish", "--tag", npmTag, ...provenanceArgs],
    },
  ];
  const notesPath = join(
    rootDir,
    ".omx",
    "plans",
    `release-notes-v${releaseVersion}.md`,
  );
  const steps = [
    ...npmPublishTargets.map((target) => ({
      label: target.label,
      command: "npm",
      args: target.args,
      cwd: target.cwd,
      displayCwd: target.displayCwd,
    })),
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
      runCommand(step.command, step.args, {
        cwd: step.cwd || rootDir,
        execFileSyncFn,
      });
    }
  }

  return {
    ok: true,
    version: releaseVersion,
    channel,
    npmTag,
    provenance,
    dryRun,
    notesPath,
    steps: steps.map((step) => ({
      label: step.label,
      command: step.displayCwd
        ? `(cd ${step.displayCwd} && ${[step.command, ...step.args].join(" ")})`
        : [step.command, ...step.args].join(" "),
    })),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = parseArgs(process.argv.slice(2));
  const envProvenance =
    String(process.env.NPM_CONFIG_PROVENANCE || "").toLowerCase() === "true";
  const result = await publishRelease({
    version: args.version,
    rootDir: args.root,
    channel: args.channel || "stable",
    dryRun: !args.execute,
    createGithubRelease: !args["skip-gh-release"],
    provenance: Boolean(args.provenance || envProvenance),
  });
  console.log(JSON.stringify(result, null, 2));
}
