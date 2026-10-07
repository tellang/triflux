import { fileURLToPath } from "node:url";

function printUsage(subcommand) {
  if (subcommand) {
    console.log(`Unknown cto subcommand: ${subcommand}`);
  }
  console.log(`
Usage
  tfx cto <collect|status|hygiene> [options]

Subcommands
  collect     Refresh .triflux/lake/current.json from repo-local authority sources
  status      Print the current authority summary
  hygiene     Project CTO hygiene counts and actionable dry-run rows
`);
}

export async function cmdCto(cmdArgs, opts = {}) {
  const [subcommand, ...rest] = cmdArgs;

  switch (subcommand) {
    case "collect": {
      const { runCollect } = await import("./collect.mjs");
      return runCollect(rest, opts);
    }
    case "status": {
      const { runStatus } = await import("./status.mjs");
      return runStatus(rest, opts);
    }
    case "hygiene": {
      const { runHygiene } = await import("./hygiene.mjs");
      return runHygiene(rest, opts);
    }
    case undefined:
    case "":
      printUsage();
      return undefined;
    default:
      printUsage(subcommand);
      return undefined;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await cmdCto(process.argv.slice(2));
}
