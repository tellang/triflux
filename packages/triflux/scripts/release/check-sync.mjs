#!/usr/bin/env node
import { fileURLToPath } from "node:url";

import { assertVersionSync, formatPathSegments, parseArgs } from "./lib.mjs";

export { assertVersionSync } from "./lib.mjs";

function toJson(result) {
  return {
    ok: result.ok,
    rootVersion: result.rootVersion,
    fixedFiles: result.fixedFiles,
    mismatches: result.mismatches.map((target) => ({
      file: target.file,
      path: formatPathSegments(target.path),
      found: target.found ?? null,
      expected: target.expected,
      missing: target.missing,
    })),
  };
}

function printHuman(result) {
  if (result.ok) {
    console.log(`Version sync OK (${result.rootVersion})`);
    return;
  }
  console.log(`Version sync mismatch (${result.rootVersion})`);
  for (const target of result.mismatches) {
    console.log(
      `- ${target.file} :: ${formatPathSegments(target.path)} => found=${target.found ?? "missing"}, expected=${target.expected}`,
    );
  }
  if (result.fixedFiles.length) {
    console.log(`Fixed files: ${result.fixedFiles.join(", ")}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = parseArgs(process.argv.slice(2));
  const result = assertVersionSync({
    rootDir: args.root,
    fix: Boolean(args.fix),
  });
  if (args.json) {
    console.log(JSON.stringify(toJson(result), null, 2));
  } else {
    printHuman(result);
  }
  process.exitCode = result.ok ? 0 : 1;
}
