import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REGISTRY_PATH = join(PROJECT_ROOT, "config", "mcp-registry.json");
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const DEFAULT_HUB_PATH = "/mcp";
const DEFAULT_REGISTRY = Object.freeze({
  $schema: "mcp-registry-schema",
  version: 1,
  description: "MCP 서버 중앙 레지스트리 — 진실의 원천",
  defaults: {
    transport: "hub-url",
    hub_base: "http://127.0.0.1:27888",
  },
  servers: {
    "tfx-hub": {
      transport: "hub-url",
      url: "http://127.0.0.1:27888/mcp",
      safe: true,
      targets: ["claude", "gemini", "codex"],
      description: "triflux Hub MCP 서버",
    },
  },
  policies: {
    stdio_action: "replace-with-hub",
    unknown_server_action: "warn",
    watched_paths: [
      "~/.gemini/settings.json",
      "~/.codex/config.toml",
      "~/.claude/settings.json",
      "~/.claude/settings.local.json",
      ".mcp.json",
    ],
  },
});

function cloneDefaultRegistry() {
  return JSON.parse(JSON.stringify(DEFAULT_REGISTRY));
}

function expandHome(filePath) {
  if (typeof filePath !== "string") return "";
  if (!filePath.startsWith("~/") && !filePath.startsWith("~\\")) return filePath;
  return join(homedir(), filePath.slice(2));
}

function resolveFilePath(filePath) {
  const expanded = expandHome(filePath);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);
}

function normalizeForMatch(filePath) {
  return resolveFilePath(filePath).replace(/\\/g, "/").toLowerCase();
}

function pathBasename(filePath) {
  return basename(filePath.replace(/\\/g, "/")).toLowerCase();
}

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJsonFile(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function ensureBackup(filePath) {
  const backupPath = `${filePath}.bak`;
  copyFileSync(filePath, backupPath);
  return backupPath;
}

function isJsonMcpConfig(filePath) {
  const name = pathBasename(filePath);
  return name === "settings.json" || name === "settings.local.json" || name === ".mcp.json";
}

function isCodexConfig(filePath) {
  const normalized = normalizeForMatch(filePath);
  return normalized.endsWith("/.codex/config.toml");
}

function detectClient(filePath) {
  const normalized = normalizeForMatch(filePath);
  if (normalized.endsWith("/.gemini/settings.json")) return "gemini";
  if (normalized.endsWith("/.codex/config.toml")) return "codex";
  if (
    normalized.endsWith("/.claude/settings.json")
    || normalized.endsWith("/.claude/settings.local.json")
    || normalized.endsWith("/.mcp.json")
  ) {
    return "claude";
  }
  return "unknown";
}

function detectLabel(filePath) {
  const normalized = normalizeForMatch(filePath);
  if (normalized.endsWith("/.gemini/settings.json")) return "Gemini";
  if (normalized.endsWith("/.codex/config.toml")) return "Codex";
  if (normalized.endsWith("/.claude/settings.json")) return "Claude User";
  if (normalized.endsWith("/.claude/settings.local.json")) return "Claude Local";
  if (normalized.endsWith("/.mcp.json")) return "Project MCP";
  return basename(filePath);
}

function isPrimaryConfigTarget(filePath) {
  const normalized = normalizeForMatch(filePath);
  return normalized.endsWith("/.gemini/settings.json")
    || normalized.endsWith("/.codex/config.toml")
    || normalized.endsWith("/.mcp.json");
}

function normalizeUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value.trim());
    if (url.pathname !== "/" && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    return url.toString();
  } catch {
    return value.trim();
  }
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

function parseCodexMcpServers(raw) {
  const lines = String(raw || "").split(/\r?\n/);
  const servers = {};
  let currentName = null;

  for (const line of lines) {
    const sectionMatch = line.match(/^\s*\[mcp_servers\.([^\]]+)\]\s*$/);
    if (sectionMatch) {
      currentName = sectionMatch[1];
      servers[currentName] = {};
      continue;
    }

    if (/^\s*\[/.test(line)) {
      currentName = null;
      continue;
    }

    if (!currentName) continue;

    const kvMatch = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (!kvMatch) continue;
    servers[currentName][kvMatch[1]] = parseTomlScalar(kvMatch[2]);
  }

  return servers;
}

