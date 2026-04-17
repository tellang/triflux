#!/usr/bin/env node

import process from "node:process";

import { reloadBroker } from "../hub/account-broker.mjs";

function parseArgs(argv) {
  const args = { direction: "from-source" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--account") {
      args.account = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === "--direction") {
      args.direction = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === "--help" || token === "-h") {
      args.help = true;
    }
  }
  return args;
}

function printUsage() {
  console.log(
    "Usage: node scripts/sync-codex-auth.mjs --account <accountId> --direction from-source|to-source|both",
  );
}

function runDirection(currentBroker, accountId, direction) {
  if (direction === "from-source") {
    return currentBroker.syncAuthFromSource(accountId);
  }
  return currentBroker.syncAuthToSource(accountId);
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.account) {
  printUsage();
  process.exit(args.help ? 0 : 1);
}

if (!["from-source", "to-source", "both"].includes(args.direction)) {
  console.error(`Invalid --direction: ${args.direction}`);
  printUsage();
  process.exit(1);
}

const result = reloadBroker();
if (!result.ok || !result.broker) {
  console.error(result.error || "broker unavailable");
  process.exit(1);
}

const broker = result.broker;
const directions =
  args.direction === "both" ? ["from-source", "to-source"] : [args.direction];
const outcomes = directions.map((direction) =>
  runDirection(broker, args.account, direction),
);

console.log(JSON.stringify({ account: args.account, outcomes }, null, 2));
const failed = outcomes.some(
  (outcome) =>
    outcome && outcome.ok === false && outcome.reason !== "up_to_date",
);
process.exit(failed ? 1 : 0);
