#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { sanitizeCodexProfileConfigFile } from "./lib/codex-profile-config.mjs";

function parseArgs(argv) {
  const result = { quiet: false, json: false };
  for (const arg of argv) {
    if (arg === "--quiet") result.quiet = true;
    else if (arg === "--json") result.json = true;
    else if (!result.configPath) result.configPath = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  result.configPath ||= process.env.TFX_CODEX_CONFIG;
  if (!result.configPath) {
    throw new Error(
      "usage: codex-profile-sanitize.mjs <config.toml> [--quiet|--json]",
    );
  }
  result.configPath = resolve(result.configPath);
  return result;
}

try {
  const opts = parseArgs(process.argv.slice(2));
  const result = sanitizeCodexProfileConfigFile(opts.configPath, {
    codexHome: dirname(opts.configPath),
  });
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (result.changed && !opts.quiet) {
    process.stderr.write(
      `[codex-profile-sanitize] removed legacy inline profiles: ${result.removedProfiles.join(", ") || "<none>"}\n`,
    );
  }
} catch (error) {
  process.stderr.write(`[codex-profile-sanitize] ${error.message}\n`);
  process.exit(1);
}
