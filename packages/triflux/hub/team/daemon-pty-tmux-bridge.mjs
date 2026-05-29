import { pathToFileURL } from "node:url";

import { createInteractiveTuiTransport } from "./interactive-tui-transport.mjs";

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
const SIGNAL_EXIT_CODES = new Map([
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
]);

export function encodeBridgeConfig(config) {
  return Buffer.from(JSON.stringify(config), "utf8").toString("base64");
}

export function parseBridgeConfig(argv = []) {
  const index = argv.indexOf("--config");
  if (index < 0 || !argv[index + 1]) {
    throw new Error("--config <base64-json> is required");
  }
  return JSON.parse(Buffer.from(argv[index + 1], "base64").toString("utf8"));
}

export async function runBridge({
  config,
  stdin,
  stdout,
  signals,
  createTransport = createInteractiveTuiTransport,
} = {}) {
  if (!config?.sessionName) throw new Error("config.sessionName is required");
  if (!stdin) throw new Error("stdin is required");
  if (!stdout) throw new Error("stdout is required");
  if (!signals) throw new Error("signals is required");

  const transport = createTransport({
    sessionName: config.sessionName,
    cwd: config.cwd,
    launchCmd: config.launchCmd,
    env: config.env || {},
    onData: (chunk) => stdout.write(chunk),
  });
  let shutdownPromise = null;

  const currentSize = () => ({
    cols: stdout.columns || config.cols || DEFAULT_COLS,
    rows: stdout.rows || config.rows || DEFAULT_ROWS,
  });

  const shutdown = async ({ exitCode, exitProcess = false } = {}) => {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        unregister();
        await transport.stop();
      })();
    }
    await shutdownPromise;
    if (exitProcess && typeof signals.exit === "function") {
      signals.exit(exitCode ?? 0);
    }
  };

  const writeInput = (chunk) => {
    void transport.writeInput(chunk).catch(() => {
      void shutdown({ exitCode: 1, exitProcess: true });
    });
  };
  const resize = () => {
    void transport.resize(currentSize()).catch(() => {
      void shutdown({ exitCode: 1, exitProcess: true });
    });
  };
  const stdinEnd = () => {
    void shutdown({ exitCode: 0, exitProcess: true });
  };
  const signalHandlers = new Map(
    [...SIGNAL_EXIT_CODES].map(([signal, exitCode]) => [
      signal,
      () => {
        void shutdown({ exitCode, exitProcess: true });
      },
    ]),
  );
  const uncaughtException = () => {
    void shutdown({ exitCode: 1, exitProcess: true });
  };
  const beforeExit = () => {
    void shutdown();
  };
  const exit = () => {
    void shutdown();
  };

  function unregister() {
    stdin.off?.("data", writeInput);
    stdin.off?.("end", stdinEnd);
    stdout.off?.("resize", resize);
    signals.off?.("uncaughtException", uncaughtException);
    signals.off?.("beforeExit", beforeExit);
    signals.off?.("exit", exit);
    for (const [signal, handler] of signalHandlers) {
      signals.off?.(signal, handler);
    }
  }

  stdin.on("data", writeInput);
  stdin.on("end", stdinEnd);
  stdout.on?.("resize", resize);
  signals.on?.("uncaughtException", uncaughtException);
  signals.on?.("beforeExit", beforeExit);
  signals.on?.("exit", exit);
  for (const [signal, handler] of signalHandlers) {
    signals.on?.(signal, handler);
  }

  try {
    await transport.start();
    await transport.resize(currentSize());
  } catch (error) {
    await shutdown().catch(() => {});
    throw error;
  }

  return { shutdown };
}

async function main() {
  const config = parseBridgeConfig(process.argv.slice(2));
  await runBridge({
    config,
    stdin: process.stdin,
    stdout: process.stdout,
    signals: process,
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}
