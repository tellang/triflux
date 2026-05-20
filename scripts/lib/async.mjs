import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

function jobDir(jobsDir, jobId) {
  return join(jobsDir, jobId);
}

function readState(dir) {
  const path = join(dir, "state.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeState(dir, state) {
  writeFileSync(join(dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function isAlive(pid) {
  if (!pid || pid === "starting") return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

export function createJob({
  jobsDir,
  command,
  args = [],
  env = process.env,
  cwd = process.cwd(),
  timeoutMs = 0,
}) {
  mkdirSync(jobsDir, { recursive: true });
  const id = randomUUID();
  const dir = jobDir(jobsDir, id);
  mkdirSync(dir, { recursive: true });
  const startedAt = Date.now();
  const stdoutPath = join(dir, "result.log");
  const stderrPath = join(dir, "stderr.log");
  writeState(dir, {
    id,
    state: "starting",
    startedAt,
    command,
    args,
    timeoutMs,
  });
  writeFileSync(join(dir, "pid"), "starting");
  writeFileSync(join(dir, "start_time"), String(Math.floor(startedAt / 1000)));

  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.unref?.();
  writeFileSync(join(dir, "pid"), String(child.pid));
  writeState(dir, {
    id,
    state: "running",
    pid: child.pid,
    startedAt,
    command,
    args,
    timeoutMs,
  });
  child.stdout?.on("data", (chunk) => {
    writeFileSync(stdoutPath, chunk, { flag: "a" });
  });
  child.stderr?.on("data", (chunk) => {
    writeFileSync(stderrPath, chunk, { flag: "a" });
  });
  let timer = null;
  let timedOut = false;
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        // Process already exited.
      }
    }, timeoutMs);
    timer.unref?.();
  }
  child.on("exit", (code) => {
    if (timer) clearTimeout(timer);
    const exitCode = timedOut ? 124 : (code ?? 1);
    writeFileSync(join(dir, "exit_code"), String(exitCode));
    writeFileSync(join(dir, "done"), "");
    writeState(dir, {
      id,
      state: exitCode === 0 ? "done" : exitCode === 124 ? "timeout" : "failed",
      pid: child.pid,
      startedAt,
      finishedAt: Date.now(),
      exitCode,
      command,
      args,
      timeoutMs,
    });
  });

  return { id, dir, pid: child.pid };
}

export function getJobStatus(jobId, { jobsDir }) {
  const dir = jobDir(jobsDir, jobId);
  if (!existsSync(dir))
    return { state: "error", text: "error: job not found", exitCode: 1 };
  const state = readState(dir);
  if (state?.state === "done") return { ...state, text: "done" };
  if (state?.state === "timeout") return { ...state, text: "timeout" };
  if (state?.state === "failed") return { ...state, text: "failed" };
  const pidText = existsSync(join(dir, "pid"))
    ? readFileSync(join(dir, "pid"), "utf8").trim()
    : "";
  if (pidText === "starting")
    return { ...(state ?? {}), state: "starting", text: "starting" };
  if (isAlive(pidText)) {
    const start =
      Number(readFileSync(join(dir, "start_time"), "utf8")) ||
      Math.floor(Date.now() / 1000);
    const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - start);
    const bytes = fileSize(join(dir, "result.log"));
    return {
      ...(state ?? {}),
      state: "running",
      text: `running elapsed=${elapsed}s output=${bytes}B`,
    };
  }
  return { ...(state ?? {}), state: "failed", text: "failed" };
}

export function getJobResult(jobId, { jobsDir }) {
  const dir = jobDir(jobsDir, jobId);
  if (!existsSync(dir)) throw new Error("job not found");
  const status = getJobStatus(jobId, { jobsDir });
  if (!["done", "timeout", "failed"].includes(status.state)) {
    throw new Error("job still running");
  }
  const stdout = existsSync(join(dir, "result.log"))
    ? readFileSync(join(dir, "result.log"), "utf8")
    : "";
  const stderr = existsSync(join(dir, "stderr.log"))
    ? readFileSync(join(dir, "stderr.log"), "utf8")
    : "";
  return {
    state: status.state,
    exitCode: status.exitCode ?? 1,
    stdout: stdout || stderr,
    stderr,
  };
}
