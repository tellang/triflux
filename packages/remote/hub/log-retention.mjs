import { once } from "node:events";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createGzip } from "node:zlib";

import { isCtoRetentionEnabled } from "@triflux/core/hub/lib/cto-env.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;
const DEFAULT_TAIL_READ_BYTES = 2 * MB;

export const LOG_RETENTION_DEFAULTS = Object.freeze({
  ledger: Object.freeze({
    maxBytes: 50 * MB,
    maxAgeMs: 30 * DAY_MS,
    tailBytes: 10 * MB,
    tailAgeMs: 14 * DAY_MS,
  }),
  swarm: Object.freeze({
    maxBytes: 25 * MB,
    maxAgeMs: 14 * DAY_MS,
    activeMtimeGraceMs: 15 * 60 * 1000,
  }),
  batch: Object.freeze({
    rotateAfterLines: 200,
    keepLines: 100,
  }),
});

function timestampForPath(now = new Date()) {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/u, "");
}

function archiveDay(now = new Date()) {
  return timestampForPath(now).slice(0, 8);
}

function normalizeTimeMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function entryTimeMs(entry) {
  return normalizeTimeMs(
    entry?.ts ??
      entry?.time ??
      entry?.timestamp ??
      entry?.created_at ??
      entry?.createdAt,
  );
}

function parseJsonLine(line) {
  const trimmed = String(line ?? "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function statOrNull(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function mkdirForFile(path) {
  mkdirSync(dirname(path), { recursive: true });
}

function writeStream(stream, chunk) {
  if (stream.write(chunk)) return Promise.resolve();
  return once(stream, "drain").then(() => {});
}

async function closeWritable(stream) {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(() => {
      stream.removeListener("error", reject);
      resolve();
    });
  });
}

function acquireLock(lockPath, opts = {}) {
  mkdirForFile(lockPath);
  const staleMs = Number.isFinite(opts.staleMs) ? opts.staleMs : 10 * 60_000;
  try {
    const current = statSync(lockPath);
    if (Date.now() - current.mtimeMs > staleMs) unlinkSync(lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const fd = openSync(lockPath, "wx", 0o600);
  writeFileSync(
    fd,
    JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }),
  );
  let released = false;
  return {
    path: lockPath,
    release() {
      if (released) return;
      released = true;
      closeSync(fd);
      try {
        unlinkSync(lockPath);
      } catch {}
    },
  };
}

async function withLock(lockPath, opts, fn) {
  let lock = null;
  try {
    lock = acquireLock(lockPath, opts);
  } catch (error) {
    if (error?.code === "EEXIST") {
      return { rotated: false, skipped: true, reason: "lock_busy", lockPath };
    }
    throw error;
  }

  try {
    return await fn(lock);
  } finally {
    lock.release();
  }
}

function collectActive(value) {
  const sessions = Array.isArray(value)
    ? value
    : Array.isArray(value?.sessions)
      ? value.sessions
      : Array.isArray(value?.live_sessions)
        ? value.live_sessions
        : [];
  const ids = new Set();
  const paths = new Set();

  function addId(value) {
    if (typeof value === "string" && value.trim()) ids.add(value.trim());
    else if (typeof value === "number" && Number.isFinite(value)) {
      ids.add(String(value));
    }
  }

  function addPath(value) {
    if (typeof value === "string" && value.trim()) paths.add(resolve(value));
  }

  for (const session of sessions) {
    addId(session?.sessionId);
    addId(session?.session_id);
    addId(session?.runId);
    addId(session?.run_id);
    addId(session?.id);
    addId(session?.agent_id);
    addId(session?.agentId);

    for (const key of [
      "logPath",
      "log_path",
      "eventLogPath",
      "event_log_path",
      "filePath",
      "path",
      "runDir",
      "run_dir",
      "logsDir",
      "logs_dir",
    ]) {
      addPath(session?.[key]);
    }

    for (const key of ["files", "dirtyFiles", "claimedPaths", "logPaths"]) {
      const values = Array.isArray(session?.[key]) ? session[key] : [];
      for (const value of values) addPath(value);
    }
  }

  return { ids, paths };
}

