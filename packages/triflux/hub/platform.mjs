import { execFile, execFileSync, execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { privateTmpRoot } from "./lib/private-tmp.mjs";

export const IS_WINDOWS = process.platform === "win32";
export const IS_MAC = process.platform === "darwin";
export const IS_LINUX = process.platform === "linux";
export const TEMP_DIR = IS_WINDOWS ? os.tmpdir() : "/tmp";
export const PATH_SEP = path.sep;

function getPathApi(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function coercePathInput(value, platform) {
  const text = String(value ?? "");
  if (platform === "win32") {
    return text.replaceAll("/", "\\");
  }
  return text.replaceAll("\\", "/");
}

function sanitizePipeSegment(value) {
  return String(value ?? "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildWhichCommandSpec(name, options = {}) {
  const commandName = String(name ?? "").trim();
  if (!commandName) return null;

  const platform = options.platform || process.platform;
  return {
    lookupCommand: platform === "win32" ? "where" : "which",
    args: [commandName],
    execOptions: {
      encoding: "utf8",
      timeout: options.timeout ?? 5000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      env: options.env || process.env,
      cwd: options.cwd,
    },
  };
}

function parseWhichCommandOutput(output) {
  return (
    String(output)
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean) || null
  );
}

function execFileAsync(command, args, options, execFileFn = execFile) {
  return new Promise((resolve, reject) => {
    execFileFn(command, args, options, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

export function normalizePath(value, options = {}) {
  const platform = options.platform || process.platform;
  const pathApi = getPathApi(platform);
  const normalized = pathApi.normalize(coercePathInput(value, platform));

  if (platform === "win32") {
    return normalized.replaceAll("\\", "/");
  }
  return normalized;
}

export function whichCommand(name, options = {}) {
  const spec = buildWhichCommandSpec(name, options);
  if (!spec) return null;

  try {
    const output = execFileSync(
      spec.lookupCommand,
      spec.args,
      spec.execOptions,
    );
    return parseWhichCommandOutput(output);
  } catch {
    return null;
  }
}

export async function whichCommandAsync(name, options = {}) {
  const spec = buildWhichCommandSpec(name, options);
  if (!spec) return null;

  try {
    const output = await execFileAsync(
      spec.lookupCommand,
      spec.args,
      spec.execOptions,
      options.execFileFn || execFile,
    );
    return parseWhichCommandOutput(output);
  } catch {
    return null;
  }
}

export function killProcess(pid, options = {}) {
  const numericPid = Number.parseInt(String(pid), 10);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;

  const platform = options.platform || process.platform;
  const signal = options.signal || "SIGTERM";
  const tree = options.tree === true;
  const force = options.force === true || signal === "SIGKILL";

  try {
    if (platform === "win32" && (tree || force)) {
      const command = [
        "taskkill",
        "/PID",
        String(numericPid),
        tree ? "/T" : "",
        force ? "/F" : "",
      ]
        .filter(Boolean)
        .join(" ");
      execSync(command, {
        stdio: "ignore",
        timeout: options.timeout ?? 5000,
        windowsHide: true,
      });
      return true;
    }

    if (tree) {
      try {
        execSync(`pkill -P ${numericPid}`, { stdio: "ignore", timeout: 3000 });
      } catch {}
    }
    process.kill(numericPid, signal);
    return true;
  } catch {
    return false;
  }
}

export function pipePath(name, pid = process.pid, options = {}) {
  const platform = options.platform || process.platform;
  const safeName = sanitizePipeSegment(name) || "triflux";
  const suffix = pid == null || pid === "" ? safeName : `${safeName}-${pid}`;

  if (platform === "win32") {
    return `\\\\.\\pipe\\${suffix}`;
  }

  // 공용 /tmp 의 소켓은 다른 사용자가 접속하거나 선점할 수 있다. 짧은 경로를 위해 /tmp 를 기준으로 둔다.
  const baseDir = options.tempDir || privateTmpRoot({ base: TEMP_DIR });
  return path.posix.join(baseDir, `${suffix}.sock`);
}

export function isPathWithin(resolvedPath, dir, options = {}) {
  if (!resolvedPath || !dir) return false;

  const platform = options.platform || process.platform;
  const pathApi = getPathApi(platform);
  const left = pathApi.resolve(coercePathInput(resolvedPath, platform));
  const right = pathApi.resolve(coercePathInput(dir, platform));

  const normalizedLeft = platform === "win32" ? left.toLowerCase() : left;
  const normalizedRight = platform === "win32" ? right.toLowerCase() : right;
  const relative = pathApi.relative(normalizedRight, normalizedLeft);

  return (
    relative === "" ||
    (!relative.startsWith("..") && !pathApi.isAbsolute(relative))
  );
}
