import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// cwd 를 따르면 다른 저장소의 hosts.json 을 사용자 설정으로 복사하게 된다. 패키지 루트로 고정한다.
const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const LEGACY_HOSTS_SEGMENTS = ["references", "hosts.json"];

let migrated = false;

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function userStateHostsPath() {
  if (process.env.TFX_HOSTS_USER_STATE_DISABLE === "1") return null;
  if (process.env.TFX_HOSTS_USER_STATE) return process.env.TFX_HOSTS_USER_STATE;
  if (process.platform === "win32") {
    return join(
      process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
      "triflux",
      "hosts.json",
    );
  }
  return join(homedir(), ".config", "triflux", "hosts.json");
}

function legacyHostsPath(repoRoot) {
  return join(repoRoot || PACKAGE_ROOT, ...LEGACY_HOSTS_SEGMENTS);
}

function candidatePaths(repoRoot) {
  const legacyPath = legacyHostsPath(repoRoot);
  const userPath = userStateHostsPath();
  return userPath ? [userPath, legacyPath] : [legacyPath];
}

export function migrateLegacyHosts(repoRoot) {
  const to = userStateHostsPath();
  let from = null;
  if (!to) {
    return {
      migrated: false,
      from: null,
      to: null,
      reason: "user-state-disabled",
    };
  }
  try {
    if (existsSync(to)) {
      return { migrated: false, from: null, to, reason: "already-exists" };
    }

    const legacyPath = legacyHostsPath(repoRoot);
    if (!existsSync(legacyPath)) {
      return { migrated: false, from: null, to, reason: "not-found" };
    }
    from = legacyPath;

    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    return { migrated: true, from, to };
  } catch (error) {
    return {
      migrated: false,
      from,
      to,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function canonicalOs(rawOs) {
  const value = String(rawOs || "")
    .trim()
    .toLowerCase();
  if (!value) return "linux";
  if (
    value === "win32" ||
    value === "windows" ||
    value.startsWith("windows-")
  ) {
    return "windows";
  }
  if (value === "macos" || value === "darwin" || value.includes("darwin")) {
    return "darwin";
  }
  return "linux";
}

function normalizeCapabilitiesArray(rawArray, rawMap) {
  const fromArray = Array.isArray(rawArray)
    ? rawArray.map((item) => String(item).trim()).filter(Boolean)
    : [];
  const fromMap =
    rawMap && typeof rawMap === "object"
      ? Object.entries(rawMap)
          .filter(([, enabled]) => Boolean(enabled))
          .map(([name]) => String(name).trim().replace(/_/g, "-"))
      : [];
  return [...new Set([...fromArray, ...fromMap])];
}

function normalizeCapabilitiesMap(rawMap, rawArray) {
  const normalized = {};
  if (rawMap && typeof rawMap === "object") {
    for (const [key, enabled] of Object.entries(rawMap)) {
      normalized[String(key).trim()] = Boolean(enabled);
    }
  }
  if (Array.isArray(rawArray)) {
    for (const item of rawArray) {
      const key = String(item).trim().replace(/-/g, "_");
      if (key) normalized[key] = true;
    }
  }
  return normalized;
}

function normalizeLastProbe(rawProbe) {
  if (!rawProbe || typeof rawProbe !== "object") {
    return null;
  }
  const probe = {};
  if (typeof rawProbe.ok === "boolean") probe.ok = rawProbe.ok;
  if (rawProbe.ts) probe.ts = String(rawProbe.ts);
  if (Number.isFinite(rawProbe.latency_ms))
    probe.latency_ms = rawProbe.latency_ms;
  return Object.keys(probe).length > 0 ? probe : null;
}

function normalizeResources(rawHost) {
  const rawResources =
    rawHost.resources && typeof rawHost.resources === "object"
      ? rawHost.resources
      : {};
  const rawSpecs =
    rawHost.specs && typeof rawHost.specs === "object" ? rawHost.specs : {};
  return { ...rawResources, ...rawSpecs };
}

export function normalizeHost(rawHost = {}, name = "") {
  const sshUser = rawHost.ssh_user || rawHost.ssh?.user || rawHost.user || null;
  const sshHost = rawHost.ssh?.host || rawHost.host || null;
  const resources = normalizeResources(rawHost);
  const tailscale = {
    ip: rawHost.tailscale?.ip || null,
    dns: rawHost.tailscale?.dns || null,
    ssh_mode: rawHost.tailscale?.ssh_mode || null,
  };
  const capabilities = normalizeCapabilitiesArray(
    rawHost.capabilities,
    rawHost.capabilities_v2,
  );
  const capabilities_v2 = normalizeCapabilitiesMap(
    rawHost.capabilities_v2,
    rawHost.capabilities,
  );

  return {
    name,
    description: rawHost.description || name,
    aliases: Array.isArray(rawHost.aliases)
      ? [
          ...new Set(
            rawHost.aliases
              .map((alias) => String(alias).trim())
              .filter(Boolean),
          ),
        ]
      : [],
    default_dir: rawHost.default_dir || "~",
    os: canonicalOs(rawHost.os),
    ssh_user: sshUser,
    ssh: {
      ...(rawHost.ssh && typeof rawHost.ssh === "object" ? rawHost.ssh : {}),
      user: sshUser,
      host: sshHost,
    },
    tailscale,
    capabilities,
    capabilities_v2,
    last_probe: normalizeLastProbe(rawHost.last_probe),
    resources,
    specs: { ...resources },
    raw: { ...rawHost },
  };
}

export function readHosts(repoRoot) {
  if (!migrated) {
    migrateLegacyHosts(repoRoot);
    migrated = true;
  }

  for (const path of candidatePaths(repoRoot)) {
    if (!existsSync(path)) continue;
    const parsed = readJsonFile(path);
    const normalizedHosts = Object.fromEntries(
      Object.entries(parsed.hosts || {}).map(([name, host]) => [
        name,
        normalizeHost(host, name),
      ]),
    );
    return {
      path,
      raw: parsed,
      hosts: normalizedHosts,
      default_host:
        parsed.default_host && normalizedHosts[parsed.default_host]
          ? parsed.default_host
          : null,
      triggers: Array.isArray(parsed.triggers)
        ? parsed.triggers.map((item) => String(item).trim()).filter(Boolean)
        : [],
    };
  }

  return {
    path: null,
    raw: { hosts: {} },
    hosts: {},
    default_host: null,
    triggers: [],
  };
}

export function resolveHost(nameOrAlias, repoRoot) {
  if (!nameOrAlias) return null;
  const registry = readHosts(repoRoot);
  const needle = String(nameOrAlias).trim();
  if (!needle) return null;

  if (registry.hosts[needle]) {
    return { name: needle, host: registry.hosts[needle], registry };
  }

  const lowered = needle.toLowerCase();
  for (const [name, host] of Object.entries(registry.hosts)) {
    const aliases = new Set([
      ...host.aliases,
      host.tailscale.ip,
      host.tailscale.dns,
      host.ssh.host,
      host.ssh_user ? `${host.ssh_user}@${name}` : null,
      host.ssh_user && host.tailscale.ip
        ? `${host.ssh_user}@${host.tailscale.ip}`
        : null,
      host.ssh_user && host.tailscale.dns
        ? `${host.ssh_user}@${host.tailscale.dns}`
        : null,
      host.ssh_user && host.ssh.host
        ? `${host.ssh_user}@${host.ssh.host}`
        : null,
    ]);
    for (const alias of aliases) {
      if (alias && String(alias).toLowerCase() === lowered) {
        return { name, host, registry };
      }
    }
  }

  return null;
}

export function readHost(nameOrAlias, repoRoot) {
  return resolveHost(nameOrAlias, repoRoot)?.host ?? null;
}