function removeTomlSection(raw, sectionName) {
  const lines = String(raw || "").split(/\r?\n/);
  const output = [];
  const header = `[mcp_servers.${sectionName}]`;
  let skipping = false;

  for (const line of lines) {
    if (line.trim() === header) {
      skipping = true;
      continue;
    }

    if (skipping && /^\s*\[/.test(line)) {
      skipping = false;
    }

    if (!skipping) output.push(line);
  }

  const cleaned = output.join("\n").replace(/\n{3,}$/g, "\n\n").replace(/^\n+/, "");
  return cleaned.length > 0 ? cleaned.replace(/\n{3,}/g, "\n\n") : "";
}

function upsertTomlUrlServer(raw, name, url) {
  const section = [
    `[mcp_servers.${name}]`,
    `url = ${formatTomlString(url)}`,
  ];
  const withoutExisting = removeTomlSection(raw, name).trimEnd();
  return withoutExisting.length > 0
    ? `${withoutExisting}\n\n${section.join("\n")}\n`
    : `${section.join("\n")}\n`;
}

function getHubServerEntry(registry) {
  const entries = Object.entries(registry?.servers || {});
  if (entries.length === 0) {
    return ["tfx-hub", { url: `${registry?.defaults?.hub_base || "http://127.0.0.1:27888"}${DEFAULT_HUB_PATH}` }];
  }

  return entries.find(([name]) => name === "tfx-hub")
    || entries.find(([, config]) => config?.transport === "hub-url")
    || entries[0];
}

function makeHubRuntimeConfig() {
  return { url: resolveHubUrl() };
}

function serverTargets(serverConfig) {
  if (Array.isArray(serverConfig?.targets) && serverConfig.targets.length > 0) {
    return [...new Set(serverConfig.targets.map((value) => String(value).trim()).filter(Boolean))];
  }
  return ["claude", "gemini", "codex"];
}

function serverAppliesToClient(serverConfig, client) {
  return serverTargets(serverConfig).includes(client);
}

function buildDesiredServerRecord(name, serverConfig, filePath) {
  const url = serverConfig?.transport === "hub-url"
    ? resolveHubUrl()
    : normalizeUrl(serverConfig?.url || "");
  const basenameValue = pathBasename(filePath);

  if (basenameValue === ".mcp.json") {
    return { name, config: { type: "url", url } };
  }

  if (isCodexConfig(filePath)) {
    return { name, config: { url } };
  }

  return { name, config: { url } };
}

function scanJsonConfig(filePath) {
  if (!existsSync(filePath)) {
    return {
      filePath,
      client: detectClient(filePath),
      label: detectLabel(filePath),
      exists: false,
      parseError: null,
      servers: [],
      stdioServers: [],
    };
  }

  try {
    const parsed = readJsonFile(filePath);
    const mcpServers = parsed?.mcpServers;
    const servers = !mcpServers || typeof mcpServers !== "object"
      ? []
      : Object.entries(mcpServers)
        .filter(([name, config]) => typeof name === "string" && config && typeof config === "object")
        .map(([name, config]) => ({
          name: name.trim(),
          url: typeof config.url === "string" ? normalizeUrl(config.url) : "",
          command: typeof config.command === "string" ? config.command : "",
          type: typeof config.type === "string" ? config.type : "",
          transport: typeof config.url === "string" && config.url
            ? "url"
            : typeof config.command === "string" && config.command
              ? "stdio"
              : "unknown",
          raw: config,
        }));

    return {
      filePath,
      client: detectClient(filePath),
      label: detectLabel(filePath),
      exists: true,
      parseError: null,
      servers,
      stdioServers: servers.filter((server) => server.transport === "stdio"),
    };
  } catch (error) {
    return {
      filePath,
      client: detectClient(filePath),
      label: detectLabel(filePath),
      exists: true,
      parseError: error,
      servers: [],
      stdioServers: [],
    };
  }
}

function scanCodexConfig(filePath) {
  if (!existsSync(filePath)) {
    return {
      filePath,
      client: detectClient(filePath),
      label: detectLabel(filePath),
      exists: false,
      parseError: null,
      servers: [],
      stdioServers: [],
    };
  }

  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = parseCodexMcpServers(raw);
    const servers = Object.entries(parsed).map(([name, config]) => ({
      name,
      url: typeof config.url === "string" ? normalizeUrl(config.url) : "",
      command: typeof config.command === "string" ? config.command : "",
      transport: typeof config.url === "string" && config.url
        ? "url"
        : typeof config.command === "string" && config.command
          ? "stdio"
          : "unknown",
      raw: config,
    }));

    return {
      filePath,
      client: detectClient(filePath),
      label: detectLabel(filePath),
      exists: true,
      parseError: null,
      servers,
      // Wave 1/2-B: Codex stdio servers are observed but not auto-remediated.
      stdioServers: [],
    };
  } catch (error) {
    return {
      filePath,
      client: detectClient(filePath),
      label: detectLabel(filePath),
      exists: true,
      parseError: error,
      servers: [],
      stdioServers: [],
    };
  }
}

