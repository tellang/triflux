import { constants } from "node:fs";
import { access, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const TARGET_FILES = [
  [".gemini", "settings.json"],
  [".claude", "settings.json"],
  [".claude", "settings.local.json"],
];
const FILE_LOCKS = new Map();

function getSettingsPaths() {
  const home = process.env.HOME || homedir();
  return TARGET_FILES.map((segments) => join(home, ...segments));
}

function getReason(error, fallback) {
  if (typeof error?.message === "string" && error.message.length > 0) {
    return error.message;
  }
  return fallback;
}

function log(logger, level, message) {
  const writer = logger?.[level];
  if (typeof writer !== "function") {
    return;
  }

  try {
    writer.call(logger, message);
  } catch {
    // logging must never break sync flow
  }
}

async function withFileLock(filePath, task) {
  while (FILE_LOCKS.has(filePath)) {
    await FILE_LOCKS.get(filePath);
  }

  let release;
  const lock = new Promise((resolve) => {
    release = resolve;
  });
  FILE_LOCKS.set(filePath, lock);

  try {
    return await task();
  } finally {
    FILE_LOCKS.delete(filePath);
    release();
  }
}

async function fileExists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonAtomic(filePath, value) {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;

  try {
    await writeFile(tmpPath, payload, "utf8");

    try {
      await rename(tmpPath, filePath);
    } catch (error) {
      if (
        error?.code !== "EEXIST" &&
        error?.code !== "EPERM" &&
        error?.code !== "EACCES"
      ) {
        throw error;
      }

      await rm(filePath, { force: true });
      await rename(tmpPath, filePath);
    }
  } finally {
    await rm(tmpPath, { force: true }).catch(() => {});
  }
}

async function syncSingleFile({ filePath, hubUrl, dryRun, logger }) {
  return withFileLock(filePath, async () => {
    if (!(await fileExists(filePath))) {
      log(logger, "info", `[mcp-sync] skipped: ${filePath}`);
      return { kind: "skipped", path: filePath };
    }

    let settings;
    try {
      settings = JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      const reason =
        error?.name === "SyntaxError"
          ? "invalid json"
          : getReason(error, "read failed");
      log(logger, "error", `[mcp-sync] error: ${filePath} (${reason})`);
      return { kind: "error", path: filePath, reason };
    }

    const servers = settings?.mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      log(logger, "info", `[mcp-sync] skipped: ${filePath}`);
      return { kind: "skipped", path: filePath };
    }

    const hubServer = servers["tfx-hub"];
    if (hubServer === undefined) {
      log(logger, "info", `[mcp-sync] skipped: ${filePath}`);
      return { kind: "skipped", path: filePath };
    }

    if (
      !hubServer ||
      typeof hubServer !== "object" ||
      Array.isArray(hubServer)
    ) {
      const reason = "invalid tfx-hub entry";
      log(logger, "error", `[mcp-sync] error: ${filePath} (${reason})`);
      return { kind: "error", path: filePath, reason };
    }

    if (hubServer.url === hubUrl) {
      log(logger, "info", `[mcp-sync] skipped: ${filePath}`);
      return { kind: "skipped", path: filePath };
    }

    log(
      logger,
      "debug",
      `[mcp-sync] ${filePath} url: ${String(hubServer.url)} -> ${hubUrl}`,
    );

    if (!dryRun) {
      try {
        hubServer.url = hubUrl;
        await writeJsonAtomic(filePath, settings);
      } catch (error) {
        const reason = getReason(error, "write failed");
        log(logger, "error", `[mcp-sync] error: ${filePath} (${reason})`);
        return { kind: "error", path: filePath, reason };
      }
    }

    log(logger, "info", `[mcp-sync] updated: ${filePath}`);
    return { kind: "updated", path: filePath };
  });
}

export async function syncHubMcpSettings({
  hubUrl,
  dryRun = false,
  logger = console,
}) {
  const result = {
    updated: [],
    skipped: [],
    errors: [],
  };

  for (const filePath of getSettingsPaths()) {
    const outcome = await syncSingleFile({ filePath, hubUrl, dryRun, logger });
    if (outcome.kind === "updated") {
      result.updated.push(outcome.path);
      continue;
    }
    if (outcome.kind === "skipped") {
      result.skipped.push(outcome.path);
      continue;
    }
    result.errors.push({ path: outcome.path, reason: outcome.reason });
  }

  return result;
}
