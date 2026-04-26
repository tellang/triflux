import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_SNAPSHOTS = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

export const CODEX_STATE_INCLUDES = Object.freeze([
  "config.toml",
  "AGENTS.md",
  "skills",
  "agents",
  "prompts",
  "plugins",
]);

export const CODEX_STATE_EXCLUDES = Object.freeze([
  "*.sqlite*",
  ".sandbox*",
  ".tmp",
  "_archived_skills",
  "memories",
  "cache",
  "log",
  "logs",
  "sessions",
  "auth.json",
  ".credentials.json",
  "*.bak*",
  "*.tmp-*",
  "cap_sid",
  "installation_id",
  "history.jsonl",
  "models_cache.json",
]);

export const GEMINI_STATE_INCLUDES = Object.freeze([
  "settings.json",
  "settings.local.json",
  "GEMINI.md",
  "commands",
  "extensions",
  "plugins",
  "skills",
  "agents",
]);

export const GEMINI_STATE_EXCLUDES = Object.freeze([
  "*.sqlite*",
  "cache",
  "log",
  "logs",
  "sessions",
  "auth.json",
  ".credentials.json",
  "*.bak*",
]);

export const STATE_SNAPSHOT_THRESHOLD_MS = DAY_MS;
export const STATE_SNAPSHOT_MAX_SNAPSHOTS = DEFAULT_MAX_SNAPSHOTS;

function normalizePath(path) {
  return String(path || "")
    .replace(/\\/gu, "/")
    .replace(/^\/+/u, "");
}

function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/gu, ".*")}$`, "u");
}

function compileExclude(pattern) {
  const text = normalizePath(pattern).replace(/\/+$/u, "");
  if (text.includes("*")) {
    const regex = globToRegExp(text);
    return (relativePath) => {
      const normalized = normalizePath(relativePath);
      return normalized.split("/").some((part) => regex.test(part));
    };
  }

  return (relativePath) => {
    const normalized = normalizePath(relativePath);
    return normalized.split("/").includes(text);
  };
}

function isSubpath(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function pathStats(path) {
  try {
    return await stat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function collectFiles({ sourceDir, includes, excludeMatchers }) {
  const sourceRoot = resolve(sourceDir);
  const files = [];

  async function visit(absPath, relativePath) {
    if (excludeMatchers.some((matcher) => matcher(relativePath))) return;

    const info = await pathStats(absPath);
    if (!info) return;
    if (info.isDirectory()) {
      const children = await readdir(absPath, { withFileTypes: true });
      for (const child of children) {
        await visit(join(absPath, child.name), join(relativePath, child.name));
      }
      return;
    }
    if (info.isFile()) {
      files.push({
        absPath,
        relativePath: normalizePath(relativePath),
        size: info.size,
      });
    }
  }

  for (const include of includes || []) {
    const relativeInclude = normalizePath(include);
    if (!relativeInclude || relativeInclude.startsWith("../")) continue;
    const absPath = resolve(sourceRoot, relativeInclude);
    if (!isSubpath(sourceRoot, absPath)) continue;
    await visit(absPath, relativeInclude);
  }

  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return files;
}

async function listSnapshots(destDir) {
  const names = await readdir(destDir).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const snapshots = [];
  for (const name of names) {
    if (!name.endsWith(".tar.gz")) continue;
    const path = join(destDir, name);
    const info = await pathStats(path);
    if (info?.isFile()) snapshots.push({ name, path, mtimeMs: info.mtimeMs });
  }
  snapshots.sort(
    (a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name),
  );
  return snapshots;
}

async function copyToStaging(files, stagingDir) {
  for (const file of files) {
    const targetPath = join(stagingDir, ...file.relativePath.split("/"));
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(file.absPath, targetPath);
  }
}

async function createArchive({ stagingDir, archivePath, files }) {
  const listPath = join(stagingDir, ".snapshot-files");
  const archiveName = normalizePath(relative(stagingDir, archivePath));
  await writeFile(
    listPath,
    `${files.map((file) => file.relativePath).join("\n")}\n`,
    "utf8",
  );
  await execFileAsync(
    "tar",
    ["-czf", archiveName, "-C", ".", "-T", ".snapshot-files"],
    {
      cwd: stagingDir,
      windowsHide: true,
    },
  );
  await rm(listPath, { force: true });
}

async function pruneSnapshots(destDir, maxSnapshots) {
  const snapshots = await listSnapshots(destDir);
  const keep = Math.max(1, Number(maxSnapshots) || DEFAULT_MAX_SNAPSHOTS);
  for (const snapshot of snapshots.slice(keep)) {
    await rm(snapshot.path, { force: true });
  }
}

function formatStamp(date) {
  return date
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "Z");
}

function uniqueSuffix() {
  return `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Snapshot selected user state into a rolling tar.gz archive.
 *
 * @param {object} options
 * @param {string} options.sourceDir
 * @param {string} options.destDir
 * @param {string[]} options.includes
 * @param {string[]} options.excludes
 * @param {number} options.thresholdMs
 * @param {number} [options.maxSnapshots=10]
 * @returns {Promise<{skipped: boolean, reason?: string, path?: string, sizeBytes?: number, fileCount?: number}>}
 */
export async function snapshotState({
  sourceDir,
  destDir,
  includes,
  excludes = [],
  thresholdMs = 0,
  maxSnapshots = DEFAULT_MAX_SNAPSHOTS,
}) {
  const sourceRoot = resolve(sourceDir || "");
  const destRoot = resolve(destDir || "");
  const sourceInfo = await pathStats(sourceRoot);
  if (!sourceInfo?.isDirectory()) {
    return { skipped: true, reason: "source-missing" };
  }

  await mkdir(destRoot, { recursive: true });
  const snapshots = await listSnapshots(destRoot);
  const newest = snapshots[0];
  if (
    newest &&
    Number(thresholdMs) > 0 &&
    Date.now() - newest.mtimeMs < Number(thresholdMs)
  ) {
    return { skipped: true, reason: "threshold", path: newest.path };
  }

  const excludeMatchers = excludes.map((pattern) => compileExclude(pattern));
  const files = await collectFiles({
    sourceDir: sourceRoot,
    includes,
    excludeMatchers,
  });
  if (files.length === 0) {
    return { skipped: true, reason: "empty" };
  }

  const suffix = uniqueSuffix();
  const stagingDir = join(tmpdir(), `tfx-state-snapshot-${suffix}`);
  const tempArchivePath = join(stagingDir, `.state-${suffix}.tar.gz.tmp`);
  const finalArchivePath = join(
    destRoot,
    `state-${formatStamp(new Date())}-${suffix}.tar.gz`,
  );

  try {
    await mkdir(stagingDir, { recursive: true });
    await copyToStaging(files, stagingDir);
    await createArchive({
      stagingDir,
      archivePath: tempArchivePath,
      files,
    });
    await rename(tempArchivePath, finalArchivePath);
    await pruneSnapshots(destRoot, maxSnapshots);
    const archiveInfo = await stat(finalArchivePath);
    const sizeBytes = files.reduce((sum, file) => sum + file.size, 0);
    return {
      skipped: false,
      path: finalArchivePath,
      sizeBytes: archiveInfo.size || sizeBytes,
      fileCount: files.length,
    };
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
    await rm(tempArchivePath, { force: true });
  }
}