function updateJsonConfig(filePath, updates = [], removals = []) {
  const resolvedPath = resolveFilePath(filePath);
  let parsed = {};

  if (existsSync(resolvedPath)) {
    parsed = readJsonFile(resolvedPath);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    parsed = {};
  }

  if (!parsed.mcpServers || typeof parsed.mcpServers !== "object" || Array.isArray(parsed.mcpServers)) {
    parsed.mcpServers = {};
  }

  let modified = false;

  for (const name of removals) {
    if (Object.hasOwn(parsed.mcpServers, name)) {
      delete parsed.mcpServers[name];
      modified = true;
    }
  }

  for (const update of updates) {
    const current = parsed.mcpServers[update.name];
    const nextConfig = { ...(current && typeof current === "object" ? current : {}), ...update.config };
    const changed = JSON.stringify(current || null) !== JSON.stringify(nextConfig);
    if (changed) {
      parsed.mcpServers[update.name] = nextConfig;
      modified = true;
    }
  }

  if (!modified) {
    return { modified: false, filePath: resolvedPath };
  }

  writeJsonFile(resolvedPath, parsed);
  return { modified: true, filePath: resolvedPath };
}

function updateCodexConfig(filePath, updates = [], removals = []) {
  const resolvedPath = resolveFilePath(filePath);
  let raw = existsSync(resolvedPath) ? readFileSync(resolvedPath, "utf8") : "";

  for (const name of removals) {
    raw = removeTomlSection(raw, name);
  }

  for (const update of updates) {
    raw = upsertTomlUrlServer(raw, update.name, update.config.url);
  }

  const finalRaw = raw.trim().length > 0 ? `${raw.trimEnd()}\n` : "";
  const previousRaw = existsSync(resolvedPath) ? readFileSync(resolvedPath, "utf8") : "";
  if (finalRaw === previousRaw) {
    return { modified: false, filePath: resolvedPath };
  }

  mkdirSync(dirname(resolvedPath), { recursive: true });
  writeFileSync(resolvedPath, finalRaw, "utf8");
  return { modified: true, filePath: resolvedPath };
}

function scanConfig(filePath) {
  const resolvedPath = resolveFilePath(filePath);
  if (isCodexConfig(resolvedPath)) return scanCodexConfig(resolvedPath);
  if (isJsonMcpConfig(resolvedPath)) return scanJsonConfig(resolvedPath);

  return {
    filePath: resolvedPath,
    client: detectClient(resolvedPath),
    label: detectLabel(resolvedPath),
    exists: existsSync(resolvedPath),
    parseError: null,
    servers: [],
    stdioServers: [],
  };
}

