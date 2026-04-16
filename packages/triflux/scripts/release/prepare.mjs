#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertVersionSync,
  buildReleaseNotes,
  ensureGitClean,
  parseArgs,
  ROOT,
  runCommand,
} from "./lib.mjs";

export async function prepareRelease({
  version,
  rootDir = ROOT,
  allowDirty = false,
  dryRun = true,
  execFileSyncFn,
} = {}) {
  const sync = assertVersionSync({ rootDir });
  if (!sync.ok) {
    throw new Error(
      "Version sync failed. Run scripts/release/check-sync.mjs first.",
    );
  }

  const gitState = ensureGitClean({ rootDir, execFileSyncFn });
  if (!gitState.clean && !allowDirty) {
    throw new Error(
      "Working tree is dirty. Re-run with --allow-dirty only for scaffolding.",
    );
  }

  const releaseVersion = version || sync.rootVersion;
  const commands = [
    ["npm", ["test"]],
    ["npm", ["run", "lint"]],
    ["npm", ["pack", "--dry-run"]],
  ];

  if (!dryRun) {
    for (const [command, args] of commands) {
      runCommand(command, args, { cwd: rootDir, execFileSyncFn });
    }
  }

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
    clean: gitState.clean,
    allowDirty,
    dryRun,
    commands: commands.map(([command, args]) => [command, ...args].join(" ")),
    releaseNotesPath: notesPath,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = parseArgs(process.argv.slice(2));
  const result = await prepareRelease({
    version: args.version,
    rootDir: args.root,
    allowDirty: Boolean(args["allow-dirty"]),
    dryRun: !args.execute,
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}
