#!/usr/bin/env node
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertVersionSync,
  isSemver,
  parseArgs,
  ROOT,
  readJson,
  syncVersionTargets,
  writeJson,
} from "./lib.mjs";

export async function bumpVersion({
  nextVersion,
  rootDir = ROOT,
  write = false,
} = {}) {
  if (!isSemver(nextVersion)) {
    throw new Error(`Invalid semver version: ${nextVersion}`);
  }

  const packagePath = join(rootDir, "package.json");
  const packageJson = readJson(packagePath);
  const previousVersion = packageJson.version;
  packageJson.version = nextVersion;

  if (write) {
    writeJson(packagePath, packageJson);
    const syncedFiles = syncVersionTargets({
      rootDir,
      expectedVersion: nextVersion,
    });
    const post = assertVersionSync({ rootDir, expectedVersion: nextVersion });
    return {
      ok: post.ok,
      previousVersion,
      nextVersion,
      updatedFiles: ["package.json", ...syncedFiles],
      targets: post.targets,
    };
  }

  const preview = assertVersionSync({
    rootDir,
    expectedVersion: nextVersion,
  });
  return {
    ok: true,
    previousVersion,
    nextVersion,
    updatedFiles: ["package.json"],
    targets: preview.targets.map((target) => ({
      ...target,
      expected: nextVersion,
      inSync: target.file === "package.json",
    })),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = parseArgs(process.argv.slice(2));
  const nextVersion = args.next || args.version;
  const result = await bumpVersion({
    nextVersion,
    rootDir: args.root,
    write: Boolean(args.write),
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `${args.write ? "Bumped" : "Planned"} version ${result.previousVersion} -> ${result.nextVersion}`,
    );
    console.log(`Updated files: ${result.updatedFiles.join(", ")}`);
  }
}
