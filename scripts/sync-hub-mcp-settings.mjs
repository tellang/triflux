import { constants } from "node:fs";
import { access, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const TARGET_FILES = [
  [".gemini", "settings.json"],
  [".claude", "settings.json"],
  [".claude", "settings.local.json"],
];
const CODEX_CONFIG_FILE = [".codex", "config.toml"];
const TFX_HUB_SECTION = "tfx-hub";
const FILE_LOCKS = new Map();

function getSettingsPaths() {
  const home = process.env.HOME || homedir();
  return TARGET_FILES.map((segments) => join(home, ...segments));
}

function getCodexConfigPath(codexConfigPath) {
  if (typeof codexConfigPath === "string" && codexConfigPath.length > 0) {
    return codexConfigPath;
  }
  const home = process.env.HOME || homedir();
  return join(home, ...CODEX_CONFIG_FILE);
}

function getProjectMcpJsonPath(projectRoot) {
  if (typeof projectRoot === "string" && projectRoot.length > 0) {
    return join(projectRoot, ".claude", "mcp.json");
  }
  return join(process.cwd(), ".claude", "mcp.json");
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

async function writeTextAtomic(filePath, payload) {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;

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

async function writeJsonAtomic(filePath, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await writeTextAtomic(filePath, payload);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatTomlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function parseTomlScalar(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) return "";
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d[\d_]*$/.test(value)) return Number(value.replace(/_/g, ""));
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return value;
}

function findMcpServerSection(raw, sectionName) {
  const headerRegex = new RegExp(
    `^\\[mcp_servers\\.${escapeRegExp(sectionName)}\\]\\s*$`,
    "m",
  );
  const headerMatch = headerRegex.exec(raw);
  if (!headerMatch) return null;

  const headerLineEnd = raw.indexOf("\n", headerMatch.index);
  const bodyStart = headerLineEnd === -1 ? raw.length : headerLineEnd + 1;
  const nextSectionRegex = /^\s*\[/gm;
  nextSectionRegex.lastIndex = bodyStart;
  const nextSectionMatch = nextSectionRegex.exec(raw);
  const sectionEnd = nextSectionMatch ? nextSectionMatch.index : raw.length;

  return {
    body: raw.slice(bodyStart, sectionEnd),
    bodyStart,
    sectionEnd,
  };
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

    const typeOk = hubServer.type === "http";
    const urlOk = hubServer.url === hubUrl;

    if (typeOk && urlOk) {
      log(logger, "info", `[mcp-sync] skipped: ${filePath}`);
      return { kind: "skipped", path: filePath };
    }

    log(
      logger,
      "debug",
      `[mcp-sync] ${filePath} type:${String(hubServer.type)} url:${String(hubServer.url)} -> type:http url:${hubUrl}`,
    );

    if (!dryRun) {
      try {
        hubServer.type = "http";
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

async function syncCodexConfigFile({ filePath, hubUrl, dryRun, logger }) {
  return withFileLock(filePath, async () => {
    if (!(await fileExists(filePath))) {
      log(logger, "info", `[codex-mcp-sync] skipped: ${filePath}`);
      return { kind: "skipped", path: filePath };
    }

    let raw;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      const reason = getReason(error, "read failed");
      log(logger, "error", `[codex-mcp-sync] error: ${filePath} (${reason})`);
      return { kind: "error", path: filePath, reason };
    }

    const section = findMcpServerSection(raw, TFX_HUB_SECTION);
    if (!section) {
      log(logger, "info", `[codex-mcp-sync] skipped: ${filePath}`);
      return { kind: "skipped", path: filePath };
    }

    const urlMatch = /^(\s*url\s*=\s*)(.+?)(\s*(?:#.*)?)$/m.exec(section.body);
    if (!urlMatch) {
      const reason = "missing tfx-hub url";
      log(logger, "error", `[codex-mcp-sync] error: ${filePath} (${reason})`);
      return { kind: "error", path: filePath, reason };
    }

    const currentUrl = parseTomlScalar(urlMatch[2]);
    if (typeof currentUrl !== "string" || currentUrl.length === 0) {
      const reason = "invalid tfx-hub url";
      log(logger, "error", `[codex-mcp-sync] error: ${filePath} (${reason})`);
      return { kind: "error", path: filePath, reason };
    }

    if (currentUrl === hubUrl) {
      log(logger, "info", `[codex-mcp-sync] skipped: ${filePath}`);
      return { kind: "skipped", path: filePath };
    }

    const nextBody = section.body.replace(
      /^(\s*url\s*=\s*)(.+?)(\s*(?:#.*)?)$/m,
      (_, prefix, _value, suffix = "") =>
        `${prefix}${formatTomlString(hubUrl)}${suffix}`,
    );
    const nextRaw = `${raw.slice(0, section.bodyStart)}${nextBody}${raw.slice(section.sectionEnd)}`;

    log(
      logger,
      "debug",
      `[codex-mcp-sync] ${filePath} url: ${String(currentUrl)} -> ${hubUrl}`,
    );

    if (!dryRun) {
      try {
        await writeTextAtomic(filePath, nextRaw);
      } catch (error) {
        const reason = getReason(error, "write failed");
        log(logger, "error", `[codex-mcp-sync] error: ${filePath} (${reason})`);
        return { kind: "error", path: filePath, reason };
      }
    }

    log(logger, "info", `[codex-mcp-sync] updated: ${filePath}`);
    return { kind: "updated", path: filePath };
  });
}

async function syncProjectMcpFile({ filePath, hubUrl, dryRun, logger }) {
  return withFileLock(filePath, async () => {
    if (!(await fileExists(filePath))) {
      log(logger, "info", `[project-mcp-sync] skipped: ${filePath}`);
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
      log(logger, "error", `[project-mcp-sync] error: ${filePath} (${reason})`);
      return { kind: "error", path: filePath, reason };
    }

    const servers = settings?.mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      log(logger, "info", `[project-mcp-sync] skipped: ${filePath}`);
      return { kind: "skipped", path: filePath };
    }

    const hubServer = servers["tfx-hub"];
    if (hubServer === undefined) {
      log(logger, "info", `[project-mcp-sync] skipped: ${filePath}`);
      return { kind: "skipped", path: filePath };
    }

    if (
      !hubServer ||
      typeof hubServer !== "object" ||
      Array.isArray(hubServer)
    ) {
      const reason = "invalid tfx-hub entry";
      log(logger, "error", `[project-mcp-sync] error: ${filePath} (${reason})`);
      return { kind: "error", path: filePath, reason };
    }

    if (hubServer.url === hubUrl) {
      log(logger, "info", `[project-mcp-sync] skipped: ${filePath}`);
      return { kind: "skipped", path: filePath };
    }

    log(
      logger,
      "debug",
      `[project-mcp-sync] ${filePath} url:${String(hubServer.url)} -> ${hubUrl}`,
    );

    if (!dryRun) {
      try {
        hubServer.url = hubUrl;
        await writeJsonAtomic(filePath, settings);
      } catch (error) {
        const reason = getReason(error, "write failed");
        log(
          logger,
          "error",
          `[project-mcp-sync] error: ${filePath} (${reason})`,
        );
        return { kind: "error", path: filePath, reason };
      }
    }

    log(logger, "info", `[project-mcp-sync] updated: ${filePath}`);
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

export async function syncCodexHubUrl({
  hubUrl,
  codexConfigPath,
  dryRun = false,
  logger = console,
}) {
  const result = {
    updated: [],
    skipped: [],
    errors: [],
  };

  const outcome = await syncCodexConfigFile({
    filePath: getCodexConfigPath(codexConfigPath),
    hubUrl,
    dryRun,
    logger,
  });

  if (outcome.kind === "updated") {
    result.updated.push(outcome.path);
  } else if (outcome.kind === "skipped") {
    result.skipped.push(outcome.path);
  } else {
    result.errors.push({ path: outcome.path, reason: outcome.reason });
  }

  return result;
}

export async function syncProjectMcpJson({
  hubUrl,
  projectRoot,
  dryRun = false,
  logger = console,
}) {
  const result = {
    updated: [],
    skipped: [],
    errors: [],
  };

  const outcome = await syncProjectMcpFile({
    filePath: getProjectMcpJsonPath(projectRoot),
    hubUrl,
    dryRun,
    logger,
  });

  if (outcome.kind === "updated") {
    result.updated.push(outcome.path);
  } else if (outcome.kind === "skipped") {
    result.skipped.push(outcome.path);
  } else {
    result.errors.push({ path: outcome.path, reason: outcome.reason });
  }

  return result;
}
