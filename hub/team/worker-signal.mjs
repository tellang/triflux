import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_POLL_MS = 1_000;
const FALLBACK_RENAME_CODES = new Set(["EACCES", "EEXIST", "EPERM"]);
const TERMINAL_TYPES = new Set(["done", "error"]);

function assertSignalDir(signalDir) {
  if (typeof signalDir !== "string" || !signalDir.trim()) {
    throw new Error("WorkerSignalChannel requires a non-empty signalDir");
  }
}

function assertShardId(shardId) {
  if (typeof shardId !== "string" || !shardId.trim()) {
    throw new Error("WorkerSignalChannel requires a non-empty shardId");
  }
  if (basename(shardId) !== shardId || shardId.includes("\\")) {
    throw new Error(`Invalid shardId for signal file: ${shardId}`);
  }
}

function objectValue(value, field) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

async function readText(filePath, fs) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function unlinkQuiet(filePath, fs) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function renameWithRollback(tempPath, targetPath, backupPath, fs) {
  try {
    await fs.rename(tempPath, targetPath);
    return;
  } catch (error) {
    if (!FALLBACK_RENAME_CODES.has(error?.code)) throw error;
  }

  let backup = false;
  try {
    await fs.rename(targetPath, backupPath);
    backup = true;
    await fs.rename(tempPath, targetPath);
  } catch (error) {
    if (backup) {
      try {
        await fs.rename(backupPath, targetPath);
        backup = false;
      } catch (rollbackError) {
        error.backupPath = backupPath;
        error.rollbackError = rollbackError;
      }
    } else if (error?.code === "ENOENT") {
      await fs.rename(tempPath, targetPath);
      return;
    }
    throw error;
  } finally {
    if (backup) await unlinkQuiet(backupPath, fs);
  }
}

/**
 * @param {string} filePath
 * @param {string} line
 * @param {{fs?: typeof import("node:fs/promises")}} [options]
 */
export async function appendSignalLineAtomic(filePath, line, options = {}) {
  const fs = options.fs ?? nodeFs;
  const dir = dirname(filePath);
  const suffix = `${process.pid}.${Date.now()}.${randomUUID()}`;
  const tempPath = join(dir, `.${basename(filePath)}.${suffix}.tmp`);
  const backupPath = join(dir, `.${basename(filePath)}.${suffix}.bak`);

  await fs.mkdir(dir, { recursive: true });
  const current = await readText(filePath, fs);

  try {
    await fs.writeFile(tempPath, `${current}${line}`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await renameWithRollback(tempPath, filePath, backupPath, fs);
  } finally {
    await unlinkQuiet(tempPath, fs);
  }
}

export class WorkerSignalChannel {
  #pendingWrite = Promise.resolve();

  constructor({
    shardId,
    signalDir,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    now,
  } = {}) {
    assertShardId(shardId);
    assertSignalDir(signalDir);
    this.shardId = shardId;
    this.signalDir = signalDir;
    this.timeoutMs = timeoutMs;
    this.now = now ?? Date.now;
    this.filePath = join(signalDir, `${shardId}.jsonl`);
  }

  start() {
    return this.#write({ type: "start", shardId: this.shardId });
  }

  heartbeat(meta = {}) {
    return this.#write({
      type: "heartbeat",
      shardId: this.shardId,
      meta: objectValue(meta, "meta"),
    });
  }

  done(payload) {
    return this.#write({
      type: "done",
      shardId: this.shardId,
      payload: objectValue(payload, "payload"),
    });
  }

  error(reason, meta = {}) {
    if (typeof reason !== "string" || !reason.trim()) {
      throw new Error("error reason must be a non-empty string");
    }
    return this.#write({
      type: "error",
      shardId: this.shardId,
      reason,
      meta: objectValue(meta, "meta"),
    });
  }

  async #write(signal) {
    const payload = { ...signal, ts: new Date(this.now()).toISOString() };
    const write = this.#pendingWrite.then(() =>
      appendSignalLineAtomic(this.filePath, `${JSON.stringify(payload)}\n`),
    );
    this.#pendingWrite = write.catch(() => {});
    return write;
  }

  static async listen({
    signalDir,
    onSignal,
    abortSignal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollMs = DEFAULT_POLL_MS,
    now = Date.now,
  } = {}) {
    assertSignalDir(signalDir);
    if (typeof onSignal !== "function") {
      throw new Error("WorkerSignalChannel.listen requires onSignal callback");
    }

    const state = {
      lineCounts: new Map(),
      lastLiveAt: new Map(),
      staleShards: new Set(),
      terminalShards: new Set(),
    };

    while (!abortSignal?.aborted) {
      await scanSignalDir(signalDir, state, onSignal);
      emitStaleSignals(state, timeoutMs, now, onSignal);
      if (abortSignal?.aborted) break;
      try {
        await delay(pollMs, undefined, { signal: abortSignal });
      } catch (error) {
        if (error?.name !== "AbortError") throw error;
      }
    }
  }
}

async function scanSignalDir(signalDir, state, onSignal) {
  let entries;
  try {
    entries = await nodeFs.readdir(signalDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => join(signalDir, entry.name))
    .sort();
  for (const filePath of files) await scanSignalFile(filePath, state, onSignal);
}

async function scanSignalFile(filePath, state, onSignal) {
  const raw = await readText(filePath, nodeFs);
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const previous = state.lineCounts.get(filePath) ?? 0;
  for (const line of lines.slice(previous > lines.length ? 0 : previous)) {
    const signal = JSON.parse(line);
    onSignal(signal);
    recordSignal(signal, state);
  }
  state.lineCounts.set(filePath, lines.length);
}

function recordSignal(signal, state) {
  if (!signal?.shardId || !signal?.ts) return;
  if (TERMINAL_TYPES.has(signal.type)) {
    state.terminalShards.add(signal.shardId);
    return;
  }
  if (signal.type === "start" || signal.type === "heartbeat") {
    const ts = Date.parse(signal.ts);
    if (Number.isFinite(ts)) {
      state.lastLiveAt.set(signal.shardId, ts);
      state.staleShards.delete(signal.shardId);
    }
  }
}

function emitStaleSignals(state, timeoutMs, now, onSignal) {
  const current = now();
  for (const [shardId, lastTs] of state.lastLiveAt.entries()) {
    if (
      state.terminalShards.has(shardId) ||
      state.staleShards.has(shardId) ||
      current - lastTs <= timeoutMs
    ) {
      continue;
    }
    state.staleShards.add(shardId);
    onSignal({
      type: "stale",
      shardId,
      ts: new Date(current).toISOString(),
      lastTs: new Date(lastTs).toISOString(),
      timeoutMs,
    });
  }
}
