import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_REGISTRY_PATH = join(PROJECT_ROOT, "config", "mcp-registry.json");
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
  policy_notes: {
    transport:
      'Server transport accepts "hub-url" for the existing triflux Hub URL flow or "http" for direct Streamable HTTP MCP endpoints. Direct stdio registration via command/args is intentionally unsupported.',
    headers:
      'Optional headers are allowed only for HTTP-compatible transports. Each header value must be a descriptor: {"value":"literal"} for non-secret static values, {"env":"ENV_VAR_NAME"} for secrets resolved at sync/runtime, or {"env":"ENV_VAR_NAME","prefix":"Bearer "} for common authorization formats.',
    secret_safety:
      "Resolved secret values must not be written back to this registry file. Missing env vars warn during sync and do not emit empty secret headers.",
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
    sync_denylist: [],
    watched_paths: [
      "~/.gemini/settings.json",
      "~/.codex/config.toml",
      "~/.claude/settings.json",
      "~/.claude/settings.local.json",
      ".claude/mcp.json",
      ".mcp.json",
    ],
  },
});

function cloneDefaultRegistry() {
  return JSON.parse(JSON.stringify(DEFAULT_REGISTRY));
}

function expandHome(filePath) {
  if (typeof filePath !== "string") return "";
  if (!filePath.startsWith("~/") && !filePath.startsWith("~\\"))
    return filePath;
  return join(homedir(), filePath.slice(2));
}

function resolveFilePath(filePath) {
  const expanded = expandHome(filePath);
  return isAbsolute(expanded)
    ? resolve(expanded)
    : resolve(process.cwd(), expanded);
}

function normalizeForMatch(filePath) {
  return resolveFilePath(filePath).replace(/\\/g, "/").toLowerCase();
}

function pathBasename(filePath) {
  return basename(filePath.replace(/\\/g, "/")).toLowerCase();
}