async function readActive(opts = {}) {
  if (opts.active) return collectActive(opts.active);
  if (typeof opts.getActive !== "function") return collectActive([]);
  return collectActive(await opts.getActive());
}

function isOwnedByActivePath(path, active) {
  const resolved = resolve(path);
  for (const activePath of active.paths) {
    if (resolved === activePath || resolved.startsWith(`${activePath}/`)) {
      return true;
    }
  }
  return false;
}

function runIdForDir(runDir) {
  const name = basename(runDir);
  return name.startsWith("run-") ? name.slice(4) : name;
}

function isTerminalSwarmEvent(entry) {
  if (entry?.event === "integration_complete") return true;
  if (entry?.event !== "swarm_state") return false;
  return entry?.to === "completed" || entry?.to === "failed";
}

function isActiveRun(runDir, eventPath, active, stat, policy, nowMs) {
  if (
    isOwnedByActivePath(runDir, active) ||
    isOwnedByActivePath(eventPath, active)
  ) {
    return true;
  }

  const runId = runIdForDir(runDir);
  const candidateIds = new Set([runId, `run-${runId}`, `swarm-${runId}`]);
  for (const id of candidateIds) {
    if (active.ids.has(id)) return true;
  }

  const tail = readJsonLines(eventPath, { limit: 20, maxBytes: 256 * 1024 });
  if (tail.some((entry) => active.ids.has(String(entry?.sessionId || "")))) {
    return true;
  }
  if (tail.some(isTerminalSwarmEvent)) return false;

  const graceMs = Number.isFinite(policy.activeMtimeGraceMs)
    ? policy.activeMtimeGraceMs
    : 0;
  return graceMs > 0 && stat && nowMs - stat.mtimeMs <= graceMs;
}

function firstJsonLineTimeMs(path) {
  const fd = openSync(path, "r");
  try {
    const stat = statSync(path);
    const size = Math.min(stat.size, 256 * 1024);
    if (size <= 0) return 0;
    const buffer = Buffer.alloc(size);
    const bytesRead = readSync(fd, buffer, 0, size, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    for (const line of text.split(/\r?\n/u)) {
      const parsed = parseJsonLine(line);
      const timeMs = entryTimeMs(parsed);
      if (timeMs > 0) return timeMs;
    }
    return 0;
  } finally {
    closeSync(fd);
  }
}

function shouldRotateBySizeOrAge(path, policy, nowMs) {
  const stat = statOrNull(path);
  if (!stat?.isFile()) {
    return { rotate: false, reason: "missing", stat };
  }
  if (Number.isFinite(policy.maxBytes) && stat.size > policy.maxBytes) {
    return { rotate: true, reason: "size", stat };
  }
  const maxAgeMs = Number.isFinite(policy.maxAgeMs) ? policy.maxAgeMs : 0;
  if (maxAgeMs > 0) {
    const firstMs =
      firstJsonLineTimeMs(path) || stat.birthtimeMs || stat.mtimeMs;
    if (firstMs > 0 && nowMs - firstMs > maxAgeMs) {
      return { rotate: true, reason: "age", stat };
    }
  }
  return { rotate: false, reason: "below_threshold", stat };
}

function lineCountUpTo(path, maxLines) {
  if (!existsSync(path)) return 0;
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let count = 0;
    let position = 0;
    while (count <= maxLines) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead <= 0) break;
      position += bytesRead;
      for (let i = 0; i < bytesRead; i += 1) {
        if (buffer[i] === 10) count += 1;
        if (count > maxLines) break;
      }
    }
    return count;
  } finally {
    closeSync(fd);
  }
}

function readFromTail(path, maxBytes) {
  const stat = statSync(path);
  const bytes = Math.min(stat.size, maxBytes);
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const offset = stat.size - bytes;
    const read = readSync(fd, buffer, 0, bytes, offset);
    return {
      size: stat.size,
      offset,
      buffer: buffer.subarray(0, read),
    };
  } finally {
    closeSync(fd);
  }
}

