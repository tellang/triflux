#!/usr/bin/env node

import childProcess from "node:child_process";
import { parseArgs } from "node:util";

const SESSION_NAME = "triflux-demo";

const WORKERS = [
  {
    pane: 0,
    agent: "codex",
    messages: [
      "[codex] Analyzing auth module...",
      "[codex] Refactoring JWT validation...",
      "[codex] Done ✓",
    ],
  },
  {
    pane: 1,
    agent: "gemini",
    messages: [
      "[gemini] Reviewing UI components...",
      "[gemini] Optimizing render cycle...",
      "[gemini] Done ✓",
    ],
  },
  {
    pane: 2,
    agent: "claude",
    messages: [
      "[claude] Security audit in progress...",
      "[claude] Found 0 vulnerabilities",
      "[claude] Done ✓",
    ],
  },
];

export function checkPsmux(opts = {}) {
  if (opts.dryRun) return false;
  try {
    childProcess.execFileSync("psmux", ["-V"], {
      encoding: "utf8",
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

export function createDemoSession(sessionName, opts = {}) {
  if (opts.dryRun) {
    console.log(`[dry-run] psmux new-session -d -s ${sessionName}`);
    console.log(`[dry-run] psmux split-window -h -t ${sessionName}`);
    console.log(`[dry-run] psmux split-window -h -t ${sessionName}`);
    return;
  }
  childProcess.execFileSync("psmux", ["new-session", "-d", "-s", sessionName], {
    stdio: "pipe",
  });
  childProcess.execFileSync(
    "psmux",
    ["split-window", "-h", "-t", sessionName],
    { stdio: "pipe" },
  );
  childProcess.execFileSync(
    "psmux",
    ["split-window", "-h", "-t", sessionName],
    { stdio: "pipe" },
  );
}

export function simulateWorker(pane, agentName, messages, opts = {}) {
  const sessionName = opts.sessionName || SESSION_NAME;
  for (const msg of messages) {
    const escapedMsg = msg.replace(/'/g, "'\\''");
    if (opts.dryRun) {
      console.log(
        `[dry-run] psmux send-keys -t ${sessionName}:0.${pane} "echo '${escapedMsg}'" Enter`,
      );
    } else {
      childProcess.execFileSync(
        "psmux",
        [
          "send-keys",
          "-t",
          `${sessionName}:0.${pane}`,
          `echo '${escapedMsg}'`,
          "Enter",
        ],
        { stdio: "pipe" },
      );
    }
  }
}

export function showSummary() {
  const lines = [
    "",
    "=== triflux demo summary ===",
    "  codex  → JWT auth refactor    [done]",
    "  gemini → UI render optimize   [done]",
    "  claude → Security audit       [done]",
    "============================",
    "",
  ];
  for (const line of lines) {
    console.log(line);
  }
}

export function cleanup(sessionName, opts = {}) {
  if (opts.dryRun) {
    console.log(`[dry-run] psmux kill-session -t ${sessionName}`);
    return;
  }
  try {
    childProcess.execFileSync("psmux", ["kill-session", "-t", sessionName], {
      stdio: "pipe",
    });
  } catch {
    // session may already be gone
  }
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const { values: flags } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      keep: { type: "boolean", default: false },
    },
    strict: false,
  });

  const psmuxAvailable = checkPsmux({ dryRun: flags["dry-run"] });
  const dryRun = flags["dry-run"] || !psmuxAvailable;

  if (!psmuxAvailable && !flags["dry-run"]) {
    console.log("[demo] psmux not found — switching to dry-run mode");
  }

  const opts = {
    dryRun,
    keep: flags.keep,
    sessionName: SESSION_NAME,
  };

  createDemoSession(SESSION_NAME, opts);

  for (const { pane, agent, messages } of WORKERS) {
    simulateWorker(pane, agent, messages, opts);
  }

  if (!opts.dryRun) {
    await wait(2000);
  }

  showSummary();

  if (!opts.keep) {
    cleanup(SESSION_NAME, opts);
  }
}

// Only run main when executed directly (not imported as a module)
// Normalize both paths to forward-slash for cross-platform comparison
function isDirectExec() {
  if (!process.argv[1]) return false;
  const scriptPath = new URL(import.meta.url).pathname.replace(
    /^\/([A-Za-z]:)/,
    "$1",
  );
  const argv1 = process.argv[1].replace(/\\/g, "/");
  const norm = scriptPath.replace(/\\/g, "/");
  return argv1 === norm || argv1.endsWith(norm);
}

if (isDirectExec()) {
  main().catch((err) => {
    console.error("demo error:", err.message);
    process.exit(1);
  });
}
