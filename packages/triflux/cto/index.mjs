const SUBCOMMANDS = ["collect", "status", "dashboard", "hygiene", "event"];

function printUsage(subcommand) {
  if (subcommand) {
    console.log(`Unknown cto subcommand: ${subcommand}`);
  }
  console.log(`
Usage
  tfx cto <collect|status|dashboard|hygiene|event> [options]

Subcommands
  collect     Refresh .triflux/lake/current.json from repo-local authority sources
  status      Print the current authority summary
  dashboard   Render the CTO console dashboard, optionally with --watch
  hygiene     Project CTO hygiene counts and actionable dry-run rows
  event       Append normalized wrapper lifecycle events to the CTO ledger
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
    case "dashboard": {
      const { runDashboard } = await import("./dashboard.mjs");
      return runDashboard(rest, opts);
    }
    case "hygiene": {
      const { runHygiene } = await import("./hygiene.mjs");
      return runHygiene(rest, opts);
    }
    case "event": {
      const { runEvent } = await import("./events.mjs");
      return runEvent(rest, opts);
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

export { SUBCOMMANDS };
