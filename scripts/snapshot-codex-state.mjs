#!/usr/bin/env node

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CODEX_STATE_EXCLUDES,
  CODEX_STATE_INCLUDES,
  STATE_SNAPSHOT_MAX_SNAPSHOTS,
  STATE_SNAPSHOT_THRESHOLD_MS,
  snapshotState,
} from "../hub/lib/state-snapshot.mjs";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export async function run() {
  return snapshotState({
    sourceDir: join(homedir(), ".codex"),
    destDir: join(PLUGIN_ROOT, "references", "codex-snapshots"),
    includes: CODEX_STATE_INCLUDES,
    excludes: CODEX_STATE_EXCLUDES,
    thresholdMs: STATE_SNAPSHOT_THRESHOLD_MS,
    maxSnapshots: STATE_SNAPSHOT_MAX_SNAPSHOTS,
  });
}

const isMain =
  process.argv[1] &&
  import.meta.url.endsWith(
    process.argv[1].replace(/\\/g, "/").split("/").pop(),
  );

if (isMain) {
  const result = await run();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