export function getRegistryPath() {
  return REGISTRY_PATH;
}

export function createDefaultRegistry() {
  return cloneDefaultRegistry();
}

export function validateRegistry(registry) {
  const errors = [];
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    return ["registry must be an object"];
  }

  if (registry.version !== 1) {
    errors.push("registry.version must be 1");
  }

  if (!registry.defaults || typeof registry.defaults !== "object") {
    errors.push("registry.defaults must be an object");
  }

  if (!registry.servers || typeof registry.servers !== "object" || Array.isArray(registry.servers)) {
    errors.push("registry.servers must be an object");
  } else {
    for (const [name, server] of Object.entries(registry.servers)) {
      if (!name.trim()) {
        errors.push("registry.servers contains an empty name");
        continue;
      }
      if (!server || typeof server !== "object" || Array.isArray(server)) {
        errors.push(`registry.servers.${name} must be an object`);
        continue;
      }
      if (typeof server.url !== "string" || !server.url.trim()) {
        errors.push(`registry.servers.${name}.url must be a non-empty string`);
      }
      if (server.targets !== undefined && !Array.isArray(server.targets)) {
        errors.push(`registry.servers.${name}.targets must be an array`);
      }
    }
  }

  if (!registry.policies || typeof registry.policies !== "object" || Array.isArray(registry.policies)) {
    errors.push("registry.policies must be an object");
  } else {
    if (!Array.isArray(registry.policies.watched_paths)) {
      errors.push("registry.policies.watched_paths must be an array");
    }
    if (registry.policies.stdio_action && !["replace-with-hub", "warn"].includes(registry.policies.stdio_action)) {
      errors.push("registry.policies.stdio_action must be replace-with-hub or warn");
    }
  }

  return errors;
}

export function inspectRegistry() {
  if (!existsSync(REGISTRY_PATH)) {
    return {
      path: REGISTRY_PATH,
      exists: false,
      valid: false,
      errors: ["registry file missing"],
      registry: null,
    };
  }

  try {
    const registry = readJsonFile(REGISTRY_PATH);
    const errors = validateRegistry(registry);
    return {
      path: REGISTRY_PATH,
      exists: true,
      valid: errors.length === 0,
      errors,
      registry: errors.length === 0 ? registry : null,
    };
  } catch (error) {
    return {
      path: REGISTRY_PATH,
      exists: true,
      valid: false,
      errors: [error.message],
      registry: null,
    };
  }
}

export function loadRegistry() {
  const state = inspectRegistry();
  if (!state.exists) {
    throw new Error(`MCP registry missing: ${state.path}`);
  }
  if (!state.valid) {
    throw new Error(`MCP registry invalid: ${state.errors.join("; ")}`);
  }
  return {
    ...state.registry,
    defaults: { ...(state.registry?.defaults || {}) },
    servers: { ...(state.registry?.servers || {}) },
    policies: { ...(state.registry?.policies || {}) },
  };
}

export function loadRegistryOrDefault() {
  const state = inspectRegistry();
  if (!state.exists) return cloneDefaultRegistry();
  if (!state.valid) return cloneDefaultRegistry();
  return {
    ...state.registry,
    defaults: { ...(state.registry?.defaults || {}) },
    servers: { ...(state.registry?.servers || {}) },
    policies: { ...(state.registry?.policies || {}) },
  };
}

export function saveRegistry(registry) {
  const errors = validateRegistry(registry);
  if (errors.length > 0) {
    throw new Error(`MCP registry invalid: ${errors.join("; ")}`);
  }
  writeJsonFile(REGISTRY_PATH, registry);
  return registry;
}

export function listManagedConfigTargets(registry = loadRegistryOrDefault()) {
  return (registry?.policies?.watched_paths || []).map((watchedPath) => {
    const filePath = resolveFilePath(watchedPath);
    return {
      watchedPath,
      filePath,
      client: detectClient(filePath),
      label: detectLabel(filePath),
      exists: existsSync(filePath),
    };
  });
}