export function readJsonLines(path, opts = {}) {
  if (!existsSync(path)) return [];
  const limit = Number.isFinite(opts.limit) ? Math.max(0, opts.limit) : 100;
  const maxBytes = Number.isFinite(opts.maxBytes)
    ? Math.max(1, opts.maxBytes)
    : DEFAULT_TAIL_READ_BYTES;
  const { size, offset, buffer } = readFromTail(path, maxBytes);
  let text = buffer.toString("utf8");
  if (offset > 0) {
    const newline = text.indexOf("\n");
    text = newline >= 0 ? text.slice(newline + 1) : "";
  }
  const parsed = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const entry = parseJsonLine(line);
      return entry ? [entry] : [];
    });
  if (limit === 0) return parsed;
  if (size <= maxBytes) return parsed.slice(-limit);
  return parsed.slice(-limit);
}

async function splitJsonlToArchiveAndTail({
  sourcePath,
  tailPath,
  archivePath,
  keepLine,
}) {
  mkdirForFile(tailPath);
  mkdirForFile(archivePath);

  const input = createReadStream(sourcePath);
  const tail = createWriteStream(tailPath, { flags: "wx" });
  const archiveFile = createWriteStream(archivePath, { flags: "wx" });
  const archiveClosed = once(archiveFile, "close");
  const gzip = createGzip();
  gzip.pipe(archiveFile);

  let carry = Buffer.alloc(0);
  let lineIndex = 0;
  let offset = 0;
  let archivedLines = 0;
  let retainedLines = 0;
  let archivedBytes = 0;
  let retainedBytes = 0;

  async function handleRecord(record) {
    const body = record.toString("utf8").replace(/\r?\n$/u, "");
    const startOffset = offset;
    const endOffset = offset + record.length;
    const parsed = parseJsonLine(body);
    const keep = keepLine({
      line: body,
      entry: parsed,
      lineIndex,
      startOffset,
      endOffset,
      bytes: record.length,
    });
    lineIndex += 1;
    offset = endOffset;
    if (keep) {
      retainedLines += 1;
      retainedBytes += record.length;
      await writeStream(tail, record);
    } else {
      archivedLines += 1;
      archivedBytes += record.length;
      await writeStream(gzip, record);
    }
  }

  try {
    for await (const chunk of input) {
      const buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      let start = 0;
      while (true) {
        const newline = buffer.indexOf(10, start);
        if (newline < 0) break;
        await handleRecord(buffer.subarray(start, newline + 1));
        start = newline + 1;
      }
      carry = buffer.subarray(start);
    }
    if (carry.length > 0) await handleRecord(carry);
    await closeWritable(tail);
    await closeWritable(gzip);
    await archiveClosed;
    return {
      archivedLines,
      retainedLines,
      archivedBytes,
      retainedBytes,
    };
  } catch (error) {
    tail.destroy();
    gzip.destroy();
    archiveFile.destroy();
    throw error;
  }
}

async function gzipWholeFile(sourcePath, archivePath) {
  mkdirForFile(archivePath);
  const input = createReadStream(sourcePath);
  const gzip = createGzip();
  const output = createWriteStream(archivePath, { flags: "wx" });
  input.pipe(gzip).pipe(output);
  await once(output, "close");
  const stat = statSync(sourcePath);
  return { archivedBytes: stat.size };
}

