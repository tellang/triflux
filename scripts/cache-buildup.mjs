#!/usr/bin/env node
// scripts/cache-buildup.mjs — legacy wrapper for cache-warmup

import { fileURLToPath } from "node:url";
import {
  buildAll,
  checkSearchEngines,
  extractProjectMeta,
  formatBuildSummary,
  probeTierEnvironment,
  scanCodexSkills,
} from "./cache-warmup.mjs";

export {
  buildAll,
  checkSearchEngines,
  extractProjectMeta,
  probeTierEnvironment,
  scanCodexSkills,
};

async function main() {
  const summary = buildAll({ force: process.argv.includes("--force") });
  console.log(formatBuildSummary(summary, { label: "cache-buildup" }));
  if (!summary.ok) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