export function listPrimaryConfigTargets(registry = loadRegistryOrDefault()) {
  return listManagedConfigTargets(registry).filter((target) => isPrimaryConfigTarget(target.filePath));
}

export function scanManagedConfigs(registry = loadRegistryOrDefault()) {
  return listManagedConfigTargets(registry).map((target) => ({
    ...target,
    ...scanConfig(target.filePath),
  }));
}

export function inspectRegistryStatus(registry = loadRegistryOrDefault()) {
  const configs = scanManagedConfigs(registry);
  const primaryTargets = new Set(listPrimaryConfigTargets(registry).map((target) => normalizeForMatch(target.filePath)));
  const rows = [];

  for (const config of configs) {
    const isPrimary = primaryTargets.has(normalizeForMatch(config.filePath));
    const managedServers = Object.entries(registry.servers || {})
      .filter(([, serverConfig]) => isPrimary && serverAppliesToClient(serverConfig, config.client));

    for (const [name, serverConfig] of managedServers) {
      const expectedUrl = buildDesiredServerRecord(name, serverConfig, config.filePath).config.url;
      const actual = config.servers.find((server) => server.name === name) || null;
      let status = "missing";

      if (!config.exists) {
        status = "missing-file";
      } else if (config.parseError) {
        status = "invalid-config";
      } else if (!actual) {
        status = "missing";
      } else if (!actual.url) {
        status = actual.transport === "stdio" ? "stdio" : "invalid";
      } else if (normalizeUrl(actual.url) === normalizeUrl(expectedUrl)) {
        status = "present";
      } else {
        status = "mismatch";
      }

      rows.push({
        type: "registry",
        name,
        client: config.client,
        label: config.label,
        filePath: config.filePath,
        expectedUrl,
        actualUrl: actual?.url || "",
        status,
      });
    }

    for (const server of config.stdioServers) {
      if (Object.hasOwn(registry.servers || {}, server.name)) continue;
      rows.push({
        type: "stdio",
        name: server.name,
        client: config.client,
        label: config.label,
        filePath: config.filePath,
        expectedUrl: "",
        actualUrl: "",
        status: "warning",
        command: server.command,
      });
    }
  }

  return {
    registry,
    configs,
    rows,
  };
}

export function scanForStdioServers(filePath) {
  return scanConfig(filePath).stdioServers;
}

export function remediate(filePath, stdioServers, policy = {}) {
  const resolvedPath = resolveFilePath(filePath);
  const offenders = Array.isArray(stdioServers) ? stdioServers.filter((server) => server?.name) : [];
  const action = policy?.stdio_action || "warn";

  if (offenders.length === 0) {
    return {
      action: "noop",
      modified: false,
      backupPath: null,
      removedServers: [],
      warnings: [],
    };
  }

  if (action === "warn") {
    return {
      action,
      modified: false,
      backupPath: null,
      removedServers: [],
      warnings: [
        `[mcp-guard] stdio MCP 감지: ${offenders.map((server) => server.name).join(", ")}`,
      ],
    };
  }

  if (isCodexConfig(resolvedPath)) {
    return {
      action,
      modified: false,
      backupPath: null,
      removedServers: [],
      warnings: ["[mcp-guard] Codex TOML 자동 수정은 Wave 2-B 범위 밖입니다."],
    };
  }

  const snapshot = scanConfig(resolvedPath);
  if (snapshot.parseError) {
    return {
      action,
      modified: false,
      backupPath: null,
      removedServers: [],
      warnings: [`[mcp-guard] 설정 파싱 실패: ${snapshot.parseError.message}`],
    };
  }

  let backupPath = null;
  try {
    if (existsSync(resolvedPath)) backupPath = ensureBackup(resolvedPath);
  } catch (error) {
    return {
      action,
      modified: false,
      backupPath: null,
      removedServers: [],
      warnings: [`[mcp-guard] 백업 생성 실패: ${error.message}`],
    };
  }

  const removals = offenders.map((server) => server.name);
  const updates = [];
  let replacement = null;

  if (action === "replace-with-hub") {
    const registry = loadRegistryOrDefault();
    const [hubServerName, hubServerConfig] = getHubServerEntry(registry);
    const desired = buildDesiredServerRecord(hubServerName, hubServerConfig, resolvedPath);
    replacement = { name: desired.name, ...desired.config };
    updates.push(desired);
  }

  const result = updateJsonConfig(resolvedPath, updates, removals);
  return {
    action,
    modified: result.modified,
    backupPath,
    removedServers: removals,
    replacement,
    warnings: [],
  };
}

