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

// Windows 에서 process.env.HOME 만 set 하고 USERPROFILE 은 그대로 둔 fixture 환경
// (e.g. integration test) 에서 production path 로 새는 것을 방지하려면 platform
// 별로 native 변수를 우선한다 (#193).
//
// - TRIFLUX_TEST_HOME: 두 OS 모두 명시 override
// - Windows: USERPROFILE > HOME > homedir() (Windows native 가 USERPROFILE)
// - POSIX: HOME > homedir()
function resolveHome() {
  if (process.env.TRIFLUX_TEST_HOME) return process.env.TRIFLUX_TEST_HOME;
  if (process.platform === "win32") {
    return process.env.USERPROFILE || process.env.HOME || homedir();
  }
  return process.env.HOME || homedir();
}

function getSettingsPaths() {
  const home = resolveHome();
  return TARGET_FILES.map((segments) => join(home, ...segments));
}

function getCodexConfigPath(codexConfigPath) {
  if (typeof codexConfigPath === "string" && codexConfigPath.length > 0) {
    return codexConfigPath;
  }
  return join(resolveHome(), ...CODEX_CONFIG_FILE);
}

export function getProjectMcpJsonPaths(projectRoot) {
  const root =
    typeof projectRoot === "string" && projectRoot.length > 0
      ? projectRoot
      : process.cwd();
  return [join(root, ".claude", "mcp.json"), join(root, ".mcp.json")];
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
  // #164 MEDIUM 1: rename fallback 비원자성 개선.
  // 기존: rename 실패 시 원본을 먼저 rm → rename(tmp, dest) 이므로 2차 실패/프로세스 중단 시 원본 유실.
  // 개선: 원본을 backup 경로로 먼저 옮기고 (atomic rename), tmp → dest 성공 후에만 backup 삭제.
  //       tmp → dest 실패 시 backup 을 다시 dest 로 복원해 원자성 보장.
  //       backup 복원 자체가 실패하면 backup 을 **절대 삭제하지 않는다** (수동 복구용 보존).
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const backupPath = `${filePath}.bak-${process.pid}-${Date.now()}`;
  let hasBackup = false;

  try {
    await writeFile(tmpPath, payload, "utf8");

    // 1) 원본이 있으면 backup 으로 rename (원본 유실 위험 제거)
    try {
      await rename(filePath, backupPath);
      hasBackup = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    // 2) tmp → dest
    try {
      await rename(tmpPath, filePath);
    } catch (error) {
      // Windows 에서 dest 에 stale lock 이 남아있으면 EEXIST/EPERM/EACCES 가 여전히 발생 가능.
      // 이 경우 dest 를 제거한 뒤 재시도. backup 은 아직 살아있으므로 복원 가능.
      if (
        error?.code === "EEXIST" ||
        error?.code === "EPERM" ||
        error?.code === "EACCES"
      ) {
        await rm(filePath, { force: true }).catch(() => {});
        await rename(tmpPath, filePath);
      } else {
        throw error;
      }
    }

    // 3) 성공 — backup 정리
    if (hasBackup) {
      await rm(backupPath, { force: true }).catch(() => {});
      hasBackup = false;
    }
  } catch (error) {
    // 실패 — backup 복원 시도. 복원 성공 시에만 hasBackup=false 로 내려 cleanup 경로 진입 허용.
    // 복원 실패 시에는 hasBackup=true 유지 → finally 에서도 backup 을 **삭제하지 않아** 수동 복구 가능.
    if (hasBackup) {
      try {
        await rename(backupPath, filePath);
        hasBackup = false;
      } catch (rollbackError) {
        // eslint-disable-next-line no-console — 사용자가 backup 존재를 인지해야 복구 가능
        console.warn(
          `[sync-hub-mcp-settings] atomic write rollback failed for ${filePath}: ${rollbackError?.message || rollbackError}. ` +
            `Original content preserved at: ${backupPath}`,
        );
      }
    }
    throw error;
  } finally {
    // tmp 는 항상 정리. backup 은 성공 경로/복원 경로에서만 명시적으로 rm 한다
    // (rollback 실패 시 hasBackup=true 상태로 남음 → 이 블록에서 절대 삭제하지 않음)
    await rm(tmpPath, { force: true }).catch(() => {});
  }
}

// #164 MEDIUM 2: TOML write 후 유효성 검증.
// write 직전 nextRaw 가 최소 구조 (섹션 헤더 + url= 키) 를 만족하는지 확인해
// 깨진 TOML 을 filesystem 에 반영하지 않는다.
function validateCodexTomlPayload(raw, sectionName) {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, reason: "empty payload" };
  }
  const section = findMcpServerSection(raw, sectionName);
  if (!section) {
    return { ok: false, reason: "missing section header" };
  }
  if (!/^\s*url\s*=\s*.+$/m.test(section.body)) {
    return { ok: false, reason: "missing url key" };
  }
  return { ok: true };
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
  // TOML 동치 표현 지원: [mcp_servers.name] / [mcp_servers."name"] / [mcp_servers . name]
  // 미검출 시 appendCodexMcpServerSection이 중복 테이블 생성 → TOMLDecodeError 회귀 방지.
  const escaped = escapeRegExp(sectionName);
  const headerRegex = new RegExp(
    `^\\[\\s*mcp_servers\\s*\\.\\s*(?:${escaped}|"${escaped}"|'${escaped}')\\s*\\]\\s*$`,
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

function appendCodexMcpServerSection(raw, sectionName, hubUrl) {
  const normalized = raw.length > 0 && !raw.endsWith("\n") ? `${raw}\n` : raw;
  const separator =
    normalized.length > 0 && !normalized.endsWith("\n\n") ? "\n" : "";
  return `${normalized}${separator}[mcp_servers.${sectionName}]\nurl = ${formatTomlString(hubUrl)}\n`;
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
      const nextRaw = appendCodexMcpServerSection(raw, TFX_HUB_SECTION, hubUrl);
      log(
        logger,
        "debug",
        `[codex-mcp-sync] ${filePath} add ${TFX_HUB_SECTION}: ${hubUrl}`,
      );

      if (!dryRun) {
        const validation = validateCodexTomlPayload(nextRaw, TFX_HUB_SECTION);
        if (!validation.ok) {
          const reason = `invalid toml payload: ${validation.reason}`;
          log(
            logger,
            "error",
            `[codex-mcp-sync] error: ${filePath} (${reason})`,
          );
          return { kind: "error", path: filePath, reason };
        }
        try {
          await writeTextAtomic(filePath, nextRaw);
        } catch (error) {
          const reason = getReason(error, "write failed");
          log(
            logger,
            "error",
            `[codex-mcp-sync] error: ${filePath} (${reason})`,
          );
          return { kind: "error", path: filePath, reason };
        }
      }

      log(logger, "info", `[codex-mcp-sync] updated: ${filePath}`);
      return { kind: "updated", path: filePath };
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
      const validation = validateCodexTomlPayload(nextRaw, TFX_HUB_SECTION);
      if (!validation.ok) {
        const reason = `invalid toml payload: ${validation.reason}`;
        log(logger, "error", `[codex-mcp-sync] error: ${filePath} (${reason})`);
        return { kind: "error", path: filePath, reason };
      }
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

    // Claude Code 는 현재 type:"http" 만 허용. 과거 type:"url" 엔트리는 스키마 오류로
    // project config parse 실패 → MCP 전체 연결 단절. url 일치만으로 skip 하면 legacy
    // type 이 영원히 안 고쳐진다. syncSingleFile (user-level settings) 이 type+url
    // 둘 다 보는 것과 동일 규약 적용.
    const typeOk = hubServer.type === "http";
    const urlOk = hubServer.url === hubUrl;
    if (typeOk && urlOk) {
      log(logger, "info", `[project-mcp-sync] skipped: ${filePath}`);
      return { kind: "skipped", path: filePath };
    }

    log(
      logger,
      "debug",
      `[project-mcp-sync] ${filePath} type:${String(hubServer.type)} url:${String(hubServer.url)} -> type:http url:${hubUrl}`,
    );

    if (!dryRun) {
      try {
        hubServer.type = "http";
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

  for (const filePath of getProjectMcpJsonPaths(projectRoot)) {
    const outcome = await syncProjectMcpFile({
      filePath,
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
  }

  return result;
}