async function rotateLedger({ ledgerPath, lakeRoot, policy, active, now }) {
  const nowMs = now.getTime();
  if (isOwnedByActivePath(ledgerPath, active)) {
    return { log: "ledger", rotated: false, skipped: true, reason: "active" };
  }
  const decision = shouldRotateBySizeOrAge(ledgerPath, policy, nowMs);
  if (!decision.rotate) {
    return { log: "ledger", rotated: false, reason: decision.reason };
  }

  const lockPath = join(lakeRoot, "retention.lock");
  return await withLock(lockPath, {}, async () => {
    const ledgerLockPath = `${ledgerPath}.lock`;
    return await withLock(ledgerLockPath, {}, async () => {
      const ts = timestampForPath(now);
      const archiveDir = join(lakeRoot, "archive", archiveDay(now));
      const movedPath = join(archiveDir, `.ledger-${ts}.jsonl.rotating`);
      const archivePath = join(archiveDir, `ledger-${ts}.jsonl.gz`);
      const tailTmpPath = `${ledgerPath}.${process.pid}.${ts}.tmp`;
      mkdirSync(archiveDir, { recursive: true });
      renameSync(ledgerPath, movedPath);

      try {
        const sourceSize = decision.stat.size;
        const tailStart = Math.max(0, sourceSize - policy.tailBytes);
        const cutoffMs = nowMs - policy.tailAgeMs;
        const split = await splitJsonlToArchiveAndTail({
          sourcePath: movedPath,
          tailPath: tailTmpPath,
          archivePath,
          keepLine({ entry, startOffset }) {
            const timeMs = entryTimeMs(entry);
            return (
              startOffset >= tailStart || (timeMs > 0 && timeMs >= cutoffMs)
            );
          },
        });
        renameSync(tailTmpPath, ledgerPath);
        rmSync(movedPath, { force: true });
        return {
          log: "ledger",
          rotated: true,
          reason: decision.reason,
          archivePath,
          retainedPath: ledgerPath,
          ...split,
        };
      } catch (error) {
        try {
          if (!existsSync(ledgerPath) && existsSync(movedPath)) {
            renameSync(movedPath, ledgerPath);
          }
        } catch {}
        rmSync(tailTmpPath, { force: true });
        throw error;
      }
    });
  });
}

async function rotateSwarmRun({
  runDir,
  eventPath,
  policy,
  active,
  now,
  archiveRoot,
}) {
  const stat = statOrNull(eventPath);
  if (!stat?.isFile()) {
    return { log: "swarm-events", runDir, rotated: false, reason: "missing" };
  }
  const nowMs = now.getTime();
  if (isActiveRun(runDir, eventPath, active, stat, policy, nowMs)) {
    return {
      log: "swarm-events",
      runDir,
      rotated: false,
      skipped: true,
      reason: "active",
    };
  }
  const decision = shouldRotateBySizeOrAge(eventPath, policy, nowMs);
  if (!decision.rotate) {
    return {
      log: "swarm-events",
      runDir,
      rotated: false,
      reason: decision.reason,
    };
  }

  return await withLock(join(runDir, ".retention.lock"), {}, async () => {
    const ts = timestampForPath(now);
    const runName = basename(runDir);
    const archiveDir = join(archiveRoot, archiveDay(now), runName);
    const movedPath = join(archiveDir, `swarm-events-${ts}.jsonl`);
    const archivePath = `${movedPath}.gz`;
    mkdirSync(archiveDir, { recursive: true });
    renameSync(eventPath, movedPath);
    try {
      const result = await gzipWholeFile(movedPath, archivePath);
      rmSync(movedPath, { force: true });
      return {
        log: "swarm-events",
        runDir,
        rotated: true,
        reason: decision.reason,
        archivePath,
        ...result,
      };
    } catch (error) {
      try {
        if (!existsSync(eventPath) && existsSync(movedPath)) {
          renameSync(movedPath, eventPath);
        }
      } catch {}
      throw error;
    }
  });
}

