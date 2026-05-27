#!/usr/bin/env node
import process from "node:process";

import { launchAdoptedInteractiveWorker } from "../../hub/team/interactive-native-launcher.mjs";

function parseArgs(argv) {
  const args = {
    cwd: process.cwd(),
    launch: "codex",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cwd") {
      args.cwd = argv[(index += 1)];
    } else if (arg === "--launch") {
      args.launch = argv[(index += 1)];
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const handle = await launchAdoptedInteractiveWorker({
  cwd: args.cwd,
  sessionName: `tfx-interactive-probe-${process.pid}`,
  launchCmd: args.launch,
  cli: args.launch.split(/\s+/)[0] || "codex",
  role: "interactive",
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  await handle.close().catch((error) => {
    process.stderr.write(
      `failed to close interactive worker: ${error.message}\n`,
    );
  });
  process.exit(signal === "SIGINT" || signal === "SIGTERM" ? 0 : 1);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

process.stdout.write(`row: ${handle.displayName}\n`);
process.stdout.write(`short: ${handle.short}\n`);
process.stdout.write(
  "claude agents에서 이 행에 attach해서 타이핑해보라. 종료하면 roster entry가 제거된다.\n",
);

await new Promise(() => {});
