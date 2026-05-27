import { startNativeWorkerFacade } from "./claude-native-bridge.mjs";
import { createInteractiveTuiTransport } from "./interactive-tui-transport.mjs";

// Output currently flows through capture-pane snapshots, so attach clients may
// receive whole-screen refreshes rather than byte-accurate terminal deltas.
export async function startInteractiveNativeWorker({
  short,
  rvSock,
  ptySock,
  sessionName,
  cwd,
  launchCmd,
  pid = process.pid,
  env = {},
  createTransport = createInteractiveTuiTransport,
} = {}) {
  let facade = null;
  let closePromise = null;

  const transport = createTransport({
    sessionName,
    cwd,
    launchCmd,
    env,
    onData(chunk) {
      if (facade) facade.writeOutput(chunk);
    },
  });

  async function close({ exitCode = 0, waitForPtyEnd = false } = {}) {
    if (!closePromise) {
      closePromise = (async () => {
        await transport.stop().catch(() => {});
        if (waitForPtyEnd) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (facade) await facade.close({ exitCode });
      })();
    }
    return closePromise;
  }

  try {
    facade = await startNativeWorkerFacade({
      short,
      rvSock,
      ptySock,
      pid,
      workerType: "interactive",
      onInput(payload) {
        void Promise.resolve()
          .then(() => transport.writeInput(payload))
          .catch(() => {
            void close({ exitCode: 1 }).catch(() => {});
          });
      },
      onKill() {
        void close({ waitForPtyEnd: true }).catch(() => {});
      },
    });
  } catch (error) {
    await transport.stop().catch(() => {});
    throw error;
  }

  try {
    await transport.start();
  } catch (error) {
    await close({ exitCode: 1 }).catch(() => {});
    throw error;
  }

  return {
    short,
    rvSock,
    ptySock,
    pid,
    close,
  };
}