export function resolveHubUrl() {
  const registryState = inspectRegistry();
  const registry = registryState.valid ? registryState.registry : cloneDefaultRegistry();
  const [, hubServer] = getHubServerEntry(registry);
  const fallbackRaw = hubServer?.url || `${registry?.defaults?.hub_base || "http://127.0.0.1:27888"}${DEFAULT_HUB_PATH}`;

  let fallback;
  try {
    fallback = new URL(fallbackRaw);
  } catch {
    fallback = new URL(`http://127.0.0.1:27888${DEFAULT_HUB_PATH}`);
  }

  const envPortRaw = Number(process.env.TFX_HUB_PORT || "");
  const envPort = Number.isFinite(envPortRaw) && envPortRaw > 0 ? envPortRaw : null;
  const target = {
    protocol: fallback.protocol || "http:",
    host: fallback.hostname || "127.0.0.1",
    port: envPort || Number(fallback.port || 27888),
    pathname: fallback.pathname && fallback.pathname !== "/" ? fallback.pathname : DEFAULT_HUB_PATH,
  };

  const hubPidPath = join(homedir(), ".claude", "cache", "tfx-hub", "hub.pid");
  if (existsSync(hubPidPath)) {
    try {
      const info = readJsonFile(hubPidPath);
      if (!envPort) {
        const pidPort = Number(info?.port);
        if (Number.isFinite(pidPort) && pidPort > 0) target.port = pidPort;
      }
      if (typeof info?.host === "string") {
        const host = info.host.trim();
        if (LOOPBACK_HOSTS.has(host)) target.host = host;
      }
    } catch {
      // pid 파일 파싱 실패 시 registry 기본값 사용
    }
  }

  const hostPart = target.host.includes(":") ? `[${target.host}]` : target.host;
  return `${target.protocol}//${hostPart}:${target.port}${target.pathname}`;
}

export function isWatchedPath(filePath) {
  const registryState = inspectRegistry();
  const registry = registryState.valid ? registryState.registry : cloneDefaultRegistry();
  const candidate = normalizeForMatch(filePath);

  return (registry?.policies?.watched_paths || []).some((watchedPath) => {
    if (typeof watchedPath !== "string" || !watchedPath.trim()) return false;

    const trimmed = watchedPath.trim();
    const expanded = expandHome(trimmed);

    if (trimmed !== expanded || isAbsolute(expanded)) {
      return candidate === normalizeForMatch(expanded);
    }

    if (!trimmed.includes("/") && !trimmed.includes("\\")) {
      return pathBasename(candidate) === trimmed.toLowerCase();
    }

    const suffix = trimmed.replace(/^[.][\\/]/, "").replace(/\\/g, "/").toLowerCase();
    return candidate.endsWith(`/${suffix}`);
  });
}

