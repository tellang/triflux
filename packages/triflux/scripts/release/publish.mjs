#!/usr/bin/env node
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertVersionSync, parseArgs, ROOT, runCommand } from "./lib.mjs";

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForRemoteTag(
  tagName,
  {
    rootDir = ROOT,
    execFileSyncFn,
    attempts = 30,
    intervalMs = 2000,
    sleepFn = defaultSleep,
  } = {},
) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const out = runCommand(
        "git",
        ["ls-remote", "--tags", "origin", tagName],
        {
          cwd: rootDir,
          execFileSyncFn,
          stdio: "pipe",
        },
      );
      if (String(out).includes(`refs/tags/${tagName}`)) return true;
    } catch {
      // Transient network/auth blips are retried below.
    }
    if (attempt < attempts - 1) await sleepFn(intervalMs);
  }
  throw new Error(
    `Tag ${tagName} not visible on origin after ${attempts} attempts`,
  );
}

export async function publishRelease({
  version,
  rootDir = ROOT,
  channel = "stable",
  dryRun = true,
  createGithubRelease = true,
  publishNpm = true,
  provenance = false,
  allowExistingArtifacts = false,
  pushBranch = true,
  tagPoll = {},
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
    ...(publishNpm
      ? npmPublishTargets.map((target) => ({
          label: target.label,
          command: "npm",
          args: target.args,
          cwd: target.cwd,
          displayCwd: target.displayCwd,
        }))
      : []),
    { label: "git tag", command: "git", args: ["tag", `v${releaseVersion}`] },
  ];
  if (pushBranch) {
    steps.push({
      label: "git push branch",
      command: "git",
      args: ["push", "origin", "HEAD"],
    });
  }
  steps.push({
    label: "git push tag",
    command: "git",
    args: ["push", "origin", `v${releaseVersion}`],
  });

  if (createGithubRelease) {
    steps.push({
      label: "wait for tag",
      kind: "wait-tag",
      command: "git",
      args: ["ls-remote", "--tags", "origin", `v${releaseVersion}`],
    });
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

  const shouldSkipExistingTag = (tagName) => {
    if (!allowExistingArtifacts) return false;
    try {
      runCommand("git", ["rev-parse", "--verify", tagName], {
        cwd: rootDir,
        execFileSyncFn,
        stdio: "pipe",
      });
      return true;
    } catch {
      return false;
    }
  };

  const shouldSkipExistingGithubRelease = (tagName) => {
    if (!allowExistingArtifacts) return false;
    try {
      runCommand("gh", ["release", "view", tagName, "--json", "tagName"], {
        cwd: rootDir,
        execFileSyncFn,
        stdio: "pipe",
      });
      return true;
    } catch {
      return false;
    }
  };

  if (!dryRun) {
    if (!pushBranch) {
      const branch = process.env.GITHUB_REF_NAME || "main";
      runCommand("git", ["fetch", "origin", branch], {
        cwd: rootDir,
        execFileSyncFn,
      });
      const head = String(
        runCommand("git", ["rev-parse", "HEAD"], {
          cwd: rootDir,
          execFileSyncFn,
          stdio: "pipe",
        }),
      ).trim();
      const remote = String(
        runCommand("git", ["rev-parse", `origin/${branch}`], {
          cwd: rootDir,
          execFileSyncFn,
          stdio: "pipe",
        }),
      ).trim();
      if (head !== remote) {
        throw new Error(
          `Refusing tag-only publish: HEAD ${head} != origin/${branch} ${remote} (stale checkout or unpushed ${branch})`,
        );
      }
    }
    for (const step of steps) {
      const tagName = `v${releaseVersion}`;
      if (step.label === "git tag" && shouldSkipExistingTag(tagName)) {
        continue;
      }
      if (step.kind === "wait-tag") {
        await waitForRemoteTag(tagName, {
          rootDir,
          execFileSyncFn,
          ...tagPoll,
        });
        continue;
      }
      if (
        step.label === "gh release create" &&
        shouldSkipExistingGithubRelease(tagName)
      ) {
        continue;
      }
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
    publishNpm,
    provenance,
    allowExistingArtifacts,
    pushBranch,
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
    publishNpm: !args["skip-npm"],
    provenance: Boolean(args.provenance || envProvenance),
    allowExistingArtifacts: Boolean(args["allow-existing"]),
    pushBranch: !args["tag-only"],
  });
  console.log(JSON.stringify(result, null, 2));
}
