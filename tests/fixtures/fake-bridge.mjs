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
const claimMode = process.env.FAKE_BRIDGE_CLAIM_MODE || "";

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

switch (cmd) {
  case "team-task-update":
    if (process.argv.includes("--claim") && claimMode) {
      const sameOwner = claimMode === "same-owner";
      console.log(
        JSON.stringify({
          ok: false,
          error: {
            code: "CLAIM_CONFLICT",
            message: "task claim 충돌",
            details: {
              task_before: {
                owner: sameOwner
                  ? argValue("--owner") || "worker"
                  : "other-worker",
                status: "in_progress",
              },
            },
          },
        }),
      );
      break;
    }
    console.log(
      JSON.stringify({
        ok: true,
        data: {
          claimed: process.argv.includes("--claim"),
          updated: true,
        },
      }),
    );
    break;
  case "team-send-message":
    console.log(
      JSON.stringify({
        ok: true,
        data: { message_id: "fake-message-id" },
      }),
    );
    break;
  case "result":
    console.log(
      JSON.stringify({
        ok: true,
        data: { message_id: "fake-result-id" },
      }),
    );
    break;
  default:
    console.log(JSON.stringify({ ok: true, data: {} }));
    break;
}
