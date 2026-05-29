#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createClaudeUdsEndpoint,
  createCodexExecEndpoint,
  runUdsOrchestration,
} from "../../hub/team/uds-orchestrator.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultReportPath = path.join(
  here,
  "uds-orchestration-latest-report.json",
);

function parseArgs(argv) {
  const flags = {
    mode: "all",
    codexBackend: "echo",
    report: defaultReportPath,
    task: "Validate Claude-Codex orchestration. Keep every answer under ten words.",
    timeoutMs: 90_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`Missing value for --${key}`);
    index += 1;
    if (key === "mode") flags.mode = value;
    else if (key === "codex-backend") flags.codexBackend = value;
    else if (key === "report") flags.report = value;
    else if (key === "task") flags.task = value;
    else if (key === "timeout") flags.timeoutMs = Number(value) * 1000;
    else throw new Error(`Unknown flag --${key}`);
  }
  return flags;
}

function usage() {
  return [
    "Usage:",
    "  claude-codex-uds-orchestration-smoke.mjs [--mode all|codex-led|claude-led|peer] [--codex-backend echo|exec] [--task TEXT] [--report PATH]",
    "",
    "Runs dev-only Claude<->Codex orchestration with Claude transported over UDS.",
  ].join("\n");
}

function createEchoCodexEndpoint() {
  let count = 0;
  return {
    name: "codex",
    async ask(prompt) {
      count += 1;
      return {
        endpoint: "codex",
        text: `CODEX_ECHO_${count}: ${String(prompt).split("\n")[0]}`,
        done: true,
      };
    },
  };
}

function buildCodexEndpoint(flags) {
  if (flags.codexBackend === "echo") return createEchoCodexEndpoint();
  if (flags.codexBackend === "exec") {
    return createCodexExecEndpoint({
      workdir: process.cwd(),
      timeout: 180_000,
    });
  }
  throw new Error("--codex-backend must be echo or exec");
}

function compactTurn(turn) {
  return {
    role: turn.role,
    endpoint: turn.endpoint,
    done: turn.done,
    text: String(turn.text || "").slice(0, 500),
    meta: turn.meta,
  };
}

async function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  if (flags.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const modes =
    flags.mode === "all" ? ["codex-led", "claude-led", "peer"] : [flags.mode];
  const report = {
    generatedAt: new Date().toISOString(),
    kind: "claude-codex-uds-orchestration-smoke",
    codexBackend: flags.codexBackend,
    task: flags.task,
    modes: [],
    verdict: "unknown",
  };

  try {
    for (const mode of modes) {
      const claude = createClaudeUdsEndpoint({ timeoutMs: flags.timeoutMs });
      const codex = buildCodexEndpoint(flags);
      const result = await runUdsOrchestration({
        mode,
        task: flags.task,
        claude,
        codex,
      });
      report.modes.push({
        mode,
        ok: result.turns.every((turn) => turn.done === true),
        final: compactTurn(result.final),
        turns: result.turns.map(compactTurn),
      });
    }
    report.verdict = report.modes.every((mode) => mode.ok)
      ? "all-modes-ok"
      : "mode-failed";
  } catch (error) {
    report.verdict = "error";
    report.error = error?.stack || error?.message || String(error);
  }

  await fs.writeFile(flags.report, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.verdict !== "all-modes-ok") process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}
