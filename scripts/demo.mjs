#!/usr/bin/env node

import childProcess from "node:child_process";
import { parseArgs } from "node:util";

const { values: flags } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
  },
  strict: false,
});

const DRY_RUN = flags["dry-run"];
const KEEP_SESSION = flags.keep;
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

export function checkPsmux() {
  if (DRY_RUN) return false;
  try {
    childProcess.execFileSync("psmux", ["-V"], { encoding: "utf8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export function createDemoSession(sessionName) {
  if (DRY_RUN) {
    console.log(`[dry-run] psmux new-session -d -s ${sessionName}`);
    console.log(`[dry-run] psmux split-window -h -t ${sessionName}`);
    console.log(`[dry-run] psmux split-window -h -t ${sessionName}`);
    return;
  }
  childProcess.execFileSync("psmux", ["new-session", "-d", "-s", sessionName], { stdio: "pipe" });
  childProcess.execFileSync("psmux", ["split-window", "-h", "-t", sessionName], { stdio: "pipe" });
  childProcess.execFileSync("psmux", ["split-window", "-h", "-t", sessionName], { stdio: "pipe" });
}

export function simulateWorker(pane, agentName, messages) {
  for (const msg of messages) {
    if (DRY_RUN) {
      console.log(`[dry-run] psmux send-keys -t ${SESSION_NAME}:0.${pane} "echo '${msg}'" Enter`);
    } else {
      childProcess.execFileSync(
        "psmux",
        ["send-keys", "-t", `${SESSION_NAME}:0.${pane}`, `echo '${msg}'`, "Enter"],
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

export function cleanup(sessionName) {
  if (DRY_RUN) {
    console.log(`[dry-run] psmux kill-session -t ${sessionName}`);
    return;
  }
  try {
    childProcess.execFileSync("psmux", ["kill-session", "-t", sessionName], { stdio: "pipe" });
  } catch {
    // session may already be gone
  }
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const psmuxAvailable = checkPsmux();
  const effectiveDryRun = DRY_RUN || !psmuxAvailable;

  if (!psmuxAvailable && !DRY_RUN) {
    console.log("[demo] psmux not found — switching to dry-run mode");
  }

  if (effectiveDryRun && !DRY_RUN) {
    // Re-enter dry-run mode by setting module-level flag is not possible,
    // but we can call functions with the understanding they will check DRY_RUN.
    // Since DRY_RUN is module-level const, we log commands manually here.
    console.log(`[dry-run] psmux new-session -d -s ${SESSION_NAME}`);
    console.log(`[dry-run] psmux split-window -h -t ${SESSION_NAME}`);
    console.log(`[dry-run] psmux split-window -h -t ${SESSION_NAME}`);
    for (const { pane, messages } of WORKERS) {
      for (const msg of messages) {
        console.log(`[dry-run] psmux send-keys -t ${SESSION_NAME}:0.${pane} "echo '${msg}'" Enter`);
      }
    }
    showSummary();
    if (!KEEP_SESSION) {
      console.log(`[dry-run] psmux kill-session -t ${SESSION_NAME}`);
    }
    return;
  }

  createDemoSession(SESSION_NAME);

  for (const { pane, agentName, messages } of WORKERS) {
    simulateWorker(pane, agentName, messages);
  }

  await wait(2000);
  showSummary();

  if (!KEEP_SESSION) {
    cleanup(SESSION_NAME);
  }
}

// Only run main when executed directly (not imported as a module)
// Normalize both paths to forward-slash for cross-platform comparison
function isDirectExec() {
  if (!process.argv[1]) return false;
  const scriptPath = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
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
