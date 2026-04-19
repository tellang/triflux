import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const HOSTS_LOCATIONS = [
  ["references", "hosts.json"],
  ["skills", "tfx-remote-spawn", "references", "hosts.json"],
  ["packages", "triflux", "references", "hosts.json"],
];

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function candidatePaths(repoRoot) {
  const root = repoRoot || process.cwd();
  return HOSTS_LOCATIONS.map((segments) => join(root, ...segments));
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

export function normalizeHost(rawHost = {}, name = "") {
  const sshUser = rawHost.ssh_user || rawHost.ssh?.user || rawHost.user || null;
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
    },
    tailscale,
    capabilities,
    capabilities_v2,
    last_probe: normalizeLastProbe(rawHost.last_probe),
    specs:
      rawHost.specs && typeof rawHost.specs === "object"
        ? { ...rawHost.specs }
        : {},
    raw: { ...rawHost },
  };
}

export function readHosts(repoRoot) {
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
      host.ssh_user ? `${host.ssh_user}@${name}` : null,
      host.ssh_user && host.tailscale.ip
        ? `${host.ssh_user}@${host.tailscale.ip}`
        : null,
      host.ssh_user && host.tailscale.dns
        ? `${host.ssh_user}@${host.tailscale.dns}`
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

export function selfTestFixtures() {
  const v1 = normalizeHost(
    {
      description: "legacy",
      aliases: ["desk"],
      default_dir: "~/Desktop/Projects",
      os: "win32",
      ssh_user: "SSAFY",
      tailscale: { ip: "100.64.0.1", dns: "desk.ts.net" },
      capabilities: ["codex", "claude"],
    },
    "ultra4",
  );
  const v2 = normalizeHost(
    {
      description: "modern",
      aliases: ["mac"],
      default_dir: "~/projects",
      os: "darwin kernel",
      ssh: { user: "tellang" },
      tailscale: {
        ip: "100.64.0.2",
        dns: "mac.ts.net",
        ssh_mode: "ssh-over-vpn",
      },
      capabilities_v2: { codex: true, claude: true, high_memory: true },
      last_probe: { ok: true, ts: "2026-04-18T12:34:56Z", latency_ms: 143 },
    },
    "m2",
  );
  return {
    v1,
    v2,
    checks: {
      v1_os: v1.os === "windows",
      v1_ssh_user: v1.ssh.user === "SSAFY" && v1.ssh_user === "SSAFY",
      v2_os: v2.os === "darwin",
      v2_caps: v2.capabilities.includes("high-memory"),
      v2_probe: v2.last_probe?.ok === true && v2.last_probe?.latency_ms === 143,
    },
  };
}

if (process.argv.includes("--self-test")) {
  process.stdout.write(`${JSON.stringify(selfTestFixtures(), null, 2)}\n`);
}
