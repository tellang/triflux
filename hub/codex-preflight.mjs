import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { whichCommandAsync } from './platform.mjs';
import { getCodexVersion } from './team/codex-compat.mjs';

const MIN_RECOMMENDED_MINOR = 118;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readConfigText(configPath = join(homedir(), '.codex', 'config.toml')) {
  if (!existsSync(configPath)) return '';
  try {
    return readFileSync(configPath, 'utf8');
  } catch {
    return '';
  }
}

function readTomlString(text, key) {
  const match = String(text).match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]*)"\\s*$`, 'mu'));
  return match?.[1] ?? null;
}

function readSection(text, name) {
  const lines = String(text).split(/\r?\n/u);
  const header = `[${name}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return '';
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\[[^\]]+\]\s*$/u.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

async function checkCodexInstalled() {
  const codexPath = await whichCommandAsync('codex');
  if (codexPath) return { codexPath, ok: true, warnings: [] };
  return {
    codexPath: null,
    ok: false,
    warnings: ['Codex CLI not found. Install Codex and ensure `codex` is available on PATH.'],
  };
}

function checkCodexVersion() {
  const version = getCodexVersion();
  const warnings = version >= MIN_RECOMMENDED_MINOR
    ? []
    : [`Codex CLI 0.${version}.x detected; 0.${MIN_RECOMMENDED_MINOR}.x or newer is recommended.`];
  return { version, warnings };
}

function checkApprovalMode(configText, opts = {}) {
  const approvalMode = readTomlString(configText, 'approval_mode');
  const sandbox = readTomlString(configText, 'sandbox');
  const subcommand = opts.subcommand || 'exec';
  return {
    needsBypass: subcommand === 'exec' || approvalMode !== 'full-auto',
    approvalMode,
    sandbox,
  };
}

async function verifyServerHealth(name, configText) {
  const section = readSection(configText, `mcp_servers.${name}`);
  if (!section) return { ok: false, warning: `MCP server '${name}' is not configured.` };
  if (/^\s*enabled\s*=\s*false\s*$/mu.test(section)) {
    return { ok: false, warning: `MCP server '${name}' is disabled in config.toml.` };
  }

  const command = readTomlString(section, 'command');
  if (command) {
    const resolved = await whichCommandAsync(command);
    return resolved
      ? { ok: true, warning: '' }
      : { ok: false, warning: `MCP server '${name}' command not found: ${command}` };
  }

  const url = readTomlString(section, 'url');
  if (!url || !/^https?:\/\//u.test(url)) return { ok: true, warning: '' };
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return response.status < 500
      ? { ok: true, warning: '' }
      : { ok: false, warning: `MCP server '${name}' returned HTTP ${response.status}.` };
  } catch {
    return { ok: false, warning: `MCP server '${name}' is unreachable at ${url}.` };
  }
}

async function checkMcpHealth(mcpServers, configText) {
  const excludeMcpServers = [];
  const warnings = [];

  for (const name of Array.isArray(mcpServers) ? mcpServers : []) {
    const server = String(name ?? '').trim();
    if (!server) continue;
    const result = await verifyServerHealth(server, configText);
    if (!result.ok) excludeMcpServers.push(server);
    if (result.warning) warnings.push(result.warning);
  }

  return { excludeMcpServers, warnings };
}

export async function runPreflight(opts = {}) {
  const install = await checkCodexInstalled();
  if (!install.ok) {
    return {
      codexPath: null,
      version: 0,
      needsBypass: true,
      excludeMcpServers: [],
      warnings: install.warnings,
      ok: false,
    };
  }

  const warnings = [...install.warnings];
  const { version, warnings: versionWarnings } = checkCodexVersion();
  warnings.push(...versionWarnings);

  const configText = readConfigText(opts.configPath);
  const approval = checkApprovalMode(configText, opts);
  if (approval.approvalMode !== 'full-auto') {
    warnings.push(`approval_mode is '${approval.approvalMode || 'unset'}'; bypass flag will be used.`);
  }
  if (approval.sandbox) warnings.push(`sandbox mode from config.toml: ${approval.sandbox}`);

  const mcp = await checkMcpHealth(opts.mcpServers, configText);
  warnings.push(...mcp.warnings);

  return {
    codexPath: install.codexPath,
    version,
    needsBypass: approval.needsBypass,
    excludeMcpServers: mcp.excludeMcpServers,
    warnings,
    ok: true,
  };
}
