#!/usr/bin/env node

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CLAUDE_WORKER_CANDIDATES = [
  resolve(SCRIPT_DIR, "../hub/workers/claude-worker.mjs"),
  resolve(SCRIPT_DIR, "./hub/workers/claude-worker.mjs"),
  resolve(process.cwd(), "hub/workers/claude-worker.mjs"),
];

const WORKER_UNAVAILABLE_EXIT_CODE = 70;

let ClaudeWorker = null;

for (const candidate of CLAUDE_WORKER_CANDIDATES) {
  if (!existsSync(candidate)) continue;
  try {
    ({ ClaudeWorker } = await import(pathToFileURL(candidate).href));
  } catch (err) {
    if (err.code === "ERR_MODULE_NOT_FOUND") {
      process.stderr.write(
        `[tfx-route-worker] 모듈 로드 실패: ${err.message}\n`,
      );
      process.exit(WORKER_UNAVAILABLE_EXIT_CODE);
    }
    throw err;
  }
  break;
}

if (!ClaudeWorker) {
  process.stderr.write(
    "[tfx-route-worker] claude-worker.mjs를 찾지 못했습니다.\n",
  );
  process.exit(WORKER_UNAVAILABLE_EXIT_CODE);
}

function parseArgs(argv) {
  const args = {
    extraArgs: [],
    mcpConfig: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];

    switch (token) {
      case "--type":
        args.type = next;
        index += 1;
        break;
      case "--command":
        args.command = next;
        index += 1;
        break;
      case "--command-args-json":
        args.commandArgsJson = next;
        index += 1;
        break;
      case "--model":
        args.model = next;
        index += 1;
        break;
      case "--effort":
        args.effort = next;
        index += 1;
        break;
      case "--timeout-ms":
        args.timeoutMs = Number(next);
        index += 1;
        break;
      case "--stall-ms":
        args.stallMs = Number(next);
        index += 1;
        break;
      case "--permission-mode":
        args.permissionMode = next;
        index += 1;
        break;
      case "--allow-dangerously-skip-permissions":
        args.allowDangerouslySkipPermissions = true;
        break;
      case "--extra-arg":
        args.extraArgs.push(next);
        index += 1;
        break;
      case "--mcp-config":
        args.mcpConfig.push(next);
        index += 1;
        break;
      case "--cwd":
        args.cwd = next;
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  if (!args.type) {
    throw new Error("--type is required");
  }
  if (args.type !== "claude") {
    throw new Error(`Unknown worker type: ${args.type}`);
  }

  return args;
}

function parseJsonArray(raw, label) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON array`);
    }
    return parsed.map((item) => String(item));
  } catch (error) {
    throw new Error(`${label} parse failed: ${error.message}`);
  }
}

async function readPromptFromStdin() {
  // Stream-based async read avoids EAGAIN race on Node v25 + background pipe stdin.
  // readFileSync(0, "utf8") raised EAGAIN when stdin pipe was non-blocking and
  // data hadn't fully arrived (Node v25 timing change vs v22), causing the
  // tfx-route.sh wrapper to fall back to claude-native silently.
  if (process.stdin.isTTY) return "";
  process.stdin.setEncoding("utf8");
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}

const args = parseArgs(process.argv.slice(2));
const prompt = await readPromptFromStdin();

const worker = new ClaudeWorker({
  command: args.command,
  commandArgs: parseJsonArray(args.commandArgsJson, "--command-args-json"),
  model: args.model,
  effort: args.effort,
  timeoutMs: args.timeoutMs,
  stallMs: args.stallMs,
  permissionMode: args.permissionMode,
  allowDangerouslySkipPermissions: args.allowDangerouslySkipPermissions,
  extraArgs: args.extraArgs,
  mcpConfig: args.mcpConfig,
  cwd: args.cwd || process.cwd(),
});

try {
  const result = await worker.run(prompt);
  if (result.response) {
    process.stdout.write(result.response);
    if (!result.response.endsWith("\n")) process.stdout.write("\n");
  }
} catch (error) {
  process.stderr.write(`[tfx-route-worker] ${error.message}\n`);

  if (error.stderr) {
    process.stderr.write(String(error.stderr));
    if (!String(error.stderr).endsWith("\n")) process.stderr.write("\n");
  }

  // stderr 가 비어 있으면 조용한 실패 원인을 추적하도록 result 진단 정보를 출력한다.
  if (!error.stderr && error.result) {
    const r = error.result;
    const diag = [
      `[tfx-route-worker] diagnostics: exitCode=${r.exitCode ?? "null"} signal=${r.exitSignal ?? "none"} timedOut=${r.timedOut ?? false}`,
      r.events?.length
        ? `[tfx-route-worker] events(${r.events.length}): ${JSON.stringify(r.events.slice(-3))}`
        : "[tfx-route-worker] events: none",
      r.stdout
        ? `[tfx-route-worker] child stdout(${r.stdout.length}B): ${r.stdout.slice(0, 512)}`
        : "[tfx-route-worker] child stdout: empty",
    ];
    process.stderr.write(diag.join("\n") + "\n");
  }

  process.exitCode = error.code === "ETIMEDOUT" ? 124 : 1;
} finally {
  try {
    await worker.stop();
  } catch {}
}