export function addRegistryServer(name, url, options = {}) {
  const trimmedName = String(name || "").trim();
  const normalizedUrl = normalizeUrl(url);
  if (!trimmedName) throw new Error("server name is required");
  if (!normalizedUrl) throw new Error("server url is required");

  const registryState = inspectRegistry();
  const registry = registryState.valid ? loadRegistry() : cloneDefaultRegistry();
  const transport = options.transport || (trimmedName === "tfx-hub" ? "hub-url" : "url");

  registry.servers[trimmedName] = {
    transport,
    url: normalizedUrl,
    safe: options.safe ?? true,
    targets: Array.isArray(options.targets) && options.targets.length > 0
      ? [...new Set(options.targets.map((value) => String(value).trim()).filter(Boolean))]
      : ["claude", "gemini", "codex"],
    description: options.description || `${trimmedName} MCP 서버`,
  };

  saveRegistry(registry);
  return registry.servers[trimmedName];
}

export function removeRegistryServer(name) {
  const trimmedName = String(name || "").trim();
  if (!trimmedName) throw new Error("server name is required");

  const state = inspectRegistry();
  if (!state.exists || !state.valid) return null;
  const registry = loadRegistry();
  const existing = registry.servers[trimmedName] || null;
  if (existing) {
    delete registry.servers[trimmedName];
    saveRegistry(registry);
  }

  return existing;
}

export function removeServerFromTargets(name, options = {}) {
  const trimmedName = String(name || "").trim();
  if (!trimmedName) throw new Error("server name is required");

  const registry = options.registry || (inspectRegistry().valid ? loadRegistry() : cloneDefaultRegistry());
  const targetsFilter = Array.isArray(options.targets) && options.targets.length > 0
    ? new Set(options.targets)
    : null;
  const actions = [];

  for (const target of listManagedConfigTargets(registry)) {
    if (targetsFilter && !targetsFilter.has(target.client)) continue;

    const snapshot = scanConfig(target.filePath);
    if (snapshot.parseError) {
      actions.push({
        type: "remove",
        name: trimmedName,
        filePath: target.filePath,
        label: target.label,
        status: "invalid-config",
        message: snapshot.parseError.message,
      });
      continue;
    }

    let result;
    if (isCodexConfig(target.filePath)) {
      result = updateCodexConfig(target.filePath, [], [trimmedName]);
    } else if (isJsonMcpConfig(target.filePath)) {
      result = updateJsonConfig(target.filePath, [], [trimmedName]);
    } else {
      continue;
    }

    actions.push({
      type: "remove",
      name: trimmedName,
      filePath: target.filePath,
      label: target.label,
      status: result.modified ? "removed" : "noop",
    });
  }

  return { actions };
}

export function syncRegistryTargets(options = {}) {
  const registry = options.registry || loadRegistryOrDefault();
  const actions = [];

  for (const target of listManagedConfigTargets(registry)) {
    const snapshot = scanConfig(target.filePath);
    if (snapshot.parseError) {
      actions.push({
        type: "sync",
        filePath: target.filePath,
        label: target.label,
        status: "invalid-config",
        message: snapshot.parseError.message,
      });
      continue;
    }

    if (snapshot.stdioServers.length > 0) {
      const remediation = remediate(target.filePath, snapshot.stdioServers, registry.policies);
      actions.push({
        type: "remediate",
        filePath: target.filePath,
        label: target.label,
        status: remediation.modified ? "updated" : "warning",
        removedServers: remediation.removedServers,
        replacement: remediation.replacement || null,
        warnings: remediation.warnings || [],
      });
    }
  }

  for (const target of listPrimaryConfigTargets(registry)) {
    const updates = Object.entries(registry.servers || {})
      .filter(([, serverConfig]) => serverAppliesToClient(serverConfig, target.client))
      .map(([name, serverConfig]) => buildDesiredServerRecord(name, serverConfig, target.filePath));

    if (updates.length === 0) continue;

    let result;
    if (isCodexConfig(target.filePath)) {
      result = updateCodexConfig(target.filePath, updates, []);
    } else if (isJsonMcpConfig(target.filePath)) {
      result = updateJsonConfig(target.filePath, updates, []);
    } else {
      continue;
    }

    actions.push({
      type: "sync",
      filePath: target.filePath,
      label: target.label,
      status: result.modified ? "updated" : "ok",
      serverCount: updates.length,
    });
  }

  return { actions };
}
