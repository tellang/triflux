import { spawn } from "node:child_process";

export function timeoutCodeForSignal(signal) {
  return signal ? 124 : null;
}

export function runWithTimeout(command, args = [], options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    input,
    timeoutMs = 0,
    stdio = "pipe",
    spawnFn = spawn,
  } = options;

  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let timedOut = false;
    const child = spawnFn(command, args, {
      cwd,
      env,
      stdio,
      signal: controller.signal,
    });
    const stdout = [];
    const stderr = [];
    let timer = null;

    if (child.stdout) child.stdout.on("data", (chunk) => stdout.push(chunk));
    if (child.stderr) child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (err) => {
      if (timedOut && err.name === "AbortError") return;
      reject(err);
    });
    child.on("exit", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: timedOut ? 124 : (code ?? timeoutCodeForSignal(signal) ?? 1),
        signal,
        timedOut,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        if (child.pid) {
          try {
            process.kill(child.pid, "SIGTERM");
          } catch {
            // Process already exited.
          }
        }
      }, timeoutMs);
      timer.unref?.();
    }

    if (input !== undefined && child.stdin) {
      child.stdin.end(input);
    }
  });
}