function isClaudeProjectMcpConfig(filePath) {
  return normalizeForMatch(filePath).endsWith("/.claude/mcp.json");
}

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJsonFile(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function registryPath() {
  return process.env.TFX_MCP_REGISTRY_PATH
    ? resolve(process.env.TFX_MCP_REGISTRY_PATH)
    : DEFAULT_REGISTRY_PATH;
}

function ensureBackup(filePath) {
  const backupPath = `${filePath}.bak`;
  copyFileSync(filePath, backupPath);
  return backupPath;
}

function isJsonMcpConfig(filePath) {
  const name = pathBasename(filePath);
  return (
    name === "settings.json" ||
    name === "settings.local.json" ||
    name === ".mcp.json" ||
    isClaudeProjectMcpConfig(filePath)
  );
}

function isCodexConfig(filePath) {
  const normalized = normalizeForMatch(filePath);
  return normalized.endsWith("/.codex/config.toml");
}

function isProtectedCodexConfigMutationEnv(env = process.env) {
  return env.NODE_ENV === "test" || env.CI === "true" || env.TFX_TEST === "1";
}

function shouldSkipCodexConfigMutation() {
  return (
    process.env.TFX_CODEX_CONFIG_SYNC !== "1" &&
    isProtectedCodexConfigMutationEnv()
  );
}

function detectClient(filePath) {
  const normalized = normalizeForMatch(filePath);
  if (normalized.endsWith("/.gemini/settings.json")) return "gemini";
  if (normalized.endsWith("/.codex/config.toml")) return "codex";
  if (
    normalized.endsWith("/.claude/settings.json") ||
    normalized.endsWith("/.claude/settings.local.json") ||
    normalized.endsWith("/.claude/mcp.json") ||
    normalized.endsWith("/.mcp.json")
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
  if (normalized.endsWith("/.claude/settings.local.json"))
    return "Claude Local";
  if (normalized.endsWith("/.claude/mcp.json")) return "Claude Project MCP";
  if (normalized.endsWith("/.mcp.json")) return "Project MCP";
  return basename(filePath);
}

function isPrimaryConfigTarget(filePath) {
  const normalized = normalizeForMatch(filePath);
  return (
    normalized.endsWith("/.gemini/settings.json") ||
    normalized.endsWith("/.codex/config.toml") ||
    normalized.endsWith("/.claude/mcp.json") ||
    normalized.endsWith("/.mcp.json")
  );
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
  if (value.startsWith("{") && value.endsWith("}")) {
    return parseTomlInlineTable(value);
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return value;
}

function parseTomlInlineTable(rawValue) {
  const source = String(rawValue || "").trim();
  const body = source.slice(1, -1).trim();
  if (!body) return {};

  const parts = [];
  let current = "";
  let inString = false;
  let escaped = false;
  for (const char of body) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && inString) {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '"') inString = !inString;
    if (char === "," && !inString) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());

  const table = {};
  for (const part of parts) {
    const match = part.match(
      /^\s*(?:"((?:\\"|[^"])*)"|([A-Za-z0-9_-]+))\s*=\s*(.+?)\s*$/,
    );
    if (!match) continue;
    const key = (match[1] || match[2] || "")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
    table[key] = parseTomlScalar(match[3]);
  }
  return table;
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

function isValidHeaderName(name) {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(String(name || ""));
}

function normalizeHeaderDescriptors(headers = {}) {
  const normalized = {};
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return normalized;
  }
  for (const [name, descriptor] of Object.entries(headers)) {
    if (!isValidHeaderName(name)) continue;
    if (
      descriptor &&
      typeof descriptor === "object" &&
      !Array.isArray(descriptor)
    ) {
      if (
        Object.hasOwn(descriptor, "value") &&
        typeof descriptor.value === "string"
      ) {
        normalized[name] = { value: descriptor.value };
      } else if (
        Object.hasOwn(descriptor, "env") &&
        typeof descriptor.env === "string" &&
        descriptor.env.trim()
      ) {
        normalized[name] = { env: descriptor.env.trim() };
        if (typeof descriptor.prefix === "string") {
          normalized[name].prefix = descriptor.prefix;
        }
      }
    }
  }
  return normalized;
}

function resolveHeaderDescriptors(name, serverConfig, filePath) {
  const descriptors = normalizeHeaderDescriptors(serverConfig?.headers || {});
  const headers = {};
  const warnings = [];
  const codex = {
    bearer_token_env_var: null,
    env_http_headers: {},
    http_headers: {},
  };
  const codexTarget = isCodexConfig(filePath);

  for (const [headerName, descriptor] of Object.entries(descriptors)) {
    if (Object.hasOwn(descriptor, "value")) {
      headers[headerName] = descriptor.value;
      if (codexTarget) codex.http_headers[headerName] = descriptor.value;
      continue;
    }

    const envName = descriptor.env;
    const envValue = process.env[envName];
    const prefix = descriptor.prefix || "";
    if (typeof envValue !== "string" || envValue.length === 0) {
      warnings.push(
        `[mcp-guard] ${name}.${headerName} header skipped: env ${envName} is not set`,
      );
      continue;
    }

    headers[headerName] = `${prefix}${envValue}`;

    if (!codexTarget) continue;

    if (
      headerName.toLowerCase() === "authorization" &&
      /^Bearer\s+$/i.test(prefix)
    ) {
      codex.bearer_token_env_var = envName;
    } else if (!prefix) {
      codex.env_http_headers[headerName] = envName;
    } else {
      codex.http_headers[headerName] = `${prefix}${envValue}`;
      warnings.push(
        `[mcp-guard] ${name}.${headerName} header uses resolved literal in Codex TOML because prefixed env headers are unsupported`,
      );
    }
  }

  return {
    descriptors,
    headers,
    warnings,
    codex: {
      ...(codex.bearer_token_env_var
        ? { bearer_token_env_var: codex.bearer_token_env_var }
        : {}),
      env_http_headers: codex.env_http_headers,
      http_headers: codex.http_headers,
    },
  };
}

function hasOwnEntries(value) {
  return value && typeof value === "object" && Object.keys(value).length > 0;
}

function redactHeaders(headers = {}) {
  const redacted = {};
  for (const key of Object.keys(headers || {})) {
    redacted[key] = "***REDACTED***";
  }
  return redacted;
}

function redactServerConfig(config = {}) {
  if (!config || typeof config !== "object") return config;
  return {
    ...config,
    ...(config.headers ? { headers: redactHeaders(config.headers) } : {}),
  };
}

function descriptorsFromCodexConfig(config = {}) {
  const descriptors = {};
  if (typeof config.bearer_token_env_var === "string") {
    descriptors.Authorization = {
      env: config.bearer_token_env_var,
      prefix: "Bearer ",
    };
  }
  if (config.env_http_headers && typeof config.env_http_headers === "object") {
    for (const [name, envName] of Object.entries(config.env_http_headers)) {
      if (typeof envName === "string") descriptors[name] = { env: envName };
    }
  }
  if (config.http_headers && typeof config.http_headers === "object") {
    for (const [name, value] of Object.entries(config.http_headers)) {
      if (typeof value === "string") descriptors[name] = { value };
    }
  }
  return descriptors;
}

function descriptorsFromJsonConfig(config = {}) {
  const descriptors = {};
  if (!config?.headers || typeof config.headers !== "object") {
    return descriptors;
  }
  for (const [name, value] of Object.entries(config.headers)) {
    if (typeof value === "string") descriptors[name] = { value };
  }
  return descriptors;
}

function headerNames(headers = {}) {
  return Object.keys(headers || {}).sort();
}

function sameHeaderDescriptors(left = {}, right = {}) {
  const leftNames = headerNames(left);
  const rightNames = headerNames(right);
  if (JSON.stringify(leftNames) !== JSON.stringify(rightNames)) return false;
  return leftNames.every(
    (name) => JSON.stringify(left[name]) === JSON.stringify(right[name]),
  );
}

function headerStatus(expected = {}, actual = {}) {
  const expectedNames = headerNames(expected);
  const actualNames = headerNames(actual);
  if (expectedNames.length === 0 && actualNames.length === 0) return "ok";
  if (expectedNames.some((name) => !Object.hasOwn(actual, name))) {
    return "missing";
  }
  if (!sameHeaderDescriptors(expected, actual)) return "stale";
  return "ok";
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

  const cleaned = output
    .join("\n")
    .replace(/\n{3,}$/g, "\n\n")
    .replace(/^\n+/, "");
  return cleaned.length > 0 ? cleaned.replace(/\n{3,}/g, "\n\n") : "";
}

function formatTomlInlineTable(data = {}) {
  const entries = Object.entries(data);
  if (entries.length === 0) return null;
  return `{ ${entries
    .map(
      ([key, value]) => `${formatTomlString(key)} = ${formatTomlString(value)}`,
    )
    .join(", ")} }`;
}

function upsertTomlServer(raw, name, config, codex = {}) {
  const lines = String(raw || "").split(/\r?\n/);
  const header = `[mcp_servers.${name}]`;
  const managedKeys = new Set([
    "url",
    "command",
    "args",
    "bearer_token_env_var",
    "http_headers",
    "env_http_headers",
  ]);
  const nextManagedLines = [`url = ${formatTomlString(config.url)}`];
  if (codex.bearer_token_env_var) {
    nextManagedLines.push(
      `bearer_token_env_var = ${formatTomlString(codex.bearer_token_env_var)}`,
    );
  }
  const httpHeaders = formatTomlInlineTable(codex.http_headers || {});
  if (httpHeaders) nextManagedLines.push(`http_headers = ${httpHeaders}`);
  const envHttpHeaders = formatTomlInlineTable(codex.env_http_headers || {});
  if (envHttpHeaders) {
    nextManagedLines.push(`env_http_headers = ${envHttpHeaders}`);
  }

  const sectionStart = lines.findIndex((line) => line.trim() === header);
  if (sectionStart < 0) {
    const section = [header, ...nextManagedLines].join("\n");
    const withoutTrailing = String(raw || "").trimEnd();
    return withoutTrailing.length > 0
      ? `${withoutTrailing}\n\n${section}\n`
      : `${section}\n`;
  }

  const output = [];
  for (let index = 0; index < lines.length; index += 1) {
    output.push(lines[index]);
    if (index !== sectionStart) continue;

    index += 1;
    const preserved = [];
    while (index < lines.length && !/^\s*\[/.test(lines[index])) {
      const keyMatch = lines[index].match(/^\s*([A-Za-z0-9_]+)\s*=/);
      if (!keyMatch || !managedKeys.has(keyMatch[1])) {
        preserved.push(lines[index]);
      }
      index += 1;
    }
    output.push(...nextManagedLines, ...preserved.filter(Boolean));
    index -= 1;
  }

  return output.join("\n");
}

function getHubServerEntry(registry) {
  const entries = Object.entries(registry?.servers || {});
  if (entries.length === 0) {
    return [
      "tfx-hub",
      {
        url: `${registry?.defaults?.hub_base || "http://127.0.0.1:27888"}${DEFAULT_HUB_PATH}`,
      },
    ];
  }

  return (
    entries.find(([name]) => name === "tfx-hub") ||
    entries.find(([, config]) => config?.transport === "hub-url") ||
    entries[0]
  );
}

function _makeHubRuntimeConfig() {
  return { url: resolveHubUrl() };
}

function serverTargets(serverConfig) {
  if (Array.isArray(serverConfig?.targets) && serverConfig.targets.length > 0) {
    return [
      ...new Set(
        serverConfig.targets
          .map((value) => String(value).trim())
          .filter(Boolean),
      ),
    ];
  }
  return ["claude", "gemini", "codex"];
}

function serverAppliesToClient(serverConfig, client) {
  return serverTargets(serverConfig).includes(client);
}

function syncDenylistEntries(policy = {}) {
  if (!Array.isArray(policy?.sync_denylist)) return new Set();
  return new Set(
    policy.sync_denylist
      .map((entry) =>
        String(entry || "")
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean),
  );
}

function syncDenylistKey(client, serverName) {
  return `${String(client || "")
    .trim()
    .toLowerCase()}:${String(serverName || "")
    .trim()
    .toLowerCase()}`;
}

export function buildDesiredServerRecord(name, serverConfig, filePath) {
  const url =
    serverConfig?.transport === "hub-url"
      ? resolveHubUrl()
      : normalizeUrl(serverConfig?.url || "");
  const basenameValue = pathBasename(filePath);
  const resolvedHeaders = resolveHeaderDescriptors(
    name,
    serverConfig,
    filePath,
  );
  const headerConfig = hasOwnEntries(resolvedHeaders.headers)
    ? { headers: resolvedHeaders.headers }
    : {};

  if (basenameValue === ".mcp.json" || isClaudeProjectMcpConfig(filePath)) {
    return {
      name,
      config: { type: "http", url, ...headerConfig },
      headerDescriptors: resolvedHeaders.descriptors,
      codex: resolvedHeaders.codex,
      warnings: resolvedHeaders.warnings,
    };
  }

  if (isCodexConfig(filePath)) {
    return {
      name,
      config: { url, ...headerConfig },
      headerDescriptors: resolvedHeaders.descriptors,
      codex: resolvedHeaders.codex,
      warnings: resolvedHeaders.warnings,
    };
  }

  return {
    name,
    config: { url, ...headerConfig },
    headerDescriptors: resolvedHeaders.descriptors,
    codex: resolvedHeaders.codex,
    warnings: resolvedHeaders.warnings,
  };
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
    const servers =
      !mcpServers || typeof mcpServers !== "object"
        ? []
        : Object.entries(mcpServers)
            .filter(
              ([name, config]) =>
                typeof name === "string" &&
                config &&
                typeof config === "object",
            )
            .map(([name, config]) => ({
              name: name.trim(),
              url:
                typeof config.url === "string" ? normalizeUrl(config.url) : "",
              command: typeof config.command === "string" ? config.command : "",
              type: typeof config.type === "string" ? config.type : "",
              headers:
                config.headers &&
                typeof config.headers === "object" &&
                !Array.isArray(config.headers)
                  ? Object.fromEntries(
                      Object.entries(config.headers).filter(
                        ([, value]) => typeof value === "string",
                      ),
                    )
                  : {},
              headerDescriptors: descriptorsFromJsonConfig(config),
              transport:
                typeof config.url === "string" && config.url
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
      headers:
        config.http_headers && typeof config.http_headers === "object"
          ? config.http_headers
          : {},
      headerDescriptors: descriptorsFromCodexConfig(config),
      transport:
        typeof config.url === "string" && config.url
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

  if (
    !parsed.mcpServers ||
    typeof parsed.mcpServers !== "object" ||
    Array.isArray(parsed.mcpServers)
  ) {
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
    const nextConfig = {
      ...(current && typeof current === "object" ? current : {}),
      ...update.config,
    };
    if (!Object.hasOwn(update.config, "headers")) {
      delete nextConfig.headers;
    }
    const changed =
      JSON.stringify(current || null) !== JSON.stringify(nextConfig);
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
  if (shouldSkipCodexConfigMutation()) {
    return {
      modified: false,
      filePath: resolvedPath,
      skipped: true,
      reason: "protected-env",
    };
  }

  let raw = existsSync(resolvedPath) ? readFileSync(resolvedPath, "utf8") : "";

  for (const name of removals) {
    raw = removeTomlSection(raw, name);
  }

  for (const update of updates) {
    raw = upsertTomlServer(raw, update.name, update.config, update.codex || {});
  }

  const finalRaw = raw.trim().length > 0 ? `${raw.trimEnd()}\n` : "";
  const previousRaw = existsSync(resolvedPath)
    ? readFileSync(resolvedPath, "utf8")
    : "";
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
  return registryPath();
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

  if (
    !registry.servers ||
    typeof registry.servers !== "object" ||
    Array.isArray(registry.servers)
  ) {
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
      const transport = server.transport || registry.defaults?.transport;
      if (!["hub-url", "http"].includes(transport)) {
        errors.push(
          `registry.servers.${name}.transport must be hub-url or http`,
        );
      }
      if (server.command !== undefined) {
        errors.push(
          `registry.servers.${name}.command is not supported; stdio registration is intentionally unsupported`,
        );
      }
      if (server.args !== undefined) {
        errors.push(
          `registry.servers.${name}.args is not supported; stdio registration is intentionally unsupported`,
        );
      }
      if (server.headers !== undefined) {
        if (!["hub-url", "http"].includes(transport)) {
          errors.push(
            `registry.servers.${name}.headers is allowed only for HTTP-compatible transports`,
          );
        }
        if (
          !server.headers ||
          typeof server.headers !== "object" ||
          Array.isArray(server.headers)
        ) {
          errors.push(`registry.servers.${name}.headers must be an object`);
        } else {
          for (const [headerName, descriptor] of Object.entries(
            server.headers,
          )) {
            if (!isValidHeaderName(headerName)) {
              errors.push(
                `registry.servers.${name}.headers contains invalid header name ${headerName}`,
              );
              continue;
            }
            if (
              !descriptor ||
              typeof descriptor !== "object" ||
              Array.isArray(descriptor)
            ) {
              errors.push(
                `registry.servers.${name}.headers.${headerName} must be a descriptor object`,
              );
              continue;
            }
            const keys = Object.keys(descriptor);
            const hasValue = Object.hasOwn(descriptor, "value");
            const hasEnv = Object.hasOwn(descriptor, "env");
            if (hasValue && hasEnv) {
              errors.push(
                `registry.servers.${name}.headers.${headerName} must use either value or env`,
              );
            } else if (hasValue) {
              if (
                keys.length !== 1 ||
                typeof descriptor.value !== "string" ||
                descriptor.value.length === 0
              ) {
                errors.push(
                  `registry.servers.${name}.headers.${headerName}.value must be a non-empty string`,
                );
              }
            } else if (hasEnv) {
              if (
                !["env", "prefix"].every((key) => keys.includes(key)) &&
                keys.some((key) => !["env", "prefix"].includes(key))
              ) {
                errors.push(
                  `registry.servers.${name}.headers.${headerName} supports only env and optional prefix`,
                );
              }
              if (
                typeof descriptor.env !== "string" ||
                !descriptor.env.trim()
              ) {
                errors.push(
                  `registry.servers.${name}.headers.${headerName}.env must be a non-empty string`,
                );
              }
              if (
                descriptor.prefix !== undefined &&
                typeof descriptor.prefix !== "string"
              ) {
                errors.push(
                  `registry.servers.${name}.headers.${headerName}.prefix must be a string`,
                );
              }
            } else {
              errors.push(
                `registry.servers.${name}.headers.${headerName} must use value or env`,
              );
            }
          }
        }
      }
      if (server.targets !== undefined && !Array.isArray(server.targets)) {
        errors.push(`registry.servers.${name}.targets must be an array`);
      }
    }
  }

  if (
    !registry.policies ||
    typeof registry.policies !== "object" ||
    Array.isArray(registry.policies)
  ) {
    errors.push("registry.policies must be an object");
  } else {
    if (!Array.isArray(registry.policies.watched_paths)) {
      errors.push("registry.policies.watched_paths must be an array");
    }
    if (
      registry.policies.sync_denylist !== undefined &&
      !Array.isArray(registry.policies.sync_denylist)
    ) {
      errors.push("registry.policies.sync_denylist must be an array");
    }
    if (Array.isArray(registry.policies.sync_denylist)) {
      for (const entry of registry.policies.sync_denylist) {
        if (typeof entry !== "string" || !entry.includes(":")) {
          errors.push(
            "registry.policies.sync_denylist entries must use client:server format",
          );
          break;
        }
      }
    }
    if (
      registry.policies.stdio_action &&
      !["replace-with-hub", "warn"].includes(registry.policies.stdio_action)
    ) {
      errors.push(
        "registry.policies.stdio_action must be replace-with-hub or warn",
      );
    }
  }

  return errors;
}

export function inspectRegistry() {
  if (!existsSync(registryPath())) {
    return {
      path: registryPath(),
      exists: false,
      valid: false,
      errors: ["registry file missing"],
      registry: null,
    };
  }

  try {
    const registry = readJsonFile(registryPath());
    const errors = validateRegistry(registry);
    return {
      path: registryPath(),
      exists: true,
      valid: errors.length === 0,
      errors,
      registry: errors.length === 0 ? registry : null,
    };
  } catch (error) {
    return {
      path: registryPath(),
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
  writeJsonFile(registryPath(), registry);
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
  return listManagedConfigTargets(registry).filter((target) =>
    isPrimaryConfigTarget(target.filePath),
  );
}

export function scanManagedConfigs(registry = loadRegistryOrDefault()) {
  return listManagedConfigTargets(registry).map((target) => ({
    ...target,
    ...scanConfig(target.filePath),
  }));
}

export function inspectRegistryStatus(registry = loadRegistryOrDefault()) {
  const configs = scanManagedConfigs(registry);
  const primaryTargets = new Set(
    listPrimaryConfigTargets(registry).map((target) =>
      normalizeForMatch(target.filePath),
    ),
  );
  const rows = [];

  for (const config of configs) {
    const isPrimary = primaryTargets.has(normalizeForMatch(config.filePath));
    const managedServers = Object.entries(registry.servers || {}).filter(
      ([, serverConfig]) =>
        isPrimary && serverAppliesToClient(serverConfig, config.client),
    );

    for (const [name, serverConfig] of managedServers) {
      const desired = buildDesiredServerRecord(
        name,
        serverConfig,
        config.filePath,
      );
      const expectedUrl = desired.config.url;
      const expectedHeaders = isCodexConfig(config.filePath)
        ? desired.headerDescriptors || {}
        : descriptorsFromJsonConfig(desired.config);
      const actual =
        config.servers.find((server) => server.name === name) || null;
      const actualHeaders = actual?.headerDescriptors || {};
      const currentHeaderStatus = headerStatus(expectedHeaders, actualHeaders);
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
        status = currentHeaderStatus === "ok" ? "present" : "mismatch";
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
        headerStatus: currentHeaderStatus,
        expectedHeaderNames: headerNames(expectedHeaders),
        actualHeaderNames: headerNames(actualHeaders),
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
  const offenders = Array.isArray(stdioServers)
    ? stdioServers.filter((server) => server?.name)
    : [];
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
    const registry = policy.registry || loadRegistryOrDefault();
    const matchingOffender = offenders.find((server) =>
      Object.hasOwn(registry.servers || {}, server.name),
    );
    const [hubServerName, hubServerConfig] = matchingOffender
      ? [matchingOffender.name, registry.servers[matchingOffender.name]]
      : getHubServerEntry(registry);
    const desired = buildDesiredServerRecord(
      hubServerName,
      hubServerConfig,
      resolvedPath,
    );
    replacement = { name: desired.name, ...redactServerConfig(desired.config) };
    updates.push(desired);
  }

  const result = updateJsonConfig(resolvedPath, updates, removals);
  return {
    action,
    modified: result.modified,
    backupPath,
    removedServers: removals,
    replacement,
    warnings: updates.flatMap((update) => update.warnings || []),
  };
}

export function resolveHubUrl() {
  const registryState = inspectRegistry();
  const registry = registryState.valid
    ? registryState.registry
    : cloneDefaultRegistry();
  const [, hubServer] = getHubServerEntry(registry);
  const fallbackRaw =
    hubServer?.url ||
    `${registry?.defaults?.hub_base || "http://127.0.0.1:27888"}${DEFAULT_HUB_PATH}`;

  let fallback;
  try {
    fallback = new URL(fallbackRaw);
  } catch {
    fallback = new URL(`http://127.0.0.1:27888${DEFAULT_HUB_PATH}`);
  }

  const envPortRaw = Number(process.env.TFX_HUB_PORT || "");
  const envPort =
    Number.isFinite(envPortRaw) && envPortRaw > 0 ? envPortRaw : null;
  const target = {
    protocol: fallback.protocol || "http:",
    host: fallback.hostname || "127.0.0.1",
    port: envPort || Number(fallback.port || 27888),
    pathname:
      fallback.pathname && fallback.pathname !== "/"
        ? fallback.pathname
        : DEFAULT_HUB_PATH,
  };

  // PR #158 정책: port = TFX_HUB_PORT env (없으면 registry/default 27888) single source.
  // hub.pid 는 loopback host 힌트 전용. 과거 pid port cascade 는 오염된 port 영속화의
  // 원인이었고 hub-ensure.resolveHubTarget 에서 이미 제거됨. 여기도 일관 적용.
  const hubPidPath = join(homedir(), ".claude", "cache", "tfx-hub", "hub.pid");
  if (existsSync(hubPidPath)) {
    try {
      const info = readJsonFile(hubPidPath);
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
  const registry = registryState.valid
    ? registryState.registry
    : cloneDefaultRegistry();
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

    const suffix = trimmed
      .replace(/^[.][\\/]/, "")
      .replace(/\\/g, "/")
      .toLowerCase();
    return candidate.endsWith(`/${suffix}`);
  });
}

export function addRegistryServer(name, url, options = {}) {
  const trimmedName = String(name || "").trim();
  const normalizedUrl = normalizeUrl(url);
  if (!trimmedName) throw new Error("server name is required");
  if (!normalizedUrl) throw new Error("server url is required");

  const registryState = inspectRegistry();
  const registry = registryState.valid
    ? loadRegistry()
    : cloneDefaultRegistry();
  const transport =
    options.transport || (trimmedName === "tfx-hub" ? "hub-url" : "url");

  registry.servers[trimmedName] = {
    transport,
    url: normalizedUrl,
    safe: options.safe ?? true,
    targets:
      Array.isArray(options.targets) && options.targets.length > 0
        ? [
            ...new Set(
              options.targets
                .map((value) => String(value).trim())
                .filter(Boolean),
            ),
          ]
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

  const registry =
    options.registry ||
    (inspectRegistry().valid ? loadRegistry() : cloneDefaultRegistry());
  const targetsFilter =
    Array.isArray(options.targets) && options.targets.length > 0
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
  const invalidConfigs = new Set();
  const denylist = syncDenylistEntries(registry.policies);

  for (const target of listManagedConfigTargets(registry)) {
    const snapshot = scanConfig(target.filePath);
    if (snapshot.parseError) {
      invalidConfigs.add(normalizeForMatch(target.filePath));
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
      const remediation = remediate(target.filePath, snapshot.stdioServers, {
        ...registry.policies,
        registry,
      });
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
    const snapshot = scanConfig(target.filePath);
    const targetKey = normalizeForMatch(target.filePath);
    if (snapshot.parseError) {
      if (!invalidConfigs.has(targetKey)) {
        actions.push({
          type: "sync",
          filePath: target.filePath,
          label: target.label,
          status: "invalid-config",
          message: snapshot.parseError.message,
        });
      }
      continue;
    }

    const updates = [];
    for (const [name, serverConfig] of Object.entries(registry.servers || {})) {
      if (serverConfig?.safe !== true) continue;
      if (!serverAppliesToClient(serverConfig, target.client)) continue;

      const denyKey = syncDenylistKey(target.client, name);
      if (denylist.has(denyKey)) {
        const existing = snapshot.servers.find(
          (server) => server.name === name,
        );
        if (!existing) {
          actions.push({
            type: "sync",
            filePath: target.filePath,
            label: target.label,
            status: "policy-skip",
            server: name,
            client: target.client,
            message: `[mcp-guard] policy skip: ${denyKey}`,
          });
        }
        continue;
      }

      updates.push(
        buildDesiredServerRecord(name, serverConfig, target.filePath),
      );
    }

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
      warnings: updates.flatMap((update) => update.warnings || []),
    });
  }

  return { actions };
}
