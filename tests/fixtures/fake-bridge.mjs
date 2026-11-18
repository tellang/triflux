#!/usr/bin/env node

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const logPath = process.env.FAKE_BRIDGE_LOG;
if (logPath) {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(
    logPath,
    `${JSON.stringify({ argv: process.argv.slice(2) })}\n`,
    "utf8",
  );
}

const cmd = process.argv[2];

switch (cmd) {
  default:
    console.log(JSON.stringify({ ok: true, data: {} }));
    break;
}