async function rotateBatchEvents({ batchPath, policy, active, now }) {
  if (!existsSync(batchPath)) {
    return { log: "batch-events", rotated: false, reason: "missing" };
  }
  if (isOwnedByActivePath(batchPath, active)) {
    return {
      log: "batch-events",
      rotated: false,
      skipped: true,
      reason: "active",
    };
  }
  const count = lineCountUpTo(batchPath, policy.rotateAfterLines + 1);
  if (count <= policy.rotateAfterLines) {
    return { log: "batch-events", rotated: false, reason: "below_threshold" };
  }

  const lockPath = join(dirname(batchPath), "retention.lock");
  return await withLock(lockPath, {}, async () => {
    const ts = timestampForPath(now);
    const archiveDir = join(dirname(batchPath), "archive", archiveDay(now));
    const movedPath = join(archiveDir, `.batch-events-${ts}.jsonl.rotating`);
    const archivePath = join(archiveDir, `batch-events-${ts}.jsonl.gz`);
    const tailTmpPath = `${batchPath}.${process.pid}.${ts}.tmp`;
    mkdirSync(archiveDir, { recursive: true });
    renameSync(batchPath, movedPath);
    try {
      const totalLines = lineCountUpTo(movedPath, Number.MAX_SAFE_INTEGER);
      const keepFrom = Math.max(0, totalLines - policy.keepLines);
      const split = await splitJsonlToArchiveAndTail({
        sourcePath: movedPath,
        tailPath: tailTmpPath,
        archivePath,
        keepLine({ lineIndex }) {
          return lineIndex >= keepFrom;
        },
      });
      renameSync(tailTmpPath, batchPath);
      rmSync(movedPath, { force: true });
      return {
        log: "batch-events",
        rotated: true,
        reason: "line_count",
        archivePath,
        retainedPath: batchPath,
        ...split,
      };
    } catch (error) {
      try {
        if (!existsSync(batchPath) && existsSync(movedPath)) {
          renameSync(movedPath, batchPath);
        }
      } catch {}
      rmSync(tailTmpPath, { force: true });
      throw error;
    }
  });
}

function listSwarmEventPaths(swarmLogsRoot) {
  if (!existsSync(swarmLogsRoot)) return [];
  return readdirSync(swarmLogsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const runDir = join(swarmLogsRoot, entry.name);
      return { runDir, eventPath: join(runDir, "swarm-events.jsonl") };
    })
    .filter(({ eventPath }) => existsSync(eventPath));
}

function mergePolicies(overrides = {}) {
  return {
    ledger: { ...LOG_RETENTION_DEFAULTS.ledger, ...(overrides.ledger || {}) },
    swarm: { ...LOG_RETENTION_DEFAULTS.swarm, ...(overrides.swarm || {}) },
    batch: { ...LOG_RETENTION_DEFAULTS.batch, ...(overrides.batch || {}) },
  };
}

export async function runLogRetention(opts = {}) {
  const enabled =
    typeof opts.enabled === "boolean" ? opts.enabled : isCtoRetentionEnabled();
  if (!enabled) {
    return { enabled: false, applied: false, results: [] };
  }

  const rootDir = resolve(opts.rootDir || process.cwd());
  const lakeRoot = resolve(opts.lakeRoot || join(rootDir, ".triflux", "lake"));
  const swarmLogsRoot = resolve(
    opts.swarmLogsRoot || join(rootDir, ".triflux", "swarm-logs"),
  );
  const batchPath = resolve(
    opts.batchEventsPath ||
      join(homedir(), ".claude", "cache", "batch-events.jsonl"),
  );
  const now =
    opts.now instanceof Date ? opts.now : new Date(opts.now || Date.now());
  const policies = mergePolicies(opts.policies);
  const active = await readActive(opts);
  const results = [];

  mkdirSync(lakeRoot, { recursive: true });
  results.push(
    await rotateLedger({
      ledgerPath: join(lakeRoot, "ledger.jsonl"),
      lakeRoot,
      policy: policies.ledger,
      active,
      now,
    }),
  );

  const swarmArchiveRoot =
    opts.swarmArchiveRoot || join(swarmLogsRoot, "archive");
  for (const entry of listSwarmEventPaths(swarmLogsRoot)) {
    results.push(
      await rotateSwarmRun({
        ...entry,
        policy: policies.swarm,
        active,
        now,
        archiveRoot: swarmArchiveRoot,
      }),
    );
  }

  results.push(
    await rotateBatchEvents({
      batchPath,
      policy: policies.batch,
      active,
      now,
    }),
  );

  return {
    enabled: true,
    applied: results.some((result) => result.rotated),
    results,
  };
}

export const applyLogRetention = runLogRetention;
