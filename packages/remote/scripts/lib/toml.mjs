import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { sanitizeCodexProfileConfig } from "./codex-profile-config.mjs";

const require = createRequire(import.meta.url);
let TOML = null;
try {
  TOML = require("@iarna/toml");
} catch {
  TOML = null;
}

function walk(value, visitor) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    visitor(value, key, child);
    walk(child, visitor);
  }
}

export function parseToml(source) {
  if (!TOML) return parseTomlFallback(source);
  return TOML.parse(source || "");
}

export function stringifyToml(value) {
  if (!TOML) return stringifyTomlFallback(value);
  return TOML.stringify(value);
}

function parseTomlFallback(source = "") {
  const root = {};
  let current = root;
  for (const rawLine of String(source).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      current = root;
      for (const part of section[1].split(".")) {
        current[part] ??= {};
        current = current[part];
      }
      continue;
    }
    const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"$/);
    if (assignment) {
      current[assignment[1]] = assignment[2];
    }
  }
  return root;
}

function stringifyTomlFallback(value) {
  const lines = [];
  for (const [key, child] of Object.entries(value)) {
    if (child && typeof child === "object") continue;
    lines.push(`${key} = "${String(child)}"`);
  }
  function writeSections(prefix, obj) {
    for (const [key, child] of Object.entries(obj)) {
      if (!child || typeof child !== "object") continue;
      const section = [...prefix, key];
      lines.push("", `[${section.join(".")}]`);
      for (const [childKey, childValue] of Object.entries(child)) {
        if (childValue && typeof childValue === "object") continue;
        lines.push(`${childKey} = "${String(childValue)}"`);
      }
      writeSections(section, child);
    }
  }
  writeSections([], value);
  return `${lines.join("\n")}\n`;
}

export function detectTopLevelCodexConfig(source) {
  const parsed = parseToml(source);
  return {
    hasTopLevelSandboxOrApproval:
      Object.hasOwn(parsed, "sandbox") ||
      Object.hasOwn(parsed, "approval_mode"),
  };
}

export function patchMcpApprovalMode(source) {
  const parsed = parseToml(source);
  let count = 0;
  walk(parsed.mcp_servers, (parent, key, value) => {
    if (key === "approval_mode" && value === "approve") {
      parent[key] = "full-auto";
      count += 1;
    }
  });
  return {
    changed: count > 0,
    count,
    toml: count > 0 ? stringifyToml(parsed) : source,
  };
}

export function patchCodexConfigFile(path, { now = () => new Date() } = {}) {
  if (!path || !existsSync(path)) return { changed: false, count: 0 };
  const source = readFileSync(path, "utf8");
  const approvalPatched = patchMcpApprovalMode(source);
  const profileSanitized = sanitizeCodexProfileConfig(approvalPatched.toml, {
    codexHome: dirname(path),
  });
  const changed = approvalPatched.changed || profileSanitized.changed;
  if (!changed) {
    return {
      changed: false,
      count: 0,
      removedProfiles: [],
      migratedProfiles: [],
    };
  }
  const stamp = now()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..*$/, "")
    .replace("T", "-");
  writeFileSync(`${path}.bak-${stamp}`, source);
  writeFileSync(path, profileSanitized.toml);
  return {
    changed: true,
    count: approvalPatched.count,
    removedProfiles: profileSanitized.removedProfiles,
    migratedProfiles: profileSanitized.migratedProfiles,
    toml: profileSanitized.toml,
  };
}
